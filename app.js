"use strict";
// ======================================================================
// ARKAGRID v2 — CAMPUS ENERGY INTELLIGENCE
// Adaptive digital twin: time-aware load model, tariff-aware smart
// dispatch, look-ahead forecast, edge anomaly detection + Python hybrid
// engine, AI advisor, sustainability scoring, resilient networking.
// Drop-in replacement: all original DOM ids / events / API routes kept.
// ======================================================================
(() => {

// ----------------------------------------------------------------------
// 1. CONFIG
// ----------------------------------------------------------------------
const CONFIG = {
    api: { anomalies: "/api/anomalies", readings: "/api/readings", health: "/api/health" },
    timing: { tickMs: 1000, stepMinutes: 5, pollMs: 5000, uploadEveryTicks: 5, timeoutMs: 6000, maxQueue: 20 },
    tariff: {
        baseRate: 8, // INR per kWh
        peak: { from: 18, to: 22, mult: 1.5 },
        offPeak: { from: 23, to: 6, mult: 0.7 }
    },
    co2PerKwh: 0.82, // kg CO2 per grid kWh (India average, illustrative)
    detector: { threshold: 0.28, zLimit: 3, maxEvents: 30 },
    faultSteps: 60,
    historyLimit: 288,
    storageKey: "arkagrid.v2.settings"
};

const BUILDINGS = [
    { name: "Academic Block", icon: "🏛️", base: 25, night: 0.25, peak: 11,   spread: 3.5 },
    { name: "Laboratory",     icon: "🔬", base: 40, night: 0.35, peak: 13,   spread: 4.0 },
    { name: "Library",        icon: "📚", base: 18, night: 0.15, peak: 15,   spread: 4.0 },
    { name: "Administration", icon: "🏢", base: 15, night: 0.20, peak: 11.5, spread: 3.0 },
    { name: "Hostel",         icon: "🏠", base: 30, night: 0.45, peak: 21,   spread: 4.5 }
];

const MODES = {
    balanced: { label: "Balanced", hint: "Solar first, battery covers deficits." },
    eco:      { label: "Eco",      hint: "Minimise grid import and carbon." },
    cost:     { label: "Cost saver", hint: "Charge cheap, discharge in peak tariff." }
};

// ----------------------------------------------------------------------
// 2. HELPERS
// ----------------------------------------------------------------------
const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const safeNumber = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
const setHTML = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
const pad2 = n => String(n).padStart(2, "0");

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[c]);
}

function formatTimestamp(value) {
    if (!value) return "Unavailable";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value)
        : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

const inWindow = (h, from, to) => from <= to ? (h >= from && h < to) : (h >= from || h < to);
const formatHour = h => { const x = ((h % 24) + 24) % 24; return `${pad2(Math.floor(x))}:${pad2(Math.floor((x % 1) * 60))}`; };

function tariffMultiplier(h) {
    const t = CONFIG.tariff;
    if (inWindow(h, t.peak.from, t.peak.to)) return t.peak.mult;
    if (inWindow(h, t.offPeak.from, t.offPeak.to)) return t.offPeak.mult;
    return 1;
}

function severityFor(devFraction) {
    const d = Math.abs(devFraction);
    return d > 0.8 ? "critical" : d > 0.5 ? "high" : d > 0.3 ? "moderate" : "low";
}

function saveSettings() {
    try {
        localStorage.setItem(CONFIG.storageKey, JSON.stringify({
            selected: state.selected, mode: state.mode, speed: state.speed,
            occupancy: $("occupancy")?.value, hours: $("operatingHours")?.value, extra: $("extraLoad")?.value
        }));
    } catch (_) { /* storage unavailable */ }
}
function loadSettings() {
    try { return JSON.parse(localStorage.getItem(CONFIG.storageKey) || "null") || {}; }
    catch (_) { return {}; }
}

// ----------------------------------------------------------------------
// 3. STATE
// ----------------------------------------------------------------------
const state = {
    selected: "Academic Block",
    mode: "balanced",
    speed: 1,
    running: true,
    clock: { h: 9, m: 0, day: 1 },
    solarCapacity: 25,
    cloud: 0.85,
    lossRate: 0.05,
    battery: { capacity: 100, soc: 60, maxPower: 15, eff: 0.95, floor: 10 },
    totals: null,
    demands: {},
    faults: {},
    balance: null,
    forecast: null,
    history: [],
    detector: {},
    localEvents: [],
    server: { online: false, events: [], buildings: [], count: 0, readings: 0, generatedAt: null, modelInfo: {} },
    queue: [],
    retryAt: 0,
    flushing: false,
    polling: false,
    uploadCounter: 0,
    lastSignature: "",
    hoverIdx: -1
};

function freshTotals() {
    return { energy: 0, required: 0, grid: 0, solar: 0, cost: 0, baselineCost: 0, co2Avoided: 0, peakGrid: 0, curtailed: 0 };
}
state.totals = freshTotals();

const hourFloat = () => state.clock.h + state.clock.m / 60;

// ----------------------------------------------------------------------
// 4. ENERGY MODEL
// ----------------------------------------------------------------------
function shape(b, h) {
    let d = Math.abs(h - b.peak);
    d = Math.min(d, 24 - d);
    return b.night + (1 - b.night) * Math.exp(-(d * d) / (2 * b.spread ** 2));
}

function scenarioInputs() {
    return {
        occupancy: safeNumber($("occupancy")?.value, 70),
        hours: Math.max(1, safeNumber($("operatingHours")?.value, 10)),
        extra: safeNumber($("extraLoad")?.value, 0)
    };
}

// Original daily-energy comparison model (kept for the scenario cards).
function calculateEnergy(building, occupancyPercent, operatingHours, additionalLoad) {
    const occF = 0.4 + 0.6 * (occupancyPercent / 100);
    const refF = 0.4 + 0.6 * 0.7;
    const referenceEnergy = building.base * 10 * refF;
    const simulatedEnergy = building.base * operatingHours * occF * (1 + additionalLoad / 100);
    return { referenceEnergy, simulatedEnergy, difference: referenceEnergy - simulatedEnergy };
}

function scenarioDemand(b) {
    const { occupancy, extra } = scenarioInputs();
    return b.base * (0.4 + 0.6 * occupancy / 100) * (1 + extra / 100);
}

function computeDemands(hour, { noise = true, faults = true } = {}) {
    const out = {};
    for (const b of BUILDINGS) {
        let kw = scenarioDemand(b) * shape(b, hour);
        if (noise) kw *= 1 + (Math.random() - 0.5) * 0.06;
        if (faults && state.faults[b.name]) kw *= state.faults[b.name].mult;
        out[b.name] = kw;
    }
    return out;
}

const demandList = () => BUILDINGS.map(b => ({ ...b, demand: state.demands[b.name] ?? scenarioDemand(b) }));

