// --- 3D build viewer ---
//
// Builds the vehicle out of primitives, grouped into the systems people
// actually track parts for (frame, engine, drivetrain, suspension, brakes,
// body, interior, electrical, trim). Each group is coloured by how far along
// that system's parts are, can be exploded away from the car, hidden, and —
// in edit mode — nudged/resized so the mock-up matches the real vehicle.
//
// The shape comes from a body-style profile (sedan, pickup, SUV, …) rather
// than one fixed car, so a Bronco reads as a short boxy SUV and an F-150 as a
// long-wheelbase truck with a bed. Every system's geometry is derived from
// that profile, so the frame, driveshaft and interior stretch with it.
//
// three.js is pulled in lazily so the ~600KB only downloads when someone
// actually opens the 3D tab.

let threePromise = null;
function loadThree() {
  if (!threePromise) threePromise = import('https://esm.sh/three@0.169.0');
  return threePromise;
}

// Every component maps onto the part categories app.js already uses, so the
// 3D view reads straight from the existing parts list — nothing to re-enter.
// 'Tools & Supplies' is deliberately unmapped: it has no place on the car.
export const BUILD_COMPONENTS = [
  { key: 'frame',      label: 'Frame & chassis',   categories: ['Other'],                   explode: [0, 0, 0],       hint: 'Rails, crossmembers, mounts' },
  { key: 'engine',     label: 'Engine',            categories: ['Engine'],                  explode: [0, 0.5, 0.9],   hint: 'Block, heads, intake, cooling' },
  { key: 'drivetrain', label: 'Transmission & driveline', categories: ['Transmission/Drivetrain'], explode: [0, 0.1, -1.4], hint: 'Trans, driveshaft, diff, axles' },
  { key: 'suspension', label: 'Suspension, steering & wheels', categories: ['Suspension/Steering'], explode: [0, -0.9, 0], hint: 'Springs, shocks, arms, rack, wheels' },
  { key: 'brakes',     label: 'Brakes',            categories: ['Brakes'],                  explode: [0, -1.7, 0],    hint: 'Rotors, calipers, lines' },
  { key: 'electrical', label: 'Electrical',        categories: ['Electrical'],              explode: [0.9, 0.9, 0],   hint: 'Battery, charging, wiring' },
  { key: 'interior',   label: 'Interior',          categories: ['Interior'],                explode: [0, 1.5, 0],     hint: 'Seats, dash, wheel, carpet' },
  { key: 'body',       label: 'Body & paint',      categories: ['Body & Paint'],            explode: [0, 2.6, 0],     hint: 'Panels, glass, paint' },
  { key: 'trim',       label: 'Trim & exterior',   categories: ['Trim/Exterior'],           explode: [0, 3.5, 0],     hint: 'Bumpers, lights, chrome, exhaust' },
];

export const UNPLACED_CATEGORIES = ['Tools & Supplies'];

// Build progress states. Colours mirror the CSS custom properties in
// styles.css so the 3D view and the rest of the app agree on what green means.
export const BUILD_STATES = {
  empty:     { label: 'Nothing logged', color: 0x94a3b8, cssVar: 'var(--text-muted)' },
  planned:   { label: 'Planned',        color: 0x2a5f9e, cssVar: 'var(--series-1)' },
  progress:  { label: 'In progress',    color: 0xfab219, cssVar: 'var(--warning)' },
  installed: { label: 'Installed',      color: 0x0ca30c, cssVar: 'var(--good)' },
};

export function componentPartsFor(component, parts) {
  return parts.filter(p => component.categories.includes(p.category));
}

export function componentState(parts) {
  if (parts.length === 0) return 'empty';
  const installed = parts.filter(p => p.status === 'installed').length;
  if (installed === parts.length) return 'installed';
  const moved = parts.filter(p => p.status !== 'needed' && p.status !== 'returned').length;
  return moved > 0 ? 'progress' : 'planned';
}

// --- Body styles ---
//
// Dimensions are in metres and describe a representative vehicle of each
// shape. Front of the car is +Z, up is +Y, the right-hand side is +X.
//   lift      how far the body sits above the wheels beyond a car's ride height
//   hood/cabin/rear  centre Z and length of each section of the body
//   rear      'trunk' (separate boot lid) | 'cargo' (roof carries back) |
//             'bed' (open pickup bed) | 'none' (roadster tail)
//   roof      false for open cars

