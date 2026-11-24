#!/usr/bin/env python3
"""
ARKAGRID | ENGINE A — Hybrid anomaly detection + dashboard server
=================================================================

One process does everything:

  * generates (or loads) a synthetic 90-day hourly dataset for 5 buildings
  * trains an Isolation Forest per building (falls back to a robust z-score
    detector if scikit-learn is not installed)
  * serves the dashboard files (index.html, app.js, ...) AND the JSON API
    the dashboard calls:

        GET  /api/health      engine status
        GET  /api/anomalies   historical + live anomaly events and summaries
        POST /api/readings    live readings from the browser simulation

Usage (run from the project root):

    python engine_a/anomaly_detection.py --serve          # dashboard + API
    python engine_a/anomaly_detection.py --serve --open   # ...and open browser
    python engine_a/anomaly_detection.py                  # terminal report only
    python engine_a/anomaly_detection.py --regenerate     # rebuild the dataset

All data is synthetic and for demonstration only.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import random
import statistics
import sys
import threading
import webbrowser
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

try:
    import numpy as np
    from sklearn.ensemble import IsolationForest

    HAVE_SKLEARN = True
except Exception:  # scikit-learn / numpy missing -> robust z-score fallback
    HAVE_SKLEARN = False

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "campus_energy.csv"

# Same load shape as the browser simulation (app.js) so live data is comparable.
BUILDINGS = {
    "Academic Block": {"base": 25, "night": 0.25, "peak": 11.0, "spread": 3.5},
    "Laboratory":     {"base": 40, "night": 0.35, "peak": 13.0, "spread": 4.0},
    "Library":        {"base": 18, "night": 0.15, "peak": 15.0, "spread": 4.0},
    "Administration": {"base": 15, "night": 0.20, "peak": 11.5, "spread": 3.0},
    "Hostel":         {"base": 30, "night": 0.45, "peak": 21.0, "spread": 4.5},
}

DEFAULT_OCCUPANCY_FACTOR = 0.4 + 0.6 * 0.70  # 0.82, the dashboard default
DEVIATION_THRESHOLD = 0.25       # |deviation| needed to confirm an anomaly
OBVIOUS_DEVIATION = 0.70         # flagged even if the model is borderline
CONTAMINATION = 0.015
MAX_BODY_BYTES = 1_000_000
MAX_READINGS_PER_REQUEST = 50
SEVERITY_RANK = {"low": 1, "moderate": 2, "high": 3, "critical": 4}


# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------
def shape(name: str, hour: float) -> float:
    b = BUILDINGS[name]
    d = abs(hour - b["peak"])
    d = min(d, 24 - d)
    return b["night"] + (1 - b["night"]) * math.exp(-(d * d) / (2 * b["spread"] ** 2))


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_ts(value) -> datetime:
    try:
        text = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)


def severity_for(deviation: float) -> str:
    d = abs(deviation)
    if d > 0.8:
        return "critical"
    if d > 0.5:
        return "high"
    if d > 0.3:
        return "moderate"
    return "low"


def features(ratio: float, hour: float):
    angle = 2 * math.pi * hour / 24
    return [ratio, math.sin(angle), math.cos(angle)]


# ----------------------------------------------------------------------
# synthetic dataset
# ----------------------------------------------------------------------
def generate_history(days: int = 90, seed: int = 42):
    rng = random.Random(seed)
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(days=days)
    rows = []
    t = start
    while t <= end:
        for name, cfg in BUILDINGS.items():
            expected = cfg["base"] * DEFAULT_OCCUPANCY_FACTOR * shape(name, t.hour)
            value = expected * (1 + rng.uniform(-0.03, 0.03))
            if rng.random() < 0.012:  # injected anomaly
                value *= rng.uniform(1.45, 2.5) if rng.random() < 0.85 else rng.uniform(0.2, 0.5)
            rows.append({"timestamp": t, "building": name, "energy_kwh": round(value, 3)})
        t += timedelta(hours=1)
    return rows


def save_csv(rows):
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    with DATA_FILE.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["timestamp", "building", "energy_kwh"])
        for r in rows:
            writer.writerow([iso(r["timestamp"]), r["building"], r["energy_kwh"]])


def load_csv():
    rows = []
    with DATA_FILE.open(newline="", encoding="utf-8") as fh:
        for rec in csv.DictReader(fh):
            if rec["building"] in BUILDINGS:
                rows.append({
                    "timestamp": parse_ts(rec["timestamp"]),
                    "building": rec["building"],
                    "energy_kwh": float(rec["energy_kwh"]),
                })
    return rows


def load_or_create(regenerate: bool = False, days: int = 90):
    if regenerate or not DATA_FILE.exists():
        rows = generate_history(days)
        save_csv(rows)
        print(f"  dataset: generated {len(rows):,} synthetic readings -> {DATA_FILE.relative_to(ROOT)}")
        return rows
    rows = load_csv()
    print(f"  dataset: loaded {len(rows):,} readings from {DATA_FILE.relative_to(ROOT)}")
    return rows


# ----------------------------------------------------------------------
# engine
# ----------------------------------------------------------------------
class Engine:
    def __init__(self, rows):
        self.lock = threading.Lock()
        self.historical_readings = len(rows)
        self.profile: dict[str, list[float]] = {}   # median ratio per hour
        self.models = {}
        self.mad: dict[str, float] = {}              # fallback detector scale
        self.hist_events: list[dict] = []
        self.live = deque(maxlen=5000)
        self.live_events = deque(maxlen=200)
        self.live_total = 0
        self.live_event_total = 0
        self.active: dict[str, int] = {}              # building -> severity rank while flagged
        self.model_name = "isolation_forest" if HAVE_SKLEARN else "robust_zscore_fallback"
        self._train(rows)

    # -- training ------------------------------------------------------
    def _train(self, rows):
        for name, cfg in BUILDINGS.items():
            subset = [r for r in rows if r["building"] == name]
            ratios = [r["energy_kwh"] / cfg["base"] for r in subset]
            hours = [r["timestamp"].hour for r in subset]

            by_hour = {h: [] for h in range(24)}
            for ratio, hour in zip(ratios, hours):
                by_hour[hour].append(ratio)
            self.profile[name] = [
                statistics.median(by_hour[h]) if by_hour[h] else DEFAULT_OCCUPANCY_FACTOR
                for h in range(24)
            ]

            residuals = [abs(r - self.profile[name][h]) for r, h in zip(ratios, hours)]
            self.mad[name] = max(statistics.median(residuals), 1e-3)

            if HAVE_SKLEARN:
                x = np.array([features(r, h) for r, h in zip(ratios, hours)])
                model = IsolationForest(
                    n_estimators=150, contamination=CONTAMINATION, random_state=42
                )
                model.fit(x)
                self.models[name] = model

            # Score the whole history in ONE batched call (per-row predict is ~100x slower).
            if HAVE_SKLEARN:
                flags = (model.predict(x) == -1).tolist()
            else:
                flags = [self._flag(name, r, h) for r, h in zip(ratios, hours)]

            for r, row, flagged in zip(ratios, subset, flags):
                hour = row["timestamp"].hour
                if flagged:
                    expected = self.profile[name][hour] * cfg["base"]
                    dev = (row["energy_kwh"] - expected) / max(expected, 0.1)
                    if abs(dev) >= DEVIATION_THRESHOLD:
                        self.hist_events.append(
                            self._event(name, row["timestamp"], row["energy_kwh"], expected, dev, "historical")
                        )
        self.hist_events.sort(key=lambda e: e["timestamp"], reverse=True)

    # -- detection -----------------------------------------------------
    def expected_ratio(self, name: str, hour: float) -> float:
        prof = self.profile[name]
        h0 = int(math.floor(hour)) % 24
        h1 = (h0 + 1) % 24
        frac = hour - math.floor(hour)
        return prof[h0] * (1 - frac) + prof[h1] * frac

    def _flag(self, name: str, ratio: float, hour: float) -> bool:
        if HAVE_SKLEARN:
            return int(self.models[name].predict(np.array([features(ratio, hour)]))[0]) == -1
        resid = abs(ratio - self.expected_ratio(name, hour))
        return resid / (1.4826 * self.mad[name]) > 4.0

    def _event(self, name, ts, energy, expected, dev, source):
        detector = "Isolation Forest" if HAVE_SKLEARN else "robust z-score"
        direction = "above" if dev > 0 else "below"
        return {
            "building": name,
            "timestamp": iso(ts),
            "energy_kwh": round(float(energy), 3),
            "expected_kwh": round(float(expected), 3),
            "deviation_pct": round(dev * 100, 1),
            "severity": severity_for(dev),
            "source": source,
            "explanation": (
                f"Consumption is {abs(dev) * 100:.0f}% {direction} the learned profile "
                f"({expected:.1f} kWh expected, {energy:.1f} kWh observed). "
                f"Flagged by {detector} and validated against the hourly baseline."
            ),
        }

    # -- live ingestion ------------------------------------------------
    def ingest(self, readings):
        new_events = []
        with self.lock:
            for item in readings:
                name = item["building"]
                cfg = BUILDINGS[name]
                energy = item["energy_kwh"]
                ts = item["timestamp"]
                hour = item.get("sim_hour")
                if hour is None:
                    hour = ts.hour + ts.minute / 60
                nominal = item.get("nominal_kw") or cfg["base"]

                ratio = energy / nominal
                expected = self.expected_ratio(name, hour) * nominal
                dev = (energy - expected) / max(expected, 0.1)

                flagged = (self._flag(name, ratio, hour) and abs(dev) >= DEVIATION_THRESHOLD) \
                    or abs(dev) >= OBVIOUS_DEVIATION
                self.live.append(energy)
                self.live_total += 1

                if flagged:
                    rank = SEVERITY_RANK[severity_for(dev)]
                    # emit on first detection and whenever severity escalates
                    if rank > self.active.get(name, 0):
                        event = self._event(name, ts, energy, expected, dev, "live_simulation")
                        self.live_events.appendleft(event)
                        self.live_event_total += 1
                        new_events.append(event)
                    self.active[name] = max(rank, self.active.get(name, 0))
                else:
                    self.active.pop(name, None)
        return new_events

    # -- API payloads --------------------------------------------------
    def snapshot(self):
        with self.lock:
            events = list(self.live_events) + self.hist_events[:100]
            summary = []
            for name in BUILDINGS:
                mine = [e for e in events if e["building"] == name]
                worst = max((SEVERITY_RANK[e["severity"]] for e in mine), default=0)
                label = next((k for k, v in SEVERITY_RANK.items() if v == worst), None)
                summary.append({"building": name, "anomaly_count": len(mine), "highest_severity": label})
            return {
                "generated_at": iso(datetime.now(timezone.utc)),
                "anomaly_count": len(self.hist_events) + self.live_event_total,
                "total_readings": self.historical_readings + self.live_total,
                "anomalies": events,
                "buildings": summary,
                "model_info": {
                    "model": self.model_name,
                    "historical_readings": self.historical_readings,
                    "live_readings": self.live_total,
                    "live_events": self.live_event_total,
                    "contamination": CONTAMINATION,
                },
            }


def validate_readings(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("readings"), list):
        raise ValueError("Body must be {\"readings\": [...]}")
    items = payload["readings"][:MAX_READINGS_PER_REQUEST]
    clean = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        name = raw.get("building")
        if name not in BUILDINGS:
            continue
        try:
            energy = float(raw.get("energy_kwh"))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(energy) or not 0 <= energy <= 5000:
            continue
        item = {"building": name, "energy_kwh": energy, "timestamp": parse_ts(raw.get("timestamp"))}
        for key in ("sim_hour", "nominal_kw"):
            try:
                v = float(raw.get(key))
                if math.isfinite(v):
                    item[key] = v
            except (TypeError, ValueError):
                pass
        if "sim_hour" in item:
            item["sim_hour"] = item["sim_hour"] % 24
        clean.append(item)
    if not clean:
        raise ValueError("No valid readings in request")
    return clean


# ----------------------------------------------------------------------
# HTTP server (static files + API)
# ----------------------------------------------------------------------
BLOCKED_PREFIXES = ("/engine_a", "/data", "/.", "/run.", "/package", "/requirements", "/README")


def make_handler(engine: Engine):
    class Handler(SimpleHTTPRequestHandler):
        extensions_map = {
            **SimpleHTTPRequestHandler.extensions_map,
            ".js": "text/javascript",
            ".mjs": "text/javascript",
            ".css": "text/css",
            ".json": "application/json",
        }

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT), **kwargs)

        # -- utilities
        def _json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def end_headers(self):
            self.send_header("X-Content-Type-Options", "nosniff")
            if not self.path.startswith("/node_modules"):
                self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def log_message(self, fmt, *args):  # keep the terminal readable
            if self.path.startswith("/api/") and self.command == "GET":
                return
            sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))

        # -- routes
        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/api/health":
                return self._json(200, {
                    "status": "ok",
                    "model": engine.model_name,
                    "time": iso(datetime.now(timezone.utc)),
                })
            if path == "/api/anomalies":
                return self._json(200, engine.snapshot())
            if path.startswith(BLOCKED_PREFIXES):
                return self.send_error(404, "Not found")
            if path == "/":
                self.path = "/index.html"
            return super().do_GET()

        def do_POST(self):
            path = urlparse(self.path).path
            if path != "/api/readings":
                return self._json(404, {"error": "Unknown endpoint"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    return self._json(413, {"error": "Invalid body size"})
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                readings = validate_readings(payload)
            except (ValueError, json.JSONDecodeError) as exc:
                return self._json(400, {"error": str(exc)})
            new_events = engine.ingest(readings)
            if new_events:
                for ev in new_events:
                    print(f"  ⚠  {ev['severity'].upper():8} {ev['building']}: {ev['deviation_pct']:+.0f}% vs expected")
            return self._json(200, {
                "accepted": len(readings),
                "new_event_count": len(new_events),
                "new_events": new_events,
            })

    return Handler


def print_report(engine: Engine):
    snap = engine.snapshot()
    print()
    print("  ARKAGRID — HISTORICAL ANOMALY REPORT (synthetic data)")
    print("  " + "-" * 62)
    print(f"  model: {engine.model_name} | readings: {engine.historical_readings:,} | "
          f"flagged: {len(engine.hist_events)}")
    print()
    print(f"  {'Building':<16}{'Events':>8}   Highest severity")
    for b in snap["buildings"]:
        print(f"  {b['building']:<16}{b['anomaly_count']:>8}   {b['highest_severity'] or '-'}")
    print()
    print("  Latest events:")
    for e in engine.hist_events[:8]:
        print(f"  {e['timestamp']}  {e['building']:<15} {e['severity']:<9}{e['deviation_pct']:+7.1f}%")
    print()


def main():
    parser = argparse.ArgumentParser(description="ArkaGrid hybrid anomaly engine + dashboard server")
    parser.add_argument("--serve", action="store_true", help="start the dashboard + API server")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="port (default 8000)")
    parser.add_argument("--open", action="store_true", help="open the dashboard in your browser")
    parser.add_argument("--regenerate", action="store_true", help="rebuild the synthetic dataset")
    parser.add_argument("--days", type=int, default=90, help="days of history to generate")
    args = parser.parse_args()

    print()
    print("  ARKAGRID | ENGINE A")
    print(f"  detector: {'Isolation Forest (scikit-learn)' if HAVE_SKLEARN else 'robust z-score fallback (pip install scikit-learn for ML)'}")
    engine = Engine(load_or_create(args.regenerate, args.days))
    print(f"  trained on {engine.historical_readings:,} readings; {len(engine.hist_events)} historical anomalies")

    if not args.serve:
        print_report(engine)
        print("  Tip: add --serve to start the dashboard.\n")
        return

    if not (ROOT / "index.html").exists():
        print("  ! index.html not found in project root:", ROOT)
    if not (ROOT / "node_modules" / "three").exists():
        print("  ! node_modules/three missing — the 3D twin needs it. Run: npm install")

    try:
        server = ThreadingHTTPServer((args.host, args.port), make_handler(engine))
    except OSError as exc:
        print(f"\n  Cannot start on {args.host}:{args.port} ({exc}). Try --port 8001\n")
        sys.exit(1)

    url = f"http://{args.host}:{args.port}/"
    print(f"\n  Dashboard + API running at  {url}")
    print("  Press Ctrl+C to stop.\n")
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Shutting down. Goodbye.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
