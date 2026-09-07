// --- 3D build viewer ---
//
// Builds a generic vehicle out of primitives, grouped into the systems people
// actually track parts for (frame, engine, drivetrain, suspension, brakes,
// body, interior, electrical, trim). Each group is coloured by how far along
// that system's parts are, can be exploded away from the car, hidden, and —
// in edit mode — nudged/resized so the mock-up matches the real vehicle.
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

// --- Layout persistence shape ---
// { version: 1, components: { engine: { pos:[x,y,z], scale:[x,y,z], rotY:deg, hidden:bool } } }

export const DEFAULT_TRANSFORM = { pos: [0, 0, 0], scale: [1, 1, 1], rotY: 0, hidden: false };

export function normalizeLayout(raw) {
  const layout = { version: 1, components: {} };
  const src = (raw && raw.components) || {};
  BUILD_COMPONENTS.forEach(({ key }) => {
    const t = src[key] || {};
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

  const components = buildCar(THREE, carRoot);
  const pickable = [];
  components.forEach(c => c.group.traverse(o => { if (o.isMesh) pickable.push(o); }));

  // --- Camera controls (orbit / pan-free zoom, pointer + touch) ---
  const target = new THREE.Vector3(0, 0.85, 0);
  const home = { yaw: -0.75, pitch: 0.32, distance: 10.5 };
  let yaw = home.yaw;
  let pitch = home.pitch;
  let distance = home.distance;

  function applyCamera() {
    const clampedPitch = Math.max(-0.25, Math.min(1.35, pitch));
    pitch = clampedPitch;
    distance = Math.max(4, Math.min(24, distance));
    camera.position.set(
      target.x + distance * Math.cos(clampedPitch) * Math.sin(yaw),
      target.y + distance * Math.sin(clampedPitch),
      target.z + distance * Math.cos(clampedPitch) * Math.cos(yaw)
    );
    camera.lookAt(target);
  }
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
  applyTransforms();

  function animate() {
    if (disposed) return;
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();

  const api = {
    setStates(statesByKey) {
      components.forEach(c => {
        const state = BUILD_STATES[statesByKey[c.key]] || BUILD_STATES.empty;
        c.setColor(state.color);
      });
      api.select(selectedKey);
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
    getLayout() {
      return JSON.parse(JSON.stringify(layout));
    },
    resetCamera() {
      yaw = home.yaw;
      pitch = home.pitch;
      distance = home.distance;
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
      target.set(0, 0.85, 0);
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
//
// Rough production-car proportions in metres: 4.5m long, 1.85m wide, wheels on
// a 2.8m wheelbase. Front of the car is +Z, up is +Y, right side is +X.

const WHEEL_X = 0.82;
const AXLE_F = 1.4;
const AXLE_R = -1.4;
const WHEEL_R = 0.34;

function buildCar(THREE, root) {
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
        return ctx.add(new THREE.BoxGeometry(w, h, d), shade, position, rotation);
      },
      cyl(radius, height, shade, position, rotation, radiusBottom) {
        return ctx.add(new THREE.CylinderGeometry(radius, radiusBottom == null ? radius : radiusBottom, height, 24), shade, position, rotation);
      },
      // Mirrors a builder across the car's centreline — most of the car is
      // symmetric, so this halves the geometry code.
      pair(fn) { fn(1); fn(-1); },
      corners(fn) { [AXLE_F, AXLE_R].forEach(z => { fn(1, z); fn(-1, z); }); },
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
    // Two full-length rails plus crossmembers and the firewall bulkhead.
    c.pair(side => c.box(0.13, 0.16, 4.15, 'base', [side * 0.58, 0.36, -0.05]));
    [-1.75, -0.85, 0.35, 1.35, 1.95].forEach(z => c.box(1.2, 0.1, 0.13, 'dark', [0, 0.36, z]));
    c.box(1.55, 0.55, 0.06, 'dark', [0, 0.62, 0.25]);
    // Kick-ups over the rear axle so the rails clear the diff.
    c.pair(side => c.box(0.13, 0.3, 0.5, 'dark', [side * 0.58, 0.55, -1.4]));
    // Engine and transmission mounts.
    c.pair(side => c.box(0.16, 0.22, 0.16, 'light', [side * 0.42, 0.52, 1.1]));
    c.box(0.5, 0.1, 0.16, 'light', [0, 0.42, -0.1]);
  },

  engine(c) {
    c.box(0.7, 0.6, 0.78, 'base', [0, 0.88, 1.05]);           // block
    c.box(0.74, 0.16, 0.72, 'light', [0, 1.24, 1.05]);        // head
    c.box(0.5, 0.14, 0.6, 'light', [0, 1.38, 1.05]);          // valve cover
    c.box(0.44, 0.2, 0.5, 'dark', [0, 1.55, 1.05]);           // intake / air cleaner
    c.box(0.62, 0.2, 0.6, 'dark', [0, 0.5, 1.0]);             // oil pan
    c.cyl(0.16, 0.1, 'light', [0, 0.88, 1.5], [0, 0, Math.PI / 2]); // crank pulley
    c.box(0.9, 0.6, 0.12, 'dark', [0, 0.95, 1.95]);           // radiator
    c.cyl(0.22, 0.12, 'light', [0, 0.95, 1.82], [0, 0, Math.PI / 2]); // fan
    // Exhaust manifolds running back along each side of the block.
    c.pair(side => c.cyl(0.07, 0.75, 'dark', [side * 0.42, 0.72, 0.95], [Math.PI / 2, 0, 0]));
  },

  drivetrain(c) {
    c.box(0.46, 0.42, 0.75, 'base', [0, 0.72, 0.35]);         // bellhousing
    c.box(0.34, 0.32, 0.62, 'base', [0, 0.66, -0.2]);         // trans case
    c.cyl(0.07, 1.5, 'light', [0, 0.5, -1.05], [Math.PI / 2, 0, 0]); // driveshaft
    c.cyl(0.1, 0.12, 'dark', [0, 0.5, -0.5], [Math.PI / 2, 0, 0]);   // u-joint
    c.cyl(0.26, 0.3, 'base', [0, 0.42, AXLE_R], [Math.PI / 2, 0, 0]); // differential
    c.pair(side => c.cyl(0.07, 0.62, 'dark', [side * 0.5, 0.42, AXLE_R], [0, 0, Math.PI / 2])); // axle shafts
    c.box(0.3, 0.16, 0.3, 'light', [0, 0.62, 0.72]);          // clutch / flexplate housing
  },

  suspension(c) {
    c.corners((side, z) => {
      c.cyl(WHEEL_R, 0.26, 'dark', [side * WHEEL_X, WHEEL_R, z], [0, 0, Math.PI / 2]);          // tyre
      c.cyl(WHEEL_R * 0.62, 0.28, 'light', [side * WHEEL_X, WHEEL_R, z], [0, 0, Math.PI / 2]);  // rim
      c.cyl(0.12, 0.42, 'base', [side * 0.6, 0.68, z]);                                          // coil spring
      c.cyl(0.05, 0.5, 'light', [side * 0.6, 0.72, z]);                                          // shock rod
      c.box(0.5, 0.08, 0.14, 'base', [side * 0.55, 0.35, z]);                                    // lower control arm
      c.box(0.42, 0.07, 0.12, 'base', [side * 0.5, 0.62, z]);                                    // upper control arm
    });
    c.box(1.5, 0.08, 0.1, 'base', [0, 0.55, AXLE_F - 0.2]);   // steering rack
    c.box(1.45, 0.07, 0.08, 'dark', [0, 0.3, AXLE_F + 0.25]); // front sway bar
    c.box(1.45, 0.07, 0.08, 'dark', [0, 0.3, AXLE_R - 0.25]); // rear sway bar
    c.cyl(0.05, 0.55, 'light', [0.2, 0.75, AXLE_F - 0.35], [0, 0, Math.PI / 3]); // steering shaft
  },

  brakes(c) {
    c.corners((side, z) => {
      c.cyl(0.27, 0.04, 'light', [side * (WHEEL_X - 0.05), WHEEL_R, z], [0, 0, Math.PI / 2]); // rotor
      c.box(0.1, 0.2, 0.16, 'base', [side * (WHEEL_X - 0.12), WHEEL_R + 0.16, z]);            // caliper
      c.cyl(0.02, 0.4, 'dark', [side * 0.6, WHEEL_R + 0.25, z], [0, 0, Math.PI / 2.4]);       // flex line
    });
    c.box(0.26, 0.16, 0.2, 'base', [-0.35, 0.78, 0.42]);   // master cylinder
    c.cyl(0.14, 0.22, 'dark', [-0.35, 0.78, 0.62], [Math.PI / 2, 0, 0]); // booster
    c.pair(side => c.cyl(0.02, 2.6, 'dark', [side * 0.66, 0.3, -0.2], [Math.PI / 2, 0, 0])); // hard lines
  },

  electrical(c) {
    c.box(0.34, 0.26, 0.22, 'base', [0.6, 0.92, 1.7]);       // battery
    c.cyl(0.14, 0.22, 'light', [0.5, 1.12, 1.25], [0, 0, Math.PI / 2]); // alternator
    c.cyl(0.11, 0.3, 'dark', [-0.5, 0.7, 0.9], [0, 0, Math.PI / 2]);    // starter
    c.box(0.2, 0.18, 0.12, 'base', [-0.62, 0.85, 0.45]);     // fuse box
    // Wiring loom down the driver's rail and out to the tail.
    c.cyl(0.035, 2.9, 'dark', [-0.66, 0.47, 0.1], [Math.PI / 2, 0, 0]);
    c.cyl(0.03, 1.2, 'dark', [0, 0.47, -1.9], [Math.PI / 2, 0, 0]);
    c.box(0.3, 0.14, 0.1, 'light', [0, 1.28, 0.35]);         // coil / ignition module
    c.pair(side => c.box(0.12, 0.1, 0.1, 'light', [side * 0.75, 1.05, 1.95])); // headlight connectors
  },

  interior(c) {
    c.box(1.6, 0.05, 1.9, 'dark', [0, 0.78, -0.15]);         // floor
    c.pair(side => {
      c.box(0.5, 0.12, 0.5, 'base', [side * 0.42, 0.98, -0.25]);  // seat base
      c.box(0.5, 0.62, 0.12, 'base', [side * 0.42, 1.3, -0.52]);  // seat back
      c.box(0.28, 0.2, 0.12, 'light', [side * 0.42, 1.68, -0.5]); // headrest
    });
    c.box(1.55, 0.24, 0.3, 'light', [0, 1.15, 0.65]);        // dash
    c.box(0.36, 0.14, 0.2, 'base', [0, 1.22, 0.5]);          // centre stack
    c.add(new c.THREE.TorusGeometry(0.17, 0.028, 12, 28), 'base', [0.38, 1.2, 0.38], [Math.PI / 2.6, 0, 0]); // steering wheel
    c.box(0.3, 0.14, 1.3, 'dark', [0, 0.9, -0.25]);          // console
    c.box(1.5, 0.5, 0.1, 'dark', [0, 1.15, -1.15]);          // rear bulkhead
  },

  body(c) {
    c.box(1.86, 0.55, 4.3, 'base', [0, 0.85, 0]);            // lower body
    c.box(1.72, 0.2, 1.3, 'base', [0, 1.2, 1.35]);           // hood
    c.box(1.72, 0.2, 1.05, 'base', [0, 1.2, -1.6]);          // deck lid
    c.box(1.68, 0.62, 2.0, 'base', [0, 1.42, -0.15]);        // cabin
    c.box(1.5, 0.08, 1.7, 'light', [0, 1.76, -0.25]);        // roof
    c.pair(side => c.box(0.06, 0.5, 1.55, 'glass', [side * 0.84, 1.46, -0.25])); // side glass
    c.box(1.45, 0.5, 0.08, 'glass', [0, 1.46, 0.82], [-0.5, 0, 0]);              // windscreen
    c.box(1.4, 0.45, 0.08, 'glass', [0, 1.46, -1.25], [0.45, 0, 0]);             // rear glass
    // Fender arches sitting proud of the body at each wheel.
    c.corners((side, z) => c.box(0.12, 0.5, 0.95, 'light', [side * 0.93, 0.78, z]));
  },

  trim(c) {
    c.box(1.9, 0.24, 0.2, 'base', [0, 0.72, 2.2]);           // front bumper
    c.box(1.9, 0.24, 0.2, 'base', [0, 0.72, -2.2]);          // rear bumper
    c.box(1.3, 0.28, 0.1, 'dark', [0, 1.0, 2.16]);           // grille
    c.pair(side => c.cyl(0.16, 0.1, 'light', [side * 0.66, 1.05, 2.18], [Math.PI / 2, 0, 0])); // headlights
    c.pair(side => c.box(0.42, 0.16, 0.08, 'light', [side * 0.6, 1.12, -2.18]));               // tail lights
    c.pair(side => c.box(0.16, 0.1, 0.06, 'light', [side * 1.0, 1.4, 0.6]));                   // mirrors
    c.pair(side => c.box(0.04, 0.06, 2.6, 'light', [side * 0.95, 1.12, -0.1]));                // side moulding
    c.pair(side => c.cyl(0.05, 2.2, 'dark', [side * 0.45, 0.25, -1.0], [Math.PI / 2, 0, 0]));  // exhaust
    c.pair(side => c.cyl(0.07, 0.3, 'light', [side * 0.45, 0.25, -2.25], [Math.PI / 2, 0, 0])); // tips
  },
};
