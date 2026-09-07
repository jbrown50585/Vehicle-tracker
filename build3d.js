// --- 3D build viewer ---
//
// Builds the vehicle out of parametric bodywork, grouped into the systems
// people actually track parts for (frame, engine, drivetrain, suspension,
// brakes, body, interior, electrical, trim). Each group is coloured by how far
// along that system's parts are, can be exploded away from the car, hidden,
// and — in edit mode — nudged so the mock-up matches the real vehicle.
//
// The body is not a stack of boxes. Each platform is described by its side
// silhouette in inches — rocker, nose, hood, cowl, beltline, roof, backlight,
// deck — and the shell is extruded across the car from that outline with
// rounded edges and cut-out window openings. That is what makes a Beetle read
// as a Beetle, and it is also what makes the modifications real: a 4in chop
// lowers the roofline by exactly 4in and lays the pillars back with it,
// because the roof is a number in the outline rather than a fixed mesh.
//
// three.js is pulled in lazily so the ~600KB only downloads when someone
// actually opens the 3D tab.

let threePromise = null;
function loadThree() {
  if (!threePromise) threePromise = import('https://esm.sh/three@0.169.0');
  return threePromise;
}

const IN = 0.0254;  // inches to metres — every platform dimension is in inches

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

// Components bolted to the body rather than the wheels. Lowering one end of
// the car pitches these and leaves the wheels where they are.
const CHASSIS_COMPONENTS = ['frame', 'engine', 'drivetrain', 'electrical', 'interior', 'body', 'trim'];

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

// --- Platforms ---
//
// `sil` is the side view, looking at the driver's door. Heights are inches
// above the ground; Z positions are fractions of half the car's length, so
// +1 is the front bumper, 0 the middle and -1 the tail.
//
//   rocker      bottom edge of the bodywork
//   nose/hood   front sheetmetal height at the bumper and at the hood
//   cowl        where the windscreen meets the body
//   belt        beltline — the bottom of the side windows
//   roof        roofline
//   wsTop       top of the windscreen (how far back the screen rakes)
//   roofRear    back of the roof
//   backlight   bottom of the rear glass
//   deck        top of the rear bodywork (boot lid, bed floor, engine lid)
//   tail        rear sheetmetal height at the bumper
//   round       0-1, how soft the edges and corners are