function solarAt(hour, cloud = state.cloud) {
    if (hour < 6 || hour >= 18) return 0;
    return Math.max(0, state.solarCapacity * Math.sin(Math.PI * (hour - 6) / 12) * cloud);
}

// Tariff-aware dispatch. Convention: batteryPower > 0 discharge, < 0 charge.
function evaluate(demands, hour, soc, mode, dt, cloud = state.cloud) {
    const bat = state.battery;
    const totalDemand = Object.values(demands).reduce((s, v) => s + v, 0);
    const losses = totalDemand * state.lossRate;
    const required = totalDemand + losses;
    const solar = solarAt(hour, cloud);
    const tariff = tariffMultiplier(hour);
    const floor = mode === "eco" ? 5 : bat.floor;

    const solarUsed = Math.min(solar, required);
    const deficit = required - solarUsed;
    const surplus = solar - solarUsed;

    const availKW = Math.max(0, (soc - floor) / 100 * bat.capacity * bat.eff / dt);
    const roomKW = Math.max(0, (100 - soc) / 100 * bat.capacity / bat.eff / dt);

    const allowDischarge = mode !== "cost" || tariff > 1 || soc > 70;
    const discharge = deficit > 0 && allowDischarge ? Math.min(deficit, bat.maxPower, availKW) : 0;
    let charge = 0, gridCharge = 0, curtailed = 0;

    if (surplus > 0) {
        charge = Math.min(surplus, bat.maxPower, roomKW);
        curtailed = surplus - charge;
    } else if (mode === "cost" && tariff < 1 && soc < 90) {
        gridCharge = Math.min(bat.maxPower * 0.5, roomKW);
    }

    return {
        totalDemand, losses, requiredPower: required, solarPower: solar, solarUsed,
        solarSurplus: Math.max(0, surplus), curtailed, tariff,
        batteryPower: discharge - charge - gridCharge,
        charge: charge + gridCharge, discharge,
        gridPower: deficit - discharge + gridCharge,
        batterySOC: soc
    };
}

function socAfter(bal, dt) {
    const bat = state.battery;
    const delta = (bal.charge * bat.eff - bal.discharge / bat.eff) * dt / bat.capacity * 100;
    return clamp(bat.soc + delta, 0, 100);
}

// Look-ahead: deterministic 6-hour projection using the current settings.
function buildForecast(hours = 6) {
    const dt = 0.25;
    let soc = state.battery.soc, h = hourFloat();
    let gridKwh = 0, cost = 0, peakKw = 0, peakAt = h, minSoc = soc;
    const points = [];
    for (let i = 0; i < hours / dt; i++) {
        const hr = (h + i * dt) % 24;
        const bal = evaluate(computeDemands(hr, { noise: false, faults: false }), hr, soc, state.mode, dt);
        gridKwh += bal.gridPower * dt;
        cost += bal.gridPower * dt * CONFIG.tariff.baseRate * bal.tariff;
        if (bal.gridPower > peakKw) { peakKw = bal.gridPower; peakAt = hr; }
        const delta = (bal.charge * state.battery.eff - bal.discharge / state.battery.eff) * dt / state.battery.capacity * 100;
        soc = clamp(soc + delta, 0, 100);
        minSoc = Math.min(minSoc, soc);
        points.push({ hour: hr, grid: bal.gridPower, soc });
    }
    return { gridKwh, cost, peakKw, peakAt, minSoc, endSoc: soc, points };
}

// ----------------------------------------------------------------------
// 5. SIMULATION STEP
// ----------------------------------------------------------------------
function stepSimulation() {
    const dt = CONFIG.timing.stepMinutes / 60;
    const hour = hourFloat();

    state.cloud = clamp(state.cloud + (Math.random() - 0.5) * 0.06, 0.45, 1);
    tickFaults();
    state.demands = computeDemands(hour);
    const bal = evaluate(state.demands, hour, state.battery.soc, state.mode, dt);
    const t = state.totals;

    t.energy += bal.totalDemand * dt;
    t.required += bal.requiredPower * dt;
    t.grid += bal.gridPower * dt;
    t.solar += bal.solarPower * dt;
    t.curtailed += bal.curtailed * dt;
    t.cost += bal.gridPower * dt * CONFIG.tariff.baseRate * bal.tariff;
    t.baselineCost += bal.requiredPower * dt * CONFIG.tariff.baseRate;
    t.co2Avoided += Math.max(0, bal.requiredPower - bal.gridPower) * dt * CONFIG.co2PerKwh;
    if (bal.tariff > 1) t.peakGrid += bal.gridPower * dt;

    state.battery.soc = socAfter(bal, dt);
    state.balance = { ...bal, batterySOC: state.battery.soc };

    state.history.push({
        t: Date.now(), clock: formatClock(), demand: bal.totalDemand, solar: bal.solarPower,
        grid: bal.gridPower, battery: bal.batteryPower, soc: state.battery.soc, tariff: bal.tariff
    });
    if (state.history.length > CONFIG.historyLimit) state.history.shift();

    state.clock.m += CONFIG.timing.stepMinutes;
    if (state.clock.m >= 60) {
        state.clock.m = 0;
        state.clock.h = (state.clock.h + 1) % 24;
        if (state.clock.h === 0) state.clock.day++;
    }
    detectLocalAnomalies(hour);
}

function formatClock() { return `${pad2(state.clock.h)}:${pad2(state.clock.m)}`; }

function advanceSimulation() {
    if (!state.running) return;
    for (let i = 0; i < state.speed; i++) stepSimulation();
    state.forecast = buildForecast();
    renderAll();

    if (++state.uploadCounter >= CONFIG.timing.uploadEveryTicks) {
        state.uploadCounter = 0;
        sendLiveReadings();
    }
}

function resetPowerSystem() {
    state.battery.soc = 60;
    state.clock = { h: 9, m: 0, day: 1 };
    state.totals = freshTotals();
    state.history = [];
    state.faults = {};
    state.detector = {};
    state.running = true;
    state.cloud = 0.85;
    refreshDemands();
    toast("Energy model reset", "info");
    renderAll();
}

function refreshDemands() {
    state.demands = computeDemands(hourFloat(), { noise: false });
    state.balance = evaluate(state.demands, hourFloat(), state.battery.soc, state.mode, CONFIG.timing.stepMinutes / 60);
    state.forecast = buildForecast();
}

// ----------------------------------------------------------------------
// 6. FAULT INJECTION + EDGE ANOMALY DETECTION
// ----------------------------------------------------------------------
function injectFault(name = state.selected) {
    const mult = 1.7 + Math.random() * 0.6;
    state.faults[name] = { mult, ticksLeft: CONFIG.faultSteps };
    window.dispatchEvent(new CustomEvent("arkagrid:fault-injected", { detail: { name, mult } }));
    toast(`Fault injected in ${name} (×${mult.toFixed(2)} load)`, "warn");
}

function clearFaults() {
    state.faults = {};
    toast("All injected faults cleared", "info");
}