export const BODY_STYLES = [
  { key: 'sedan', label: 'Sedan', base: {
    wheelbase: 2.80, length: 4.80, width: 1.83, wheelR: 0.33, lift: 0, bodyH: 0.55, bodyRise: 0.27,
    hoodZ: 1.35, hoodLen: 1.30, cabinZ: -0.15, cabinLen: 2.00, cabinH: 0.50,
    roof: true, roofLen: 1.70, roofZ: -0.25, rear: 'trunk', rearZ: -1.75, rearLen: 1.05, rows: 2 } },
  { key: 'coupe', label: 'Coupe', base: {
    wheelbase: 2.65, length: 4.55, width: 1.82, wheelR: 0.33, lift: 0, bodyH: 0.52, bodyRise: 0.22,
    hoodZ: 1.35, hoodLen: 1.45, cabinZ: -0.35, cabinLen: 1.60, cabinH: 0.44,
    roof: true, roofLen: 1.25, roofZ: -0.45, rear: 'trunk', rearZ: -1.72, rearLen: 1.10, rows: 2 } },
  { key: 'hatchback', label: 'Hatchback', base: {
    wheelbase: 2.60, length: 4.20, width: 1.78, wheelR: 0.32, lift: 0, bodyH: 0.55, bodyRise: 0.22,
    hoodZ: 1.30, hoodLen: 1.05, cabinZ: -0.05, cabinLen: 1.95, cabinH: 0.54,
    roof: true, roofLen: 1.85, roofZ: -0.15, rear: 'cargo', rearZ: -1.45, rearLen: 0.85, rows: 2 } },
  { key: 'wagon', label: 'Wagon / estate', base: {
    wheelbase: 2.80, length: 4.85, width: 1.83, wheelR: 0.33, lift: 0, bodyH: 0.55, bodyRise: 0.23,
    hoodZ: 1.42, hoodLen: 1.25, cabinZ: -0.10, cabinLen: 2.10, cabinH: 0.55,
    roof: true, roofLen: 2.90, roofZ: -0.70, rear: 'cargo', rearZ: -1.70, rearLen: 1.10, rows: 2 } },
  { key: 'convertible', label: 'Convertible / roadster', base: {
    wheelbase: 2.55, length: 4.35, width: 1.80, wheelR: 0.32, lift: 0, bodyH: 0.52, bodyRise: 0.18,
    hoodZ: 1.30, hoodLen: 1.40, cabinZ: -0.30, cabinLen: 1.50, cabinH: 0.30,
    roof: false, roofLen: 0, roofZ: 0, rear: 'trunk', rearZ: -1.62, rearLen: 1.00, rows: 1 } },
  { key: 'suv', label: 'SUV / 4x4', base: {
    wheelbase: 2.75, length: 4.60, width: 1.90, wheelR: 0.37, lift: 0.12, bodyH: 0.70, bodyRise: 0.29,
    hoodZ: 1.55, hoodLen: 1.15, cabinZ: -0.35, cabinLen: 2.55, cabinH: 0.66,
    roof: true, roofLen: 2.70, roofZ: -0.45, rear: 'cargo', rearZ: -1.80, rearLen: 0.85, rows: 2 } },
  { key: 'pickup', label: 'Pickup truck', base: {
    wheelbase: 3.35, length: 5.60, width: 1.98, wheelR: 0.40, lift: 0.14, bodyH: 0.68, bodyRise: 0.30,
    hoodZ: 1.95, hoodLen: 1.55, cabinZ: 0.35, cabinLen: 1.70, cabinH: 0.72,
    roof: true, roofLen: 1.60, roofZ: 0.30, rear: 'bed', rearZ: -1.70, rearLen: 2.10, rows: 2 } },
  { key: 'van', label: 'Van / bus', base: {
    wheelbase: 3.05, length: 5.20, width: 1.95, wheelR: 0.36, lift: 0.10, bodyH: 0.70, bodyRise: 0.30,
    hoodZ: 2.25, hoodLen: 0.55, cabinZ: -0.15, cabinLen: 4.10, cabinH: 1.00,
    roof: true, roofLen: 4.30, roofZ: -0.25, rear: 'cargo', rearZ: -2.35, rearLen: 0.30, rows: 2 } },
];

export const DEFAULT_BODY_STYLE = 'sedan';

// How far the top of the air cleaner sits above the engine's centre — used to
// tuck the whole assembly under the hood line. Keep in step with engine().
const ENGINE_TOP_OFFSET = 0.53;

// Turns a body style key (plus an optional real wheelbase in inches) into the
// derived measurements every geometry builder works from.
export function resolveProfile(styleKey, wheelbaseIn) {
  const style = BODY_STYLES.find(s => s.key === styleKey) || BODY_STYLES.find(s => s.key === DEFAULT_BODY_STYLE);
  const p = { ...style.base, style: style.key, styleLabel: style.label };

  // A known wheelbase stretches the whole car around it, keeping the
  // overhangs proportional rather than leaving the body the wrong length.
  const wb = Number(wheelbaseIn) > 0 ? Number(wheelbaseIn) * 0.0254 : 0;
  if (wb > 0) {
    const k = Math.max(0.6, Math.min(1.7, wb / p.wheelbase));
    ['length', 'hoodZ', 'hoodLen', 'cabinZ', 'cabinLen', 'roofLen', 'roofZ', 'rearZ', 'rearLen'].forEach(f => { p[f] *= k; });
    p.wheelbase *= k;
    p.wheelbaseScale = k;
  }

  p.axleF = p.wheelbase / 2;
  p.axleR = -p.wheelbase / 2;
  p.wheelX = p.width / 2 - 0.14;
  p.frameY = p.wheelR + 0.02 + p.lift;
  p.bodyY = p.frameY + p.bodyRise;
  p.bodyTop = p.bodyY + p.bodyH / 2;
  p.roofY = p.bodyTop + p.cabinH + 0.04;
  p.hoodTop = p.bodyTop + 0.175;
  p.engineZ = p.axleF - 0.35;
  // Drop the engine in so its air cleaner just clears the underside of the
  // hood, but never so low that the sump ends up on the floor.
  p.engineY = Math.max(p.frameY + 0.15, p.hoodTop - ENGINE_TOP_OFFSET);
  // Keep the radiator and fan behind the nose of the bodywork.
  p.radiatorZ = Math.min(p.axleF + 0.55, p.length * 0.45 - 0.30);
  p.noseZ = p.length / 2;
  p.tailZ = -p.length / 2;
  p.floorY = p.bodyTop - 0.35;
  // Ceiling the interior has to stay under: the roof on a closed car, or just
  // above the screen line on an open one.
  p.interiorTop = p.roof ? p.roofY - 0.02 : p.bodyTop + p.cabinH + 0.12;
  return p;
}

