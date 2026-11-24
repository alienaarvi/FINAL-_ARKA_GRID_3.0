// ======================================================================
// ARKAGRID v3 | LIVING CAMPUS DIGITAL TWIN
// Realistic procedural campus: sky dome + time of day, textured facades
// with lit windows, vegetation, roads, people and cars, weather, bloom,
// and glowing cable networks that visibly carry energy between the
// solar farm, grid, battery, hub and every building.
// Drop-in: same DOM ids and window events as before.
// ======================================================================

const container = document.getElementById("campus3d");
const loading = document.getElementById("loading3d");
const loadingText = document.getElementById("loading3dText");
const detail = document.getElementById("twinDetail");

let THREE = null;
let OrbitControls = null;

function showFailure(title, hint = "") {
    console.error("ArkaGrid 3D:", title, hint);
    if (!loading) return;
    loading.style.display = "flex";
    loading.classList.remove("hidden");
    const orbit = loading.querySelector(".loading-orbit");
    if (orbit) orbit.style.display = "none";
    const text = `${title} ${hint}`.trim();
    if (loadingText) loadingText.textContent = text;
    else loading.textContent = text;
}

if (!container) {
    console.error("ArkaGrid: campus3d container not found.");
} else {
    try {
        THREE = await import("three");
        ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
    } catch (error) {
        console.error(error);
        showFailure("3D LIBRARY NOT FOUND.", "Run `npm install` in the project folder (or check your internet connection), then refresh.");
    }
    if (THREE) {
        try {
            initCampus();
        } catch (error) {
            console.error(error);
            showFailure("3D VIEW COULD NOT START.", `(${error?.message || error})`);
        }
    }
}