function tickFaults() {
    for (const [name, f] of Object.entries(state.faults)) {
        if (--f.ticksLeft <= 0) { delete state.faults[name]; toast(`Fault in ${name} cleared`, "ok"); }
    }
}

function detectLocalAnomalies(hour) {
    const { threshold, zLimit, maxEvents } = CONFIG.detector;
    for (const b of BUILDINGS) {
        const expected = scenarioDemand(b) * shape(b, hour);
        const actual = state.demands[b.name];
        const dev = (actual - expected) / Math.max(expected, 0.1);
        const m = state.detector[b.name] ||= { mean: 0, variance: 0.002, active: false };
        const z = (dev - m.mean) / Math.sqrt(m.variance + 1e-4);
        const flagged = Math.abs(dev) > threshold && Math.abs(z) > zLimit;

        if (!flagged) {
            m.mean = 0.95 * m.mean + 0.05 * dev;
            m.variance = 0.95 * m.variance + 0.05 * (dev - m.mean) ** 2;
        }
        if (flagged && !m.active) {
            const severity = severityFor(dev);
            state.localEvents.unshift({
                building: b.name, severity, timestamp: new Date().toISOString(),
                energy_kwh: actual, deviation_pct: dev * 100, source: "edge_detector",
                explanation: `Edge detector: load is ${(dev * 100).toFixed(0)}% ${dev > 0 ? "above" : "below"} the expected profile (z=${z.toFixed(1)}).`
            });
            state.localEvents.length = Math.min(state.localEvents.length, maxEvents);
            toast(`${severity.toUpperCase()} anomaly in ${b.name}`, severity === "low" ? "warn" : "bad");
        }
        m.active = flagged;
    }
}

const activeLocalBuildings = () => BUILDINGS.filter(b => state.detector[b.name]?.active).map(b => b.name);

// ----------------------------------------------------------------------
// 7. AI ADVISOR
// ----------------------------------------------------------------------
function buildAdvice() {
    const adv = [];
    const b = state.balance, f = state.forecast;
    if (!b) return adv;
    const h = hourFloat();
    const { occupancy, hours, extra } = scenarioInputs();
    const active = activeLocalBuildings();

    if (active.length) adv.push({ level: "bad", title: "Active anomaly", text: `Inspect ${active.join(", ")} — load deviates strongly from its expected profile.` });
    if (b.curtailed > 0.5) adv.push({ level: "info", title: "Solar being wasted", text: `${b.curtailed.toFixed(1)} kW of surplus solar can't be stored. Shift flexible loads (lab equipment, pumps) to midday.` });
    if (h >= 10 && h < 18 && state.battery.soc < 30 && state.mode !== "cost")
        adv.push({ level: "warn", title: "Battery low before peak tariff", text: `SOC is ${state.battery.soc.toFixed(0)}%. Switch to Cost saver to pre-charge for the ${CONFIG.tariff.peak.from}:00 peak window.` });
    if (b.tariff > 1 && b.gridPower > b.requiredPower * 0.6)
        adv.push({ level: "warn", title: "Heavy grid draw at peak price", text: `Importing ${b.gridPower.toFixed(1)} kW at ${b.tariff}× tariff. Defer non-critical loads.` });
    if (extra >= 30) adv.push({ level: "warn", title: "High additional load", text: `A ${extra}% load increase adds roughly ${(b.totalDemand * extra / (100 + extra)).toFixed(1)} kW campus-wide.` });
    if (occupancy < 40 && hours > 10) adv.push({ level: "info", title: "Low occupancy, long hours", text: "Reducing operating hours in low-occupancy buildings is the cheapest saving available." });
    if (f && f.minSoc < 15) adv.push({ level: "warn", title: "Battery depletion forecast", text: `SOC is projected to fall to ${f.minSoc.toFixed(0)}% within 6 hours.` });
    if (f) adv.push({ level: "info", title: "6-hour look-ahead", text: `Expect ${f.gridKwh.toFixed(0)} kWh grid import (₹${f.cost.toFixed(0)}), peaking near ${f.peakKw.toFixed(1)} kW at ${formatHour(f.peakAt)}.` });
    if (!adv.some(a => a.level === "bad" || a.level === "warn"))
        adv.unshift({ level: "ok", title: "Operating efficiently", text: "No risks detected in the current scenario." });
    return adv;
}

function sustainabilityScore() {
    const t = state.totals, b = state.balance;
    const selfSuff = t.required > 0 ? clamp(1 - t.grid / t.required, 0, 1)
        : b ? clamp(1 - b.gridPower / Math.max(b.requiredPower, 0.1), 0, 1) : 0;
    const peakShare = t.grid > 0 ? t.peakGrid / t.grid : 0;
    const anomFree = 1 - Math.min(1, activeLocalBuildings().length / BUILDINGS.length);
    return { selfSuff, score: Math.round(100 * (0.6 * selfSuff + 0.25 * (1 - peakShare) + 0.15 * anomFree)) };
}

// ----------------------------------------------------------------------
// 8. STYLES + TOASTS
// ----------------------------------------------------------------------
function injectStyles() {
    if ($("ag-style")) return;
    const style = document.createElement("style");
    style.id = "ag-style";
    style.textContent = `
    .ag-panel{margin:28px 0;padding:24px;border:1px solid rgba(130,150,190,.2);border-radius:18px;
        background:linear-gradient(145deg,rgba(17,26,48,.97),rgba(9,16,32,.97));color:#eef2ff;
        box-shadow:0 15px 45px rgba(0,0,0,.2);box-sizing:border-box;width:100%}
    .ag-eyebrow{font-size:11px;letter-spacing:2px;color:#8b9ab8}
    .ag-title{margin:8px 0;font-size:22px;color:#f0f4ff}
    .ag-sub{margin:0;color:#8996b2;font-size:12px}
    .ag-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center}
    .ag-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin-top:20px}
    .ag-kpi{min-width:0;padding:16px;border-radius:12px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);box-sizing:border-box}
    .ag-kpi label{display:block;font-size:11px;color:#91a0bd}
    .ag-kpi b{display:block;font-size:24px;margin-top:8px;color:#eaf3ff;overflow-wrap:anywhere}
    .ag-kpi small{font-size:10px;color:#7888a8}
    .ag-box{margin-top:20px;padding:16px;background:rgba(255,255,255,.035);border-radius:12px}
    .ag-box h4{margin:0 0 10px;font-size:13px}
    .ag-bar{height:14px;background:#26344b;overflow:hidden;border-radius:20px;display:flex}
    .ag-bar div{transition:width .5s}
    .ag-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;align-items:center}
    .ag-btn{padding:9px 14px;border-radius:8px;border:1px solid #52617c;background:#26344b;color:#fff;cursor:pointer;font:inherit;font-size:12px}
    .ag-btn:hover{background:#33446a}.ag-btn.ghost{background:transparent}
    .ag-btn.active{background:#6d4fe0;border-color:#9a82ff}
    .ag-btn.danger{border-color:#c0505e;color:#ffb3bd}
    .ag-seg{display:flex;gap:6px;align-items:center;font-size:11px;color:#91a0bd}
    .ag-advice{list-style:none;margin:0;padding:0;display:grid;gap:8px}
    .ag-advice li{padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.5;border-left:3px solid #5b6b8c;background:rgba(255,255,255,.04)}
    .ag-advice li.ok{border-color:#55ddb4}.ag-advice li.warn{border-color:#eabf54}
    .ag-advice li.bad{border-color:#ff6b7a}.ag-advice li.info{border-color:#37c8e8}
    .ag-advice b{display:block;margin-bottom:2px;color:#f0f4ff}
    .ag-live{font-size:11px;color:#8be6c8;margin:4px 0 0}
    .building-card.ag-fault{outline:2px solid #ff6b7a;animation:agPulse 1.2s infinite}
    @keyframes agPulse{50%{outline-color:rgba(255,107,122,.3)}}
    #ag-toasts{position:fixed;right:18px;bottom:18px;display:grid;gap:8px;z-index:9999;max-width:340px}
    .ag-toast{padding:11px 14px;border-radius:10px;font-size:12px;color:#fff;background:#26344b;border-left:4px solid #37c8e8;
        box-shadow:0 8px 24px rgba(0,0,0,.35);animation:agIn .25s ease}
    .ag-toast.ok{border-color:#55ddb4}.ag-toast.warn{border-color:#eabf54}.ag-toast.bad{border-color:#ff6b7a}
    @keyframes agIn{from{opacity:0;transform:translateY(8px)}}`;
    document.head.appendChild(style);
}