// --- Guessing the body style ---

// NHTSA's vPIC "Body Class" values, which app.js can pull from a 17-digit VIN.
const BODY_CLASS_MAP = [
  [/pickup|truck-tractor|crew cab|cab chassis/i, 'pickup'],
  [/sport utility|multi-purpose|mpv|suv/i, 'suv'],
  [/van|minivan|bus/i, 'van'],
  [/convertible|roadster|cabriolet|spyder|targa/i, 'convertible'],
  [/wagon|estate/i, 'wagon'],
  [/hatchback|liftback/i, 'hatchback'],
  [/coupe|fastback/i, 'coupe'],
  [/sedan|saloon|limousine/i, 'sedan'],
];
export function bodyClassToStyle(bodyClass) {
  if (!bodyClass) return null;
  const hit = BODY_CLASS_MAP.find(([re]) => re.test(bodyClass));
  return hit ? hit[1] : null;
}

// Fallback for vehicles with no decodable VIN — pre-1981 VINs aren't in vPIC
// at all, which covers most of what gets restored.
const MODEL_HINTS = [
  [/\b(f-?[1-6][05]0|f-?series|silverado|sierra|ram\b|c\/?k ?1[05]00|[ck]-?10\b|d-?[15]00|ranger|tacoma|tundra|colorado|canyon|frontier|titan|hilux|dakota|avalanche|ridgeline|el ?camino|ranchero|apache|3100|pickup|truck)\b/i, 'pickup'],
  [/\b(bronco|blazer|jimmy|wrangler|cherokee|grand ?wagoneer|wagoneer|scout|land ?cruiser|fj ?(40|55|60|62|80)|defender|range ?rover|discovery|4runner|pathfinder|explorer|expedition|tahoe|suburban|yukon|escalade|durango|montero|trooper|samurai|sidekick|xterra|highlander|pilot|rav4|cr-?v|suv)\b/i, 'suv'],
  [/\b(vanagon|transporter|microbus|kombi|westfalia|econoline|e-?[13]50|savana|express|astro|caravan|voyager|odyssey|sienna|sprinter|transit|van|bus)\b/i, 'van'],
  [/\b(convertible|cabriolet|roadster|spider|spyder|miata|mx-?5|boxster|z3|z4|speedster|targa)\b/i, 'convertible'],
  [/\b(wagon|estate|avant|touring|shooting ?brake|nomad|country ?squire|vista ?cruiser)\b/i, 'wagon'],
  [/\b(golf|gti|rabbit|civic ?si|hatch|hatchback|mini ?cooper|fiesta st|focus ?st|wrx ?hatch|veloster|yaris|fit)\b/i, 'hatchback'],
  [/\b(mustang|camaro|corvette|challenger|charger ?r\/?t|firebird|trans ?am|barracuda|cuda|chevelle|gto|340|442|nova|impala ?ss|celica|supra|rx-?7|240sz?|280z|300zx|350z|370z|s2000|integra|prelude|coupe|fastback|gt-?r|skyline|911|cayman|m3|m4)\b/i, 'coupe'],
];
export function guessBodyStyle({ make, model, trim, bodyClass } = {}) {
  const fromVin = bodyClassToStyle(bodyClass);
  if (fromVin) return fromVin;
  const text = [make, model, trim].filter(Boolean).join(' ');
  if (!text.trim()) return DEFAULT_BODY_STYLE;
  const hit = MODEL_HINTS.find(([re]) => re.test(text));
  return hit ? hit[1] : DEFAULT_BODY_STYLE;
}

// --- Layout persistence shape ---
// {
//   version: 1,
//   bodyStyle: 'suv' | null,      // null = fall back to the guess
//   wheelbaseIn: 92 | null,
//   components: { engine: { pos:[x,y,z], scale:[x,y,z], rotY:deg, hidden:bool } }
// }

export const DEFAULT_TRANSFORM = { pos: [0, 0, 0], scale: [1, 1, 1], rotY: 0, hidden: false };