const PLATFORM_DEFS = [
  // --- Specific platforms people actually restore ---
  { key: 'vw-beetle', label: 'VW Beetle / Bug', group: 'Platforms',
    match: /\b(beetle|bug|type ?1|k[aä]fer|super ?beetle)\b/i,
    lengthIn: 160.6, widthIn: 61, wheelbaseIn: 94.5, tireDiaIn: 25, wheelDiaIn: 15,
    enginePos: 'rear', cooling: 'air', fenders: 'separate', rear: 'trunk', rows: 2,
    sil: { rocker: 8, nose: 26, hood: 31, hoodFront: 0.45, cowl: 0.12, belt: 40,
      roof: 59, wsTop: -0.02, roofRear: -0.30, backlight: -0.42, deckStart: -0.46,
      deck: 43, tail: 30, round: 0.95 } },
  // Cab-forward: the screen sits almost over the front axle, so the "hood" is
  // a short steep nose rather than a bonnet running back to the cowl.
  { key: 'vw-bus', label: 'VW Bus / Transporter', group: 'Platforms',
    match: /\b(bus|transporter|type ?2|kombi|microbus|westfalia|vanagon|splitty|bay ?window)\b/i,
    lengthIn: 168, widthIn: 68, wheelbaseIn: 94.5, tireDiaIn: 26, wheelDiaIn: 15,
    enginePos: 'rear', cooling: 'air', fenders: 'integrated', rear: 'cargo', rows: 3,
    sil: { rocker: 11, nose: 44, hood: 50, hoodFront: 0.94, cowl: 0.86, belt: 50,
      roof: 76, wsTop: 0.66, roofRear: -0.88, backlight: -0.90, deckStart: -0.94,
      deck: 52, tail: 46, round: 0.5 } },
  { key: 'early-bronco', label: 'Early Bronco / 4x4', group: 'Platforms',
    match: /\b(bronco|scout|blazer|jimmy|land ?cruiser|fj ?(40|43|45|55)|series ?(i|ii|iii)|defender)\b/i,
    lengthIn: 152.1, widthIn: 68.8, wheelbaseIn: 92, tireDiaIn: 31, wheelDiaIn: 15,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'cargo', rows: 2,
    sil: { rocker: 15, nose: 40, hood: 43, hoodFront: 0.62, cowl: 0.18, belt: 48,
      roof: 71, wsTop: 0.10, roofRear: -0.72, backlight: -0.76, deckStart: -0.82,
      deck: 50, tail: 44, round: 0.2 } },
  { key: 'mustang-fastback', label: 'Mustang / pony car', group: 'Platforms',
    match: /\b(mustang|camaro|firebird|trans ?am|barracuda|cuda|challenger|javelin|pony)\b/i,
    lengthIn: 181.6, widthIn: 68.2, wheelbaseIn: 108, tireDiaIn: 26, wheelDiaIn: 15,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'trunk', rows: 2,
    sil: { rocker: 8, nose: 29, hood: 33, hoodFront: 0.55, cowl: 0.05, belt: 38,
      roof: 51, wsTop: -0.14, roofRear: -0.55, backlight: -0.60, deckStart: -0.66,
      deck: 42, tail: 36, round: 0.35 } },
  { key: 'c10', label: 'C10 / classic pickup', group: 'Platforms',
    match: /\b(c-?10|k-?10|c\/?k ?1[05]00|f-?[1-6][05]0|f-?series|apache|3100|d-?[15]00|silverado|sierra|stepside|fleetside)\b/i,
    lengthIn: 190, widthIn: 79, wheelbaseIn: 115, tireDiaIn: 29, wheelDiaIn: 15,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'bed', rows: 1,
    sil: { rocker: 13, nose: 36, hood: 40, hoodFront: 0.62, cowl: 0.10, belt: 46,
      roof: 70, wsTop: -0.02, roofRear: -0.26, backlight: -0.28, deckStart: -0.32,
      deck: 46, tail: 46, round: 0.2 } },
  { key: 'tri-five', label: 'Tri-Five / 50s cruiser', group: 'Platforms',
    match: /\b(bel ?air|tri-?five|150|210|nomad|fairlane|crown ?victoria|impala|biscayne|deluxe)\b/i,
    lengthIn: 197.5, widthIn: 73.5, wheelbaseIn: 115, tireDiaIn: 27, wheelDiaIn: 15,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'trunk', rows: 2,
    sil: { rocker: 9, nose: 33, hood: 37, hoodFront: 0.58, cowl: 0.08, belt: 43,
      roof: 60, wsTop: -0.08, roofRear: -0.48, backlight: -0.54, deckStart: -0.58,
      deck: 47, tail: 40, round: 0.4 } },
  { key: 'model-a', label: 'Model A / prewar hot rod', group: 'Platforms',
    match: /\b(model ?[at]|deuce|highboy|roadster ?pickup|1932|32 ?ford|hot ?rod)\b/i,
    lengthIn: 165, widthIn: 67, wheelbaseIn: 103.5, tireDiaIn: 30, wheelDiaIn: 16,
    enginePos: 'front', cooling: 'water', fenders: 'separate', rear: 'trunk', rows: 1,
    sil: { rocker: 16, nose: 34, hood: 40, hoodFront: 0.50, cowl: 0.06, belt: 46,
      roof: 68, wsTop: 0.00, roofRear: -0.40, backlight: -0.44, deckStart: -0.50,
      deck: 50, tail: 44, round: 0.2 } },
  { key: 'datsun-z', label: '240Z / classic sports coupe', group: 'Platforms',
    match: /\b(240z|260z|280z|300zx|fairlady|z-?car|rx-?7|celica|supra|mgb|triumph|tr[3-8]\b)\b/i,
    lengthIn: 162.8, widthIn: 64.1, wheelbaseIn: 90.7, tireDiaIn: 25, wheelDiaIn: 14,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'cargo', rows: 1,
    sil: { rocker: 8, nose: 26, hood: 30, hoodFront: 0.66, cowl: 0.02, belt: 37,
      roof: 50, wsTop: -0.20, roofRear: -0.60, backlight: -0.66, deckStart: -0.72,
      deck: 40, tail: 35, round: 0.5 } },

  // --- Generic shapes, for anything without a preset ---
  { key: 'sedan', label: 'Sedan', group: 'Generic shapes',
    lengthIn: 189, widthIn: 72, wheelbaseIn: 110, tireDiaIn: 26, wheelDiaIn: 16,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'trunk', rows: 2,
    sil: { rocker: 8, nose: 30, hood: 34, hoodFront: 0.55, cowl: 0.10, belt: 40,
      roof: 58, wsTop: -0.10, roofRear: -0.42, backlight: -0.50, deckStart: -0.56,
      deck: 44, tail: 38, round: 0.4 } },
  { key: 'coupe', label: 'Coupe', group: 'Generic shapes',
    lengthIn: 179, widthIn: 72, wheelbaseIn: 104, tireDiaIn: 26, wheelDiaIn: 17,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'trunk', rows: 2,
    sil: { rocker: 8, nose: 28, hood: 32, hoodFront: 0.58, cowl: 0.06, belt: 38,
      roof: 53, wsTop: -0.16, roofRear: -0.50, backlight: -0.56, deckStart: -0.62,
      deck: 42, tail: 36, round: 0.4 } },
  { key: 'hatchback', label: 'Hatchback', group: 'Generic shapes',
    lengthIn: 165, widthIn: 70, wheelbaseIn: 102, tireDiaIn: 25, wheelDiaIn: 16,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'cargo', rows: 2,
    sil: { rocker: 8, nose: 28, hood: 32, hoodFront: 0.48, cowl: 0.14, belt: 39,
      roof: 57, wsTop: -0.06, roofRear: -0.64, backlight: -0.70, deckStart: -0.76,
      deck: 50, tail: 46, round: 0.4 } },
  { key: 'wagon', label: 'Wagon / estate', group: 'Generic shapes',
    lengthIn: 191, widthIn: 72, wheelbaseIn: 110, tireDiaIn: 26, wheelDiaIn: 16,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'cargo', rows: 3,
    sil: { rocker: 8, nose: 30, hood: 34, hoodFront: 0.55, cowl: 0.10, belt: 40,
      roof: 59, wsTop: -0.10, roofRear: -0.78, backlight: -0.82, deckStart: -0.88,
      deck: 54, tail: 50, round: 0.35 } },
  { key: 'convertible', label: 'Convertible / roadster', group: 'Generic shapes',
    lengthIn: 171, widthIn: 71, wheelbaseIn: 100, tireDiaIn: 25, wheelDiaIn: 16,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'trunk', rows: 1,
    roofless: true,
    sil: { rocker: 8, nose: 27, hood: 31, hoodFront: 0.56, cowl: 0.04, belt: 37,
      roof: 49, wsTop: -0.14, roofRear: -0.20, backlight: -0.28, deckStart: -0.52,
      deck: 40, tail: 35, round: 0.4 } },
  { key: 'suv', label: 'SUV / 4x4', group: 'Generic shapes',
    lengthIn: 181, widthIn: 75, wheelbaseIn: 108, tireDiaIn: 30, wheelDiaIn: 17,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'cargo', rows: 2,
    sil: { rocker: 13, nose: 38, hood: 41, hoodFront: 0.58, cowl: 0.16, belt: 47,
      roof: 70, wsTop: 0.04, roofRear: -0.78, backlight: -0.82, deckStart: -0.88,
      deck: 52, tail: 48, round: 0.25 } },
  { key: 'pickup', label: 'Pickup truck', group: 'Generic shapes',
    lengthIn: 220, widthIn: 78, wheelbaseIn: 132, tireDiaIn: 31, wheelDiaIn: 17,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'bed', rows: 2,
    sil: { rocker: 14, nose: 40, hood: 44, hoodFront: 0.62, cowl: 0.18, belt: 50,
      roof: 76, wsTop: 0.06, roofRear: -0.14, backlight: -0.16, deckStart: -0.20,
      deck: 50, tail: 50, round: 0.2 } },
  { key: 'van', label: 'Van / bus', group: 'Generic shapes',
    lengthIn: 205, widthIn: 77, wheelbaseIn: 120, tireDiaIn: 28, wheelDiaIn: 16,
    enginePos: 'front', cooling: 'water', fenders: 'integrated', rear: 'cargo', rows: 3,
    sil: { rocker: 12, nose: 46, hood: 52, hoodFront: 0.92, cowl: 0.80, belt: 52,
      roof: 84, wsTop: 0.62, roofRear: -0.90, backlight: -0.92, deckStart: -0.96,
      deck: 54, tail: 48, round: 0.3 } },
];