function toast(message, level = "info") {
    let box = $("ag-toasts");
    if (!box) { box = document.createElement("div"); box.id = "ag-toasts"; box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
    const el = document.createElement("div");
    el.className = `ag-toast ${level}`;
    el.textContent = message;
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => el.remove(), 4500);
}

// ----------------------------------------------------------------------
// 9. BUILDING CARDS + SELECTION
// ----------------------------------------------------------------------
const grid = $("buildingGrid");
const select = $("buildingSelect");

function renderBuildings() {
    if (!grid) return;
    grid.innerHTML = BUILDINGS.map(b => `
        <article class="building-card" data-building="${escapeHTML(b.name)}" tabindex="0" role="button"
            aria-label="Select ${escapeHTML(b.name)}">
            <div class="building-icon">${b.icon}</div>
            <h3>${escapeHTML(b.name)}</h3>
            <p>SIMULATED NOMINAL LOAD</p>
            <b>${b.base} <small>kW</small></b>
            <p class="ag-live" data-live="${escapeHTML(b.name)}">-- kW now</p>
            <p>Digital Twin Node</p>
        </article>`).join("");

    grid.querySelectorAll(".building-card").forEach(card => {
        card.addEventListener("click", () => setSelectedBuilding(card.dataset.building));
        card.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedBuilding(card.dataset.building); }
        });
    });
    updateSelectedBuilding();
}

function updateBuildingCards() {
    if (!grid) return;
    const active = new Set([...activeLocalBuildings(), ...Object.keys(state.faults)]);
    grid.querySelectorAll(".building-card").forEach(card => {
        const name = card.dataset.building;
        const live = card.querySelector(".ag-live");
        if (live) live.textContent = `${safeNumber(state.demands[name]).toFixed(1)} kW now`;
        card.classList.toggle("ag-fault", active.has(name));
    });
}

function setSelectedBuilding(name, notify3D = true) {
    const building = BUILDINGS.find(b => b.name === name);
    if (!building) return;
    state.selected = name;
    if (select) select.value = name;
    updateSelectedBuilding();
    updateTwinDetail(building);
    runSimulation();
    saveSettings();
    if (notify3D) window.dispatchEvent(new CustomEvent("arkagrid:select-building", { detail: { name } }));
}

function updateSelectedBuilding() {
    grid?.querySelectorAll(".building-card").forEach(card =>
        card.classList.toggle("selected", card.dataset.building === state.selected));
}

function updateTwinDetail(building) {
    setHTML("twinDetail", `
        <span class="live-dot"></span><strong>${escapeHTML(building.name)}</strong><span>·</span>
        <span>Nominal model load: ${building.base} kW</span><span>·</span><span>Node active</span>`);
}

select?.addEventListener("change", () => setSelectedBuilding(select.value));
window.addEventListener("arkagrid:building-selected", e => {
    if (e.detail?.name) setSelectedBuilding(e.detail.name, false);
});

// ----------------------------------------------------------------------
// 10. SCENARIO INPUTS + SCENARIO CARDS
// ----------------------------------------------------------------------
function bindSlider(id, labelId, suffix) {
    const el = $(id);
    if (!el) return;
    const sync = () => setText(labelId, `${el.value}${suffix}`);
    el.addEventListener("input", () => { sync(); runSimulation(); saveSettings(); });
    sync();
}

function runSimulation() {
    const building = BUILDINGS.find(b => b.name === state.selected);
    if (!building) return;
    const { occupancy, hours, extra } = scenarioInputs();
    const { referenceEnergy, simulatedEnergy, difference } = calculateEnergy(building, occupancy, hours, extra);

    setHTML("scenarioEnergy", `${simulatedEnergy.toFixed(2)} <small>kWh/day</small>`);
    setText("baselineEnergy", `${referenceEnergy.toFixed(2)} kWh/day`);
    setText("currentEnergy", `${simulatedEnergy.toFixed(2)} kWh/day`);
    const diff = $("difference");
    if (diff) {
        diff.textContent = `${difference > 0 ? "+" : ""}${difference.toFixed(2)} kWh/day`;
        diff.style.color = difference >= 0 ? "#5be0b0" : "#ffbd75";
    }
    setText("savingStat", `${difference >= 0 ? "+" : ""}${difference.toFixed(1)} kWh`);

    let msg;
    if (difference > 0.01) msg = `The simulated scenario uses ${difference.toFixed(2)} kWh/day less than the reference scenario. This is a modelled reduction, not guaranteed savings.`;
    else if (difference < -0.01) msg = `The simulated scenario uses ${Math.abs(difference).toFixed(2)} kWh/day more than the reference.`;
    else msg = "The simulated scenario is approximately equal to the reference.";
    setText("simulationMessage", msg);

    refreshDemands();
    renderAll();
}