function initCampus() {

    // ------------------------------------------------------------------
    // 01. CONFIG, HELPERS, STATE
    // ------------------------------------------------------------------
    const BUILDINGS = [
        { name: "Academic Block", base: 25, x: -18, z: -10, w: 12, d: 10, floors: 4, color: 0xb9c7d4, type: "academic" },
        { name: "Laboratory", base: 40, x: 17, z: -10, w: 13, d: 11, floors: 3, color: 0xc9d6df, type: "laboratory" },
        { name: "Library", base: 18, x: -19, z: 13, w: 11, d: 10, floors: 3, color: 0xd6c9b8, type: "library" },
        { name: "Administration", base: 15, x: 0, z: 17, w: 12, d: 9, floors: 3, color: 0xcdd2d6, type: "administration" },
        { name: "Hostel", base: 30, x: 19, z: 13, w: 12, d: 10, floors: 5, color: 0xd2b9a6, type: "hostel" }
    ];

    const VIEWS = [
        { name: "Isometric", pos: [54, 40, 68], target: [0, 3, -4] },
        { name: "Top-down", pos: [0, 108, 0.1], target: [0, 0, -4] },
        { name: "Cinematic", pos: [72, 9, 46], target: [0, 6, -4] },
        { name: "Energy hub", pos: [24, 15, -12], target: [0, 4, -33] }
    ];

    const SEVERITY_RANK = { low: 1, moderate: 2, medium: 2, high: 3, critical: 4 };
    const IS_MOBILE = window.matchMedia("(max-width: 700px)").matches;
    const Y_AXIS = new THREE.Vector3(0, 1, 0);

    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const toCss = hex => "#" + new THREE.Color(hex).getHexString();
    const num = (v, fb) => Number.isFinite(Number(v)) ? Number(v) : fb;

    function seededRandom(seed) {
        let s = seed * 9301 + 49297;
        return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    }

    const state = {
        demands: BUILDINGS.map(b => b.base),
        solar: 0, grid: 0, battery: 0,
        totalDemand: BUILDINGS.reduce((s, b) => s + b.base, 0),
        batterySOC: 60, running: true, hasLiveData: false,
        hour: 9, envHour: 9, cloud: 0.85, tariff: 1, mode: "balanced", co2: 0,
        clockText: "09:00",
        anomalyByBuilding: new Map(),
        selected: -1, hover: -1, viewIndex: 0,
        labelsVisible: true, tour: false, visible: true,
        lens: 0, lensTarget: 0, fx: true
    };

    // ------------------------------------------------------------------
    // 02. UI STYLES (HUD layout lives in style.css)
    // ------------------------------------------------------------------
    if (!document.getElementById("ag3d-styles")) {
        const style = document.createElement("style");
        style.id = "ag3d-styles";
        style.textContent = `
            #campus3d{position:relative;overflow:hidden}
            #campus3d canvas{display:block;width:100%;height:100%}
            .ag3d-controls{position:absolute;z-index:6;right:14px;bottom:14px;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
            .ag3d-buttons{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
            .ag3d-btn{padding:8px 12px;border-radius:9px;border:1px solid rgba(74,195,255,.3);background:rgba(5,13,29,.82);
                color:#dcecff;font:inherit;font-size:11px;cursor:pointer;backdrop-filter:blur(10px)}
            .ag3d-btn:hover{background:rgba(30,60,100,.85)}
            .ag3d-btn.on{background:#5b43c9;border-color:#9a82ff}
            .ag3d-hint{font-size:9px;letter-spacing:.6px;color:#7f93b0;text-align:right}
            .ag3d-tip{position:absolute;z-index:7;pointer-events:none;display:none;padding:9px 11px;border-radius:9px;
                background:rgba(5,13,29,.94);border:1px solid rgba(74,195,255,.35);color:#eaf3ff;font-size:11px;line-height:1.5;max-width:230px}
            .ag3d-tip b{display:block;font-size:12px;margin-bottom:2px}
            .ag3d-legend{position:absolute;z-index:6;left:14px;bottom:14px;display:flex;flex-wrap:wrap;gap:6px 14px;padding:8px 12px;
                border-radius:10px;background:rgba(5,13,29,.72);border:1px solid rgba(74,195,255,.2);backdrop-filter:blur(8px);
                font-size:10px;letter-spacing:.5px;color:#cfdcf2;pointer-events:none}
            .ag3d-legend i{display:inline-block;width:18px;height:4px;border-radius:3px;margin-right:6px;vertical-align:middle;box-shadow:0 0 8px currentColor}
            @media(max-width:600px){.ag3d-hint{display:none}.ag3d-legend{display:none}}`;
        document.head.appendChild(style);
    }

    // ------------------------------------------------------------------
    // 03. RENDERER, SCENE, CAMERA, CONTROLS
    // ------------------------------------------------------------------
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch (error) {
        throw new Error("WebGL is not available in this browser or GPU. Try Chrome/Edge/Firefox with hardware acceleration on.");
    }

    let pixelRatio = Math.min(window.devicePixelRatio || 1, IS_MOBILE ? 1.5 : 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.domElement.style.touchAction = "none";
    container.appendChild(renderer.domElement);

    const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1220);
    scene.fog = new THREE.FogExp2(0x0a1220, 0.0042);

    const camera = new THREE.PerspectiveCamera(
        42, Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1), 0.5, 1400);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.minDistance = 16;
    controls.maxDistance = 130;
    controls.maxPolarAngle = Math.PI / 2.04;

    // ------------------------------------------------------------------
    // 04. PROCEDURAL TEXTURES
    // ------------------------------------------------------------------
    function makeCanvas(w, h) {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        return c;
    }
    function texFrom(canvas, { repeat = null, srgb = true } = {}) {
        const t = new THREE.CanvasTexture(canvas);
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = maxAniso;
        if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
        return t;
    }

    const grassTexture = (() => {
        const c = makeCanvas(512, 512), x = c.getContext("2d"), r = seededRandom(5);
        x.fillStyle = "#2f5b3a"; x.fillRect(0, 0, 512, 512);
        for (let i = 0; i < 40; i++) {
            const gx = r() * 512, gy = r() * 512, rad = 40 + r() * 90;
            const g = x.createRadialGradient(gx, gy, 0, gx, gy, rad);
            g.addColorStop(0, r() > 0.5 ? "rgba(70,120,66,.28)" : "rgba(30,70,45,.30)");
            g.addColorStop(1, "rgba(0,0,0,0)");
            x.fillStyle = g; x.fillRect(0, 0, 512, 512);
        }
        for (let i = 0; i < 9000; i++) {
            x.fillStyle = `rgba(${25 + r() * 35 | 0},${90 + r() * 70 | 0},${35 + r() * 30 | 0},${0.25 + r() * 0.35})`;
            x.fillRect(r() * 512, r() * 512, 1 + r() * 1.5, 2 + r() * 5);
        }
        return texFrom(c, { repeat: [26, 24] });
    })();

    const farGrassTexture = (() => {
        const t = grassTexture.clone();
        t.needsUpdate = true;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(120, 120);
        return t;
    })();

    function asphaltTexture(repeatX, repeatY) {
        const c = makeCanvas(256, 256), x = c.getContext("2d"), r = seededRandom(9);
        x.fillStyle = "#2a3039"; x.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 5000; i++) {
            const v = 30 + r() * 50 | 0;
            x.fillStyle = `rgba(${v},${v + 4},${v + 10},${0.25 + r() * 0.4})`;
            x.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2);
        }
        return texFrom(c, { repeat: [repeatX, repeatY] });
    }

    const paverTexture = (() => {
        const c = makeCanvas(256, 256), x = c.getContext("2d"), r = seededRandom(13);
        x.fillStyle = "#6f7c88"; x.fillRect(0, 0, 256, 256);
        for (let gx = 0; gx < 256; gx += 32) {
            for (let gy = 0; gy < 256; gy += 32) {
                const v = 110 + r() * 28 | 0;
                x.fillStyle = `rgb(${v},${v + 8},${v + 16})`;
                x.fillRect(gx + 1, gy + 1, 30, 30);
            }
        }
        return texFrom(c, { repeat: [4, 4] });
    })();

    const glowTexture = (() => {
        const c = makeCanvas(128, 128), x = c.getContext("2d");
        const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
        g.addColorStop(0, "rgba(255,255,255,1)");
        g.addColorStop(0.25, "rgba(255,255,255,.55)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        x.fillStyle = g; x.fillRect(0, 0, 128, 128);
        return texFrom(c);
    })();

    const cloudTexture = (() => {
        const c = makeCanvas(256, 128), x = c.getContext("2d"), r = seededRandom(21);
        for (let i = 0; i < 14; i++) {
            const cx = 50 + r() * 156, cy = 52 + r() * 30, rad = 22 + r() * 30;
            const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
            g.addColorStop(0, "rgba(255,255,255,.55)");
            g.addColorStop(1, "rgba(255,255,255,0)");
            x.fillStyle = g; x.fillRect(0, 0, 256, 128);
        }
        return texFrom(c);
    })();

    // Comet-style dash used by every energy flow (head bright, tail fading)
    const dashTexture = (() => {
        const c = makeCanvas(256, 16), x = c.getContext("2d");
        const g = x.createLinearGradient(0, 0, 256, 0);
        g.addColorStop(0, "rgba(255,255,255,0)");
        g.addColorStop(0.55, "rgba(255,255,255,.14)");
        g.addColorStop(0.9, "rgba(255,255,255,1)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        x.fillStyle = g; x.fillRect(0, 0, 256, 16);
        return texFrom(c, { srgb: false });
    })();

    // Facade: concrete/panel wall + glazed windows (diffuse) and lit windows (emissive)
    function facadeTextures(cols, floors, baseHex, seed) {
        const cw = 96, ch = 96, w = cols * cw, h = floors * ch;
        const mapCanvas = makeCanvas(w, h), emCanvas = makeCanvas(w, h);
        const m = mapCanvas.getContext("2d"), e = emCanvas.getContext("2d"), r = seededRandom(seed);
        const wall = "#" + new THREE.Color(baseHex).getHexString();

        m.fillStyle = wall; m.fillRect(0, 0, w, h);
        for (let i = 0; i < 2600; i++) {
            m.fillStyle = `rgba(${r() > 0.5 ? 255 : 0},${r() > 0.5 ? 255 : 0},${r() > 0.5 ? 255 : 0},0.035)`;
            m.fillRect(r() * w, r() * h, 2 + r() * 8, 1 + r() * 3);
        }
        e.fillStyle = "#000"; e.fillRect(0, 0, w, h);

        const warm = ["#ffd9a0", "#ffe7bd", "#fff1d6", "#ffc880", "#d8ecff"];
        for (let f = 0; f < floors; f++) {
            const ground = f === floors - 1;
            m.fillStyle = "rgba(20,28,38,.35)"; m.fillRect(0, f * ch, w, 4);
            for (let c = 0; c < cols; c++) {
                const x0 = c * cw + (ground ? 8 : 12), y0 = f * ch + (ground ? 10 : 16);
                const ww = cw - (ground ? 16 : 24), hh = ch - (ground ? 20 : 34);

                const g = m.createLinearGradient(0, y0, 0, y0 + hh);
                const dark = r() < 0.18;
                g.addColorStop(0, dark ? "#456078" : "#9cc9ec");
                g.addColorStop(0.55, dark ? "#25384b" : "#4a7ba6");
                g.addColorStop(1, "#1f3447");
                m.fillStyle = g; m.fillRect(x0, y0, ww, hh);
                m.fillStyle = "rgba(255,255,255,.10)";
                m.beginPath(); m.moveTo(x0 + ww * 0.15, y0); m.lineTo(x0 + ww * 0.5, y0); m.lineTo(x0 + ww * 0.1, y0 + hh); m.lineTo(x0 - 2, y0 + hh); m.closePath(); m.fill();
                m.strokeStyle = "#1b2733"; m.lineWidth = 3; m.strokeRect(x0, y0, ww, hh);
                m.lineWidth = 2; m.beginPath(); m.moveTo(x0 + ww / 2, y0); m.lineTo(x0 + ww / 2, y0 + hh); m.stroke();
                m.fillStyle = "rgba(235,240,245,.55)"; m.fillRect(x0 - 3, y0 + hh, ww + 6, 4);

                const lit = r() < (ground ? 0.85 : 0.5);
                if (lit) {
                    const col = warm[Math.floor(r() * warm.length)];
                    const eg = e.createLinearGradient(0, y0, 0, y0 + hh);
                    eg.addColorStop(0, col); eg.addColorStop(1, "rgba(255,200,130,.55)");
                    e.fillStyle = eg;
                    const half = r() < 0.25;
                    e.fillRect(x0 + 2, y0 + 2, half ? ww / 2 - 3 : ww - 4, hh - 4);
                }
            }
        }
        return { map: texFrom(mapCanvas), emissive: texFrom(emCanvas) };
    }

    // ------------------------------------------------------------------
    // 05. SKY DOME, SUN, MOON, STARS, ENVIRONMENT MAP
    // ------------------------------------------------------------------
    const skyUniforms = {
        topColor: { value: new THREE.Color(0x02050d) },
        horizonColor: { value: new THREE.Color(0x0a1428) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        sunColor: { value: new THREE.Color(1, 0.85, 0.6) },
        nightMix: { value: 1 }
    };
    const skyMaterial = new THREE.ShaderMaterial({
        uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false, fog: false,
        vertexShader: `
            varying vec3 vDir;
            void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
            uniform vec3 topColor; uniform vec3 horizonColor; uniform vec3 sunDir; uniform vec3 sunColor; uniform float nightMix;
            varying vec3 vDir;
            void main(){
                vec3 d = normalize(vDir);
                float h = clamp(d.y, 0.0, 1.0);
                vec3 col = mix(horizonColor, topColor, pow(h, 0.55));
                float s = max(dot(d, normalize(sunDir)), 0.0);
                col += sunColor * (pow(s, 1200.0) * 4.0 + pow(s, 24.0) * 0.28 * (1.0 - nightMix));
                if (d.y < 0.0) col = mix(horizonColor, horizonColor * 0.55, clamp(-d.y * 4.0, 0.0, 1.0));
                gl_FragColor = vec4(col, 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(520, 32, 20), skyMaterial);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    scene.add(sky);

    const stars = (() => {
        const n = 600, pos = new Float32Array(n * 3), r = seededRandom(3);
        for (let i = 0; i < n; i++) {
            const theta = r() * Math.PI * 2, phi = Math.acos(0.12 + r() * 0.88), rad = 480;
            pos[i * 3] = rad * Math.sin(phi) * Math.cos(theta);
            pos[i * 3 + 1] = rad * Math.cos(phi);
            pos[i * 3 + 2] = rad * Math.sin(phi) * Math.sin(theta);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        const pts = new THREE.Points(g, new THREE.PointsMaterial({
            color: 0xdce8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
        pts.frustumCulled = false;
        scene.add(pts);
        return pts;
    })();

    const moon = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 16),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0xdfe8ff).multiplyScalar(1.4), fog: false }));
    moon.frustumCulled = false;
    scene.add(moon);
    const moonGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture, color: 0x9fb8ff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    moonGlow.scale.set(90, 90, 1);
    scene.add(moonGlow);

    // One-off environment map so glass and metal reflect a sky
    try {
        const envScene = new THREE.Scene();
        const envMaterial = skyMaterial.clone();
        envMaterial.uniforms.topColor.value.set(0x4a86c4);
        envMaterial.uniforms.horizonColor.value.set(0xc7dcef);
        envMaterial.uniforms.sunDir.value.set(0.35, 0.8, 0.45);
        envMaterial.uniforms.nightMix.value = 0;
        envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 20), envMaterial));
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(envScene, 0.04).texture;
        pmrem.dispose();
    } catch (error) {
        console.warn("ArkaGrid 3D: environment map skipped", error);
    }

    // ------------------------------------------------------------------
    // 06. LIGHTING
    // ------------------------------------------------------------------
    const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x1d2a22, 0.8);
    scene.add(hemi);

    const sunlight = new THREE.DirectionalLight(0xfff1dc, 3);
    sunlight.castShadow = true;
    const shadowSize = IS_MOBILE ? 1024 : 2048;
    sunlight.shadow.mapSize.set(shadowSize, shadowSize);
    Object.assign(sunlight.shadow.camera, { left: -62, right: 62, top: 62, bottom: -62, near: 10, far: 280 });
    sunlight.shadow.bias = -0.0004;
    sunlight.shadow.normalBias = 0.06;
    scene.add(sunlight);
    scene.add(sunlight.target);

    const moonlight = new THREE.DirectionalLight(0x8fa8ff, 0);
    scene.add(moonlight);

    // ------------------------------------------------------------------
    // 07. SHARED GEOMETRY / MATERIALS
    // ------------------------------------------------------------------
    const geoCache = new Map();
    const boxGeo = (w, h, d) => {
        const key = `${w}|${h}|${d}`;
        if (!geoCache.has(key)) geoCache.set(key, new THREE.BoxGeometry(w, h, d));
        return geoCache.get(key);
    };

    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x9aa6b0, roughness: 0.85, metalness: 0.05 });
    const darkConcreteMat = new THREE.MeshStandardMaterial({ color: 0x4d5864, roughness: 0.9 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x74808c, metalness: 0.75, roughness: 0.38 });
    const darkMetalMat = new THREE.MeshStandardMaterial({ color: 0x2b3642, metalness: 0.7, roughness: 0.4 });
    const glassMat = new THREE.MeshPhysicalMaterial({
        color: 0x8fc6ee, metalness: 0.1, roughness: 0.06, transparent: true, opacity: 0.55,
        clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.3 });

    function addBox(parent, w, h, d, material, x, y, z, { cast = true, receive = true } = {}) {
        const m = new THREE.Mesh(boxGeo(w, h, d), material);
        m.position.set(x, y, z);
        m.castShadow = cast; m.receiveShadow = receive;
        parent.add(m);
        return m;
    }

    // ------------------------------------------------------------------
    // 08. GROUND, ROADS, PLAZA, POND, HILLS
    // ------------------------------------------------------------------
    const farGround = new THREE.Mesh(new THREE.PlaneGeometry(900, 900),
        new THREE.MeshStandardMaterial({ map: farGrassTexture, color: 0x8aa88f, roughness: 1 }));
    farGround.rotation.x = -Math.PI / 2;
    farGround.position.y = -0.05;
    farGround.receiveShadow = true;
    scene.add(farGround);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(140, 128),
        new THREE.MeshStandardMaterial({ map: grassTexture, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    function roadPlane(cx, cz, w, len, alongZ, y) {
        const tex = asphaltTexture(alongZ ? w / 7 : len / 7, alongZ ? len / 7 : w / 7);
        const mat = new THREE.MeshStandardMaterial({
            map: tex, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(alongZ ? w : len, alongZ ? len : w), mat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(cx, y, cz);
        m.receiveShadow = true;
        scene.add(m);
        return m;
    }
    roadPlane(0, 0, 5, 92, true, 0.06);          // main N-S
    roadPlane(-35, 0, 4, 76, true, 0.08);        // west ring
    roadPlane(35, 0, 4, 76, true, 0.08);         // east ring
    roadPlane(0, -1, 83, 4, false, 0.1);         // main E-W

    // lane markings (instanced)
    const markMat = new THREE.MeshBasicMaterial({ color: 0xe9e4c8, transparent: true, opacity: 0.8 });
    const marks = [];
    for (let z = -43; z < 44; z += 4) if (Math.abs(z + 1) > 3.5) marks.push([2.2, z, 0.14, 1.8, true], [-2.2, z, 0.14, 1.8, true]);
    for (let x = -40; x < 41; x += 4) if (Math.abs(x) > 4) marks.push([x, -2.8, 0.16, 1.8, false], [x, 0.8, 0.16, 1.8, false]);
    const markMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.02, 1), markMat, marks.length);
    {
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
        marks.forEach(([x, z, y, len, alongZ], i) => {
            s.set(alongZ ? 0.14 : len, 1, alongZ ? len : 0.14);
            p.set(x, y, z);
            m.compose(p, q, s);
            markMesh.setMatrixAt(i, m);
        });
    }
    scene.add(markMesh);

    for (let i = -3; i <= 3; i++) {                       // crosswalk at the main junction
        const stripe = new THREE.Mesh(boxGeo(0.5, 0.02, 2.6), markMat);
        stripe.position.set(i * 0.7, 0.17, 3.2);
        scene.add(stripe);
    }

    const pavementMat = new THREE.MeshStandardMaterial({ color: 0x8a96a0, roughness: 0.9 });
    [[-3.1, 0, 1.2, 90], [3.1, 0, 1.2, 90], [0, -4.1, 82, 1.2], [0, 2.1, 82, 1.2]].forEach(([x, z, w, len]) => {
        addBox(scene, w, 0.18, len, pavementMat, x, 0.1, z, { cast: false });
    });

    const plaza = new THREE.Mesh(new THREE.CircleGeometry(8.5, 56),
        new THREE.MeshStandardMaterial({ map: paverTexture, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(0, 0.12, 8);
    plaza.receiveShadow = true;
    scene.add(plaza);
    const plazaRim = new THREE.Mesh(new THREE.TorusGeometry(8.5, 0.16, 8, 64), concreteMat);
    plazaRim.rotation.x = Math.PI / 2;
    plazaRim.position.set(0, 0.16, 8);
    scene.add(plazaRim);

    function walkway(x, z, w, d) { addBox(scene, w, 0.1, d, pavementMat, x, 0.09, z, { cast: false }); }
    walkway(-18, 0, 2.4, 19); walkway(18, 0, 2.4, 19); walkway(-9, 9, 18, 2); walkway(9, 9, 18, 2);

    const pond = new THREE.Mesh(new THREE.CircleGeometry(5.5, 48),
        new THREE.MeshPhysicalMaterial({ color: 0x0f3d57, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.92, envMapIntensity: 1.6,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(-27, 0.09, 26);
    scene.add(pond);

    {   // distant hills for depth
        const r = seededRandom(31);
        const hillMat = new THREE.MeshStandardMaterial({ color: 0x24402f, roughness: 1 });
        for (let i = 0; i < 46; i++) {
            const a = (i / 46) * Math.PI * 2 + r() * 0.1, rad = 190 + r() * 70;
            const hill = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), hillMat);
            hill.scale.set(34 + r() * 40, 8 + r() * 20, 30 + r() * 30);
            hill.position.set(Math.cos(a) * rad, -2, Math.sin(a) * rad);
            scene.add(hill);
        }
    }

    // ------------------------------------------------------------------
    // 09. VEGETATION, LAMPS, BENCHES
    // ------------------------------------------------------------------
    const noGo = [];     // [x0, x1, z0, z1]
    BUILDINGS.forEach(b => noGo.push([b.x - b.w / 2 - 3.5, b.x + b.w / 2 + 3.5, b.z - b.d / 2 - 3, b.z + b.d / 2 + 5]));
    noGo.push(
        [-4.5, 4.5, -46, 46], [-42, 42, -5, 3.5], [-37.5, -32.5, -38, 38], [32.5, 37.5, -38, 38],
        [-39, -19, -32, -18], [-10, 10, -43, -28], [10, 25, -43, -28], [-4, 4, -56, -43],
        [-21, -15, -10, 10], [15, 21, -10, 10], [-9, 9, -1, 17], [-34, -20, 19, 33]);
    const blocked = (x, z) => noGo.some(([x0, x1, z0, z1]) => x > x0 && x < x1 && z > z0 && z < z1);

    {
        const r = seededRandom(77);
        const roundSpots = [], pineSpots = [], bushSpots = [];
        let guard = 0;
        while ((roundSpots.length + pineSpots.length) < 120 && guard++ < 4000) {
            const x = (r() - 0.5) * 112, z = (r() - 0.5) * 104;
            if (blocked(x, z)) continue;
            (r() < 0.62 ? roundSpots : pineSpots).push([x, z, 0.8 + r() * 0.7, r()]);
        }
        guard = 0;
        while (bushSpots.length < 70 && guard++ < 3000) {
            const x = (r() - 0.5) * 100, z = (r() - 0.5) * 96;
            if (!blocked(x, z)) bushSpots.push([x, z, 0.5 + r() * 0.5, r()]);
        }

        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a33, roughness: 1 });
        const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });

        const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.22, 1, 7), trunkMat, roundSpots.length + pineSpots.length);
        const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), leafMat, roundSpots.length);
        const pines1 = new THREE.InstancedMesh(new THREE.ConeGeometry(1.25, 2.6, 9), leafMat, pineSpots.length);
        const pines2 = new THREE.InstancedMesh(new THREE.ConeGeometry(0.95, 2.2, 9), leafMat, pineSpots.length);
        const bushes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), leafMat, bushSpots.length);

        let ti = 0;
        roundSpots.forEach(([x, z, sc, v], i) => {
            s.set(sc, sc * 2.0, sc); p.set(x, sc, z); m.compose(p, q, s); trunks.setMatrixAt(ti++, m);
            s.set(sc * 1.5, sc * 1.55, sc * 1.5); p.set(x, sc * 2.7, z); m.compose(p, q, s); crowns.setMatrixAt(i, m);
            col.setHSL(0.27 + v * 0.07, 0.42, 0.2 + v * 0.1); crowns.setColorAt(i, col);
        });
        pineSpots.forEach(([x, z, sc, v], i) => {
            s.set(sc, sc * 1.4, sc); p.set(x, sc * 0.7, z); m.compose(p, q, s); trunks.setMatrixAt(ti++, m);
            s.set(sc, sc, sc); p.set(x, sc * 2.3, z); m.compose(p, q, s); pines1.setMatrixAt(i, m);
            s.set(sc, sc, sc); p.set(x, sc * 3.7, z); m.compose(p, q, s); pines2.setMatrixAt(i, m);
            col.setHSL(0.34 + v * 0.04, 0.45, 0.14 + v * 0.06); pines1.setColorAt(i, col); pines2.setColorAt(i, col);
        });
        bushSpots.forEach(([x, z, sc, v], i) => {
            s.set(sc * 1.2, sc * 0.8, sc * 1.2); p.set(x, sc * 0.5, z); m.compose(p, q, s); bushes.setMatrixAt(i, m);
            col.setHSL(0.25 + v * 0.1, 0.45, 0.2 + v * 0.1); bushes.setColorAt(i, col);
        });
        [trunks, crowns, pines1, pines2, bushes].forEach(mesh => {
            mesh.castShadow = true; mesh.receiveShadow = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            scene.add(mesh);
        });
    }

    // Street lamps (poles instanced + additive glow points that switch on at night)
    const lampSpots = [];
    for (let z = -42; z <= 42; z += 10) { if (Math.abs(z + 1) > 4) lampSpots.push([-3.9, z], [3.9, z]); }
    for (let x = -40; x <= 40; x += 10) { if (Math.abs(x) > 5) lampSpots.push([x, -4.6], [x, 2.6]); }
    for (let a = 0; a < 8; a++) lampSpots.push([Math.cos(a / 8 * Math.PI * 2) * 9.4, 8 + Math.sin(a / 8 * Math.PI * 2) * 9.4]);

    const lampPoles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.1, 4.2, 6), darkMetalMat, lampSpots.length);
    {
        const m = new THREE.Matrix4();
        lampSpots.forEach(([x, z], i) => { m.makeTranslation(x, 2.1, z); lampPoles.setMatrixAt(i, m); });
    }
    lampPoles.castShadow = true;
    scene.add(lampPoles);

    const lampGlow = (() => {
        const pos = new Float32Array(lampSpots.length * 3);
        lampSpots.forEach(([x, z], i) => { pos[i * 3] = x; pos[i * 3 + 1] = 4.3; pos[i * 3 + 2] = z; });
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        const pts = new THREE.Points(g, new THREE.PointsMaterial({
            map: glowTexture, size: 4.2, sizeAttenuation: true, color: 0xffd9a0, transparent: true, opacity: 0,
            depthWrite: false, blending: THREE.AdditiveBlending }));
        pts.frustumCulled = false;
        scene.add(pts);
        return pts;
    })();
    const lampHeads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x3b4452 }), lampSpots.length);
    {
        const m = new THREE.Matrix4();
        lampSpots.forEach(([x, z], i) => { m.makeTranslation(x, 4.3, z); lampHeads.setMatrixAt(i, m); });
    }
    scene.add(lampHeads);

    {   // benches around the plaza
        const benchMat = new THREE.MeshStandardMaterial({ color: 0x7a5a40, roughness: 0.8 });
        const benches = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 0.14, 0.5), benchMat, 10);
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
        for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2 + 0.15;
            p.set(Math.cos(a) * 6.6, 0.55, 8 + Math.sin(a) * 6.6);
            q.setFromAxisAngle(Y_AXIS, -a + Math.PI / 2);
            m.compose(p, q, s);
            benches.setMatrixAt(i, m);
        }
        benches.castShadow = true;
        scene.add(benches);
    }

    // ------------------------------------------------------------------
    // 10. LIVE LABELS (name + kW) AND FLOW LABELS
    // ------------------------------------------------------------------
    function createLabel(text, color = "#00ddff") {
        const canvas = makeCanvas(512, 128), ctx = canvas.getContext("2d");
        ctx.fillStyle = "rgba(5,13,27,0.92)"; ctx.fillRect(0, 0, 512, 128);
        ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.strokeRect(3, 3, 506, 122);
        ctx.font = "bold 31px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff"; ctx.fillText(text.toUpperCase(), 256, 64, 470);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false, fog: false }));
        sprite.scale.set(11, 2.75, 1);
        return sprite;
    }

    function createLiveLabel() {
        const canvas = makeCanvas(512, 176);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false }));
        sprite.scale.set(11, 3.78, 1);
        return { sprite, canvas, ctx: canvas.getContext("2d"), texture, key: "" };
    }

    function severityColor(severity) {
        const v = String(severity || "").toLowerCase();
        if (v.includes("critical")) return 0xff4d6d;
        if (v.includes("high")) return 0xff934f;
        if (v.includes("moderate") || v.includes("medium")) return 0xffca68;
        return 0x00dfff;
    }

    function drawLiveLabel(group) {
        const u = group.userData, L = u.label;
        const kw = state.demands[u.index] || 0;
        const anomaly = u.anomaly;
        const key = `${kw.toFixed(1)}|${anomaly ? anomaly.severity : ""}|${u.selected}`;
        if (key === L.key) return;
        L.key = key;

        const accent = anomaly ? toCss(severityColor(anomaly.severity)) : (u.selected ? "#b69aff" : "#00ddff");
        const ratio = clamp(kw / (u.data.base * 1.2), 0, 1);
        const c = L.ctx;
        c.clearRect(0, 0, 512, 176);
        c.fillStyle = "rgba(5,13,27,0.92)"; c.fillRect(0, 0, 512, 176);
        c.strokeStyle = accent; c.lineWidth = 4; c.strokeRect(3, 3, 506, 170);
        c.textAlign = "center"; c.textBaseline = "middle";
        c.font = "bold 30px Arial"; c.fillStyle = "#ffffff";
        c.fillText(u.data.name.toUpperCase(), 256, 42, 470);
        c.font = "bold 40px Arial"; c.fillStyle = accent;
        c.fillText(`${kw.toFixed(1)} kW`, 256, 92);
        c.fillStyle = "#26344b"; c.fillRect(46, 130, 420, 14);
        c.fillStyle = accent; c.fillRect(46, 130, 420 * ratio, 14);
        L.texture.needsUpdate = true;
    }

    function createFlowLabel(color) {
        const canvas = makeCanvas(320, 80);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false }));
        sprite.scale.set(8.5, 2.1, 1);
        return { sprite, canvas, ctx: canvas.getContext("2d"), texture, key: "", color };
    }

    function drawFlowLabel(L, text) {
        if (L.key === text) return;
        L.key = text;
        const c = L.ctx;
        c.clearRect(0, 0, 320, 80);
        c.fillStyle = "rgba(5,13,27,0.85)";
        c.beginPath(); if (c.roundRect) c.roundRect(4, 4, 312, 72, 16); else c.rect(4, 4, 312, 72); c.fill();
        c.strokeStyle = L.color; c.lineWidth = 3;
        c.beginPath(); if (c.roundRect) c.roundRect(4, 4, 312, 72, 16); else c.rect(4, 4, 312, 72); c.stroke();
        c.font = "bold 30px Arial"; c.textAlign = "center"; c.textBaseline = "middle";
        c.fillStyle = L.color; c.fillText(text, 160, 42, 290);
        L.texture.needsUpdate = true;
    }

    // ------------------------------------------------------------------
    // 11. BUILDINGS
    // ------------------------------------------------------------------
    const buildingGroups = [];
    const buildingMeshes = [];

    function createBuilding(data, index) {
        const group = new THREE.Group();
        group.position.set(data.x, 0, data.z);
        scene.add(group);

        const W = data.w, D = data.d, H = data.floors * 3.2;
        const colsW = Math.max(3, Math.round(W / 2.4)), colsD = Math.max(3, Math.round(D / 2.4));
        const fz = facadeTextures(colsW, data.floors, data.color, index * 7 + 1);
        const fx = facadeTextures(colsD, data.floors, data.color, index * 7 + 4);
        const faceMat = f => new THREE.MeshStandardMaterial({
            map: f.map, emissiveMap: f.emissive, emissive: 0xffffff, emissiveIntensity: 0,
            roughness: 0.55, metalness: 0.12, envMapIntensity: 0.9 });
        const matZ = faceMat(fz), matX = faceMat(fx);
        const roofMat = new THREE.MeshStandardMaterial({ color: 0x59636e, roughness: 0.92 });

        const body = new THREE.Mesh(boxGeo(W, H, D), [matX, matX, roofMat, roofMat, matZ, matZ]);
        body.position.y = H / 2 + 0.3;
        body.castShadow = body.receiveShadow = true;
        group.add(body);

        addBox(group, W + 0.6, 0.3, D + 0.6, darkConcreteMat, 0, 0.15, 0);                 // plinth
        addBox(group, W + 0.7, 0.35, D + 0.7, concreteMat, 0, H + 0.48, 0);                // roof slab
        for (const sx of [-1, 1]) addBox(group, 0.25, 0.7, D + 0.7, concreteMat, sx * (W / 2 + 0.22), H + 0.9, 0);
        for (const sz of [-1, 1]) addBox(group, W + 0.7, 0.7, 0.25, concreteMat, 0, H + 0.9, sz * (D / 2 + 0.22));
        for (let i = 0; i < 3; i++) {                                                       // HVAC units
            const unit = addBox(group, 1.6, 0.9, 1.2, metalMat, -W * 0.28 + i * 1.9, H + 1.25, -D * 0.22);
            const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 16), darkMetalMat);
            fan.position.set(0, 0.48, 0); unit.add(fan);
        }

        // entrance canopy + columns + warm entrance light
        addBox(group, W * 0.5, 0.18, 2.6, metalMat, 0, 3.4, D / 2 + 1.3);
        for (const x of [-W * 0.22, W * 0.22]) addBox(group, 0.26, 3.1, 0.26, metalMat, x, 1.85, D / 2 + 2.3);
        const entranceMat = new THREE.MeshBasicMaterial({ color: 0xffe2b0, transparent: true, opacity: 0.0 });
        const entrance = new THREE.Mesh(boxGeo(W * 0.4, 0.06, 1.2), entranceMat);
        entrance.position.set(0, 3.28, D / 2 + 1.6);
        group.add(entrance);

        // antenna + aviation beacon
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 3, 6), darkMetalMat);
        mast.position.set(W * 0.34, H + 2.3, D * 0.28); group.add(mast);
        const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b });
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), beaconMat);
        beacon.position.set(W * 0.34, H + 3.85, D * 0.28); group.add(beacon);

        // type-specific architecture
        if (data.type === "academic") {
            addBox(group, W * 0.3, H + 0.6, 1.4, glassMat, 0, H / 2 + 0.6, D / 2 + 0.7, { cast: false });   // glass atrium bay
            addBox(group, W * 0.3 + 0.3, 0.3, 1.7, metalMat, 0, H + 0.95, D / 2 + 0.7);
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 5, 6), metalMat);
            pole.position.set(-W * 0.38, H + 3.4, D * 0.3); group.add(pole);
            addBox(group, 1.6, 0.9, 0.04, new THREE.MeshStandardMaterial({ color: 0x3b6fd4, side: THREE.DoubleSide }), -W * 0.38 + 0.85, H + 5.2, D * 0.3);
        }
        if (data.type === "laboratory") {
            for (const sx of [-1, 1]) {
                const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.65, 5, 14), metalMat);
                stack.position.set(sx * W * 0.32, H + 3.1, -D * 0.15); stack.castShadow = true; group.add(stack);
                const band = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.4, 14), new THREE.MeshStandardMaterial({ color: 0xc23b3b }));
                band.position.set(sx * W * 0.32, H + 4.6, -D * 0.15); group.add(band);
            }
            addBox(group, W * 0.45, 1.5, D * 0.4, glassMat, 0, H + 1.4, D * 0.05, { cast: false });
        }
        if (data.type === "library") {
            const dome = new THREE.Mesh(new THREE.SphereGeometry(2.7, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2),
                new THREE.MeshStandardMaterial({ color: 0x4f8f86, metalness: 0.65, roughness: 0.35 }));
            dome.position.set(0, H + 0.66, 0); dome.castShadow = true; group.add(dome);
            const drum = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, 0.9, 28), concreteMat);
            drum.position.set(0, H + 0.95, 0); group.add(drum);
            for (let i = 0; i < 4; i++) {
                const col = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 3.2, 12), concreteMat);
                col.position.set(-W * 0.3 + i * (W * 0.6 / 3), 2, D / 2 + 1.9); col.castShadow = true; group.add(col);
            }
        }
        if (data.type === "administration") {
            addBox(group, 2.4, 9, 2.4, concreteMat, -W * 0.36, H + 4.5, -D * 0.2);
            const clock = new THREE.Mesh(new THREE.CircleGeometry(0.85, 28), new THREE.MeshBasicMaterial({ color: 0xf1ead2 }));
            clock.position.set(-W * 0.36, H + 7.6, -D * 0.2 + 1.21); group.add(clock);
            const roof = new THREE.Mesh(new THREE.ConeGeometry(2.1, 2.6, 4), new THREE.MeshStandardMaterial({ color: 0x6d3a2f, roughness: 0.7 }));
            roof.rotation.y = Math.PI / 4; roof.position.set(-W * 0.36, H + 10.3, -D * 0.2); roof.castShadow = true; group.add(roof);
            addBox(group, W * 0.8, 0.5, 3.4, concreteMat, 0, 3.95, D / 2 + 1.7);
        }
        if (data.type === "hostel") {
            for (let f = 1; f < data.floors; f++) {
                addBox(group, W * 0.8, 0.18, 1.2, concreteMat, 0, f * 3.2 + 0.3, D / 2 + 0.6);
                addBox(group, W * 0.8, 0.7, 0.06, glassMat, 0, f * 3.2 + 0.7, D / 2 + 1.18, { cast: false });
            }
            for (let i = 0; i < 6; i++) {                                                  // rooftop PV
                const pv = addBox(group, 1.9, 0.08, 1.2, new THREE.MeshStandardMaterial({ color: 0x15406e, metalness: 0.7, roughness: 0.25 }),
                    -W * 0.3 + i * 1.3, H + 1.1, D * 0.1);
                pv.rotation.x = -0.35;
            }
        }

        // live label, status indicator, anomaly beacon, selection halo, load heat disc
        const label = createLiveLabel();
        label.sprite.position.set(0, H + 5.2, 0);
        group.add(label.sprite);

        const indicator = new THREE.Mesh(new THREE.SphereGeometry(0.45, 20, 20), new THREE.MeshBasicMaterial({ color: 0x00dfff }));
        indicator.position.set(0, H + 3.6, 0); group.add(indicator);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.04, 8, 36), new THREE.MeshBasicMaterial({ color: 0x00dfff }));
        ring.position.copy(indicator.position); ring.rotation.x = Math.PI / 2; group.add(ring);

        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 1.5, 22, 20, 1, true),
            new THREE.MeshBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        beam.position.set(0, H + 11, 0); beam.visible = false; group.add(beam);
        const shock = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 8, 56),
            new THREE.MeshBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 0, depthWrite: false }));
        shock.position.set(0, H + 1.2, 0); shock.rotation.x = Math.PI / 2; shock.visible = false; group.add(shock);

        const halo = new THREE.Mesh(new THREE.RingGeometry(1, 1.06, 72),
            new THREE.MeshBasicMaterial({ color: 0xb69aff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
        halo.rotation.x = -Math.PI / 2; halo.position.y = 0.3;
        halo.scale.setScalar(Math.max(W, D) * 0.78); halo.visible = false; group.add(halo);

        const heat = new THREE.Mesh(new THREE.CircleGeometry(1, 48),
            new THREE.MeshBasicMaterial({ map: glowTexture, color: 0x00dfff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
        heat.rotation.x = -Math.PI / 2; heat.position.y = 0.2;
        heat.scale.setScalar(Math.max(W, D) * 1.15); group.add(heat);

        group.userData = {
            data, index, body, matX, matZ, entranceMat, beaconMat, label, indicator, ring, beam, shock, halo, heat,
            height: H, selected: false, anomaly: null, shockT: 0
        };
        buildingGroups.push(group);
        buildingMeshes.push(body);
    }
    BUILDINGS.forEach(createBuilding);

    // ------------------------------------------------------------------
    // 12. ENERGY HUB, SOLAR FARM, BATTERY, GRID PYLONS
    // ------------------------------------------------------------------
    const hub = new THREE.Group();
    hub.position.set(0, 0, -35);
    scene.add(hub);

    addBox(hub, 13.4, 0.5, 9.4, darkConcreteMat, 0, 0.25, 0);
    for (let i = -1; i <= 1; i++) {                          // transformers
        addBox(hub, 2.6, 2.6, 2.4, new THREE.MeshStandardMaterial({ color: 0x748b9e, metalness: 0.7, roughness: 0.32 }), i * 4, 1.8, 2.4);
        for (let f = -3; f <= 3; f++) addBox(hub, 0.08, 1.9, 0.5, darkMetalMat, i * 4 + f * 0.34, 1.8, 3.8, { cast: false });
        for (let k = -1; k <= 1; k++) {
            const bush = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 1.1, 8), new THREE.MeshStandardMaterial({ color: 0xcfd6dc, roughness: 0.4 }));
            bush.position.set(i * 4 + k * 0.7, 3.65, 2.4); hub.add(bush);
        }
    }
    for (const x of [-5.6, 5.6]) addBox(hub, 0.3, 6.5, 0.3, metalMat, x, 3.4, -3.0);       // gantry
    addBox(hub, 11.6, 0.3, 0.3, metalMat, 0, 6.5, -3.0);
    addBox(hub, 4.2, 2.2, 2.6, metalMat, -4.2, 1.6, -1.2);                                 // switchgear
    addBox(hub, 4.2, 2.2, 2.6, metalMat, 4.2, 1.6, -1.2);

    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.5, 1, 24), darkMetalMat);
    pedestal.position.set(0, 1, -0.6); hub.add(pedestal);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(2.2, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
    dome.position.set(0, 1.5, -0.6); hub.add(dome);
    const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x00dfff).multiplyScalar(2), wireframe: true, transparent: true, opacity: 0.95, toneMapped: false });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 1), coreMat);
    core.position.set(0, 3.2, -0.6); hub.add(core);
    const coreInner = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 16),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0x00dfff).multiplyScalar(2.4), toneMapped: false }));
    coreInner.position.copy(core.position); hub.add(coreInner);
    const coreRings = [0, 1, 2].map(i => {
        const r = new THREE.Mesh(new THREE.TorusGeometry(1.5 + i * 0.28, 0.025, 8, 64),
            new THREE.MeshBasicMaterial({ color: new THREE.Color(0x00dfff).multiplyScalar(1.8), transparent: true, opacity: 0.8, toneMapped: false }));
        r.position.copy(core.position); r.rotation.set(i * 1.0, i * 0.6, 0);
        hub.add(r);
        return r;
    });
    const hubLight = new THREE.PointLight(0x00cfff, 40, 34, 1.6);
    hubLight.position.set(0, 4, -0.6);
    hub.add(hubLight);

    const hubLabel = createLabel("CAMPUS ENERGY HUB");
    hubLabel.position.set(0, 9.5, 0); hubLabel.scale.set(15, 3, 1); hub.add(hubLabel);

    const hubRing = new THREE.Mesh(new THREE.TorusGeometry(7.4, 0.07, 8, 96),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0x00dfff).multiplyScalar(1.6), toneMapped: false }));
    hubRing.rotation.x = Math.PI / 2; hubRing.position.y = 0.35; hub.add(hubRing);

    // Solar farm
    const solarGroup = new THREE.Group();
    solarGroup.position.set(-35, 0, -28);
    scene.add(solarGroup);
    const gravel = new THREE.Mesh(new THREE.PlaneGeometry(17, 11), new THREE.MeshStandardMaterial({ color: 0x6b6f72, roughness: 1 }));
    gravel.rotation.x = -Math.PI / 2; gravel.position.set(5.4, 0.04, 2.9); solarGroup.add(gravel);

    const solarPanelMat = new THREE.MeshStandardMaterial({
        color: 0x16508a, metalness: 0.8, roughness: 0.18, emissive: 0x0a2f5d, emissiveIntensity: 0.4, envMapIntensity: 1.4 });
    const solarPanels = [];
    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 4; col++) {
            const pivot = new THREE.Group();
            pivot.position.set(col * 3.8, 1.35, row * 2.9);
            const panel = new THREE.Mesh(boxGeo(3.4, 0.1, 2.4), solarPanelMat);
            panel.castShadow = true; panel.receiveShadow = true;
            panel.rotation.x = -0.2;
            pivot.add(panel);
            for (let c = 1; c < 4; c++) addBox(pivot, 0.025, 0.12, 2.4, darkMetalMat, -1.7 + c * 0.85, 0.01, 0, { cast: false });
            addBox(pivot, 0.14, 1.3, 0.14, metalMat, 0, -0.7, 0);
            solarGroup.add(pivot);
            solarPanels.push(panel);
        }
    }
    addBox(solarGroup, 1.6, 1.6, 1.0, metalMat, 15.2, 0.8, 2.9);   // inverter cabinet
    const solarLabel = createLabel("SOLAR GENERATION", "#ffc95b");
    solarLabel.position.set(5.5, 6, 3); solarLabel.scale.set(14, 3, 1); solarGroup.add(solarLabel);

    // Battery storage: three containers, LED state-of-charge bar
    const batteryGroup = new THREE.Group();
    batteryGroup.position.set(17, 0, -35);
    scene.add(batteryGroup);
    addBox(batteryGroup, 9.4, 0.5, 8.6, darkConcreteMat, 0, 0.25, 0);
    const containerMat = new THREE.MeshStandardMaterial({ color: 0x4a4a78, metalness: 0.6, roughness: 0.42, emissive: 0x1b1840, emissiveIntensity: 0.4 });
    for (let i = -1; i <= 1; i++) {
        addBox(batteryGroup, 2.6, 2.7, 6.2, containerMat, i * 2.9, 1.85, 0);
        for (let v = 0; v < 4; v++) addBox(batteryGroup, 1.8, 0.06, 0.4, darkMetalMat, i * 2.9, 3.22, -2.2 + v * 1.4, { cast: false });
    }
    const CELL_COUNT = 10;
    const batteryCells = [];
    for (let i = 0; i < CELL_COUNT; i++) {
        const cell = new THREE.Mesh(boxGeo(1.7, 0.18, 0.1),
            new THREE.MeshBasicMaterial({ color: 0x9b72ff, transparent: true, toneMapped: false }));
        cell.position.set(0, 0.95 + i * 0.26, 3.16);
        batteryGroup.add(cell);
        batteryCells.push(cell);
    }
    const batteryLabel = createLabel("BATTERY STORAGE", "#ad8cff");
    batteryLabel.position.set(0, 7.2, 0); batteryLabel.scale.set(14, 3, 1); batteryGroup.add(batteryLabel);

    // Lattice pylons carrying the grid connection
    function makePylon(x, z, height) {
        const pts = [];
        const half = 1.7, topHalf = 0.35;
        const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        legs.forEach(([a, b]) => pts.push(a * half, 0, b * half, a * topHalf, height, b * topHalf));
        const levels = 6;
        for (let l = 0; l < levels; l++) {
            const y0 = (l / levels) * height, y1 = ((l + 1) / levels) * height;
            const h0 = lerp(half, topHalf, l / levels), h1 = lerp(half, topHalf, (l + 1) / levels);
            for (let s = 0; s < 4; s++) {
                const [a0, b0] = legs[s], [a1, b1] = legs[(s + 1) % 4];
                pts.push(a0 * h0, y0, b0 * h0, a1 * h0, y0, b1 * h0);
                pts.push(a0 * h0, y0, b0 * h0, a1 * h1, y1, b1 * h1);
                pts.push(a1 * h0, y0, b1 * h0, a0 * h1, y1, b0 * h1);
            }
        }
        for (const y of [height - 1.2, height - 4.2]) pts.push(-4.4, y, 0, 4.4, y, 0);
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
        const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9fb1c2 }));
        lines.position.set(x, 0, z);
        scene.add(lines);
        return lines;
    }
    makePylon(0, -50, 18);
    makePylon(0, -76, 18);
    for (const dx of [-4.4, 4.4]) {                          // decorative wires between pylons
        const wire = new THREE.QuadraticBezierCurve3(new THREE.Vector3(dx, 16.8, -50), new THREE.Vector3(dx, 11, -63), new THREE.Vector3(dx, 16.8, -76));
        scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(wire.getPoints(30)), new THREE.LineBasicMaterial({ color: 0x7e8fa0 })));
    }

    // ------------------------------------------------------------------
    // 13. ENERGY FLOW NETWORK (glowing cables + comets + packets)
    // ------------------------------------------------------------------
    const flows = [];
    const DASH = 4.2;                 // world length of one comet
    const packetGeo = new THREE.SphereGeometry(0.3, 8, 8);
    const dummy = new THREE.Object3D();
    const tmpV = new THREE.Vector3();

    const FLOW_COLORS = {
        solar: new THREE.Color(0xffc95b), grid: new THREE.Color(0x00cfff),
        battery: new THREE.Color(0xa889ff), load: new THREE.Color(0x35e0b8)
    };
    const PEAK_COLOR = new THREE.Color(0xff9f43), OFFPEAK_COLOR = new THREE.Color(0x55ddb4);

    // Straight runs with rounded corners, sampled densely, then splined.
    function cablePoints(points, radius = 1.8) {
        const P = points.map(p => new THREE.Vector3(p[0], p[1], p[2]));
        const out = [P[0].clone()];
        let cur = P[0];
        const line = (from, to) => {
            const n = Math.max(1, Math.ceil(from.distanceTo(to) / 1.5));
            for (let k = 1; k <= n; k++) out.push(from.clone().lerp(to, k / n));
        };
        for (let i = 1; i < P.length - 1; i++) {
            const a = P[i - 1], b = P[i], c = P[i + 1];
            const r = Math.min(radius, a.distanceTo(b) / 2, b.distanceTo(c) / 2);
            const p1 = b.clone().add(a.clone().sub(b).normalize().multiplyScalar(r));
            const p2 = b.clone().add(c.clone().sub(b).normalize().multiplyScalar(r));
            line(cur, p1);
            for (let k = 1; k <= 10; k++) {
                const t = k / 10, u = 1 - t;
                out.push(new THREE.Vector3(
                    u * u * p1.x + 2 * u * t * b.x + t * t * p2.x,
                    u * u * p1.y + 2 * u * t * b.y + t * t * p2.y,
                    u * u * p1.z + 2 * u * t * b.z + t * t * p2.z));
            }
            cur = p2;
        }
        line(cur, P[P.length - 1]);
        const curve = new THREE.CatmullRomCurve3(out, false, "centripetal");
        curve.arcLengthDivisions = 600;
        return curve;
    }

    function createFlow({ id, curve, kind, maxPower, radius = 0.17, maxPackets = 18, endMarker = false }) {
        const color = FLOW_COLORS[kind];
        const length = curve.getLength();
        const tex = dashTexture.clone();
        tex.needsUpdate = true;
        tex.wrapS = THREE.RepeatWrapping;
        tex.repeat.set(Math.max(1, length / DASH), 1);

        const segs = Math.min(700, Math.max(40, Math.round(length * 3)));
        const mat = new THREE.MeshBasicMaterial({
            map: tex, color: color.clone().multiplyScalar(2.3), transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, radius, 8, false), mat);
        tube.renderOrder = 3;
        scene.add(tube);

        const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, radius * 0.7, 6, false),
            new THREE.MeshStandardMaterial({ color: 0x101a26, metalness: 0.7, roughness: 0.35, emissive: color.clone(), emissiveIntensity: 0.16 }));
        scene.add(cable);

        const packetMat = new THREE.MeshBasicMaterial({
            color: color.clone().multiplyScalar(2.8), transparent: true, opacity: 0.95,
            blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
        const packets = new THREE.InstancedMesh(packetGeo, packetMat, maxPackets);
        packets.frustumCulled = false;
        packets.count = 0;
        scene.add(packets);

        const flow = {
            id, kind, curve, length, tex, mat, packetMat, packets, maxPackets, maxPower,
            progress: Array.from({ length: maxPackets }, (_, i) => i / maxPackets),
            power: 0, opacity: 0, baseColor: color.clone(), marker: null, markerPhase: Math.random()
        };

        if (endMarker) {
            const end = curve.getPointAt(1);
            const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.1, 24),
                new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.8), transparent: true, opacity: 0.7, toneMapped: false }));
            pad.position.set(end.x, 0.22, end.z); scene.add(pad);
            const ripple = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.9, 40),
                new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
            ripple.rotation.x = -Math.PI / 2; ripple.position.set(end.x, 0.26, end.z); scene.add(ripple);
            flow.marker = { pad, ripple };
        }
        flows.push(flow);
        return flow;
    }

    const Y = 0.32;                                      // cable height above the road
    const feederDefs = [
        { lane: -0.64, pts: l => [[l, Y, -30.2], [l, Y, -1 + l], [-18 + l, Y, -1 + l], [-18 + l, Y, -3.75]] },   // Academic
        { lane: -0.32, pts: l => [[l, Y, -30.2], [l, Y, -1 + l], [17 + l, Y, -1 + l], [17 + l, Y, -3.25]] },     // Laboratory
        { lane: 0.0, pts: l => [[l, Y, -30.2], [l, Y, -1 + l], [-18 + l, Y, -1 + l], [-18 + l, Y, 7.6]] },       // Library
        { lane: 0.32, pts: l => [[l, Y, -30.2], [l, Y, 12.4]] },                                                 // Administration
        { lane: 0.64, pts: l => [[l, Y, -30.2], [l, Y, -1 + l], [18 + l, Y, -1 + l], [18 + l, Y, 7.6]] }         // Hostel
    ];
    const feederFlows = feederDefs.map((def, i) => createFlow({
        id: `feeder-${i}`, curve: cablePoints(def.pts(def.lane), 1.8), kind: "load",
        maxPower: BUILDINGS[i].base, radius: 0.15, maxPackets: 26, endMarker: true }));

    const solarFlow = createFlow({
        id: "solar", kind: "solar", maxPower: 25, radius: 0.2, maxPackets: 30,
        curve: cablePoints([[-21.6, Y, -25], [-3, Y, -25], [-3, Y, -30.2]], 2.2) });

    const batteryDischargeFlow = createFlow({
        id: "battery-out", kind: "battery", maxPower: 15, radius: 0.2, maxPackets: 10,
        curve: cablePoints([[12.2, 1.2, -33], [6.8, 1.2, -33]], 1) });
    const batteryChargeFlow = createFlow({
        id: "battery-in", kind: "battery", maxPower: 15, radius: 0.2, maxPackets: 10,
        curve: cablePoints([[6.8, 1.2, -32.4], [12.2, 1.2, -32.4]], 1) });

    const gridFlow = createFlow({
        id: "grid", kind: "grid", maxPower: 60, radius: 0.16, maxPackets: 30,
        curve: (() => {
            const c = new THREE.CatmullRomCurve3([
                new THREE.Vector3(0, 16.5, -50), new THREE.Vector3(0, 12.6, -46.5), new THREE.Vector3(0, 9.4, -43),
                new THREE.Vector3(0, 7.6, -40), new THREE.Vector3(0, 6.6, -38)], false, "centripetal");
            c.arcLengthDivisions = 300;
            return c;
        })()
    });

    const flowLabels = {
        solar: createFlowLabel("#ffc95b"), grid: createFlowLabel("#00cfff"), battery: createFlowLabel("#a889ff")
    };
    flowLabels.solar.sprite.position.set(-12, 5, -25);
    flowLabels.grid.sprite.position.set(0, 14.5, -44);
    flowLabels.battery.sprite.position.set(10, 4.4, -32.5);
    Object.values(flowLabels).forEach(l => scene.add(l.sprite));

    function updateNetworkPower() {
        feederFlows.forEach((f, i) => { f.power = state.demands[i]; });
        solarFlow.power = state.solar;
        gridFlow.power = state.grid;
        batteryDischargeFlow.power = Math.max(0, state.battery);
        batteryChargeFlow.power = Math.max(0, -state.battery);

        const gc = state.tariff > 1 ? PEAK_COLOR : state.tariff < 1 ? OFFPEAK_COLOR : gridFlow.baseColor;
        gridFlow.mat.color.copy(gc).multiplyScalar(2.3);
        gridFlow.packetMat.color.copy(gc).multiplyScalar(2.8);
    }

    const hubMix = new THREE.Color();
    function updateFlows(dt, time) {
        const lensBoost = 1 + state.lens * 0.7;
        flows.forEach(f => {
            const norm = clamp(f.power / f.maxPower, 0, 1);
            const active = f.power > 0.05;
            const targetOpacity = active ? 0.4 + 0.6 * Math.pow(norm, 0.6) : 0;
            f.opacity += (targetOpacity - f.opacity) * Math.min(1, dt * 4);
            f.mat.opacity = clamp(f.opacity * lensBoost, 0, 1);

            const speed = state.running && active ? 3 + 10 * norm : 0;
            f.tex.offset.x = (((f.tex.offset.x - (speed / DASH) * dt) % 1) + 1) % 1;

            const visible = state.running && active ? Math.max(1, Math.ceil(f.maxPackets * Math.pow(norm, 0.8))) : 0;
            f.packets.count = visible;
            for (let i = 0; i < visible; i++) {
                f.progress[i] = (f.progress[i] + (speed / f.length) * dt) % 1;
                f.curve.getPointAt(f.progress[i], tmpV);
                dummy.position.copy(tmpV);
                dummy.scale.setScalar(0.55 + 0.55 * norm + 0.15 * Math.sin(time * 8 + i * 1.7));
                dummy.updateMatrix();
                f.packets.setMatrixAt(i, dummy.matrix);
            }
            if (visible) f.packets.instanceMatrix.needsUpdate = true;

            if (f.marker) {
                const phase = (time * 0.7 + f.markerPhase) % 1;
                f.marker.ripple.visible = active;
                f.marker.ripple.scale.setScalar(1 + phase * 3.2);
                f.marker.ripple.material.opacity = active ? (1 - phase) * 0.8 * norm : 0;
                f.marker.pad.material.opacity = 0.25 + 0.6 * norm;
            }
        });

        drawFlowLabel(flowLabels.solar, `☀ ${state.solar.toFixed(1)} kW`);
        drawFlowLabel(flowLabels.grid, `⚡ GRID ${state.grid.toFixed(1)} kW`);
        const bat = state.battery;
        drawFlowLabel(flowLabels.battery, `${bat > 0.05 ? "▲" : bat < -0.05 ? "▼" : "■"} ${Math.abs(bat).toFixed(1)} kW`);
        Object.values(flowLabels).forEach(l => { l.sprite.visible = state.labelsVisible; });

        // Hub core colour mixes the live energy sources
        const sSolar = state.solar, sGrid = state.grid, sBat = Math.max(0, state.battery);
        const total = sSolar + sGrid + sBat + 0.001;
        hubMix.setRGB(0, 0, 0)
            .add(FLOW_COLORS.solar.clone().multiplyScalar(sSolar / total))
            .add(FLOW_COLORS.grid.clone().multiplyScalar(sGrid / total))
            .add(FLOW_COLORS.battery.clone().multiplyScalar(sBat / total));
        coreMat.color.copy(hubMix).multiplyScalar(2.2);
        coreInner.material.color.copy(hubMix).multiplyScalar(2.6);
        coreRings.forEach(r => r.material.color.copy(hubMix).multiplyScalar(1.8));
    }

    // ------------------------------------------------------------------
    // 14. LIVING CAMPUS: PEOPLE AND CARS
    // ------------------------------------------------------------------
    const AGENT_COUNT = IS_MOBILE ? 22 : 44;
    const loopFrom = pts => new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], 0, p[1])), true);
    const walkLoops = [
        loopFrom(Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return [Math.cos(a) * 7.2, 8 + Math.sin(a) * 7.2]; })),
        loopFrom([[-16.9, -8], [-16.9, 8], [-19.1, 8], [-19.1, -8]]),
        loopFrom([[16.9, -8], [16.9, 8], [19.1, 8], [19.1, -8]]),
        loopFrom([[-30, -4.6], [30, -4.6], [30, 2.6], [-30, 2.6]]),
        loopFrom([[-11, 25], [11, 25], [11, 29], [-11, 29]])
    ];
    const loopLengths = walkLoops.map(c => c.getLength());

    const bodyColors = [0xd96c6c, 0x6c9ad9, 0xd9c36c, 0x7fd99a, 0xb88be0, 0xe8e8e8, 0x3d4a5c, 0xe0905a];
    const agentBodies = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.22, 0.85, 4, 8),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }), AGENT_COUNT);
    const agentHeads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xe3b998, roughness: 0.7 }), AGENT_COUNT);
    agentBodies.castShadow = agentHeads.castShadow = true;
    agentBodies.frustumCulled = agentHeads.frustumCulled = false;
    const agents = (() => {
        const r = seededRandom(101), col = new THREE.Color();
        return Array.from({ length: AGENT_COUNT }, (_, i) => {
            col.setHex(bodyColors[Math.floor(r() * bodyColors.length)]);
            agentBodies.setColorAt(i, col);
            const li = Math.floor(r() * walkLoops.length);
            return { loop: walkLoops[li], length: loopLengths[li], t: r(), speed: 1.0 + r() * 0.8, dir: r() < 0.5 ? 1 : -1, phase: r() * 10 };
        });
    })();
    if (agentBodies.instanceColor) agentBodies.instanceColor.needsUpdate = true;
    scene.add(agentBodies, agentHeads);

    const lanes = [
        { a: [1.3, -44], b: [1.3, 44], yaw: 0 }, { a: [-1.3, 44], b: [-1.3, -44], yaw: Math.PI },
        { a: [-41, -0.2], b: [41, -0.2], yaw: Math.PI / 2 }, { a: [41, -1.8], b: [-41, -1.8], yaw: -Math.PI / 2 }
    ];
    const CAR_COUNT = IS_MOBILE ? 8 : 16;
    const carBodies = new THREE.InstancedMesh(new THREE.BoxGeometry(1.9, 0.65, 4.2),
        new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.3, envMapIntensity: 1.2 }), CAR_COUNT);
    const carCabins = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.55, 2.0),
        new THREE.MeshStandardMaterial({ color: 0x18222d, metalness: 0.5, roughness: 0.15, envMapIntensity: 1.4 }), CAR_COUNT);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xfff1cc, toneMapped: false });
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a, toneMapped: false });
    const carHeads = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.16, 0.1), headMat, CAR_COUNT);
    const carTails = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.14, 0.1), tailMat, CAR_COUNT);
    [carBodies, carCabins].forEach(m => { m.castShadow = true; m.frustumCulled = false; });
    carHeads.frustumCulled = carTails.frustumCulled = false;

    const carLocal = {
        body: new THREE.Matrix4().makeTranslation(0, 0.5, 0),
        cabin: new THREE.Matrix4().makeTranslation(0, 1.1, -0.2),
        head: new THREE.Matrix4().makeTranslation(0, 0.62, 2.12),
        tail: new THREE.Matrix4().makeTranslation(0, 0.62, -2.12)
    };
    const cars = (() => {
        const r = seededRandom(55), col = new THREE.Color();
        const palette = [0xc8cdd4, 0x2b3a55, 0xb83a3a, 0xe9e9e9, 0x1f6f8b, 0xd6a436, 0x3a3f46];
        return Array.from({ length: CAR_COUNT }, (_, i) => {
            col.setHex(palette[Math.floor(r() * palette.length)]);
            carBodies.setColorAt(i, col);
            return { lane: lanes[i % lanes.length], t: r(), speed: 6 + r() * 4 };
        });
    })();
    if (carBodies.instanceColor) carBodies.instanceColor.needsUpdate = true;
    scene.add(carBodies, carCabins, carHeads, carTails);

    const carMatrix = new THREE.Matrix4(), partMatrix = new THREE.Matrix4();
    const tangent = new THREE.Vector3();

    function updateAgents(dt, time, day) {
        const running = state.running;
        const peopleVisible = Math.round(AGENT_COUNT * (0.28 + 0.72 * day));
        agentBodies.count = agentHeads.count = peopleVisible;
        for (let i = 0; i < peopleVisible; i++) {
            const a = agents[i];
            if (running) a.t = (((a.t + (a.speed * dt / a.length) * a.dir) % 1) + 1) % 1;
            a.loop.getPointAt(a.t, tmpV);
            a.loop.getTangentAt(a.t, tangent);
            const bob = Math.abs(Math.sin(time * 5 + a.phase)) * 0.06;
            dummy.position.set(tmpV.x, 0.82 + bob, tmpV.z);
            dummy.rotation.set(0, Math.atan2(tangent.x * a.dir, tangent.z * a.dir), 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            agentBodies.setMatrixAt(i, dummy.matrix);
            dummy.position.y += 0.78;
            dummy.updateMatrix();
            agentHeads.setMatrixAt(i, dummy.matrix);
        }
        agentBodies.instanceMatrix.needsUpdate = true;
        agentHeads.instanceMatrix.needsUpdate = true;

        const carsVisible = Math.round(CAR_COUNT * (0.35 + 0.65 * day));
        carBodies.count = carCabins.count = carHeads.count = carTails.count = carsVisible;
        for (let i = 0; i < carsVisible; i++) {
            const c = cars[i];
            if (running) c.t = (c.t + (c.speed * dt) / 88) % 1;
            const x = lerp(c.lane.a[0], c.lane.b[0], c.t), z = lerp(c.lane.a[1], c.lane.b[1], c.t);
            dummy.position.set(x, 0.12, z);
            dummy.rotation.set(0, c.lane.yaw, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            carMatrix.copy(dummy.matrix);
            carBodies.setMatrixAt(i, partMatrix.multiplyMatrices(carMatrix, carLocal.body));
            carCabins.setMatrixAt(i, partMatrix.multiplyMatrices(carMatrix, carLocal.cabin));
            carHeads.setMatrixAt(i, partMatrix.multiplyMatrices(carMatrix, carLocal.head));
            carTails.setMatrixAt(i, partMatrix.multiplyMatrices(carMatrix, carLocal.tail));
        }
        [carBodies, carCabins, carHeads, carTails].forEach(m => { m.instanceMatrix.needsUpdate = true; });
    }

    // ------------------------------------------------------------------
    // 15. WEATHER: CLOUDS + RAIN
    // ------------------------------------------------------------------
    const cloudSprites = (() => {
        const r = seededRandom(17);
        return Array.from({ length: 10 }, () => {
            const mat = new THREE.SpriteMaterial({ map: cloudTexture, transparent: true, opacity: 0.5, depthWrite: false, fog: true });
            const s = new THREE.Sprite(mat);
            const w = 55 + r() * 60;
            s.scale.set(w, w * 0.42, 1);
            s.position.set(-150 + r() * 300, 70 + r() * 35, -140 + r() * 260);
            s.userData.speed = 1.0 + r() * 1.8;
            scene.add(s);
            return s;
        });
    })();

    const RAIN_COUNT = IS_MOBILE ? 600 : 1600;
    const rain = (() => {
        const pos = new Float32Array(RAIN_COUNT * 3), r = seededRandom(41);
        for (let i = 0; i < RAIN_COUNT; i++) {
            pos[i * 3] = (r() - 0.5) * 120; pos[i * 3 + 1] = r() * 55; pos[i * 3 + 2] = (r() - 0.5) * 120;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        const pts = new THREE.Points(g, new THREE.PointsMaterial({
            color: 0xaecdf5, size: 0.28, transparent: true, opacity: 0, depthWrite: false }));
        pts.frustumCulled = false;
        scene.add(pts);
        return pts;
    })();

    function updateWeather(dt, day) {
        const cover = clamp((1 - state.cloud) / 0.55, 0, 1);
        cloudSprites.forEach(s => {
            s.position.x += s.userData.speed * dt;
            if (s.position.x > 170) s.position.x = -170;
            s.material.opacity = 0.18 + 0.55 * cover;
            const b = 0.22 + 0.78 * day - 0.25 * cover;
            s.material.color.setRGB(clamp(b, 0.12, 1), clamp(b + 0.02, 0.12, 1), clamp(b + 0.08, 0.15, 1));
        });
        const rainAmount = clamp((0.64 - state.cloud) / 0.14, 0, 1);
        rain.material.opacity = rainAmount * 0.6;
        rain.visible = rainAmount > 0.02;
        if (rain.visible) {
            const attr = rain.geometry.attributes.position;
            for (let i = 0; i < RAIN_COUNT; i++) {
                let y = attr.getY(i) - 38 * dt;
                if (y < 0) y += 55;
                attr.setY(i, y);
            }
            attr.needsUpdate = true;
            rain.position.set(camera.position.x * 0.5, 0, camera.position.z * 0.5);
        }
    }

    // ------------------------------------------------------------------
    // 16. TIME OF DAY (sky, sun, lights, fog, windows, lamps) + ENERGY LENS
    // ------------------------------------------------------------------
    const COLORS = {
        topNight: new THREE.Color(0x02050e), topDay: new THREE.Color(0x3a78b8), topDusk: new THREE.Color(0x3a3f78),
        horNight: new THREE.Color(0x0b1730), horDay: new THREE.Color(0xb4d3ea), horDusk: new THREE.Color(0xff9a62),
        sunWhite: new THREE.Color(0xfff1dc), sunWarm: new THREE.Color(0xffa860)
    };
    const env = { day: 1, night: 0, elev: 1 };
    const sunVec = new THREE.Vector3();
    const lampOn = new THREE.Color(0xffe3b0), lampOff = new THREE.Color(0x3b4452);

    function updateEnvironment(dt) {
        const diff = (((state.hour - state.envHour + 12) % 24) + 24) % 24 - 12;
        state.envHour = (state.envHour + diff * Math.min(1, dt * 2.5) + 24) % 24;
        const h = state.envHour;
        state.lens += (state.lensTarget - state.lens) * Math.min(1, dt * 3);
        const lens = state.lens;

        const elev = Math.sin(Math.PI * (h - 6) / 12);
        const day = smoothstep(-0.12, 0.35, elev);
        const twilight = Math.exp(-Math.pow(elev / 0.22, 2));
        env.day = day; env.night = 1 - day; env.elev = elev;

        const a = Math.PI * (h - 6) / 12;
        sunVec.set(-Math.cos(a), Math.sin(a), 0.38).normalize();
        const dim = 1 - 0.6 * lens;

        skyUniforms.topColor.value.copy(COLORS.topNight).lerp(COLORS.topDay, day).lerp(COLORS.topDusk, twilight * 0.5).multiplyScalar(dim);
        skyUniforms.horizonColor.value.copy(COLORS.horNight).lerp(COLORS.horDay, day).lerp(COLORS.horDusk, twilight * 0.85).multiplyScalar(dim);
        skyUniforms.sunDir.value.copy(sunVec);
        skyUniforms.sunColor.value.copy(COLORS.sunWhite).lerp(COLORS.sunWarm, twilight);
        skyUniforms.nightMix.value = env.night;
        scene.background.copy(skyUniforms.horizonColor.value);
        scene.fog.color.copy(skyUniforms.horizonColor.value).multiplyScalar(0.92);
        scene.fog.density = 0.0042 + (1 - state.cloud) * 0.003;

        const cloudDim = 0.55 + 0.45 * state.cloud;
        sunlight.position.copy(sunVec).multiplyScalar(110);
        sunlight.intensity = 3.1 * day * cloudDim * dim;
        sunlight.color.copy(COLORS.sunWhite).lerp(COLORS.sunWarm, twilight * 0.8);
        moonlight.position.copy(sunVec).multiplyScalar(-90);
        moonlight.intensity = 0.55 * env.night * dim;
        hemi.intensity = (0.25 + 0.95 * day) * dim + 0.12;
        hemi.color.setHex(0xbfd9ff).lerp(COLORS.horDusk, twilight * 0.3);
        scene.environmentIntensity = (0.08 + 0.85 * day * cloudDim) * (1 - 0.5 * lens);
        renderer.toneMappingExposure = 1.08 + 0.12 * day;

        stars.material.opacity = clamp(env.night * 1.1, 0, 1) * 0.9;
        moon.position.copy(sunVec).multiplyScalar(-420);
        moonGlow.position.copy(moon.position);
        moon.visible = moonGlow.visible = elev < 0.1;
        moonGlow.material.opacity = 0.5 * env.night;

        lampGlow.material.opacity = clamp(env.night * 1.15, 0, 1);
        lampHeads.material.color.copy(lampOff).lerp(lampOn, env.night).multiplyScalar(1 + env.night);

        const winBoost = env.night * (0.75 + 0.5 * lens) + 0.03 + 0.1 * lens;
        buildingGroups.forEach(g => {
            const u = g.userData, ratio = state.demands[u.index] / (u.data.base * 0.85);
            const e = winBoost * (0.35 + 0.9 * clamp(ratio, 0, 1.3));
            u.matX.emissiveIntensity = e; u.matZ.emissiveIntensity = e;
            u.entranceMat.opacity = clamp(env.night * 1.1, 0, 0.95);
        });
        headMat.color.setHex(0xfff1cc).multiplyScalar(0.25 + 2.2 * env.night);
        tailMat.color.setHex(0xff2a2a).multiplyScalar(0.5 + 1.6 * env.night);

        const tilt = -(0.1 + (1 - clamp(elev, 0, 1)) * 0.55);
        solarPanels.forEach(p => { p.rotation.x = tilt; });
        solarPanelMat.emissiveIntensity = 0.25 + clamp(state.solar / 25, 0, 1) * 0.9;

        sky.position.copy(camera.position);
        return day;
    }

    // ------------------------------------------------------------------
    // 17. BUILDING VISUALS (heat, anomaly beacons, selection) + BATTERY
    // ------------------------------------------------------------------
    const CYAN = new THREE.Color(0x00dfff), AMBER = new THREE.Color(0xffb347), HOT = new THREE.Color(0xff5a3c);
    const tmpColor = new THREE.Color();
    let labelTimer = 0;

    function updateBuildingVisuals(time, dt) {
        labelTimer += dt;
        const refresh = labelTimer > 0.4;
        if (refresh) labelTimer = 0;
        const lens = state.lens;

        buildingGroups.forEach((group, index) => {
            const u = group.userData;
            const ratio = state.demands[index] / (u.data.base * 0.85);
            const pulse = 0.8 + Math.sin(time * 2.5 + index) * 0.2;
            const anomaly = u.anomaly;

            const heat = clamp(ratio - 0.6, 0, 1) * (0.2 + 0.8 * lens);
            const hoverBoost = state.hover === index ? 1.18 : 1;
            u.matX.color.setRGB(hoverBoost, (1 - 0.2 * heat) * hoverBoost, (1 - 0.5 * heat) * hoverBoost);
            u.matZ.color.copy(u.matX.color);

            tmpColor.copy(CYAN).lerp(AMBER, clamp((ratio - 0.5) / 0.6, 0, 1)).lerp(HOT, clamp((ratio - 1.1) / 0.6, 0, 1));
            u.heat.material.color.copy(tmpColor);
            u.heat.material.opacity = (0.12 + 0.28 * clamp(ratio, 0, 1.4)) * (0.35 + 0.65 * (0.4 + lens));
            u.heat.scale.setScalar(Math.max(u.data.w, u.data.d) * (1.05 + 0.35 * clamp(ratio, 0, 1.4)));

            u.indicator.scale.setScalar(pulse * (0.75 + clamp(ratio, 0.2, 2.5) * 0.3));
            u.ring.rotation.z = time * 0.45;
            u.beaconMat.color.setHex(0xff3b3b).multiplyScalar(0.3 + 1.7 * (Math.sin(time * 3 + index * 2) > 0.7 ? 1 : 0));

            if (anomaly) {
                const color = severityColor(anomaly.severity);
                u.ring.material.color.setHex(color);
                u.indicator.material.color.setHex(color);
                u.ring.scale.setScalar((u.selected ? 1.3 : 1) * (1 + Math.sin(time * 5) * 0.15));
                u.beam.visible = true;
                u.beam.material.color.setHex(color);
                u.beam.material.opacity = 0.16 + 0.12 * (0.5 + 0.5 * Math.sin(time * 4));
                u.shockT = (u.shockT + dt / 1.6) % 1;
                u.shock.visible = true;
                u.shock.material.color.setHex(color);
                u.shock.scale.setScalar(1 + u.shockT * 7);
                u.shock.material.opacity = (1 - u.shockT) * 0.8;
            } else {
                tmpColor.copy(CYAN).lerp(AMBER, clamp((ratio - 0.7) / 0.8, 0, 1));
                u.ring.material.color.copy(tmpColor);
                u.indicator.material.color.copy(tmpColor);
                u.ring.scale.setScalar(u.selected ? 1.3 : 1);
                u.beam.visible = false;
                u.shock.visible = false;
            }

            u.halo.visible = u.selected;
            if (u.selected) {
                u.halo.material.opacity = 0.55 + Math.sin(time * 3) * 0.3;
                u.halo.rotation.z = time * 0.3;
            }

            u.label.sprite.visible = state.labelsVisible;
            if (refresh) drawLiveLabel(group);
        });
    }

    const CELL_LOW = new THREE.Color(0xff4d6d), CELL_MID = new THREE.Color(0xffca68), CELL_OK = new THREE.Color(0x9b72ff);
    function updateBattery(time) {
        const soc = clamp(state.batterySOC, 0, 100);
        const lit = (soc / 100) * CELL_COUNT;
        const base = soc < 20 ? CELL_LOW : soc < 45 ? CELL_MID : CELL_OK;
        const flowing = Math.abs(state.battery) > 0.05 && state.running;
        batteryCells.forEach((cell, i) => {
            const on = clamp(lit - i, 0, 1);
            cell.material.color.copy(base).multiplyScalar(on > 0 ? 2.2 : 0.4);
            let opacity = 0.14 + 0.86 * on;
            if (flowing && on > 0 && i === Math.min(CELL_COUNT - 1, Math.floor(lit))) opacity *= 0.6 + 0.4 * Math.sin(time * 8);
            cell.material.opacity = opacity;
        });
    }

    // ------------------------------------------------------------------
    // 18. BURSTS (anomaly onset / injected faults)
    // ------------------------------------------------------------------
    const bursts = [];
    function spawnBurst(position, color) {
        const n = 48, pos = new Float32Array(n * 3), vel = [];
        for (let i = 0; i < n; i++) {
            pos.set([position.x, position.y, position.z], i * 3);
            vel.push(new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5)
                .normalize().multiplyScalar(5 + Math.random() * 9));
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        const pts = new THREE.Points(g, new THREE.PointsMaterial({
            color: new THREE.Color(color).multiplyScalar(2), size: 0.6, transparent: true, opacity: 1,
            blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
        pts.frustumCulled = false;
        scene.add(pts);
        bursts.push({ pts, vel, age: 0 });
    }
    function updateBursts(dt) {
        for (let b = bursts.length - 1; b >= 0; b--) {
            const burst = bursts[b];
            burst.age += dt;
            const attr = burst.pts.geometry.attributes.position;
            burst.vel.forEach((v, i) => {
                v.y -= 9 * dt;
                attr.setXYZ(i, attr.getX(i) + v.x * dt, Math.max(0.1, attr.getY(i) + v.y * dt), attr.getZ(i) + v.z * dt);
            });
            attr.needsUpdate = true;
            burst.pts.material.opacity = Math.max(0, 1 - burst.age / 1.3);
            if (burst.age > 1.3) {
                scene.remove(burst.pts);
                burst.pts.geometry.dispose();
                burst.pts.material.dispose();
                bursts.splice(b, 1);
            }
        }
    }

    // ------------------------------------------------------------------
    // 19. HUD
    // ------------------------------------------------------------------
    const hud = {
        clock: document.getElementById("hudClock"), demand: document.getElementById("hudDemand"),
        solar: document.getElementById("hudSolar"), grid: document.getElementById("hudGrid"),
        battery: document.getElementById("hudBattery"), batterySOC: document.getElementById("hudBatterySOC"),
        batteryFill: document.getElementById("hudBatteryFill"), status: document.getElementById("hudStatus")
    };
    const hudRoot = document.querySelector(".arkagrid-hud");
    if (hudRoot && !document.getElementById("hudTariff")) {
        const extra = document.createElement("div");
        extra.className = "hud-extra";
        extra.innerHTML = `<span id="hudTariff">TARIFF --</span><span id="hudMode">MODE --</span><span id="hudCO2">CO₂ SAVED --</span><span id="hudSky">SKY --</span>`;
        hudRoot.appendChild(extra);
    }
    const fmtKw = v => `${Number(v || 0).toFixed(1)} kW`;
    const setText = (el, text) => { if (el) el.textContent = text; };

    function updateHUD() {
        setText(hud.demand, fmtKw(state.totalDemand));
        setText(hud.solar, fmtKw(state.solar));
        setText(hud.grid, fmtKw(state.grid));
        if (hud.battery) {
            const mode = state.battery > 0.05 ? "DISCHARGING" : state.battery < -0.05 ? "CHARGING" : "IDLE";
            hud.battery.textContent = `${Math.abs(state.battery).toFixed(1)} kW · ${mode}`;
        }
        setText(hud.batterySOC, `${state.batterySOC.toFixed(1)}%`);
        if (hud.batteryFill) hud.batteryFill.style.width = `${clamp(state.batterySOC, 0, 100)}%`;
        const clockEl = document.getElementById("simulationClock");
        setText(hud.clock, clockEl ? clockEl.textContent : state.clockText);
        setText(hud.status, state.running ? "SYNTHETIC SIMULATION ACTIVE" : "SIMULATION PAUSED");
        const dot = document.querySelector(".hud-status-dot");
        if (dot) {
            dot.style.background = state.running ? "#48e5b1" : "#f0b45d";
            dot.style.boxShadow = `0 0 12px ${state.running ? "#48e5b1" : "#f0b45d"}`;
        }
        setText(document.getElementById("hudTariff"), state.tariff > 1 ? "● PEAK TARIFF" : state.tariff < 1 ? "● OFF-PEAK TARIFF" : "● STANDARD TARIFF");
        setText(document.getElementById("hudMode"), `MODE: ${String(state.mode).toUpperCase()}`);
        setText(document.getElementById("hudCO2"), `CO₂ SAVED: ${state.co2.toFixed(1)} kg`);
        setText(document.getElementById("hudSky"), `SKY: ${Math.round(state.cloud * 100)}% CLEAR`);
    }

    // ------------------------------------------------------------------
    // 20. LIVE DATA + ANOMALY EVENTS
    // ------------------------------------------------------------------
    const readPower = value => {
        if (typeof value === "number") return value;
        if (value && typeof value === "object") return Number(value.kw ?? value.kW ?? value.power ?? value.value ?? 0);
        return 0;
    };

    window.addEventListener("arkagrid:energy-update", event => {
        const d = event.detail || {};
        if (Array.isArray(d.demands)) {
            d.demands.forEach(r => {
                const i = BUILDINGS.findIndex(b => b.name === r.name);
                if (i !== -1) state.demands[i] = readPower(r.demand);
            });
        }
        state.solar = readPower(d.solarPower ?? d.solar);
        state.grid = readPower(d.gridPower ?? d.gridImport ?? d.grid);
        state.battery = readPower(d.batteryPower ?? d.battery);
        state.totalDemand = readPower(d.totalDemand);
        if (d.running !== undefined) state.running = Boolean(d.running);
        if (d.batterySOC !== undefined) state.batterySOC = num(d.batterySOC, state.batterySOC);
        else {
            const soc = parseFloat(document.getElementById("metric-soc")?.textContent);
            if (Number.isFinite(soc)) state.batterySOC = soc;
        }
        if (typeof d.clock === "string") {
            state.clockText = d.clock;
            const [h, m] = d.clock.split(":").map(Number);
            if (Number.isFinite(h)) state.hour = h + (Number.isFinite(m) ? m / 60 : 0);
        }
        state.cloud = clamp(num(d.cloud, state.cloud), 0.3, 1);
        state.tariff = num(d.tariff, state.tariff);
        state.mode = d.mode || state.mode;
        state.co2 = num(d.co2Avoided, state.co2);
        state.hasLiveData = true;
        updateNetworkPower();
    });

    function normalizeAnomalies(data) {
        if (Array.isArray(data)) return data;
        for (const key of ["results", "anomalies", "records", "byBuilding"]) if (Array.isArray(data?.[key])) return data[key];
        return [];
    }

    window.addEventListener("arkagrid:anomaly-update", event => {
        const records = normalizeAnomalies(event.detail || {});
        const previous = new Set(state.anomalyByBuilding.keys());
        state.anomalyByBuilding.clear();

        records.forEach(rec => {
            const name = rec.building || rec.name || rec.building_name;
            if (!name) return;
            const status = String(rec.status || "").toLowerCase();
            if (status === "normal" || status === "0" || rec.is_anomaly === false) return;
            const severity = String(rec.severity || "moderate").toLowerCase();
            const rank = SEVERITY_RANK[severity] || 2;
            const existing = state.anomalyByBuilding.get(name);
            if (existing && existing.rank >= rank) { existing.count++; return; }
            state.anomalyByBuilding.set(name, {
                severity, rank, count: (existing?.count || 0) + 1,
                explanation: rec.explanation || "Unusual energy reading detected.",
                timestamp: rec.timestamp || "", deviation: Number(rec.deviation_percent || 0), source: rec.source || ""
            });
        });

        buildingGroups.forEach(g => {
            const u = g.userData;
            u.anomaly = state.anomalyByBuilding.get(u.data.name) || null;
            if (u.anomaly && !previous.has(u.data.name)) {
                u.shockT = 0;
                spawnBurst(new THREE.Vector3(u.data.x, u.height + 3.6, u.data.z), severityColor(u.anomaly.severity));
            }
        });
        renderDetail();
    });

    window.addEventListener("arkagrid:fault-injected", event => {
        const g = buildingGroups.find(x => x.userData.data.name === event.detail?.name);
        if (g) spawnBurst(new THREE.Vector3(g.userData.data.x, g.userData.height + 3.6, g.userData.data.z), 0xffca68);
    });

    // ------------------------------------------------------------------
    // 21. CAMERA: INTRO FLIGHT, VIEWS, TOUR, FLY-TO-BUILDING
    // ------------------------------------------------------------------
    let tween = null;
    function flyTo(pos, target, duration = 1.3) {
        tween = {
            t: 0, dur: duration,
            fromP: camera.position.clone(), toP: new THREE.Vector3(pos[0], pos[1], pos[2]),
            fromT: controls.target.clone(), toT: new THREE.Vector3(target[0], target[1], target[2])
        };
    }
    function updateTween(dt) {
        if (!tween) return;
        tween.t += dt;
        const k = easeInOut(clamp(tween.t / tween.dur, 0, 1));
        camera.position.lerpVectors(tween.fromP, tween.toP, k);
        controls.target.lerpVectors(tween.fromT, tween.toT, k);
        if (tween.t >= tween.dur) tween = null;
    }
    controls.addEventListener("start", () => { tween = null; if (state.tour) setTour(false); });

    function flyToBuilding(i) {
        const d = BUILDINGS[i], H = buildingGroups[i].userData.height;
        flyTo([d.x + 22, 16 + H * 0.45, d.z + 32], [d.x, H * 0.4, d.z]);
    }
    function setView(index) {
        state.viewIndex = ((index % VIEWS.length) + VIEWS.length) % VIEWS.length;
        const v = VIEWS[state.viewIndex];
        flyTo(v.pos, v.target, 1.5);
        btnView.textContent = `🎥 ${v.name}`;
    }
    let tourTimer = 0;
    function setTour(on) {
        state.tour = on;
        tourTimer = on ? 99 : 0;
        btnTour.classList.toggle("on", on);
        btnTour.textContent = on ? "■ Tour" : "▶ Tour";
    }

    // start high and far, then glide into the isometric view
    camera.position.set(150, 95, 160);
    controls.target.set(0, 3, -4);
    flyTo(VIEWS[0].pos, VIEWS[0].target, 4.2);

    // ------------------------------------------------------------------
    // 22. SELECTION, DETAIL PANEL, TOOLTIP, PICKING
    // ------------------------------------------------------------------
    function selectBuilding(index, { emit = true, fly = true } = {}) {
        if (index < 0 || index >= BUILDINGS.length) return;
        buildingGroups.forEach(g => { g.userData.selected = false; });
        buildingGroups[index].userData.selected = true;
        state.selected = index;
        if (fly) flyToBuilding(index);
        if (emit) window.dispatchEvent(new CustomEvent("arkagrid:building-selected", { detail: { name: BUILDINGS[index].name } }));
        renderDetail();
    }

    function renderDetail() {
        if (!detail || state.selected < 0) return;
        const i = state.selected, b = BUILDINGS[i];
        const anomaly = buildingGroups[i].userData.anomaly;
        const demand = state.demands[i] || 0;
        detail.replaceChildren();
        const add = (text, tag = "span", cls = "") => {
            const el = document.createElement(tag);
            el.textContent = text;
            if (cls) el.className = cls;
            detail.appendChild(el);
        };
        add("", "span", "live-dot");
        add(b.name, "strong");
        add(`Live demand: ${demand.toFixed(1)} kW`);
        add(`Nominal: ${b.base} kW (${Math.round(demand / b.base * 100)}%)`);
        if (anomaly) {
            add(`AI ALERT: ${anomaly.severity.toUpperCase()}${anomaly.count > 1 ? ` ×${anomaly.count}` : ""}`, "strong");
            add(anomaly.explanation);
        } else {
            add("AI status: No anomaly reported");
        }
    }

    const tip = document.createElement("div");
    tip.className = "ag3d-tip";
    container.appendChild(tip);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerEvent = null, downAt = null;

    function pick(clientX, clientY) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(buildingMeshes);
        return hits.length ? buildingMeshes.indexOf(hits[0].object) : -1;
    }

    renderer.domElement.addEventListener("pointermove", e => { pointerEvent = e; });
    renderer.domElement.addEventListener("pointerleave", () => {
        pointerEvent = null; state.hover = -1; tip.style.display = "none"; renderer.domElement.style.cursor = "";
    });
    renderer.domElement.addEventListener("pointerdown", e => { downAt = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener("click", e => {
        if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
        const index = pick(e.clientX, e.clientY);
        if (index !== -1) { if (state.tour) setTour(false); selectBuilding(index); }
    });
    renderer.domElement.addEventListener("dblclick", () => setView(0));

    function updateHover() {
        if (!pointerEvent) return;
        const index = pick(pointerEvent.clientX, pointerEvent.clientY);
        state.hover = index;
        renderer.domElement.style.cursor = index !== -1 ? "pointer" : "";
        if (index === -1) { tip.style.display = "none"; return; }
        const b = BUILDINGS[index], a = buildingGroups[index].userData.anomaly;
        tip.replaceChildren();
        const title = document.createElement("b"); title.textContent = b.name; tip.appendChild(title);
        const line = document.createElement("div");
        line.textContent = `${(state.demands[index] || 0).toFixed(1)} kW now · nominal ${b.base} kW`;
        tip.appendChild(line);
        const status = document.createElement("div");
        status.textContent = a ? `⚠ ${a.severity.toUpperCase()}: ${a.explanation}` : "✓ Operating normally";
        status.style.color = a ? "#ffb3bd" : "#8be6c8";
        tip.appendChild(status);
        const rect = container.getBoundingClientRect();
        tip.style.display = "block";
        tip.style.left = `${clamp(pointerEvent.clientX - rect.left + 14, 0, rect.width - 240)}px`;
        tip.style.top = `${clamp(pointerEvent.clientY - rect.top + 14, 0, rect.height - 90)}px`;
    }

    window.addEventListener("arkagrid:select-building", e => {
        const i = BUILDINGS.findIndex(b => b.name === e.detail?.name);
        if (i !== -1) selectBuilding(i, { emit: false });
    });

    // ------------------------------------------------------------------
    // 23. ON-SCREEN CONTROLS, LEGEND, KEYBOARD
    // ------------------------------------------------------------------
    const controlsBox = document.createElement("div");
    controlsBox.className = "ag3d-controls";
    controlsBox.innerHTML = `
        <div class="ag3d-buttons">
            <button type="button" class="ag3d-btn" id="ag3dView">🎥 Isometric</button>
            <button type="button" class="ag3d-btn" id="ag3dTour">▶ Tour</button>
            <button type="button" class="ag3d-btn" id="ag3dLens" title="Energy lens (L)">⚡ Energy lens</button>
            <button type="button" class="ag3d-btn on" id="ag3dFx" title="Glow effects (B)">✨ Glow</button>
            <button type="button" class="ag3d-btn on" id="ag3dLabels">🏷 Labels</button>
        </div>
        <div class="ag3d-hint">Click: inspect · Double-click: reset · V view · C tour · L lens · B glow · H labels</div>`;
    container.appendChild(controlsBox);

    const legend = document.createElement("div");
    legend.className = "ag3d-legend";
    legend.innerHTML = `
        <span><i style="background:#ffc95b;color:#ffc95b"></i>Solar</span>
        <span><i style="background:#00cfff;color:#00cfff"></i>Grid</span>
        <span><i style="background:#a889ff;color:#a889ff"></i>Battery</span>
        <span><i style="background:#35e0b8;color:#35e0b8"></i>Building feeders</span>`;
    container.appendChild(legend);

    const btnView = controlsBox.querySelector("#ag3dView");
    const btnTour = controlsBox.querySelector("#ag3dTour");
    const btnLens = controlsBox.querySelector("#ag3dLens");
    const btnFx = controlsBox.querySelector("#ag3dFx");
    const btnLabels = controlsBox.querySelector("#ag3dLabels");

    function toggleLabels() { state.labelsVisible = !state.labelsVisible; btnLabels.classList.toggle("on", state.labelsVisible); }
    function toggleLens() { state.lensTarget = state.lensTarget ? 0 : 1; btnLens.classList.toggle("on", Boolean(state.lensTarget)); }
    function toggleFx() { state.fx = !state.fx; btnFx.classList.toggle("on", state.fx); }

    btnView.addEventListener("click", () => setView(state.viewIndex + 1));
    btnTour.addEventListener("click", () => setTour(!state.tour));
    btnLens.addEventListener("click", toggleLens);
    btnFx.addEventListener("click", toggleFx);
    btnLabels.addEventListener("click", toggleLabels);

    // 1-5, F, P, R belong to app.js; these keys do not collide.
    document.addEventListener("keydown", e => {
        if (e.target.matches?.("input,select,textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
        const k = e.key.toLowerCase();
        if (k === "v") setView(state.viewIndex + 1);
        else if (k === "c") setTour(!state.tour);
        else if (k === "h") toggleLabels();
        else if (k === "l") toggleLens();
        else if (k === "b") toggleFx();
    });

    // ------------------------------------------------------------------
    // 24. GLOW (bloom) POST-PROCESSING - loaded lazily, optional
    // ------------------------------------------------------------------
    let composer = null, bloomPass = null;
    async function setupBloom() {
        if (IS_MOBILE) { btnFx.style.display = "none"; return; }
        try {
            const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
                import("three/addons/postprocessing/EffectComposer.js"),
                import("three/addons/postprocessing/RenderPass.js"),
                import("three/addons/postprocessing/UnrealBloomPass.js"),
                import("three/addons/postprocessing/OutputPass.js")
            ]);
            const w = container.clientWidth, h = container.clientHeight;
            const target = new THREE.WebGLRenderTarget(w * pixelRatio, h * pixelRatio, { type: THREE.HalfFloatType, samples: 4 });
            const c = new EffectComposer(renderer, target);
            c.setPixelRatio(pixelRatio);
            c.setSize(w, h);
            c.addPass(new RenderPass(scene, camera));
            bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.7, 0.55, 1.0);
            c.addPass(bloomPass);
            c.addPass(new OutputPass());
            composer = c;
            console.log("ArkaGrid 3D: glow post-processing enabled");
        } catch (error) {
            composer = null;
            btnFx.style.display = "none";
            console.warn("ArkaGrid 3D: glow effects unavailable, using standard rendering.", error);
        }
    }

    // ------------------------------------------------------------------
    // 25. ANIMATION LOOP (+ adaptive quality)
    // ------------------------------------------------------------------
    let lastTime = performance.now();
    let detailTimer = 0, hudTimer = 0, slowFrames = 0, frameCount = 0;

    function applyPixelRatio(value) {
        pixelRatio = value;
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(container.clientWidth, container.clientHeight);
        if (composer) { composer.setPixelRatio(pixelRatio); composer.setSize(container.clientWidth, container.clientHeight); }
    }

    function animate(now) {
        requestAnimationFrame(animate);
        const rawDelta = Math.min(0.25, Math.max(0.0001, (now - lastTime) / 1000 || 0.016));
        lastTime = now;
        if (!state.visible || document.hidden) return;

        const dt = Math.min(rawDelta, 0.05);
        const time = now / 1000;

        updateTween(dt);
        controls.update();
        const day = updateEnvironment(dt);
        updateBuildingVisuals(time, dt);
        updateFlows(dt, time);
        updateBattery(time);
        updateAgents(dt, time, day);
        updateWeather(dt, day);
        updateBursts(dt);
        updateHover();

        const loadFactor = clamp(state.totalDemand / 90, 0.3, 2);
        hubLight.intensity = 36 + Math.sin(time * 3 * loadFactor) * 8;
        hubRing.rotation.z = time * 0.15;
        core.rotation.y = time * 0.7 * loadFactor;
        core.rotation.x = time * 0.4;
        coreInner.scale.setScalar(1 + Math.sin(time * 4 * loadFactor) * 0.12);
        coreRings.forEach((r, i) => { r.rotation.z = time * (0.5 + i * 0.25) * loadFactor; });

        if (state.tour) {
            tourTimer += dt;
            if (tourTimer > 7) { tourTimer = 0; selectBuilding((Math.max(state.selected, -1) + 1) % BUILDINGS.length); }
        }
        hudTimer += dt; detailTimer += dt;
        if (hudTimer > 0.2) { hudTimer = 0; updateHUD(); }
        if (detailTimer > 0.6) { detailTimer = 0; renderDetail(); }

        if (composer && state.fx) {
            bloomPass.strength = lerp(0.95, 0.4, env.day) * (1 + 0.7 * state.lens);
            bloomPass.threshold = lerp(0.9, 1.25, env.day) - 0.12 * state.lens;
            bloomPass.radius = 0.55;
            composer.render(dt);
        } else {
            renderer.render(scene, camera);
        }

        frameCount++;
        if (rawDelta > 1 / 38) slowFrames++;
        if (frameCount >= 120) {
            if (slowFrames > 70 && pixelRatio > 1) {
                applyPixelRatio(Math.max(1, pixelRatio - 0.25));
                console.log(`ArkaGrid 3D: reduced pixel ratio to ${pixelRatio} for performance`);
            }
            frameCount = 0; slowFrames = 0;
        }
    }

    // ------------------------------------------------------------------
    // 26. RESIZE, VISIBILITY, START
    // ------------------------------------------------------------------
    function resize() {
        const w = container.clientWidth, h = container.clientHeight;
        if (!w || !h) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        if (composer) composer.setSize(w, h);
    }
    new ResizeObserver(resize).observe(container);
    window.addEventListener("resize", resize);
    if ("IntersectionObserver" in window) {
        new IntersectionObserver(entries => { state.visible = entries[0].isIntersecting; }).observe(container);
    }

    resize();
    updateNetworkPower();
    updateHUD();
    buildingGroups.forEach(g => drawLiveLabel(g));
    requestAnimationFrame(animate);
    setupBloom();
    if (loading) loading.style.display = "none";

    window.ArkaGrid3D = { state, selectBuilding, setView, setTour, flyTo, toggleLens, toggleFx };

    console.log("====================================");
    console.log("ARKAGRID v3 | LIVING CAMPUS ONLINE");
    console.log("Buildings:", BUILDINGS.length, "· Energy flows:", flows.length, "· three.js source:", window.__THREE_SOURCE || "n/a");
    console.log("Sky + day/night · People & traffic · Energy lens · Glow");
    console.log("====================================");
}