export const BODY_STYLES = PLATFORM_DEFS.map(({ key, label, group }) => ({ key, label, group }));
export const DEFAULT_BODY_STYLE = 'sedan';

// --- Modifications ---
//
// The real operations, in the language and units people use in the shop. All
// in inches; positive always means "more of the thing the label says".

export const MODIFICATIONS = [
  { key: 'chopIn',    label: 'Chop the top',   min: 0,  max: 8,  step: 0.5, unit: 'in',
    hint: 'Lowers the roof and lays the pillars back with it' },
  { key: 'channelIn', label: 'Channel body',   min: 0,  max: 6,  step: 0.5, unit: 'in',
    hint: 'Drops the body down over the frame' },
  { key: 'sectionIn', label: 'Section body',   min: 0,  max: 6,  step: 0.5, unit: 'in',
    hint: 'Takes a horizontal slice out of the bodywork' },
  { key: 'frontIn',   label: 'Lower front',    min: -6, max: 8,  step: 0.5, unit: 'in',
    hint: 'Ride height at the front axle — negative raises it' },
  { key: 'rearIn',    label: 'Lower rear',     min: -6, max: 8,  step: 0.5, unit: 'in',
    hint: 'Ride height at the rear axle — negative raises it' },
  { key: 'tireDiaIn', label: 'Tyre diameter',  min: 20, max: 40, step: 0.5, unit: 'in', fromPlatform: 'tireDiaIn' },
  { key: 'wheelDiaIn', label: 'Wheel diameter', min: 12, max: 26, step: 1, unit: 'in', fromPlatform: 'wheelDiaIn' },
  { key: 'flareIn',   label: 'Fender flare',   min: 0,  max: 6,  step: 0.5, unit: 'in',
    hint: 'Widens the arches over each wheel' },
];

export function defaultMods(platformKey) {
  const def = platformDef(platformKey);
  const mods = {};
  MODIFICATIONS.forEach(m => { mods[m.key] = m.fromPlatform ? def[m.fromPlatform] : 0; });
  return mods;
}
function platformDef(key) {
  return PLATFORM_DEFS.find(d => d.key === key) || PLATFORM_DEFS.find(d => d.key === DEFAULT_BODY_STYLE);
}
export function modsAreStock(platformKey, mods) {
  const stock = defaultMods(platformKey);
  return MODIFICATIONS.every(m => Math.abs((mods[m.key] || 0) - stock[m.key]) < 0.001);
}

// --- Building a profile ---

export function resolveProfile(platformKey, options = {}) {
  const def = platformDef(platformKey);
  const mods = { ...defaultMods(def.key), ...(options.mods || {}) };
  MODIFICATIONS.forEach(m => {
    const n = Number(mods[m.key]);
    mods[m.key] = Number.isFinite(n) ? Math.max(m.min, Math.min(m.max, n)) : (m.fromPlatform ? def[m.fromPlatform] : 0);
  });

  // A known wheelbase stretches the whole car around it, keeping the
  // overhangs proportional rather than leaving the body the wrong length.
  const wbIn = Number(options.wheelbaseIn) > 0 ? Number(options.wheelbaseIn) : def.wheelbaseIn;
  const stretch = Math.max(0.6, Math.min(1.7, wbIn / def.wheelbaseIn));

  const p = {
    style: def.key, styleLabel: def.label, platform: def,
    enginePos: def.enginePos, cooling: def.cooling, fenders: def.fenders,
    rear: def.rear, rows: def.rows, roof: !def.roofless, mods,
    length: def.lengthIn * IN * stretch,
    width: def.widthIn * IN,
    wheelbase: wbIn * IN,
    wheelbaseIn: wbIn,
    stretch,
  };

  p.wheelR = (mods.tireDiaIn * IN) / 2;
  p.rimR = Math.min(p.wheelR - 0.02, (mods.wheelDiaIn * IN) / 2);
  p.axleF = p.wheelbase / 2;
  p.axleR = -p.wheelbase / 2;
  p.wheelX = p.width / 2 - 0.14;
  p.flare = mods.flareIn * IN;

  // Frame sits on the axles; the body then sits on the frame, less any
  // channelling, and the whole lot pitches if one end is lowered.
  p.frameY = p.wheelR + 0.02;
  p.bodyDrop = mods.channelIn * IN;
  const frontDrop = mods.frontIn * IN;
  const rearDrop = mods.rearIn * IN;
  p.rideOffset = -(frontDrop + rearDrop) / 2;
  p.pitch = Math.atan2(frontDrop - rearDrop, p.wheelbase);

  p.sil = buildSilhouette(def, p, mods);
  p.bodyTop = p.sil.beltY;
  p.roofY = p.sil.roofY;
  p.hoodTop = p.sil.hoodY;
  p.interiorTop = p.roof ? p.sil.roofY - 0.05 : p.sil.beltY + 0.30;
  p.floorY = Math.max(p.frameY + 0.06, p.sil.rockerY + 0.06);

  // Engine bay: ahead of the cowl for a front-engine car, behind the cabin
  // for a Beetle or Bus.
  const half = p.length / 2;
  if (def.enginePos === 'rear') {
    p.engineZ = Math.max(p.axleR - 0.20, -half + 0.55);
    p.radiatorZ = null;
  } else {
    p.engineZ = Math.min(p.axleF - 0.30, (p.sil.hoodFrontZ + p.sil.cowlZ) / 2);
    p.radiatorZ = Math.min(p.sil.hoodFrontZ + 0.15, half - 0.22);
  }
  if (def.cooling === 'air') p.radiatorZ = null;
  p.cabForward = def.sil.cowl > 0.5;
  // Whatever sheetmetal is directly above the engine: the middle of the hood
  // line for a normal bonnet, the engine lid for a Beetle or Bus, and the
  // doghouse between the seats when the engine ends up under the cabin.
  p.engineLidY = def.enginePos === 'rear'
    ? (p.sil.deckY + p.sil.beltY) / 2
    : (p.engineZ >= p.sil.cowlZ
      ? (p.sil.hoodY + p.sil.beltY) / 2
      : Math.max(p.floorY + 0.30, p.sil.beltY - 0.25));
  // Drop the engine so its air cleaner just clears that lid, without putting
  // the sump on the floor.
  p.engineY = Math.max(p.frameY + 0.12, p.engineLidY - ENGINE_TOP_OFFSET);

  p.noseZ = half;
  p.tailZ = -half;
  return p;
}