// ----------------------------------------------------------------------
// 11. POWER PANEL + COMMAND CENTER (built dynamically)
// ----------------------------------------------------------------------
function createPanels() {
    const host = $("simulation") || document.querySelector("main") || document.body;

    if (!$("powerBalancePanel")) {
        const metrics = [
            ["Total demand", "demand", "kW"], ["Solar generation", "solar", "kW"],
            ["Grid import", "grid", "kW"], ["Battery power (+discharge)", "battery", "kW"],
            ["Distribution losses", "losses", "kW"], ["Battery charge", "soc", "%"]
        ];
        const panel = document.createElement("section");
        panel.id = "powerBalancePanel";
        panel.className = "ag-panel";
        panel.innerHTML = `
            <div class="ag-head">
                <div><div class="ag-eyebrow">ARKAGRID / POWER SYSTEM</div>
                <h2 class="ag-title">Campus Power Balance</h2>
                <p class="ag-sub">Synthetic live simulation · Illustrative readings</p></div>
                <span id="powerStatus" style="font-size:12px;color:#55ddb4">● SYSTEM ACTIVE</span>
            </div>
            <div class="ag-grid">${metrics.map(([l, id, u]) => `
                <div class="ag-kpi"><label>${l}</label><b id="metric-${id}">--</b><small>${u}</small></div>`).join("")}</div>
            <div class="ag-box">
                <h4>Energy source contribution</h4>
                <div class="ag-bar">
                    <div id="solarBar" style="width:0%;background:#eabf54"></div>
                    <div id="batteryBar" style="width:0%;background:#a58aff"></div>
                    <div id="gridBar" style="width:0%;background:#37c8e8"></div>
                </div>
                <div class="ag-row" style="font-size:11px;color:#a5b1c9;margin-top:10px">
                    <span>🟡 Solar</span><span>🟣 Battery discharge</span><span>🔵 Grid</span></div>
            </div>
            <div class="ag-box"><h4>Energy accounting</h4>
                <div id="powerEquation" style="color:#a9b8d1;font-size:12px;line-height:1.8">Calculating power balance...</div></div>
            <div class="ag-grid">
                <div class="ag-kpi"><label>Simulated energy consumed</label><b id="energyConsumed">0 kWh</b></div>
                <div class="ag-kpi"><label>Estimated grid cost</label><b id="energyCost">₹0</b></div>
                <div class="ag-kpi"><label>Simulated clock</label><b id="simulationClock">09:00</b></div>
            </div>
            <div class="ag-row">
                <button id="powerPause" type="button" class="ag-btn">Pause simulation</button>
                <button id="powerReset" type="button" class="ag-btn ghost">Reset energy model</button>
            </div>`;
        host.appendChild(panel);

        $("powerPause").addEventListener("click", togglePause);
        $("powerReset").addEventListener("click", resetPowerSystem);
    }

    if (!$("commandCenter")) {
        const cc = document.createElement("section");
        cc.id = "commandCenter";
        cc.className = "ag-panel";
        cc.innerHTML = `
            <div class="ag-head">
                <div><div class="ag-eyebrow">ARKAGRID / COMMAND CENTER</div>
                <h2 class="ag-title">Adaptive Control &amp; Sustainability</h2>
                <p class="ag-sub" id="modeHint"></p></div>
                <span id="tariffBadge" style="font-size:12px;color:#eabf54"></span>
            </div>
            <div class="ag-row">
                <span class="ag-seg">Dispatch:
                    ${Object.entries(MODES).map(([k, m]) => `<button type="button" class="ag-btn ghost" data-mode="${k}">${m.label}</button>`).join("")}
                </span>
                <span class="ag-seg">Speed:
                    ${[1, 2, 4, 8].map(s => `<button type="button" class="ag-btn ghost" data-speed="${s}">${s}×</button>`).join("")}
                </span>
            </div>
            <div class="ag-row">
                <button type="button" id="agFault" class="ag-btn danger">⚡ Inject fault (F)</button>
                <button type="button" id="agClear" class="ag-btn ghost">Clear faults</button>
                <button type="button" id="agCsv" class="ag-btn ghost">Export CSV</button>
                <button type="button" id="agReport" class="ag-btn ghost">Export report</button>
            </div>
            <div class="ag-grid">
                <div class="ag-kpi"><label>Sustainability score</label><b id="kpi-score">--</b><small>/ 100</small></div>
                <div class="ag-kpi"><label>Solar self-sufficiency</label><b id="kpi-self">--</b><small>% of demand</small></div>
                <div class="ag-kpi"><label>CO₂ avoided</label><b id="kpi-co2">--</b><small>kg</small></div>
                <div class="ag-kpi"><label>Savings vs grid-only</label><b id="kpi-savings">--</b><small>INR</small></div>
                <div class="ag-kpi"><label>Sky clearness</label><b id="kpi-cloud">--</b><small>%</small></div>
                <div class="ag-kpi"><label>Tariff now</label><b id="kpi-tariff">--</b><small>× base rate</small></div>
            </div>
            <div class="ag-box"><h4>AI advisor</h4><ul id="advisorList" class="ag-advice"></ul></div>`;
        host.appendChild(cc);

        cc.querySelectorAll("[data-mode]").forEach(btn => btn.addEventListener("click", () => setMode(btn.dataset.mode)));
        cc.querySelectorAll("[data-speed]").forEach(btn => btn.addEventListener("click", () => setSpeed(Number(btn.dataset.speed))));
        $("agFault").addEventListener("click", () => injectFault());
        $("agClear").addEventListener("click", clearFaults);
        $("agCsv").addEventListener("click", exportCSV);
        $("agReport").addEventListener("click", exportReport);
    }
}

function togglePause() {
    state.running = !state.running;
    setText("powerPause", state.running ? "Pause simulation" : "Resume simulation");
    toast(state.running ? "Simulation resumed" : "Simulation paused", "info");
    renderAll();
}

function setMode(mode) {
    if (!MODES[mode]) return;
    state.mode = mode;
    refreshDemands();
    toast(`Dispatch mode: ${MODES[mode].label}`, "info");
    saveSettings();
    renderAll();
}

function setSpeed(speed) {
    state.speed = [1, 2, 4, 8].includes(speed) ? speed : 1;
    saveSettings();
    renderAll();
}

function updatePowerPanel() {
    const b = state.balance;
    if (!b) return;
    setText("metric-demand", b.totalDemand.toFixed(1));
    setText("metric-solar", b.solarPower.toFixed(1));
    setText("metric-grid", b.gridPower.toFixed(1));
    setText("metric-battery", `${b.batteryPower >= 0 ? "+" : ""}${b.batteryPower.toFixed(1)}`);
    setText("metric-losses", b.losses.toFixed(1));
    setText("metric-soc", `${state.battery.soc.toFixed(1)}%`);

    const solarUsed = b.solarUsed, batteryUsed = b.discharge, gridUsed = b.gridPower;
    const denom = Math.max(solarUsed + batteryUsed + gridUsed, 0.001);
    const w = (id, v) => { const el = $(id); if (el) el.style.width = `${v / denom * 100}%`; };
    w("solarBar", solarUsed); w("batteryBar", batteryUsed); w("gridBar", gridUsed);

    setText("powerEquation",
        `Solar used ${solarUsed.toFixed(1)} kW + Battery discharge ${batteryUsed.toFixed(1)} kW + ` +
        `Grid import ${gridUsed.toFixed(1)} kW = ${(solarUsed + batteryUsed + gridUsed).toFixed(1)} kW supplied ` +
        `(${b.requiredPower.toFixed(1)} kW required incl. losses). Solar surplus: ${b.solarSurplus.toFixed(1)} kW ` +
        `(${b.curtailed.toFixed(1)} kW curtailed). Battery charging: ${b.charge.toFixed(1)} kW.`);

    setText("energyConsumed", `${state.totals.energy.toFixed(2)} kWh`);
    setText("energyCost", `₹${state.totals.cost.toFixed(2)}`);
    setText("simulationClock", `${formatClock()}${state.clock.day > 1 ? ` · Day ${state.clock.day}` : ""}`);
    setText("powerStatus", state.running ? "● SYSTEM ACTIVE" : "● SIMULATION PAUSED");
}