export function normalizeLayout(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const styleKey = BODY_STYLES.some(s => s.key === src.bodyStyle) ? src.bodyStyle : null;
  const wb = Number(src.wheelbaseIn);
  const layout = {
    version: 1,
    bodyStyle: styleKey,
    wheelbaseIn: Number.isFinite(wb) && wb > 0 ? wb : null,
    components: {},
  };
  const components = src.components || {};
  BUILD_COMPONENTS.forEach(({ key }) => {
    const t = components[key] || {};
    layout.components[key] = {
      pos: num3(t.pos, DEFAULT_TRANSFORM.pos),
      scale: num3(t.scale, DEFAULT_TRANSFORM.scale),
      rotY: Number.isFinite(Number(t.rotY)) ? Number(t.rotY) : 0,
      hidden: !!t.hidden,
    };
  });
  return layout;
}
function num3(value, fallback) {
  if (!Array.isArray(value) || value.length !== 3) return fallback.slice();
  return value.map((n, i) => (Number.isFinite(Number(n)) ? Number(n) : fallback[i]));
}
export function isDefaultTransform(t) {
  return t.pos.every(n => n === 0) && t.scale.every(n => n === 1) && t.rotY === 0 && !t.hidden;
}
export function layoutIsCustomized(layout) {
  return Object.values(layout.components).some(t => !isDefaultTransform(t));
}

// --- Scene ---

export async function createBuildViewer(container, options = {}) {
  const THREE = await loadThree();
  // The tab can be navigated away from while three.js is still downloading.
  if (!container.isConnected) return null;

  const onSelect = options.onSelect || (() => {});
  let layout = normalizeLayout(options.layout);
  let profile = options.profile || resolveProfile(DEFAULT_BODY_STYLE);
  let states = {};
  let explode = 0;
  let selectedKey = null;
  let disposed = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);
  scene.fog = new THREE.Fog(0x0f172a, 16, 34);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';

  scene.add(new THREE.HemisphereLight(0xdfeaff, 0x1b2735, 1.15));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
  keyLight.position.set(5, 8, 6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.left = -8;
  keyLight.shadow.camera.right = 8;
  keyLight.shadow.camera.top = 8;
  keyLight.shadow.camera.bottom = -8;
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x9dc3ff, 0.5);
  fillLight.position.set(-6, 4, -5);
  scene.add(fillLight);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.ShadowMaterial({ opacity: 0.35 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(40, 40, 0x3b5473, 0x1e293b);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);

  const carRoot = new THREE.Group();
  scene.add(carRoot);

  let components = [];
  let pickable = [];
  function rebuild() {
    components.forEach(c => {
      carRoot.remove(c.group);
      c.group.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) [].concat(obj.material).forEach(m => m.dispose());
      });
    });
    components = buildCar(THREE, carRoot, profile);
    pickable = [];
    components.forEach(c => c.group.traverse(o => { if (o.isMesh) pickable.push(o); }));
    applyTransforms();
    applyStates();
  }

  // --- Camera controls (orbit / zoom, pointer + touch) ---
  const target = new THREE.Vector3(0, 0.85, 0);
  const home = { yaw: -0.75, pitch: 0.32, distance: 10.5 };
  let yaw = home.yaw;
  let pitch = home.pitch;
  let distance = home.distance;

  function applyCamera() {
    const clampedPitch = Math.max(-0.25, Math.min(1.35, pitch));
    pitch = clampedPitch;
    distance = Math.max(4, Math.min(30, distance));
    camera.position.set(
      target.x + distance * Math.cos(clampedPitch) * Math.sin(yaw),
      target.y + distance * Math.sin(clampedPitch),
      target.z + distance * Math.cos(clampedPitch) * Math.cos(yaw)
    );
    camera.lookAt(target);
  }

  // Long vehicles need the camera further back to stay in frame.
  function homeDistanceFor(p) {
    return Math.max(8, p.length * 2.2);
  }
  function homeTargetFor(p) {
    return new THREE.Vector3(0, p.bodyTop * 0.7, 0);
  }
  home.distance = homeDistanceFor(profile);
  distance = home.distance;
  target.copy(homeTargetFor(profile));
  applyCamera();

  const pointers = new Map();
  let dragDistance = 0;
  let pinchStart = null;

  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) dragDistance = 0;
    if (pointers.size === 2) pinchStart = { spread: pointerSpread(), distance };
    renderer.domElement.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragDistance += Math.abs(dx) + Math.abs(dy);
      yaw -= dx * 0.006;
      pitch += dy * 0.005;
      applyCamera();
    } else if (pointers.size === 2 && pinchStart) {
      dragDistance += 10;
      const spread = pointerSpread();
      if (spread > 0 && pinchStart.spread > 0) {
        distance = pinchStart.distance * (pinchStart.spread / spread);
        applyCamera();
      }
    }
  }
  function onPointerUp(e) {
    const wasSingleTap = pointers.size === 1 && dragDistance < 6;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId);
    if (wasSingleTap) pickAt(e);
  }
  function pointerSpread() {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function onWheel(e) {
    e.preventDefault();
    distance *= e.deltaY > 0 ? 1.1 : 0.9;
    applyCamera();
  }

  const raycaster = new THREE.Raycaster();
  const pointerVec = new THREE.Vector2();
  function pickAt(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointerVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerVec, camera);
    const hit = raycaster.intersectObjects(pickable, false).find(i => i.object.visible && groupVisible(i.object));
    const key = hit ? hit.object.userData.componentKey : null;
    api.select(key);
    onSelect(key);
  }
  function groupVisible(mesh) {
    let node = mesh;
    while (node) {
      if (node.visible === false) return false;
      node = node.parent;
    }
    return true;
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  function applyTransforms() {
    components.forEach(c => {
      const t = layout.components[c.key];
      c.group.position.set(
        t.pos[0] + c.def.explode[0] * explode,
        t.pos[1] + c.def.explode[1] * explode,
        t.pos[2] + c.def.explode[2] * explode
      );
      c.group.scale.set(t.scale[0], t.scale[1], t.scale[2]);
      c.group.rotation.y = (t.rotY * Math.PI) / 180;
      c.group.visible = !t.hidden;
    });
  }
  function applyStates() {
    components.forEach(c => {
      const state = BUILD_STATES[states[c.key]] || BUILD_STATES.empty;
      c.setColor(state.color);
      c.setSelected(c.key === selectedKey);
    });
  }

  rebuild();

  function animate() {
    if (disposed) return;
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();

  const api = {
    setStates(statesByKey) {
      states = statesByKey || {};
      applyStates();
    },
    select(key) {
      selectedKey = key;
      components.forEach(c => c.setSelected(c.key === key));
    },
    setExplode(t) {
      explode = Math.max(0, Math.min(1, Number(t) || 0));
      applyTransforms();
    },
    setLayout(next) {
      layout = normalizeLayout(next);
      applyTransforms();
    },
    setTransform(key, transform) {
      if (!layout.components[key]) return;
      Object.assign(layout.components[key], transform);
      applyTransforms();
    },
    // Swaps in a different body shape without tearing down the scene, so the
    // camera, selection and any layout edits survive the change.
    setProfile(next) {
      profile = next || resolveProfile(DEFAULT_BODY_STYLE);
      rebuild();
      home.distance = homeDistanceFor(profile);
      return profile;
    },
    getProfile() { return profile; },
    getLayout() {
      return JSON.parse(JSON.stringify(layout));
    },
    resetCamera() {
      yaw = home.yaw;
      pitch = home.pitch;
      distance = homeDistanceFor(profile);
      applyCamera();
    },
    focus(key) {
      const component = components.find(c => c.key === key);
      if (!component) return;
      const box = new THREE.Box3().setFromObject(component.group);
      if (box.isEmpty()) return;
      box.getCenter(target);
      distance = Math.max(4.5, box.getSize(new THREE.Vector3()).length() * 1.9);
      applyCamera();
    },
    resetTarget() {
      target.copy(homeTargetFor(profile));
      applyCamera();
    },
    dispose() {
      disposed = true;
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      scene.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) [].concat(obj.material).forEach(m => m.dispose());
      });
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
  return api;
}