// How far the top of the air cleaner sits above the engine's centre — used to
// tuck the whole assembly under the hood line. Keep in step with engine().
const ENGINE_TOP_OFFSET = 0.48;

// Turns the platform's inch-based side view into metres, applies the
// modifications, and clamps the result so no combination of sliders can turn
// the outline inside out.
function buildSilhouette(def, p, mods) {
  const s = def.sil;
  const half = p.length / 2;
  const section = mods.sectionIn * IN;
  const chop = mods.chopIn * IN;
  const drop = p.bodyDrop;

  const rockerY = s.rocker * IN - drop;
  // Sectioning removes a slice from the middle of the body: everything above
  // the rocker comes down, the rocker itself stays put.
  const lift = -section - drop;
  const sil = {
    rockerY,
    noseY: s.nose * IN + lift,
    hoodY: s.hood * IN + lift,
    beltY: s.belt * IN + lift,
    deckY: s.deck * IN + lift,
    tailY: s.tail * IN + lift,
    roofY: s.roof * IN + lift - chop,
    noseZ: half,
    tailZ: -half,
    hoodFrontZ: s.hoodFront * half,
    cowlZ: s.cowl * half,
    // A chop lays the screen and backlight down as the roof comes to meet them.
    wsTopZ: s.wsTop * half - chop * 0.35,
    roofRearZ: s.roofRear * half + chop * 0.25,
    backlightZ: s.backlight * half,
    deckStartZ: s.deckStart * half,
    round: s.round,
  };

  // Keep the outline well-formed whatever the sliders say.
  const floor = sil.rockerY + 0.10;
  ['noseY', 'hoodY', 'beltY', 'deckY', 'tailY'].forEach(k => { sil[k] = Math.max(floor, sil[k]); });
  sil.roofY = Math.max(sil.beltY + 0.14, sil.roofY);
  // Front to back ordering must hold: nose, hood, cowl, screen top, roof rear,
  // backlight, deck start, tail.
  sil.hoodFrontZ = Math.min(sil.hoodFrontZ, sil.noseZ - 0.05);
  sil.cowlZ = Math.min(sil.cowlZ, sil.hoodFrontZ - 0.05);
  sil.wsTopZ = Math.min(sil.wsTopZ, sil.cowlZ - 0.02);
  sil.roofRearZ = Math.min(sil.roofRearZ, sil.wsTopZ - 0.05);
  sil.backlightZ = Math.min(sil.backlightZ, sil.roofRearZ - 0.02);
  sil.deckStartZ = Math.min(sil.deckStartZ, sil.backlightZ - 0.02);
  sil.deckStartZ = Math.max(sil.deckStartZ, sil.tailZ + 0.10);
  sil.backlightZ = Math.max(sil.backlightZ, sil.deckStartZ + 0.02);
  sil.roofRearZ = Math.max(sil.roofRearZ, sil.backlightZ + 0.02);
  sil.wsTopZ = Math.min(sil.wsTopZ, sil.cowlZ - 0.02);
  return sil;
}

// --- Guessing the platform ---

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

// Generic fallbacks for anything without a specific platform preset.
const MODEL_HINTS = [
  [/\b(ranger|tacoma|tundra|colorado|canyon|frontier|titan|hilux|dakota|avalanche|ridgeline|el ?camino|ranchero|ram\b|pickup|truck)\b/i, 'pickup'],
  [/\b(wrangler|cherokee|wagoneer|range ?rover|discovery|4runner|pathfinder|explorer|expedition|tahoe|suburban|yukon|escalade|durango|montero|trooper|samurai|sidekick|xterra|highlander|pilot|rav4|cr-?v|suv|jeep)\b/i, 'suv'],
  [/\b(econoline|e-?[13]50|savana|express|astro|caravan|voyager|odyssey|sienna|sprinter|transit|van)\b/i, 'van'],
  [/\b(convertible|cabriolet|roadster|spider|spyder|miata|mx-?5|boxster|z3|z4|speedster)\b/i, 'convertible'],
  [/\b(wagon|estate|avant|touring|shooting ?brake|vista ?cruiser|country ?squire)\b/i, 'wagon'],
  [/\b(golf|gti|rabbit|hatch|hatchback|mini ?cooper|fiesta|focus|veloster|yaris|fit)\b/i, 'hatchback'],
  [/\b(corvette|chevelle|gto|442|nova|s2000|integra|prelude|coupe|fastback|gt-?r|skyline|911|cayman|m[34]\b|240sx)\b/i, 'coupe'],
];

export function guessBodyStyle({ make, model, trim, bodyClass } = {}) {
  const text = [make, model, trim].filter(Boolean).join(' ');
  const fromVin = bodyClassToStyle(bodyClass);
  // A specific platform beats a body class — a VIN that says "Sedan" for a
  // Beetle is technically right and completely useless here. The exception is
  // an open car, where the VIN knows something the model name doesn't: a
  // Mustang convertible is a different shape from a Mustang fastback.
  if (text.trim()) {
    const platform = PLATFORM_DEFS.find(d => d.match && d.match.test(text));
    if (platform) return fromVin === 'convertible' && !platform.roofless ? 'convertible' : platform.key;
  }
  if (fromVin) return fromVin;
  if (!text.trim()) return DEFAULT_BODY_STYLE;
  const hit = MODEL_HINTS.find(([re]) => re.test(text));
  return hit ? hit[1] : DEFAULT_BODY_STYLE;
}

// --- Layout persistence shape ---
// {
//   version: 1,
//   bodyStyle: 'vw-beetle' | null,   // null = fall back to the guess
//   wheelbaseIn: 94.5 | null,
//   mods: { chopIn: 4, ... } | null, // null = stock
//   components: { engine: { pos:[x,y,z], scale:[x,y,z], rotY:deg, hidden:bool } }
// }

export const DEFAULT_TRANSFORM = { pos: [0, 0, 0], scale: [1, 1, 1], rotY: 0, hidden: false };