function updateCommandCenter() {
    if (!$("commandCenter") || !state.balance) return;
    const { score, selfSuff } = sustainabilityScore();
    const t = state.totals;
    setText("kpi-score", score);
    setText("kpi-self", (selfSuff * 100).toFixed(0));
    setText("kpi-co2", t.co2Avoided.toFixed(1));
    setText("kpi-savings", `₹${(t.baselineCost - t.cost).toFixed(0)}`);
    setText("kpi-cloud", (state.cloud * 100).toFixed(0));
    setText("kpi-tariff", state.balance.tariff.toFixed(1));
    setText("modeHint", MODES[state.mode].hint);
    setText("tariffBadge", state.balance.tariff > 1 ? "● PEAK TARIFF" : state.balance.tariff < 1 ? "● OFF-PEAK TARIFF" : "● STANDARD TARIFF");

    document.querySelectorAll("#commandCenter [data-mode]").forEach(b => b.classList.toggle("active", b.dataset.mode === state.mode));
    document.querySelectorAll("#commandCenter [data-speed]").forEach(b => b.classList.toggle("active", Number(b.dataset.speed) === state.speed));

    const list = $("advisorList");
    if (list) list.innerHTML = buildAdvice().map(a =>
        `<li class="${a.level}"><b>${escapeHTML(a.title)}</b>${escapeHTML(a.text)}</li>`).join("");
}

// ----------------------------------------------------------------------
// 12. 3D DIGITAL TWIN EVENTS
// ----------------------------------------------------------------------
function update3DScene() {
    const b = state.balance;
    if (!b) return;
    window.dispatchEvent(new CustomEvent("arkagrid:energy-update", {
        detail: {
            demands: demandList().map(i => ({ name: i.name, demand: i.demand })),
            solarPower: b.solarPower, gridPower: b.gridPower, batteryPower: b.batteryPower,
            batterySOC: state.battery.soc, totalDemand: b.totalDemand, clock: formatClock(),
            running: state.running, mode: state.mode, tariff: b.tariff,
            co2Avoided: state.totals.co2Avoided, cloud: state.cloud
        }
    }));
}

// ----------------------------------------------------------------------
// 13. CHART (24h profile, solar overlay, live cursor, hover tooltip)
// ----------------------------------------------------------------------
function dailyProfile() {
    const demand = [], solar = [];
    for (let h = 0; h < 24; h++) {
        demand.push(Object.values(computeDemands(h, { noise: false, faults: false })).reduce((s, v) => s + v, 0));
        solar.push(solarAt(h));
    }
    return { demand, solar };
}

function smoothPath(ctx, pts) {
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
        ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
            p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
    }
}

function drawChart() {
    const canvas = $("energyChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { demand, solar } = dailyProfile();
    const max = Math.max(20, Math.ceil(Math.max(...demand, ...solar) / 20) * 20);
    const L = 37, R = 12, T = 22, B = 27;
    const cw = width - L - R, ch = height - T - B, xs = cw / 23;
    const X = i => L + i * xs, Y = v => T + ch - (v / max) * ch;

    ctx.font = "10px 'DM Sans', sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
        const y = T + (ch / 4) * i;
        ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(width - R, y);
        ctx.strokeStyle = "rgba(160,160,200,0.12)"; ctx.stroke();
        ctx.fillStyle = "#858aa9"; ctx.fillText((max - (max / 4) * i).toFixed(0), L - 8, y);
    }

    // peak-tariff shading
    ctx.fillStyle = "rgba(234,191,84,0.06)";
    const pk = CONFIG.tariff.peak;
    ctx.fillRect(X(pk.from), T, X(Math.min(pk.to, 23)) - X(pk.from), ch);

    const dPts = demand.map((v, i) => ({ x: X(i), y: Y(v) }));
    const sPts = solar.map((v, i) => ({ x: X(i), y: Y(v) }));

    const grad = ctx.createLinearGradient(0, T, 0, height);
    grad.addColorStop(0, "rgba(152,101,255,0.35)"); grad.addColorStop(1, "rgba(152,101,255,0)");
    ctx.beginPath(); ctx.moveTo(dPts[0].x, T + ch); ctx.lineTo(dPts[0].x, dPts[0].y);
    smoothPath(ctx, dPts); ctx.lineTo(dPts.at(-1).x, T + ch); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.lineJoin = ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(dPts[0].x, dPts[0].y); smoothPath(ctx, dPts);
    ctx.strokeStyle = "#a57aff"; ctx.lineWidth = 2.5; ctx.stroke();

    ctx.beginPath(); ctx.moveTo(sPts[0].x, sPts[0].y); smoothPath(ctx, sPts);
    ctx.strokeStyle = "#eabf54"; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);

    // axis labels
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#858aa9";
    [0, 4, 8, 12, 16, 20, 23].forEach(h => ctx.fillText(`${pad2(h)}:00`, X(h), height - 18));

    // peak marker
    const peakIdx = demand.indexOf(Math.max(...demand));
    ctx.beginPath(); ctx.arc(dPts[peakIdx].x, dPts[peakIdx].y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#55dff2"; ctx.fill();

    // live "now" cursor
    const nowX = L + (hourFloat() / 23) * cw;
    ctx.beginPath(); ctx.moveTo(nowX, T); ctx.lineTo(nowX, T + ch);
    ctx.strokeStyle = "rgba(85,221,180,.8)"; ctx.lineWidth = 1.2; ctx.stroke();

    // legend
    ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.font = "10px 'DM Sans', sans-serif";
    ctx.fillStyle = "#a57aff"; ctx.fillText("● Demand", L, 8);
    ctx.fillStyle = "#eabf54"; ctx.fillText("● Solar", L + 62, 8);
    ctx.fillStyle = "#55ddb4"; ctx.fillText("│ Now", L + 114, 8);

    // hover tooltip
    if (state.hoverIdx >= 0) {
        const i = state.hoverIdx;
        const lines = [`${pad2(i)}:00`, `Demand ${demand[i].toFixed(1)} kW`, `Solar ${solar[i].toFixed(1)} kW`, `Tariff ${tariffMultiplier(i)}×`];
        const bw = 104, bh = 58;
        const bx = clamp(X(i) + 10, L, width - bw - 4), by = T + 4;
        ctx.fillStyle = "rgba(20,28,50,.95)"; ctx.strokeStyle = "rgba(160,160,200,.4)"; ctx.lineWidth = 1;
        ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh);
        ctx.fillStyle = "#e6ecff"; ctx.textAlign = "left"; ctx.textBaseline = "top";
        lines.forEach((ln, k) => ctx.fillText(ln, bx + 8, by + 6 + k * 13));
        ctx.beginPath(); ctx.arc(X(i), Y(demand[i]), 4, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
    }

    setHTML("totalEnergy", `${demand.reduce((s, v) => s + v, 0).toFixed(0)} <small>kWh/day</small>`);
}