// --- Geometry ---

function buildCar(THREE, root, profile) {
  return BUILD_COMPONENTS.map(def => {
    const group = new THREE.Group();
    group.name = def.key;
    root.add(group);

    // One material set per component, so recolouring on a status change is a
    // handful of assignments rather than a walk over every mesh.
    const materials = {
      base: new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.35, roughness: 0.55 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.4, roughness: 0.7 }),
      light: new THREE.MeshStandardMaterial({ color: 0xc3ccd8, metalness: 0.25, roughness: 0.4 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.1, roughness: 0.1, transparent: true, opacity: 0.28 }),
    };

    const ctx = {
      THREE,
      p: profile,
      group,
      materials,
      add(geometry, shade, position, rotation) {
        const mesh = new THREE.Mesh(geometry, materials[shade || 'base']);
        if (position) mesh.position.set(position[0], position[1], position[2]);
        if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.componentKey = def.key;
        group.add(mesh);
        return mesh;
      },
      box(w, h, d, shade, position, rotation) {
        return ctx.add(new THREE.BoxGeometry(Math.abs(w) || 0.01, Math.abs(h) || 0.01, Math.abs(d) || 0.01), shade, position, rotation);
      },
      cyl(radius, height, shade, position, rotation, radiusBottom) {
        return ctx.add(new THREE.CylinderGeometry(radius, radiusBottom == null ? radius : radiusBottom, Math.abs(height) || 0.01, 24), shade, position, rotation);
      },
      // Mirrors a builder across the car's centreline — most of the car is
      // symmetric, so this halves the geometry code.
      pair(fn) { fn(1); fn(-1); },
      corners(fn) { [profile.axleF, profile.axleR].forEach(z => { fn(1, z); fn(-1, z); }); },
    };

    GEOMETRY_BUILDERS[def.key](ctx);

    return {
      key: def.key,
      def,
      group,
      setColor(hex) {
        const base = new THREE.Color(hex);
        materials.base.color.copy(base);
        materials.dark.color.copy(base).multiplyScalar(0.62);
        materials.light.color.copy(base).lerp(new THREE.Color(0xffffff), 0.45);
        materials.glass.color.copy(base).lerp(new THREE.Color(0xffffff), 0.3);
      },
      setSelected(on) {
        Object.values(materials).forEach(m => {
          m.emissive.copy(m.color).multiplyScalar(on ? 0.55 : 0);
        });
      },
    };
  });
}