export function normalizeLayout(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const styleKey = PLATFORM_DEFS.some(d => d.key === src.bodyStyle) ? src.bodyStyle : null;
  const wb = Number(src.wheelbaseIn);
  const layout = {
    version: 1,
    bodyStyle: styleKey,
    wheelbaseIn: Number.isFinite(wb) && wb > 0 ? wb : null,
    mods: null,
    components: {},
  };
  if (src.mods && typeof src.mods === 'object') {
    layout.mods = {};
    MODIFICATIONS.forEach(m => {
      const n = Number(src.mods[m.key]);
      if (Number.isFinite(n)) layout.mods[m.key] = Math.max(m.min, Math.min(m.max, n));
    });
    if (Object.keys(layout.mods).length === 0) layout.mods = null;
  }
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
  scene.fog = new THREE.Fog(0x0f172a, 18, 40);

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
  const home = { yaw: -0.75, pitch: 0.32 };
  let yaw = home.yaw;
  let pitch = home.pitch;
  let distance = 10.5;

  function applyCamera() {
    const clampedPitch = Math.max(-0.25, Math.min(1.35, pitch));
    pitch = clampedPitch;
    distance = Math.max(3, Math.min(34, distance));
    camera.position.set(
      target.x + distance * Math.cos(clampedPitch) * Math.sin(yaw),
      target.y + distance * Math.sin(clampedPitch),
      target.z + distance * Math.cos(clampedPitch) * Math.cos(yaw)
    );
    camera.lookAt(target);
  }
  const homeDistanceFor = (p) => Math.max(8, p.length * 2.2);
  const homeTargetFor = (p) => new THREE.Vector3(0, p.roofY * 0.55, 0);
  distance = homeDistanceFor(profile);
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
      // Lowering one end pitches everything bolted to the body; the wheels and
      // the brakes inside them stay where they are.
      const onChassis = CHASSIS_COMPONENTS.includes(c.key);
      c.group.position.set(
        t.pos[0] + c.def.explode[0] * explode,
        t.pos[1] + c.def.explode[1] * explode + (onChassis ? profile.rideOffset : 0),
        t.pos[2] + c.def.explode[2] * explode
      );
      c.group.scale.set(t.scale[0], t.scale[1], t.scale[2]);
      c.group.rotation.set(onChassis ? profile.pitch : 0, (t.rotY * Math.PI) / 180, 0);
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
    // Swaps in different bodywork without tearing down the scene, so the
    // camera, selection and any layout edits survive the change.
    setProfile(next) {
      profile = next || resolveProfile(DEFAULT_BODY_STYLE);
      rebuild();
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
      distance = Math.max(3.5, box.getSize(new THREE.Vector3()).length() * 1.9);
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
      base: new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.35, roughness: 0.5 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.4, roughness: 0.7 }),
      light: new THREE.MeshStandardMaterial({ color: 0xc3ccd8, metalness: 0.25, roughness: 0.4 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.1, roughness: 0.1, transparent: true, opacity: 0.3 }),
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
        return ctx.add(new THREE.CylinderGeometry(Math.abs(radius) || 0.01, Math.abs(radiusBottom == null ? radius : radiusBottom) || 0.01, Math.abs(height) || 0.01, 24), shade, position, rotation);
      },
      // Extrudes a side-view outline across the car. The shape is authored in
      // (z, y) — the way you'd draw the car looking at its door — then rotated
      // so the extrusion runs left-to-right.
      loft(shape, width, shade, roundness) {
        const bevel = Math.max(0.012, Math.min(0.09, 0.015 + roundness * 0.075));
        const depth = Math.max(0.05, width - bevel * 2);
        const geometry = new THREE.ExtrudeGeometry(shape, {
          depth,
          bevelEnabled: true,
          bevelThickness: bevel,
          bevelSize: bevel,
          bevelOffset: 0,
          bevelSegments: roundness > 0.5 ? 4 : 2,
          curveSegments: 14,
        });
        // The bevel adds `bevel` to each end of the extrusion, so the solid
        // spans -(depth + bevel)..bevel once rotated. Shift by depth/2 to
        // centre it on the car — shifting by depth/2 + bevel leaves the whole
        // body sitting off to one side.
        geometry.rotateY(-Math.PI / 2);
        geometry.translate(depth / 2, 0, 0);
        return ctx.add(geometry, shade);
      },
      // Bulbous separate fender, or a subtle arch on a car with integrated wings.
      arch(radius, tube, position, shade) {
        const geometry = new THREE.TorusGeometry(Math.max(0.05, radius), Math.max(0.02, tube), 8, 22, Math.PI);
        geometry.rotateY(Math.PI / 2);
        return ctx.add(geometry, shade, position);
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

// The lower bodywork outline, drawn from the front bumper clockwise.
function lowerBodyShape(THREE, p) {
  const s = p.sil;
  const r = Math.min(0.13, 0.03 + s.round * 0.13);
  const noseR = Math.min(r, (s.noseY - s.rockerY) * 0.4);
  const tailR = Math.min(r, (s.tailY - s.rockerY) * 0.4);
  const deckMidZ = s.deckStartZ - (s.deckStartZ - s.tailZ) * 0.3;

  const shape = new THREE.Shape();
  shape.moveTo(s.noseZ, s.rockerY);
  shape.lineTo(s.noseZ, s.noseY - noseR);
  shape.quadraticCurveTo(s.noseZ, s.noseY, s.noseZ - noseR, s.noseY);
  shape.quadraticCurveTo(s.hoodFrontZ + (s.noseZ - s.hoodFrontZ) * 0.35, s.hoodY, s.hoodFrontZ, s.hoodY);
  shape.lineTo(s.cowlZ, s.beltY);
  shape.lineTo(s.deckStartZ, s.beltY);
  shape.quadraticCurveTo(deckMidZ, s.deckY, Math.min(deckMidZ, s.tailZ + tailR * 2), s.deckY);
  shape.lineTo(s.tailZ + tailR, s.tailY);
  shape.quadraticCurveTo(s.tailZ, s.tailY, s.tailZ, s.tailY - tailR);
  shape.lineTo(s.tailZ, s.rockerY);
  shape.closePath();
  return shape;
}

// The cabin above the beltline, with the side window cut out of it.
function greenhouseShape(THREE, p) {
  const s = p.sil;
  const r = Math.min(0.11, 0.02 + s.round * 0.11);
  const height = s.roofY - s.beltY;
  const shape = new THREE.Shape();
  shape.moveTo(s.cowlZ, s.beltY);
  shape.lineTo(s.wsTopZ + r * 0.5, s.roofY - r);
  shape.quadraticCurveTo(s.wsTopZ, s.roofY, s.wsTopZ - r, s.roofY);
  shape.lineTo(s.roofRearZ + r, s.roofY);
  shape.quadraticCurveTo(s.roofRearZ, s.roofY, s.roofRearZ - r * 0.5, s.roofY - r);
  shape.lineTo(s.backlightZ, s.beltY);
  shape.closePath();

  // Window opening, inset from the pillars and the roof rail.
  const sill = height * 0.16;
  const header = height * 0.16;
  const pillar = Math.min(0.14, (s.cowlZ - s.backlightZ) * 0.10);
  const frontBot = s.cowlZ - pillar * 1.5;
  const frontTop = s.wsTopZ - pillar * 0.7;
  const rearTop = s.roofRearZ + pillar * 0.7;
  const rearBot = s.backlightZ + pillar * 1.5;
  if (frontBot > rearBot + 0.12 && frontTop > rearTop + 0.10 && height - sill - header > 0.10) {
    const hole = new THREE.Path();
    hole.moveTo(frontBot, s.beltY + sill);
    hole.lineTo(frontTop, s.roofY - header);
    hole.lineTo(rearTop, s.roofY - header);
    hole.lineTo(rearBot, s.beltY + sill);
    hole.closePath();
    shape.holes.push(hole);
  }
  return shape;
}

const GEOMETRY_BUILDERS = {
  frame(c) {
    const p = c.p, s = p.sil;
    const railLen = p.length * 0.84;
    const railX = p.width * 0.29;
    c.pair(side => c.box(0.12, 0.15, railLen, 'base', [side * railX, p.frameY, 0]));
    [-0.42, -0.18, 0.12, 0.34].forEach(f => c.box(railX * 1.85, 0.09, 0.12, 'dark', [0, p.frameY, f * railLen]));
    // Firewall bulkhead at the cowl.
    c.box(p.width * 0.78, 0.50, 0.06, 'dark', [0, p.frameY + 0.24, s.cowlZ - 0.06]);
    // Kick-ups so the rails clear the axles.
    c.corners((side, z) => { if (side > 0) c.box(railX * 1.85, 0.26, 0.42, 'dark', [0, p.frameY + 0.17, z]); });
    // Engine and transmission mounts.
    c.pair(side => c.box(0.15, 0.20, 0.15, 'light', [side * 0.40, p.engineY - 0.30, p.engineZ]));
    // Body mounts along the rails — these are what a channelled body sits on.
    c.pair(side => [0.6, 0.1, -0.45].forEach(f =>
      c.box(0.11, 0.10, 0.13, 'light', [side * railX, p.frameY + 0.11, f * railLen])));
  },

  engine(c) {
    const p = c.p, y = p.engineY, z = p.engineZ;
    if (p.cooling === 'air') {
      // Flat-four: wide, short, with a cooling fan housing on top.
      c.box(0.86, 0.32, 0.46, 'base', [0, y, z]);                          // case
      c.pair(side => c.box(0.30, 0.24, 0.42, 'light', [side * 0.52, y, z])); // cylinder banks
      c.cyl(0.18, 0.20, 'dark', [0, y + 0.24, z], [Math.PI / 2, 0, 0]);     // fan housing
      c.box(0.28, 0.12, 0.28, 'light', [0, y + 0.38, z]);                   // generator stand
      c.box(0.62, 0.14, 0.40, 'dark', [0, y - 0.24, z]);                    // sump
      c.pair(side => c.cyl(0.05, 0.42, 'dark', [side * 0.42, y - 0.20, z - 0.10], [Math.PI / 2, 0, 0]));
    } else {
      c.box(0.70, 0.46, 0.78, 'base', [0, y, z]);               // block
      c.box(0.74, 0.11, 0.72, 'light', [0, y + 0.28, z]);       // head
      c.box(0.50, 0.09, 0.60, 'light', [0, y + 0.38, z]);       // valve cover
      c.box(0.44, 0.12, 0.50, 'dark', [0, y + 0.42, z]);        // intake / air cleaner
      c.box(0.62, 0.14, 0.60, 'dark', [0, y - 0.28, z - 0.05]); // oil pan
      c.cyl(0.16, 0.10, 'light', [0, y, z + 0.45], [0, 0, Math.PI / 2]); // crank pulley
      c.pair(side => c.cyl(0.07, 0.75, 'dark', [side * 0.42, y - 0.14, z - 0.10], [Math.PI / 2, 0, 0]));
    }
    if (p.radiatorZ != null) {
      c.box(0.88, 0.46, 0.10, 'dark', [0, y + 0.06, p.radiatorZ]);
      c.cyl(0.19, 0.11, 'light', [0, y + 0.06, p.radiatorZ - 0.12], [0, 0, Math.PI / 2]);
    }
  },

  drivetrain(c) {
    const p = c.p, y = p.frameY;
    const rearEngine = p.enginePos === 'rear';
    const axleZ = rearEngine ? p.axleR : p.axleR;
    if (rearEngine) {
      // Transaxle: gearbox ahead of the engine, swing axles either side. No
      // propshaft to run the length of the car.
      c.box(0.40, 0.36, 0.60, 'base', [0, y + 0.16, p.engineZ + 0.62]);
      c.cyl(0.22, 0.26, 'base', [0, y + 0.10, p.engineZ + 0.40], [Math.PI / 2, 0, 0]);
      c.box(0.30, 0.14, 0.26, 'light', [0, y + 0.30, p.engineZ + 0.30]);
    } else {
      c.box(0.44, 0.40, 0.72, 'base', [0, y + 0.32, p.engineZ - 0.68]);   // bellhousing
      c.box(0.32, 0.30, 0.60, 'base', [0, y + 0.26, p.engineZ - 1.22]);   // trans case
      c.box(0.28, 0.15, 0.28, 'light', [0, y + 0.24, p.engineZ - 0.38]);  // flexplate housing
      const shaftFront = p.engineZ - 1.52;
      const shaftLen = Math.max(0.3, shaftFront - axleZ);
      c.cyl(0.065, shaftLen, 'light', [0, y + 0.12, (shaftFront + axleZ) / 2], [Math.PI / 2, 0, 0]);
      c.cyl(0.09, 0.11, 'dark', [0, y + 0.12, shaftFront], [Math.PI / 2, 0, 0]);
      c.cyl(0.25, 0.28, 'base', [0, y + 0.05, axleZ], [Math.PI / 2, 0, 0]); // differential
    }
    const axleLen = Math.max(0.2, p.wheelX - 0.16);
    c.pair(side => c.cyl(0.065, axleLen, 'dark', [side * (0.16 + axleLen / 2), y + 0.05, axleZ], [0, 0, Math.PI / 2]));
  },

  suspension(c) {
    const p = c.p;
    const sidewall = Math.max(0.03, p.wheelR - p.rimR);
    c.corners((side, z) => {
      c.cyl(p.wheelR, 0.24 + p.flare * 0.6, 'dark', [side * p.wheelX, p.wheelR, z], [0, 0, Math.PI / 2]);  // tyre
      c.cyl(p.rimR, 0.26 + p.flare * 0.6, 'light', [side * p.wheelX, p.wheelR, z], [0, 0, Math.PI / 2]);   // rim
      c.cyl(0.11, 0.40, 'base', [side * (p.wheelX - 0.22), p.wheelR + sidewall + 0.20, z]);               // spring
      c.cyl(0.045, 0.48, 'light', [side * (p.wheelX - 0.22), p.wheelR + sidewall + 0.24, z]);             // shock
      c.box(0.48, 0.07, 0.13, 'base', [side * (p.wheelX - 0.26), p.wheelR * 0.55, z]);                    // lower arm
      c.box(0.40, 0.06, 0.11, 'base', [side * (p.wheelX - 0.30), p.wheelR * 1.15, z]);                    // upper arm
    });
    c.box(p.width * 0.78, 0.07, 0.09, 'base', [0, p.frameY + 0.16, p.axleF - 0.20]);   // steering rack
    c.box(p.width * 0.75, 0.06, 0.07, 'dark', [0, p.frameY - 0.07, p.axleF + 0.24]);   // front sway bar
    c.box(p.width * 0.75, 0.06, 0.07, 'dark', [0, p.frameY - 0.07, p.axleR - 0.24]);   // rear sway bar
    c.cyl(0.045, 0.52, 'light', [0.20, p.frameY + 0.34, p.axleF - 0.34], [0, 0, Math.PI / 3]); // steering shaft
  },

  brakes(c) {
    const p = c.p;
    c.corners((side, z) => {
      c.cyl(p.rimR * 0.86, 0.035, 'light', [side * (p.wheelX - 0.04), p.wheelR, z], [0, 0, Math.PI / 2]); // rotor
      c.box(0.09, 0.18, 0.15, 'base', [side * (p.wheelX - 0.11), p.wheelR + p.rimR * 0.6, z]);            // caliper
      c.cyl(0.018, 0.36, 'dark', [side * (p.wheelX - 0.21), p.wheelR + p.rimR * 0.7, z], [0, 0, Math.PI / 2.4]);
    });
    c.box(0.24, 0.15, 0.18, 'base', [-0.32, p.frameY + 0.38, p.sil.cowlZ + 0.14]);                   // master cylinder
    c.cyl(0.13, 0.20, 'dark', [-0.32, p.frameY + 0.38, p.sil.cowlZ + 0.32], [Math.PI / 2, 0, 0]);    // booster
    const lineLen = Math.max(0.5, p.wheelbase - 0.2);
    c.pair(side => c.cyl(0.018, lineLen, 'dark', [side * (p.width * 0.34), p.frameY - 0.06, 0], [Math.PI / 2, 0, 0]));
  },

  electrical(c) {
    const p = c.p, y = p.engineY, z = p.engineZ;
    const bayDir = p.enginePos === 'rear' ? -1 : 1;
    c.box(0.32, 0.24, 0.20, 'base', [p.width * 0.28, y + 0.10, z + bayDir * 0.55]);            // battery
    c.cyl(0.13, 0.20, 'light', [0.46, y + 0.20, z + bayDir * 0.12], [0, 0, Math.PI / 2]);      // alternator
    c.cyl(0.10, 0.28, 'dark', [-0.46, y - 0.14, z - bayDir * 0.12], [0, 0, Math.PI / 2]);      // starter
    c.box(0.19, 0.17, 0.11, 'base', [-p.width * 0.30, p.frameY + 0.40, p.sil.cowlZ - 0.10]);   // fuse box
    c.box(0.28, 0.13, 0.09, 'light', [0, y + 0.32, z - bayDir * 0.42]);                        // coil
    const loomLen = Math.max(0.6, p.wheelbase);
    c.cyl(0.032, loomLen, 'dark', [-p.width * 0.32, p.frameY + 0.10, 0], [Math.PI / 2, 0, 0]);
    const tailRun = Math.max(0.4, Math.abs(p.tailZ - p.axleR));
    c.cyl(0.028, tailRun, 'dark', [0, p.frameY + 0.10, (p.tailZ + p.axleR) / 2], [Math.PI / 2, 0, 0]);
    c.pair(side => c.box(0.11, 0.09, 0.09, 'light', [side * (p.width * 0.32), p.sil.noseY - 0.10, p.sil.hoodFrontZ + 0.10]));
  },

  interior(c) {
    const p = c.p, s = p.sil;
    const cabFront = s.cowlZ;
    const cabBack = s.backlightZ;
    const cabLen = Math.max(0.6, cabFront - cabBack);

    // Everything in here is a fraction of the headroom the cabin actually has,
    // so a chopped roof or a sectioned body squeezes the interior to match
    // instead of leaving seats and headrests standing through the roofline.
    const avail = Math.min(1.05, Math.max(0.20, p.interiorTop - p.floorY));
    const seatY = p.floorY + avail * 0.19;
    const backH = avail * 0.42;
    const backY = seatY + avail * 0.03 + backH / 2;
    const headH = avail * 0.16;
    const headY = backY + backH / 2 + avail * 0.09;

    c.box(p.width * 0.82, 0.05, cabLen, 'dark', [0, p.floorY, (cabFront + cabBack) / 2]);        // floor
    c.box(p.width * 0.80, avail * 0.23, 0.26, 'light', [0, p.floorY + avail * 0.38, cabFront - 0.20]); // dash
    c.box(0.34, avail * 0.13, 0.18, 'base', [0, p.floorY + avail * 0.44, cabFront - 0.32]);      // centre stack
    c.add(new c.THREE.TorusGeometry(Math.min(0.16, avail * 0.20), 0.026, 12, 26), 'base',
      [0.36, p.floorY + avail * 0.42, cabFront - 0.42], [Math.PI / 2.6, 0, 0]);                  // steering wheel

    const rowSpacing = Math.min(0.92, cabLen * 0.40);
    for (let row = 0; row < p.rows; row++) {
      const z = cabFront - 0.95 - row * rowSpacing;
      if (z < cabBack + 0.12) break;
      c.pair(side => {
        c.box(0.48, avail * 0.11, 0.48, 'base', [side * (p.width * 0.21), seatY, z]);
        c.box(0.48, backH, 0.11, 'base', [side * (p.width * 0.21), backY, z - 0.26]);
        c.box(0.26, headH, 0.11, 'light', [side * (p.width * 0.21), headY, z - 0.24]);
      });
    }
    c.box(0.28, avail * 0.13, Math.min(1.2, cabLen * 0.55), 'dark', [0, p.floorY + avail * 0.11, (cabFront + cabBack) / 2]);
  },

  body(c) {
    const p = c.p, s = p.sil;
    // Lower bodywork: one lofted shell from the side-view outline.
    c.loft(lowerBodyShape(c.THREE, p), p.width, 'base', s.round);

    if (p.roof && s.roofY > s.beltY + 0.16) {
      c.loft(greenhouseShape(c.THREE, p), p.width * 0.86, 'base', s.round);
      // Glass sitting in the openings the greenhouse leaves.
      const gh = s.roofY - s.beltY;
      const wsLen = Math.hypot(s.cowlZ - s.wsTopZ, gh);
      const wsAngle = Math.atan2(s.cowlZ - s.wsTopZ, gh);
      c.box(p.width * 0.74, wsLen, 0.05, 'glass',
        [0, (s.beltY + s.roofY) / 2, (s.cowlZ + s.wsTopZ) / 2], [-wsAngle, 0, 0]);
      const blLen = Math.hypot(s.roofRearZ - s.backlightZ, gh);
      const blAngle = Math.atan2(s.roofRearZ - s.backlightZ, gh);
      c.box(p.width * 0.72, blLen, 0.05, 'glass',
        [0, (s.beltY + s.roofY) / 2, (s.roofRearZ + s.backlightZ) / 2], [blAngle, 0, 0]);
      c.pair(side => c.box(0.04, gh * 0.62, (s.wsTopZ - s.roofRearZ) * 0.92, 'glass',
        [side * (p.width * 0.42), s.beltY + gh * 0.52, (s.wsTopZ + s.roofRearZ) / 2]));
    } else if (!p.roof) {
      // Open car: a low screen and a roll hoop instead of a roof.
      const screenY = s.beltY + 0.26;
      c.box(p.width * 0.68, 0.28, 0.05, 'glass', [0, screenY, s.cowlZ - 0.06], [-0.35, 0, 0]);
      c.pair(side => c.box(0.09, 0.28, 0.09, 'light', [side * (p.width * 0.24), screenY, s.backlightZ]));
    }

    if (p.rear === 'bed') {
      // Open bed behind the cab, walled on three sides.
      const bedZ = (s.deckStartZ + s.tailZ) / 2;
      const bedLen = Math.max(0.4, s.deckStartZ - s.tailZ);
      const wallH = 0.42;
      c.pair(side => c.box(0.08, wallH, bedLen, 'base', [side * (p.width * 0.45), s.deckY + wallH / 2, bedZ]));
      c.box(p.width * 0.92, wallH, 0.08, 'base', [0, s.deckY + wallH / 2, s.tailZ + 0.06]);
      c.box(p.width * 0.92, wallH, 0.08, 'base', [0, s.deckY + wallH / 2, s.deckStartZ]);
    }

    // Fenders: bulbous separate wings on a Beetle or a Model A, a subtle arch
    // on anything with them pressed into the body.
    const separate = p.fenders === 'separate';
    const archR = p.wheelR + (separate ? 0.10 : 0.06);
    const tube = (separate ? 0.09 : 0.05) + p.flare * 0.4;
    c.corners((side, z) => c.arch(archR, tube, [side * (p.wheelX + (separate ? 0.02 : -0.02) + p.flare), p.wheelR, z], 'light'));
  },

  trim(c) {
    const p = c.p, s = p.sil;
    const bumperY = Math.max(s.rockerY + 0.12, s.noseY - 0.22);
    c.box(p.width * 0.98, 0.16, 0.14, 'light', [0, bumperY, s.noseZ - 0.02]);                    // front bumper
    c.box(p.width * 0.98, 0.16, 0.14, 'light', [0, Math.max(s.rockerY + 0.12, s.tailY - 0.22), s.tailZ + 0.02]); // rear bumper
    c.pair(side => c.cyl(0.13, 0.09, 'light', [side * (p.width * 0.30), s.noseY - 0.09, s.noseZ - 0.06], [Math.PI / 2, 0, 0])); // headlights
    c.pair(side => c.box(0.20, 0.13, 0.07, 'light', [side * (p.width * 0.30), s.tailY - 0.09, s.tailZ + 0.06]));                // tail lights
    if (p.cooling === 'water' && p.enginePos === 'front') {
      c.box(p.width * 0.50, 0.20, 0.07, 'dark', [0, s.noseY - 0.14, s.noseZ - 0.05]);            // grille
    }
    c.pair(side => c.box(0.14, 0.09, 0.05, 'light', [side * (p.width * 0.52), s.beltY + 0.06, s.cowlZ - 0.14])); // mirrors
    c.pair(side => c.box(0.03, 0.05, p.length * 0.50, 'light', [side * (p.width * 0.50), (s.beltY + s.rockerY) / 2, 0])); // moulding
    // Exhaust from the engine out past the rear valance.
    const pipeFront = p.enginePos === 'rear' ? p.engineZ + 0.1 : p.engineZ - 0.4;
    const pipeLen = Math.max(0.35, pipeFront - (s.tailZ + 0.18));
    c.pair(side => c.cyl(0.045, pipeLen, 'dark', [side * 0.42, Math.max(0.10, p.frameY - 0.12), pipeFront - pipeLen / 2], [Math.PI / 2, 0, 0]));
    c.pair(side => c.cyl(0.06, 0.26, 'light', [side * 0.42, Math.max(0.10, p.frameY - 0.12), s.tailZ + 0.06], [Math.PI / 2, 0, 0]));
  },
};