function bindChartHover() {
    const canvas = $("energyChart");
    if (!canvas) return;
    canvas.addEventListener("mousemove", e => {
        const rect = canvas.getBoundingClientRect();
        const cw = rect.width - 37 - 12;
        state.hoverIdx = clamp(Math.round(((e.clientX - rect.left - 37) / cw) * 23), 0, 23);
        drawChart();
    });
    canvas.addEventListener("mouseleave", () => { state.hoverIdx = -1; drawChart(); });
}

// ----------------------------------------------------------------------
// 14. NETWORKING (timeouts, queue, backoff)
// ----------------------------------------------------------------------
async function fetchJSON(url, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.timing.timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `API returned ${res.status}`);
        }
        return await res.json();
    } finally { clearTimeout(timer); }
}

function setLink(online) {
    if (state.server.online === online) return;
    const wasKnown = state.server.linkKnown;
    state.server.online = online;
    state.server.linkKnown = true;
    if (wasKnown || !online) toast(online ? "Hybrid AI engine online" : "Hybrid engine offline — edge detector active", online ? "ok" : "warn");
}

async function sendLiveReadings() {
    if (!state.running) return;
    const timestamp = new Date().toISOString();
    state.queue.push(demandList().map(item => ({
        building: item.name,
        energy_kwh: Number(item.demand.toFixed(3)), // one-hour-equivalent synthetic reading
        timestamp,
        sim_hour: Number(hourFloat().toFixed(2)),   // lets the engine compare against the right hour
        nominal_kw: item.base,
        source: "campus_simulation"
    })));
    if (state.queue.length > CONFIG.timing.maxQueue) state.queue.shift();
    await flushQueue();
}

async function flushQueue() {
    if (state.flushing || Date.now() < state.retryAt) return;
    state.flushing = true;
    let failures = state.failures || 0;
    try {
        while (state.queue.length) {
            const result = await fetchJSON(CONFIG.api.readings, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ readings: state.queue[0] })
            });
            state.queue.shift();
            failures = 0;
            if (result.new_event_count > 0) console.log("ArkaGrid new live anomaly events:", result.new_events);
        }
        state.failures = 0;
        await loadAnomalyResults();
    } catch (error) {
        state.failures = ++failures;
        state.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** failures);
        console.error("ArkaGrid live reading upload failed:", error);
        setText("anomalyModelStatus", "LIVE ENGINE CONNECTION ISSUE");
        setLink(false);
        renderAnomalies();
    } finally { state.flushing = false; }
}

async function loadAnomalyResults() {
    if (state.polling) return;
    state.polling = true;
    try {
        setText("anomalyModelStatus", "SYNCING HYBRID AI ENGINE...");
        const data = await fetchJSON(`${CONFIG.api.anomalies}?t=${Date.now()}`, { cache: "no-store" });
        state.server = {
            ...state.server,
            events: Array.isArray(data.anomalies) ? data.anomalies : [],
            buildings: Array.isArray(data.buildings) ? data.buildings : [],
            count: safeNumber(data.anomaly_count, 0),
            readings: safeNumber(data.total_readings, 0),
            generatedAt: data.generated_at,
            modelInfo: data.model_info || {}
        };
        setLink(true);
        setText("anomalyModelStatus", "HYBRID AI ENGINE ONLINE");
    } catch (error) {
        console.error("ArkaGrid anomaly API error:", error);
        setLink(false);
        setText("anomalyModelStatus", "HYBRID ENGINE OFFLINE");
        state.server.error = error.message;
    } finally { state.polling = false; }
    renderAnomalies();
}

// ----------------------------------------------------------------------
// 15. ANOMALY RENDERING (server + edge events merged)
// ----------------------------------------------------------------------
const sourceLabel = s => s === "live_simulation" ? "LIVE SIMULATION" : s === "edge_detector" ? "EDGE DETECTOR" : "HISTORICAL DATA";