const GEOMETRY_BUILDERS = {
  frame(c) {
    const p = c.p;
    const railLen = p.length * 0.86;
    const railX = p.width * 0.31;
    c.pair(side => c.box(0.13, 0.16, railLen, 'base', [side * railX, p.frameY, 0]));
    [-0.42, -0.18, 0.12, 0.34].forEach(f => c.box(railX * 1.9, 0.1, 0.13, 'dark', [0, p.frameY, f * railLen]));
    // Firewall bulkhead, just behind the engine bay.
    c.box(p.width * 0.82, 0.55, 0.06, 'dark', [0, p.frameY + 0.26, p.engineZ - 0.75]);
    // Kick-ups so the rails clear the rear axle.
    c.pair(side => c.box(0.13, 0.3, 0.5, 'dark', [side * railX, p.frameY + 0.19, p.axleR]));
    // Engine and transmission mounts.
    c.pair(side => c.box(0.16, 0.22, 0.16, 'light', [side * 0.42, p.frameY + 0.16, p.engineZ + 0.05]));
    c.box(0.5, 0.1, 0.16, 'light', [0, p.frameY + 0.06, p.engineZ - 1.15]);
  },

  engine(c) {
    const p = c.p, y = p.engineY, z = p.engineZ;
    c.box(0.70, 0.48, 0.78, 'base', [0, y, z]);               // block
    c.box(0.74, 0.12, 0.72, 'light', [0, y + 0.30, z]);       // head
    c.box(0.50, 0.10, 0.60, 'light', [0, y + 0.41, z]);       // valve cover
    c.box(0.44, 0.14, 0.50, 'dark', [0, y + 0.46, z]);        // intake / air cleaner
    c.box(0.62, 0.16, 0.60, 'dark', [0, y - 0.30, z - 0.05]); // oil pan
    c.cyl(0.16, 0.10, 'light', [0, y, z + 0.45], [0, 0, Math.PI / 2]); // crank pulley
    c.box(0.90, 0.50, 0.12, 'dark', [0, y + 0.06, p.radiatorZ]);       // radiator
    c.cyl(0.20, 0.12, 'light', [0, y + 0.06, p.radiatorZ - 0.13], [0, 0, Math.PI / 2]); // fan
    c.pair(side => c.cyl(0.07, 0.75, 'dark', [side * 0.42, y - 0.14, z - 0.10], [Math.PI / 2, 0, 0])); // manifolds
  },

  drivetrain(c) {
    const p = c.p, y = p.frameY;
    c.box(0.46, 0.42, 0.75, 'base', [0, y + 0.36, p.engineZ - 0.70]);  // bellhousing
    c.box(0.34, 0.32, 0.62, 'base', [0, y + 0.30, p.engineZ - 1.25]);  // trans case
    c.box(0.30, 0.16, 0.30, 'light', [0, y + 0.26, p.engineZ - 0.40]); // flexplate housing
    // Driveshaft spans whatever gap the wheelbase leaves between the
    // transmission tail and the rear axle.
    const shaftFront = p.engineZ - 1.55;
    const shaftLen = Math.max(0.3, shaftFront - p.axleR);
    c.cyl(0.07, shaftLen, 'light', [0, y + 0.14, (shaftFront + p.axleR) / 2], [Math.PI / 2, 0, 0]);
    c.cyl(0.10, 0.12, 'dark', [0, y + 0.14, shaftFront], [Math.PI / 2, 0, 0]);  // u-joint
    c.cyl(0.26, 0.30, 'base', [0, y + 0.06, p.axleR], [Math.PI / 2, 0, 0]);     // differential
    const axleLen = Math.max(0.2, p.wheelX - 0.15);
    c.pair(side => c.cyl(0.07, axleLen, 'dark', [side * (0.15 + axleLen / 2), y + 0.06, p.axleR], [0, 0, Math.PI / 2]));
  },

  suspension(c) {
    const p = c.p;
    c.corners((side, z) => {
      c.cyl(p.wheelR, 0.26, 'dark', [side * p.wheelX, p.wheelR, z], [0, 0, Math.PI / 2]);          // tyre
      c.cyl(p.wheelR * 0.62, 0.28, 'light', [side * p.wheelX, p.wheelR, z], [0, 0, Math.PI / 2]);  // rim
      c.cyl(0.12, 0.42, 'base', [side * (p.wheelX - 0.22), p.wheelR + 0.34 + p.lift, z]);          // coil spring
      c.cyl(0.05, 0.50, 'light', [side * (p.wheelX - 0.22), p.wheelR + 0.38 + p.lift, z]);         // shock rod
      c.box(0.50, 0.08, 0.14, 'base', [side * (p.wheelX - 0.27), p.wheelR + 0.01, z]);             // lower arm
      c.box(0.42, 0.07, 0.12, 'base', [side * (p.wheelX - 0.32), p.wheelR + 0.26, z]);             // upper arm
    });
    c.box(p.width * 0.82, 0.08, 0.10, 'base', [0, p.frameY + 0.19, p.axleF - 0.20]);  // steering rack
    c.box(p.width * 0.79, 0.07, 0.08, 'dark', [0, p.frameY - 0.06, p.axleF + 0.25]);  // front sway bar
    c.box(p.width * 0.79, 0.07, 0.08, 'dark', [0, p.frameY - 0.06, p.axleR - 0.25]);  // rear sway bar
    c.cyl(0.05, 0.55, 'light', [0.20, p.frameY + 0.39, p.axleF - 0.35], [0, 0, Math.PI / 3]); // steering shaft
  },

  brakes(c) {
    const p = c.p;
    c.corners((side, z) => {
      c.cyl(p.wheelR * 0.8, 0.04, 'light', [side * (p.wheelX - 0.05), p.wheelR, z], [0, 0, Math.PI / 2]); // rotor
      c.box(0.10, 0.20, 0.16, 'base', [side * (p.wheelX - 0.12), p.wheelR + 0.16, z]);                    // caliper
      c.cyl(0.02, 0.40, 'dark', [side * (p.wheelX - 0.22), p.wheelR + 0.25, z], [0, 0, Math.PI / 2.4]);   // flex line
    });
    c.box(0.26, 0.16, 0.20, 'base', [-0.35, p.frameY + 0.42, p.engineZ - 0.63]);                     // master cylinder
    c.cyl(0.14, 0.22, 'dark', [-0.35, p.frameY + 0.42, p.engineZ - 0.43], [Math.PI / 2, 0, 0]);      // booster
    const lineLen = Math.max(0.5, p.wheelbase - 0.2);
    c.pair(side => c.cyl(0.02, lineLen, 'dark', [side * (p.width * 0.36), p.frameY - 0.06, 0], [Math.PI / 2, 0, 0])); // hard lines
  },

  electrical(c) {
    const p = c.p, y = p.engineY, z = p.engineZ;
    c.box(0.34, 0.26, 0.22, 'base', [p.width * 0.32, y + 0.04, z + 0.65]);      // battery
    c.cyl(0.14, 0.22, 'light', [0.50, y + 0.24, z + 0.20], [0, 0, Math.PI / 2]); // alternator
    c.cyl(0.11, 0.30, 'dark', [-0.50, y - 0.18, z - 0.15], [0, 0, Math.PI / 2]); // starter
    c.box(0.20, 0.18, 0.12, 'base', [-p.width * 0.34, y - 0.03, z - 0.60]);     // fuse box
    c.box(0.30, 0.14, 0.10, 'light', [0, y + 0.40, z - 0.70]);                  // coil / ignition
    // Wiring loom down the driver's rail and out to the tail lights.
    const loomLen = Math.max(0.6, p.wheelbase);
    c.cyl(0.035, loomLen, 'dark', [-p.width * 0.36, p.frameY + 0.11, 0], [Math.PI / 2, 0, 0]);
    const tailRun = Math.max(0.4, Math.abs(p.tailZ - p.axleR));
    c.cyl(0.03, tailRun, 'dark', [0, p.frameY + 0.11, (p.tailZ + p.axleR) / 2], [Math.PI / 2, 0, 0]);
    c.pair(side => c.box(0.12, 0.10, 0.10, 'light', [side * (p.width * 0.36), y + 0.17, p.radiatorZ - 0.05]));
  },

  interior(c) {
    const p = c.p;
    const cabFront = p.cabinZ + p.cabinLen / 2;
    const cabBack = p.cabinZ - p.cabinLen / 2;
    c.box(p.width * 0.86, 0.05, p.cabinLen, 'dark', [0, p.floorY, p.cabinZ]);   // floor
    c.box(p.width * 0.84, 0.24, 0.30, 'light', [0, p.floorY + 0.37, cabFront - 0.35]); // dash
    c.box(0.36, 0.14, 0.20, 'base', [0, p.floorY + 0.44, cabFront - 0.50]);            // centre stack
    c.add(new c.THREE.TorusGeometry(0.17, 0.028, 12, 28), 'base',
      [0.38, p.floorY + 0.42, cabFront - 0.62], [Math.PI / 2.6, 0, 0]);                // steering wheel

    // Seats are sized to whatever headroom the cabin actually has, so a
    // roadster's headrests don't stand up where its roof would have been.
    const seatY = p.floorY + 0.20;
    const backH = Math.min(0.62, Math.max(0.25, p.interiorTop - 0.16 - (seatY + 0.06)));
    const backY = seatY + 0.06 + backH / 2;
    const headY = Math.min(backY + backH / 2 + 0.10, p.interiorTop - 0.10);

    // Rows spaced back from the dash; a roadster only gets the front pair.
    const rowSpacing = Math.min(0.95, p.cabinLen * 0.42);
    for (let row = 0; row < p.rows; row++) {
      const z = cabFront - 1.05 - row * rowSpacing;
      if (z < cabBack + 0.15) break;
      c.pair(side => {
        c.box(0.50, 0.12, 0.50, 'base', [side * (p.width * 0.23), seatY, z]);
        c.box(0.50, backH, 0.12, 'base', [side * (p.width * 0.23), backY, z - 0.27]);
        c.box(0.28, 0.20, 0.12, 'light', [side * (p.width * 0.23), headY, z - 0.25]);
      });
    }
    c.box(0.30, 0.14, Math.min(1.3, p.cabinLen * 0.6), 'dark', [0, p.floorY + 0.12, p.cabinZ]); // console
    c.box(p.width * 0.80, 0.50, 0.10, 'dark', [0, p.floorY + 0.37, cabBack + 0.05]);            // bulkhead
  },

  body(c) {
    const p = c.p;
    const cabFront = p.cabinZ + p.cabinLen / 2;
    const cabBack = p.cabinZ - p.cabinLen / 2;
    c.box(p.width, p.bodyH, p.length * 0.90, 'base', [0, p.bodyY, 0]);                 // lower body
    c.box(p.width * 0.94, 0.20, p.hoodLen, 'base', [0, p.bodyTop + 0.075, p.hoodZ]);   // hood
    c.box(p.width * 0.92, p.cabinH, p.cabinLen, 'base', [0, p.bodyTop + p.cabinH / 2, p.cabinZ]); // cabin

    if (p.roof) {
      c.box(p.width * 0.82, 0.08, p.roofLen, 'light', [0, p.roofY, p.roofZ]);
      c.pair(side => c.box(0.06, p.cabinH * 0.78, p.cabinLen * 0.78, 'glass',
        [side * (p.width * 0.46), p.bodyTop + p.cabinH * 0.58, p.cabinZ]));            // side glass
      c.box(p.width * 0.78, p.cabinH * 0.78, 0.08, 'glass', [0, p.bodyTop + p.cabinH * 0.58, cabFront], [-0.45, 0, 0]);
      c.box(p.width * 0.76, p.cabinH * 0.72, 0.08, 'glass', [0, p.bodyTop + p.cabinH * 0.58, cabBack], [0.45, 0, 0]);
    } else {
      // Open car: a low screen and a roll hoop instead of a roof.
      const screenY = p.bodyTop + p.cabinH * 0.5 + 0.12;
      c.box(p.width * 0.72, 0.30, 0.06, 'glass', [0, screenY, cabFront], [-0.35, 0, 0]);
      c.pair(side => c.box(0.10, 0.30, 0.10, 'light', [side * (p.width * 0.26), screenY, cabBack + 0.1]));
    }

    if (p.rear === 'trunk') {
      c.box(p.width * 0.94, 0.20, p.rearLen, 'base', [0, p.bodyTop + 0.075, p.rearZ]);
    } else if (p.rear === 'cargo') {
      // Roof carries back over the load area; add the tailgate panel.
      c.box(p.width * 0.92, p.cabinH, p.rearLen, 'base', [0, p.bodyTop + p.cabinH / 2, p.rearZ]);
      c.box(p.width * 0.88, p.cabinH * 0.6, 0.08, 'glass', [0, p.bodyTop + p.cabinH * 0.65, p.rearZ - p.rearLen / 2]);
    } else if (p.rear === 'bed') {
      const bedY = p.bodyTop;
      const wallH = 0.44;
      c.box(p.width * 0.94, 0.08, p.rearLen, 'dark', [0, bedY + 0.04, p.rearZ]);                       // bed floor
      c.pair(side => c.box(0.09, wallH, p.rearLen, 'base', [side * (p.width * 0.45), bedY + wallH / 2, p.rearZ])); // bed sides
      c.box(p.width * 0.92, wallH, 0.09, 'base', [0, bedY + wallH / 2, p.rearZ - p.rearLen / 2]);       // tailgate
      c.box(p.width * 0.92, wallH, 0.09, 'base', [0, bedY + wallH / 2, p.rearZ + p.rearLen / 2]);       // bed front wall
    }

    // Fender arches standing proud of the body over each wheel.
    c.corners((side, z) => c.box(0.12, p.bodyH * 0.9, p.wheelR * 2.8, 'light', [side * (p.width * 0.5), p.bodyY - 0.07, z]));
  },

  trim(c) {
    const p = c.p;
    const bumperY = p.bodyY - p.bodyH * 0.24;
    c.box(p.width * 1.02, 0.24, 0.20, 'base', [0, bumperY, p.noseZ - 0.10]);   // front bumper
    c.box(p.width * 1.02, 0.24, 0.20, 'base', [0, bumperY, p.tailZ + 0.10]);   // rear bumper
    c.box(p.width * 0.70, 0.28, 0.10, 'dark', [0, p.bodyTop - 0.12, p.noseZ - 0.14]); // grille
    c.pair(side => c.cyl(0.16, 0.10, 'light', [side * (p.width * 0.36), p.bodyTop - 0.07, p.noseZ - 0.12], [Math.PI / 2, 0, 0])); // headlights
    c.pair(side => c.box(0.42, 0.16, 0.08, 'light', [side * (p.width * 0.33), p.bodyTop, p.tailZ + 0.12]));                       // tail lights
    c.pair(side => c.box(0.16, 0.10, 0.06, 'light', [side * (p.width * 0.50), p.bodyTop + p.cabinH * 0.5, p.cabinZ + p.cabinLen / 2 - 0.15])); // mirrors
    c.pair(side => c.box(0.04, 0.06, p.length * 0.54, 'light', [side * (p.width * 0.50), p.bodyY + 0.13, 0]));                    // side moulding
    // Exhaust from under the engine out past the rear bumper.
    const pipeFront = p.engineZ - 0.4;
    const pipeLen = Math.max(0.6, pipeFront - (p.tailZ + 0.2));
    c.pair(side => c.cyl(0.05, pipeLen, 'dark', [side * 0.45, p.frameY - 0.11, pipeFront - pipeLen / 2], [Math.PI / 2, 0, 0]));
    c.pair(side => c.cyl(0.07, 0.30, 'light', [side * 0.45, p.frameY - 0.11, p.tailZ + 0.05], [Math.PI / 2, 0, 0]));
  },
};