function renderAnomalies() {
    const srv = state.server;
    const events = [...srv.events, ...state.localEvents]
        .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

    const severityRank = { low: 1, moderate: 2, medium: 2, high: 3, critical: 4 };
    const worst = new Map();
    events.forEach(e => {
        const r = severityRank[String(e.severity || "moderate").toLowerCase()] || 2;
        worst.set(e.building, Math.max(worst.get(e.building) || 0, r));
    });
    const affected = worst.size;
    const highCount = [...worst.values()].filter(r => r >= 3).length;
    const total = srv.count + state.localEvents.length;

    setText("anomalyTotal", total);
    setText("anomalyCount", total);
    setText("anomalyHigh", highCount);
    setText("anomalyBuildings", affected);
    setText("anomalyReadings", srv.readings.toLocaleString("en-IN"));

    const latest = events[0];
    if (latest) {
        setText("feedAnomalyText", `${latest.building}: ${latest.explanation || "Unusual energy consumption detected."}`);
        setText("feedAnomalyTime", `Event: ${formatTimestamp(latest.timestamp)} · Source: ${sourceLabel(latest.source)} · Engine run: ${formatTimestamp(srv.generatedAt)}`);
        setText("anomalyStatusText", `${total} FLAGGED EVENTS`);
    } else {
        setText("feedAnomalyText", "No unusual energy events detected.");
        setText("feedAnomalyTime", `Engine run: ${formatTimestamp(srv.generatedAt)}`);
        setText("anomalyStatusText", "ALL SYSTEMS NORMAL");
    }

    const list = $("anomalyList");
    if (list) {
        if (!events.length) {
            list.innerHTML = srv.online || srv.linkKnown === undefined
                ? `<div class="anomaly-empty">No anomaly events found.</div>`
                : `<div class="anomaly-empty">Cannot connect to the Python hybrid engine. Start it using: py engine_a/anomaly_detection.py --serve</div>`;
        } else {
            const allowed = ["low", "moderate", "medium", "high", "critical"];
            list.innerHTML = events.slice(0, 15).map(e => {
                const sev = String(e.severity || "moderate").toLowerCase();
                const cls = allowed.includes(sev) ? sev : "moderate";
                const dev = safeNumber(e.deviation_pct, 0);
                return `
                <div class="anomaly-event">
                    <div class="anomaly-event-main">
                        <strong>${escapeHTML(e.building || "Unknown Building")}</strong>
                        <p>${escapeHTML(e.explanation || "Unusual energy consumption detected.")}</p>
                    </div>
                    <span class="anomaly-severity ${cls}">${escapeHTML(sev.toUpperCase())}</span>
                    <div class="anomaly-event-meta">
                        <strong>${sourceLabel(e.source)}</strong><br>
                        Event time: ${escapeHTML(formatTimestamp(e.timestamp))}<br>
                        Energy: ${safeNumber(e.energy_kwh, 0).toFixed(2)} kWh<br>
                        Deviation: ${dev > 0 ? "+" : ""}${dev.toFixed(1)}%
                    </div>
                </div>`;
            }).join("");
        }
    }

    const mi = srv.modelInfo;
    setText("anomalyDataNote", srv.online
        ? `Hybrid engine: Isolation Forest + live deviation validation + on-device z-score edge detector. ` +
          `${safeNumber(mi.historical_readings).toLocaleString("en-IN")} historical readings; ` +
          `${safeNumber(mi.live_readings).toLocaleString("en-IN")} live simulation readings; ` +
          `${safeNumber(mi.live_events)} live events. Last engine update: ${formatTimestamp(srv.generatedAt)}. ` +
          `All live readings are synthetic demonstrations.`
        : `Python engine unreachable${srv.error ? ` (${srv.error})` : ""}. Running on-device edge detector only; ` +
          `${state.queue.length} reading batch(es) queued for retry.`);

    // Dispatch to the 3D twin only when the active event set changes.
    const active = new Set(activeLocalBuildings());
    const twinEvents = [
        ...srv.events,
        ...state.localEvents.filter(e => active.has(e.building))
    ].map(e => ({
        building: e.building, status: "anomaly", is_anomaly: true,
        severity: e.severity || "moderate", timestamp: e.timestamp || "",
        deviation_percent: safeNumber(e.deviation_pct, 0),
        explanation: e.explanation || "Unusual energy consumption detected.",
        source: e.source || "historical"
    }));
    const sig = JSON.stringify(twinEvents);
    if (sig !== state.lastSignature) {
        state.lastSignature = sig;
        window.dispatchEvent(new CustomEvent("arkagrid:anomaly-update", { detail: twinEvents }));
    }
}

// ----------------------------------------------------------------------
// 16. EXPORTS
// ----------------------------------------------------------------------
function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCSV() {
    if (!state.history.length) return toast("No data to export yet", "warn");
    const head = "clock,demand_kw,solar_kw,grid_kw,battery_kw,soc_pct,tariff_mult";
    const rows = state.history.map(h =>
        [h.clock, h.demand, h.solar, h.grid, h.battery, h.soc, h.tariff].map(v => typeof v === "number" ? v.toFixed(3) : v).join(","));
    download(`arkagrid-history-${Date.now()}.csv`, [head, ...rows].join("\n"), "text/csv");
    toast("CSV exported", "ok");
}

function exportReport() {
    const { score, selfSuff } = sustainabilityScore();
    const report = {
        generatedAt: new Date().toISOString(),
        note: "Synthetic simulation data — illustrative only.",
        settings: { mode: state.mode, building: state.selected, ...scenarioInputs() },
        totals: state.totals,
        sustainability: { score, selfSufficiency: selfSuff },
        forecast6h: state.forecast && { gridKwh: state.forecast.gridKwh, cost: state.forecast.cost, peakKw: state.forecast.peakKw, peakAt: formatHour(state.forecast.peakAt), minSoc: state.forecast.minSoc },
        advisor: buildAdvice(),
        events: [...state.server.events, ...state.localEvents].slice(0, 50)
    };
    download(`arkagrid-report-${Date.now()}.json`, JSON.stringify(report, null, 2), "application/json");
    toast("Report exported", "ok");
}

// ----------------------------------------------------------------------
// 17. RENDER + KEYBOARD + BOOT
// ----------------------------------------------------------------------
function renderAll() {
    updatePowerPanel();
    updateCommandCenter();
    updateBuildingCards();
    update3DScene();
    drawChart();
    if (state.localEvents.length) renderAnomalies();
}

document.addEventListener("keydown", e => {
    if (e.target.matches?.("input,select,textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= BUILDINGS.length) setSelectedBuilding(BUILDINGS[n - 1].name);
    else if (e.key.toLowerCase() === "f") injectFault();
    else if (e.key.toLowerCase() === "p") togglePause();
    else if (e.key.toLowerCase() === "r") resetPowerSystem();
});

document.addEventListener("visibilitychange", () => { if (!document.hidden) loadAnomalyResults(); });

$("refreshAnomalies")?.addEventListener("click", async () => {
    state.retryAt = 0;
    await loadAnomalyResults();
    await sendLiveReadings();
});

function init() {
    injectStyles();
    const saved = loadSettings();
    const apply = (id, v) => { const el = $(id); if (el && v != null) el.value = v; };
    apply("occupancy", saved.occupancy); apply("operatingHours", saved.hours); apply("extraLoad", saved.extra);
    if (MODES[saved.mode]) state.mode = saved.mode;
    if ([1, 2, 4, 8].includes(saved.speed)) state.speed = saved.speed;
    if (BUILDINGS.some(b => b.name === saved.selected)) state.selected = saved.selected;

    setText("buildingCount", String(BUILDINGS.length).padStart(2, "0"));
    bindSlider("occupancy", "occupancyValue", "%");
    bindSlider("operatingHours", "hoursValue", " hours");
    bindSlider("extraLoad", "loadValue", "%");

    $("simulateBtn")?.addEventListener("click", () => {
        runSimulation();
        const panel = $("resultsPanel");
        panel?.classList.remove("flash"); void panel?.offsetWidth; panel?.classList.add("flash");
        toast("Simulation updated", "ok");
    });
    $("resetBtn")?.addEventListener("click", () => {
        [["occupancy", 70], ["operatingHours", 10], ["extraLoad", 0]].forEach(([id, v]) => {
            const el = $(id);
            if (el) { el.value = v; el.dispatchEvent(new Event("input")); }
        });
        toast("Parameters reset", "info");
    });

    renderBuildings();
    createPanels();
    bindChartHover();
    setSelectedBuilding(state.selected);

    loadAnomalyResults();
    setInterval(() => { if (!document.hidden) loadAnomalyResults(); }, CONFIG.timing.pollMs);
    setInterval(advanceSimulation, CONFIG.timing.tickMs);
    window.addEventListener("resize", drawChart);

    fetchJSON(CONFIG.api.health).catch(() => {}); // warm-up / early link detection
    window.ArkaGrid = { state, CONFIG, injectFault, setMode, setSpeed, exportCSV, exportReport }; // debug handle
}

init();

})();
