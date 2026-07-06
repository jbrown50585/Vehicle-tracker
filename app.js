import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://fdewpzbeqkkpciqmygdi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_NsyWsfX22nRMBqqYnp8TMA_MGaj2woh';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const PHOTO_BUCKET = 'vehicle-photos';

const CATEGORIES = ['Engine','Transmission/Drivetrain','Brakes','Suspension/Steering','Body & Paint','Interior','Electrical','Trim/Exterior','Tools & Supplies','Other'];
const STATUSES = [
  { key: 'needed',    label: 'Needed',    color: 'var(--text-muted)' },
  { key: 'ordered',   label: 'Ordered',   color: 'var(--series-1)' },
  { key: 'received',  label: 'Received',  color: 'var(--warning)' },
  { key: 'installed', label: 'Installed', color: 'var(--good)' },
  { key: 'returned',  label: 'Returned',  color: 'var(--critical)' },
];
const SPENT_STATUSES = ['received', 'installed'];
const PLANNED_STATUSES = ['needed', 'ordered'];

function statusInfo(key) { return STATUSES.find(s => s.key === key) || STATUSES[0]; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

const MAKES = [
  'Acura','AMC','Audi','Bentley','BMW','Buick','Cadillac','Chevrolet','Chrysler','Datsun','Dodge',
  'Ferrari','Fiat','Ford','GMC','Honda','Hudson','Hyundai','Infiniti','International Harvester',
  'Jaguar','Jeep','Kia','Lancia','Land Rover','Lexus','Lincoln','Lotus','Mazda','Mercedes-Benz',
  'Mercury','MG','Mini','Mitsubishi','Nash','Nissan','Oldsmobile','Packard','Plymouth','Pontiac',
  'Porsche','Ram','Saab','Saturn','Scion','Studebaker','Subaru','Suzuki','Tesla','Toyota','Triumph',
  'Volkswagen','Volvo','Willys',
].sort();
const OTHER_VALUE = '__other__';
const CURRENT_YEAR = new Date().getFullYear();

function cleanVinValue(v) {
  if (!v) return null;
  const trimmed = String(v).trim();
  if (!trimmed || trimmed === '0' || trimmed.toLowerCase() === 'not applicable') return null;
  return trimmed;
}
async function decodeVehicleFromVin(vin) {
  if (!vin || vin.length !== 17) return null;
  try {
    const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${encodeURIComponent(vin)}?format=json`);
    const json = await res.json();
    const results = json.Results || [];
    const byVar = (name) => cleanVinValue((results.find(r => r.Variable === name) || {}).Value);
    return {
      year: byVar('Model Year'),
      make: byVar('Make'),
      model: byVar('Model'),
      trim: byVar('Trim') || byVar('Series'),
    };
  } catch (err) {
    return null;
  }
}

const modelsCache = new Map();
async function fetchModelsForMake(make) {
  if (modelsCache.has(make)) return modelsCache.get(make);
  try {
    const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMake/${encodeURIComponent(make)}?format=json`);
    const json = await res.json();
    const models = (json.Results || []).map(r => r.Model_Name).filter((v, i, a) => a.indexOf(v) === i).sort();
    modelsCache.set(make, models);
    return models;
  } catch (err) {
    return [];
  }
}

let currentUser = null;
let authReady = false;
let authMode = 'signin';
let authError = '';
let authInfo = '';
let data = { vehicles: [], contacts: [] };
let currentView = { screen: 'home' };

// --- URL routing ---
// /                              -> vehicle list
// /vehicle/:id                   -> vehicle detail, Budget tab
// /vehicle/:id/parts             -> Parts tab
// /vehicle/:id/buildlog          -> Build log tab

const TAB_TO_SEGMENT = { budget: 'budget', parts: 'parts', journal: 'buildlog', notes: 'notes' };
const SEGMENT_TO_TAB = { budget: 'budget', parts: 'parts', buildlog: 'journal', notes: 'notes' };

function parseRoute() {
  const segments = window.location.pathname.split('/').filter(Boolean);
  if (segments[0] === 'vehicle' && segments[1]) {
    const tab = SEGMENT_TO_TAB[segments[2]] || 'budget';
    return { screen: 'detail', vehicleId: segments[1], tab };
  }
  if (segments[0] === 'projects' && (segments[1] === 'mine' || segments[1] === 'shared')) {
    if (segments[2] === 'project' || segments[2] === 'maintenance') {
      return { screen: 'list', ownership: segments[1], vehicleType: segments[2], vehicleId: null, tab: 'budget' };
    }
    return { screen: 'category', ownership: segments[1] };
  }
  return { screen: 'home' };
}
function routeToPath(view) {
  if (view.screen === 'detail' && view.vehicleId) {
    return `/vehicle/${view.vehicleId}/${TAB_TO_SEGMENT[view.tab] || 'budget'}`;
  }
  if (view.screen === 'list' && view.ownership && view.vehicleType) {
    return `/projects/${view.ownership}/${view.vehicleType}`;
  }
  if (view.screen === 'category' && view.ownership) {
    return `/projects/${view.ownership}`;
  }
  return '/';
}
function navigate(view, options = {}) {
  currentView = view;
  const path = routeToPath(view);
  if (options.replace) {
    history.replaceState(null, '', path);
  } else if (window.location.pathname !== path) {
    history.pushState(null, '', path);
  }
  render();
}
window.addEventListener('popstate', () => {
  const route = parseRoute();
  currentView = (route.screen === 'detail' && !data.vehicles.some(v => v.id === route.vehicleId))
    ? { screen: 'home' }
    : route;
  render();
});

function money(n) {
  return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// --- Mapping DB rows <-> local shape ---

function dbVehicleToLocal(row) {
  return {
    id: row.id, vin: row.vin, make: row.make, model: row.model, year: row.year, trim: row.trim,
    startDate: row.start_date, targetDate: row.target_date, coverPhoto: row.cover_photo_path,
    vehicleType: row.vehicle_type || 'project', currentMileage: row.current_mileage,
    purchasePrice: row.purchase_price != null ? Number(row.purchase_price) : null,
    salePrice: row.sale_price != null ? Number(row.sale_price) : null,
    ownerId: row.user_id, ownerEmail: row.owner_email,
    phases: [], parts: [], labor: [], credits: [], journal: [], checklist: [], favorites: [], maintenance: [], fuel: [], notes: [], collaborators: [], lastViewedAt: null,
  };
}
function dbPhaseToLocal(row) { return { id: row.id, vehicleId: row.vehicle_id, name: row.name, budget: Number(row.budget) }; }
function dbPartToLocal(row) {
  return {
    id: row.id, vehicleId: row.vehicle_id, phaseId: row.phase_id, name: row.name, category: row.category,
    cost: Number(row.cost), status: row.status, vendor: row.vendor, notes: row.notes, photo: row.photo_path,
    partNumber: row.part_number, createdAt: row.created_at,
  };
}

function partSearchQuery(v, p) {
  return p.partNumber ? p.partNumber : `${v.year} ${v.make} ${v.model} ${p.name}`;
}
function amazonSearchUrl(v, p) {
  return `https://www.amazon.com/s?k=${encodeURIComponent(partSearchQuery(v, p))}`;
}
function rockAutoSearchUrl(v, p) {
  if (p.partNumber) return `https://www.rockauto.com/en/partsearch/?partnum=${encodeURIComponent(p.partNumber)}`;
  return `https://www.google.com/search?q=${encodeURIComponent('site:rockauto.com ' + partSearchQuery(v, p))}`;
}

async function openEbayModal(v, p) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<h2>eBay results</h2><div id="ebay-results" class="section-sub">Searching…</div><div class="modal-actions"><button id="ebay-close">Close</button></div>`;
  const backdrop = openModalBackdrop(modal);
  modal.querySelector('#ebay-close').addEventListener('click', () => backdrop.remove());
  const resultsEl = modal.querySelector('#ebay-results');
  try {
    const query = partSearchQuery(v, p);
    const res = await fetch(`/api/ebay-search?q=${encodeURIComponent(query)}`);
    const json = await res.json();
    if (!res.ok) { resultsEl.textContent = json.error || 'Search failed.'; return; }
    if (!json.items || json.items.length === 0) { resultsEl.textContent = 'No results found.'; return; }
    resultsEl.className = '';
    resultsEl.innerHTML = '';
    json.items.forEach((item) => {
      const row = document.createElement('a');
      row.href = item.itemUrl;
      row.target = '_blank';
      row.rel = 'noopener';
      row.style.cssText = 'display:flex; gap:10px; align-items:center; padding:8px 0; border-bottom:1px solid var(--gridline); text-decoration:none; color:inherit;';
      row.innerHTML = `
        ${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" style="width:48px;height:48px;object-fit:cover;border-radius:6px;flex:none;">` : ''}
        <div style="flex:1">
          <div style="font-size:13px">${escapeHtml(item.title)}</div>
          <div style="font-size:12px; color:var(--text-muted)">${item.condition ? escapeHtml(item.condition) + ' · ' : ''}${item.price ? escapeHtml(item.price) : ''}</div>
        </div>
      `;
      resultsEl.appendChild(row);
    });
  } catch (err) {
    resultsEl.textContent = 'Search failed: ' + err.message;
  }
}
function dbLaborToLocal(row) {
  return { id: row.id, vehicleId: row.vehicle_id, date: row.date, description: row.description, hours: Number(row.hours), paid: row.paid, amount: Number(row.amount) };
}
function dbCreditToLocal(row) { return { id: row.id, vehicleId: row.vehicle_id, date: row.date, amount: Number(row.amount), reason: row.reason }; }
function dbJournalToLocal(row) { return { id: row.id, vehicleId: row.vehicle_id, date: row.date, text: row.text, photos: row.photo_paths || [], createdAt: row.created_at }; }
function dbChecklistToLocal(row) {
  return { id: row.id, vehicleId: row.vehicle_id, category: row.category, task: row.task, done: row.done, doneDate: row.done_date, position: row.position };
}
function dbFavoriteToLocal(row) {
  return { id: row.id, vehicleId: row.vehicle_id, name: row.name, partNumber: row.part_number, vendor: row.vendor, category: row.category, notes: row.notes };
}
function dbMaintenanceToLocal(row) {
  return {
    id: row.id, vehicleId: row.vehicle_id, task: row.task,
    intervalDays: row.interval_days, intervalMiles: row.interval_miles,
    lastDoneDate: row.last_done_date, lastDoneMileage: row.last_done_mileage, notes: row.notes,
  };
}

function dbFuelToLocal(row) {
  return { id: row.id, vehicleId: row.vehicle_id, date: row.date, mileage: row.mileage, gallons: Number(row.gallons), totalCost: Number(row.total_cost), fullTank: row.full_tank, notes: row.notes, createdAt: row.created_at };
}
function dbNoteToLocal(row) {
  return { id: row.id, vehicleId: row.vehicle_id, text: row.text, createdAt: row.created_at, authorEmail: row.author_email, editedAt: row.edited_at };
}
function dbCollaboratorToLocal(row) {
  return { id: row.id, vehicleId: row.vehicle_id, email: row.email, createdAt: row.created_at };
}
function dbContactToLocal(row) {
  return { id: row.id, email: row.email, nickname: row.nickname };
}

async function loadAllData() {
  const [vehiclesRes, phasesRes, partsRes, laborRes, creditsRes, journalRes, checklistRes, favoritesRes, maintenanceRes, fuelRes, notesRes, collabRes, contactsRes, viewsRes] = await Promise.all([
    supabase.from('vehicles').select('*').order('created_at'),
    supabase.from('phases').select('*'),
    supabase.from('parts').select('*'),
    supabase.from('labor').select('*'),
    supabase.from('credits').select('*'),
    supabase.from('journal_entries').select('*'),
    supabase.from('checklist_items').select('*'),
    supabase.from('favorite_parts').select('*'),
    supabase.from('maintenance_items').select('*'),
    supabase.from('fuel_logs').select('*'),
    supabase.from('vehicle_notes').select('*'),
    supabase.from('vehicle_collaborators').select('*'),
    supabase.from('known_collaborators').select('*').order('nickname'),
    supabase.from('vehicle_views').select('*'),
  ]);
  const vehicles = (vehiclesRes.data || []).map(dbVehicleToLocal);
  vehicles.forEach(v => {
    v.phases = (phasesRes.data || []).filter(r => r.vehicle_id === v.id).map(dbPhaseToLocal);
    v.parts = (partsRes.data || []).filter(r => r.vehicle_id === v.id).map(dbPartToLocal);
    v.labor = (laborRes.data || []).filter(r => r.vehicle_id === v.id).map(dbLaborToLocal);
    v.credits = (creditsRes.data || []).filter(r => r.vehicle_id === v.id).map(dbCreditToLocal);
    v.journal = (journalRes.data || []).filter(r => r.vehicle_id === v.id).map(dbJournalToLocal);
    v.checklist = (checklistRes.data || []).filter(r => r.vehicle_id === v.id).map(dbChecklistToLocal);
    v.favorites = (favoritesRes.data || []).filter(r => r.vehicle_id === v.id).map(dbFavoriteToLocal);
    v.maintenance = (maintenanceRes.data || []).filter(r => r.vehicle_id === v.id).map(dbMaintenanceToLocal);
    v.fuel = (fuelRes.data || []).filter(r => r.vehicle_id === v.id).map(dbFuelToLocal);
    v.notes = (notesRes.data || []).filter(r => r.vehicle_id === v.id).map(dbNoteToLocal);
    v.collaborators = (collabRes.data || []).filter(r => r.vehicle_id === v.id).map(dbCollaboratorToLocal);
    const viewRow = (viewsRes.data || []).find(r => r.vehicle_id === v.id);
    v.lastViewedAt = viewRow ? viewRow.last_viewed_at : null;
  });
  data = { vehicles, contacts: (contactsRes.data || []).map(dbContactToLocal) };
}

// --- Shared project activity ---

function newActivityCounts(v) {
  const since = v.lastViewedAt || '1970-01-01T00:00:00Z';
  const countNew = (list) => list.filter(item => item.createdAt && item.createdAt > since).length;
  return {
    parts: countNew(v.parts),
    journal: countNew(v.journal),
    notes: countNew(v.notes),
    fuel: countNew(v.fuel),
  };
}
function totalNewActivity(v) {
  const c = newActivityCounts(v);
  return c.parts + c.journal + c.notes + c.fuel;
}

const visitedThisSession = new Set();
async function markVehicleVisited(v) {
  if (visitedThisSession.has(v.id)) return;
  visitedThisSession.add(v.id);
  await supabase.from('vehicle_views').upsert(
    { vehicle_id: v.id, user_id: currentUser.id, last_viewed_at: new Date().toISOString() },
    { onConflict: 'vehicle_id,user_id' }
  );
}

// --- Fuel log / MPG ---

function computeFuelStats(v) {
  const sorted = v.fuel.slice().sort((a, b) => a.mileage - b.mileage);
  let totalDistance = 0;
  let totalGallons = 0;
  // MPG via the standard "fill-to-full" method: a partial fill-up between two
  // full tanks doesn't get its own MPG, but its gallons still count toward the
  // next full tank's total (since that's the fuel actually used for those miles).
  let lastFullTankMileage = null;
  let gallonsSinceLastFullTank = 0;

  const withMpg = sorted.map((entry) => {
    gallonsSinceLastFullTank += Number(entry.gallons) || 0;
    let mpg = null;
    if (entry.fullTank) {
      if (lastFullTankMileage !== null) {
        const distance = entry.mileage - lastFullTankMileage;
        if (distance > 0 && gallonsSinceLastFullTank > 0) {
          mpg = distance / gallonsSinceLastFullTank;
          totalDistance += distance;
          totalGallons += gallonsSinceLastFullTank;
        }
      }
      lastFullTankMileage = entry.mileage;
      gallonsSinceLastFullTank = 0;
    }
    return { ...entry, mpg };
  });
  const avgMpg = totalGallons > 0 ? totalDistance / totalGallons : null;
  return { entries: withMpg.slice().reverse(), avgMpg };
}

// --- Maintenance due-tracking ---

const MAINTENANCE_WARNING_DAYS = 14;
const MAINTENANCE_WARNING_MILES = 500;

const MAINTENANCE_PRESETS = [
  { label: 'Oil & filter change', days: 180, miles: 5000 },
  { label: 'Tire rotation', days: 180, miles: 5000 },
  { label: 'Engine air filter', days: 365, miles: 15000 },
  { label: 'Cabin air filter', days: 365, miles: 15000 },
  { label: 'Brake fluid flush', days: 730, miles: 30000 },
  { label: 'Coolant flush', days: 730, miles: 30000 },
  { label: 'Transmission fluid change', days: 1095, miles: 30000 },
  { label: 'Differential fluid change', days: 730, miles: 30000 },
  { label: 'Spark plugs', days: 1095, miles: 30000 },
  { label: 'Serpentine belt', days: 1825, miles: 60000 },
  { label: 'Timing belt', days: 1825, miles: 60000 },
  { label: 'Fuel filter', days: 1095, miles: 30000 },
  { label: 'Power steering fluid', days: 730, miles: 30000 },
  { label: 'PCV valve', days: 1095, miles: 30000 },
  { label: 'Battery check/replace', days: 730, miles: null },
  { label: 'Wiper blades', days: 365, miles: null },
];

function maintenanceStatus(v, item) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let daysUntil = null;
  if (item.lastDoneDate && item.intervalDays) {
    const dueDate = new Date(item.lastDoneDate + 'T00:00:00');
    dueDate.setDate(dueDate.getDate() + item.intervalDays);
    daysUntil = Math.round((dueDate - today) / 86400000);
  }
  let milesUntil = null;
  if (item.lastDoneMileage != null && item.intervalMiles && v.currentMileage != null) {
    const dueMileage = item.lastDoneMileage + item.intervalMiles;
    milesUntil = dueMileage - v.currentMileage;
  }
  if (daysUntil === null && milesUntil === null) return { level: 'unknown', color: 'var(--text-muted)', label: 'Set an interval to track this' };
  const overdue = (daysUntil !== null && daysUntil < 0) || (milesUntil !== null && milesUntil < 0);
  const soon = !overdue && ((daysUntil !== null && daysUntil <= MAINTENANCE_WARNING_DAYS) || (milesUntil !== null && milesUntil <= MAINTENANCE_WARNING_MILES));
  const parts = [];
  if (daysUntil !== null) parts.push(daysUntil < 0 ? `${-daysUntil} day${-daysUntil === 1 ? '' : 's'} overdue` : `due in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`);
  if (milesUntil !== null) parts.push(milesUntil < 0 ? `${-milesUntil} mi overdue` : `due in ${milesUntil} mi`);
  const label = parts.join(' · ');
  if (overdue) return { level: 'overdue', color: 'var(--critical)', label };
  if (soon) return { level: 'soon', color: 'var(--warning)', label };
  return { level: 'ok', color: 'var(--good)', label };
}
function maintenanceAlertCount(v) {
  return v.maintenance.filter(item => ['overdue', 'soon'].includes(maintenanceStatus(v, item).level)).length;
}

// --- Restoration checklist ---

const CHECKLIST_TEMPLATE = {
  'Engine': [
    'Compression / leak-down test',
    'Remove engine',
    'Disassemble & inspect',
    'Machine shop work (bore/hone/resurface)',
    'Rebuild with new gaskets & seals',
    'Reinstall engine',
    'Break-in & tune',
  ],
  'Transmission/Drivetrain': [
    'Inspect transmission & clutch/torque converter',
    'Rebuild or replace transmission',
    'Inspect driveshaft & U-joints',
    'Rebuild differential',
    'Reinstall drivetrain',
  ],
  'Brakes': [
    'Inspect lines & hoses',
    'Replace master/wheel cylinders or calipers',
    'Replace pads/shoes & rotors/drums',
    'Bleed brake system',
    'Test & adjust',
  ],
  'Suspension/Steering': [
    'Inspect bushings & ball joints',
    'Replace shocks/struts & springs',
    'Rebuild steering box/rack',
    'Align front end',
  ],
  'Body & Paint': [
    'Strip old paint/rust',
    'Repair metal & replace rusted panels',
    'Bodywork & filler',
    'Prime',
    'Paint & clear coat',
    'Wet sand & buff',
  ],
  'Interior': [
    'Remove & inspect interior',
    'Repair/replace upholstery & carpet',
    'Restore dash & gauges',
    'Rewire interior electronics',
    'Reinstall interior',
  ],
  'Electrical': [
    'Inspect wiring harness',
    'Replace/repair wiring',
    'Restore lighting',
    'Test charging & starting system',
  ],
  'Trim/Exterior': [
    'Restore/replace chrome & trim',
    'Replace weatherstripping & seals',
    'Restore glass & mirrors',
    'Reinstall exterior trim',
  ],
};

async function seedChecklist(vehicleId) {
  const rows = [];
  let position = 0;
  Object.entries(CHECKLIST_TEMPLATE).forEach(([category, tasks]) => {
    tasks.forEach(task => { rows.push({ vehicle_id: vehicleId, category, task, position: position++ }); });
  });
  const { data: inserted, error } = await supabase.from('checklist_items').insert(rows).select();
  if (error) { alert('Could not load standard checklist: ' + error.message); return []; }
  return (inserted || []).map(dbChecklistToLocal);
}

// --- Budget math ---

function totalBudget(v) { return v.phases.reduce((s, ph) => s + Number(ph.budget || 0), 0); }
function partsSpent(v) { return v.parts.filter(p => SPENT_STATUSES.includes(p.status)).reduce((s, p) => s + Number(p.cost || 0), 0); }
function partsPlanned(v) { return v.parts.filter(p => PLANNED_STATUSES.includes(p.status)).reduce((s, p) => s + Number(p.cost || 0), 0); }
function paidLaborTotal(v) { return v.labor.filter(l => l.paid).reduce((s, l) => s + Number(l.amount || 0), 0); }
function creditsTotal(v) { return v.credits.reduce((s, c) => s + Number(c.amount || 0), 0); }
function totalSpent(v) { return partsSpent(v) + paidLaborTotal(v); }
function remainingBudget(v) { return totalBudget(v) - totalSpent(v) + creditsTotal(v); }
function netInvested(v) { return (v.purchasePrice || 0) + totalSpent(v) - creditsTotal(v); }
function projectProfit(v) { return (v.salePrice || 0) - netInvested(v); }
function phaseSpent(v, phaseId) {
  return v.parts.filter(p => p.phaseId === phaseId && SPENT_STATUSES.includes(p.status)).reduce((s, p) => s + Number(p.cost || 0), 0);
}
function budgetStatus(remaining, budget) {
  if (budget <= 0) return { color: 'var(--text-muted)', label: 'No budget set' };
  const pctRemaining = remaining / budget;
  if (remaining < 0) return { color: 'var(--critical)', label: 'Over budget' };
  if (pctRemaining <= 0.1) return { color: 'var(--serious)', label: 'Near limit' };
  if (pctRemaining <= 0.3) return { color: 'var(--warning)', label: 'Getting close' };
  return { color: 'var(--good)', label: 'On track' };
}

// --- Photos: resize, upload, signed URLs ---

function resizeImageToBlob(file, maxWidth, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality);
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadPhoto(vehicleId, blob) {
  const path = `${currentUser.id}/${vehicleId}/${uid()}.jpg`;
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
  if (error) { alert('Photo upload failed: ' + error.message); return null; }
  return path;
}
async function deletePhotos(paths) {
  const clean = paths.filter(Boolean);
  if (clean.length) await supabase.storage.from(PHOTO_BUCKET).remove(clean);
}

const signedUrlCache = new Map();
async function getPhotoUrl(path) {
  if (!path) return null;
  const cached = signedUrlCache.get(path);
  if (cached && cached.expires > Date.now()) return cached.url;
  const { data: signed, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, 3600);
  if (error || !signed) return null;
  signedUrlCache.set(path, { url: signed.signedUrl, expires: Date.now() + 55 * 60 * 1000 });
  return signed.signedUrl;
}

function hydratePhotos(root) {
  root.querySelectorAll('img.lazy-photo[data-photo-path]').forEach(img => {
    const path = img.getAttribute('data-photo-path');
    getPhotoUrl(path).then(url => { if (url) img.src = url; });
  });
}

function openLightbox(src) {
  const backdrop = document.createElement('div');
  backdrop.className = 'lightbox-backdrop';
  backdrop.innerHTML = `<img src="${src}">`;
  backdrop.addEventListener('click', () => backdrop.remove());
  document.body.appendChild(backdrop);
}
function openLightboxForPath(path) { getPhotoUrl(path).then(url => { if (url) openLightbox(url); }); }

// --- Render root ---

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  updateHeaderForAuth();

  if (!authReady) {
    app.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><div>Loading…</div></div>';
    return;
  }
  if (!currentUser) {
    app.appendChild(renderAuthScreen());
    return;
  }
  if (currentView.screen === 'home') app.appendChild(renderHome());
  else if (currentView.screen === 'category') app.appendChild(renderCategoryScreen(currentView.ownership));
  else if (currentView.screen === 'list') app.appendChild(renderList());
  else if (currentView.screen === 'detail') app.appendChild(renderDetail(currentView.vehicleId));

  hydratePhotos(app);
}

function updateHeaderForAuth() {
  const signedIn = !!currentUser;
  document.getElementById('signedInBar').style.display = signedIn ? 'inline-flex' : 'none';
  document.getElementById('newVehicleBtn').style.display = signedIn ? '' : 'none';
  document.getElementById('exportBtn').style.display = signedIn ? '' : 'none';
  document.getElementById('headerNav').style.display = signedIn ? 'flex' : 'none';
  document.getElementById('headerSearchWrap').style.display = signedIn ? 'block' : 'none';
  if (signedIn) document.getElementById('userEmail').textContent = currentUser.email;

  const projectsBtn = document.getElementById('navProjectsBtn');
  const sharedBtn = document.getElementById('navSharedBtn');
  if (signedIn) {
    const isMineView = currentView.ownership === 'mine';
    const isSharedView = currentView.ownership === 'shared';
    projectsBtn.className = isMineView ? 'active' : '';
    sharedBtn.className = isSharedView ? 'active' : '';
    const sharedNewTotal = ownershipVehicles('shared').reduce((s, v) => s + totalNewActivity(v), 0);
    sharedBtn.innerHTML = `Shared${sharedNewTotal > 0 ? ` <span class="chip" style="color:var(--series-1)">🔔 ${sharedNewTotal}</span>` : ''}`;
  }
}

// --- Auth screen ---

function renderAuthScreen() {
  const wrap = document.createElement('div');
  wrap.className = 'auth-wrap';

  const hero = document.createElement('div');
  hero.className = 'auth-hero';
  hero.innerHTML = `
    <img src="/icons/icon-512.png" class="auth-hero-icon" alt="">
    <h1>Vehicle Project Tracker</h1>
    <p>Track every restoration and repair — parts, budget, maintenance, and progress, all in one place.</p>
  `;
  wrap.appendChild(hero);

  const box = document.createElement('div');
  box.className = 'auth-box';
  const isSignUp = authMode === 'signup';
  box.innerHTML = `
    <h2>${isSignUp ? 'Create your account' : 'Sign in'}</h2>
    <div class="field"><label>Email</label><input type="email" id="auth-email" autocomplete="email"></div>
    <div class="field"><label>Password</label><input type="password" id="auth-password" autocomplete="${isSignUp ? 'new-password' : 'current-password'}"></div>
    ${authError ? `<div class="error-text">${escapeHtml(authError)}</div>` : ''}
    ${authInfo ? `<div class="info-text">${escapeHtml(authInfo)}</div>` : ''}
    <div class="modal-actions" style="justify-content:stretch; margin-top:16px;">
      <button class="primary" id="auth-submit" style="flex:1">${isSignUp ? 'Create account' : 'Sign in'}</button>
    </div>
    <div class="auth-toggle">
      ${isSignUp ? 'Already have an account? <a id="auth-toggle-link">Sign in</a>' : "Don't have an account? <a id=\"auth-toggle-link\">Create one</a>"}
    </div>
  `;
  wrap.appendChild(box);

  box.querySelector('#auth-toggle-link').addEventListener('click', () => {
    authMode = isSignUp ? 'signin' : 'signup';
    authError = ''; authInfo = '';
    render();
  });
  box.querySelector('#auth-submit').addEventListener('click', () => handleAuthSubmit(isSignUp));
  box.querySelectorAll('input').forEach(inp => inp.addEventListener('keydown', e => { if (e.key === 'Enter') handleAuthSubmit(isSignUp); }));

  return wrap;
}

async function handleAuthSubmit(isSignUp) {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  authError = ''; authInfo = '';
  if (!email || !password) { authError = 'Enter both an email and a password.'; render(); return; }

  if (isSignUp) {
    const { data: res, error } = await supabase.auth.signUp({ email, password });
    if (error) { authError = error.message; render(); return; }
    if (!res.session) {
      authInfo = 'Account created — check your email for a confirmation link, then sign in.';
      authMode = 'signin';
      render();
    }
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { authError = error.message; render(); }
  }
}

// --- Vehicle list ---

function renderVehicleCard(v) {
  const budget = totalBudget(v);
  const spent = totalSpent(v);
  const remaining = remainingBudget(v);
  const pctUsed = budget > 0 ? Math.min(100, Math.max(0, (spent / budget) * 100)) : 0;
  const status = budgetStatus(remaining, budget);
  const alertCount = maintenanceAlertCount(v);
  const newCount = totalNewActivity(v);

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    ${v.coverPhoto ? `<img class="lazy-photo card-cover" data-photo-path="${v.coverPhoto}">` : ''}
    <h3>${v.year} ${escapeHtml(v.make)} ${escapeHtml(v.model)}${v.trim ? ' ' + escapeHtml(v.trim) : ''}</h3>
    <div class="vin">${v.vin ? 'VIN: ' + escapeHtml(v.vin) : 'No VIN entered'} &middot; <span class="chip">${v.vehicleType === 'maintenance' ? 'Maintenance' : 'Project'}</span>${v.ownerId !== currentUser.id ? ' <span class="chip">Shared</span>' : ''}${alertCount > 0 ? ` <span class="chip" style="color:var(--serious)">⚠ ${alertCount} due</span>` : ''}${newCount > 0 ? ` <span class="chip" style="color:var(--series-1)">🔔 ${newCount} new</span>` : ''}</div>
    <div class="timeframe">${v.vehicleType === 'maintenance' ? 'Ongoing' : `${v.startDate ? formatDate(v.startDate) : '?'} &rarr; ${v.targetDate ? formatDate(v.targetDate) : 'no target date'}`}</div>
    <div class="meter-row">
      <span class="meter-remaining">${money(remaining)}</span>
      <span class="meter-total">remaining of ${money(budget)}</span>
    </div>
    <div class="meter-track"><div class="meter-fill" style="width:${pctUsed}%; background:${status.color}"></div></div>
    <div class="status-label"><span class="status-dot" style="background:${status.color}"></span>${status.label} &middot; ${v.parts.length} part${v.parts.length === 1 ? '' : 's'}</div>
  `;
  card.addEventListener('click', () => navigate({ screen: 'detail', vehicleId: v.id, tab: 'budget' }));
  return card;
}

function ownershipVehicles(ownership) {
  return data.vehicles.filter(v => ownership === 'mine' ? v.ownerId === currentUser.id : v.ownerId !== currentUser.id);
}

function renderHome() {
  const wrap = document.createElement('div');
  const ownVehicles = ownershipVehicles('mine');
  const sharedVehicles = ownershipVehicles('shared');
  const sharedNewTotal = sharedVehicles.reduce((s, v) => s + totalNewActivity(v), 0);

  if (data.vehicles.length === 0) {
    wrap.innerHTML = '<div class="empty-state">No vehicle projects yet. Click "+ New Vehicle Project" to add your first one.</div>';
    return wrap;
  }

  const grid = document.createElement('div');
  grid.className = 'grid';

  const mineCard = document.createElement('div');
  mineCard.className = 'card';
  mineCard.innerHTML = `
    <h3>🚗 Your projects</h3>
    <div class="section-sub" style="margin-bottom:14px;">${ownVehicles.length} project${ownVehicles.length === 1 ? '' : 's'} you own</div>
    <div class="meter-remaining">${ownVehicles.length}</div>
  `;
  mineCard.addEventListener('click', () => navigate({ screen: 'category', ownership: 'mine' }));
  grid.appendChild(mineCard);

  const sharedCard = document.createElement('div');
  sharedCard.className = 'card';
  sharedCard.innerHTML = `
    <h3>🤝 Shared with you${sharedNewTotal > 0 ? ` <span class="chip" style="color:var(--series-1)">🔔 ${sharedNewTotal} new</span>` : ''}</h3>
    <div class="section-sub" style="margin-bottom:14px;">${sharedVehicles.length} project${sharedVehicles.length === 1 ? '' : 's'} shared with you</div>
    <div class="meter-remaining">${sharedVehicles.length}</div>
  `;
  sharedCard.addEventListener('click', () => navigate({ screen: 'category', ownership: 'shared' }));
  grid.appendChild(sharedCard);

  wrap.appendChild(grid);
  return wrap;
}

function renderCategoryScreen(ownership) {
  const wrap = document.createElement('div');
  const back = document.createElement('a');
  back.className = 'back-link';
  back.textContent = '← Home';
  back.addEventListener('click', () => navigate({ screen: 'home' }));
  wrap.appendChild(back);

  const header = document.createElement('div');
  header.className = 'section-header';
  header.innerHTML = `<h3>${ownership === 'mine' ? 'Your projects' : 'Shared with you'}</h3>`;
  wrap.appendChild(header);

  const vehicles = ownershipVehicles(ownership);
  const projectVehicles = vehicles.filter(v => v.vehicleType !== 'maintenance');
  const maintenanceVehicles = vehicles.filter(v => v.vehicleType === 'maintenance');

  if (vehicles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = ownership === 'mine' ? 'No vehicle projects yet. Click "+ New Vehicle Project" to add your first one.' : 'No one has shared a project with you yet.';
    wrap.appendChild(empty);
    return wrap;
  }

  const grid = document.createElement('div');
  grid.className = 'grid';

  const projectNew = projectVehicles.reduce((s, v) => s + totalNewActivity(v), 0);
  const projectCard = document.createElement('div');
  projectCard.className = 'card';
  projectCard.innerHTML = `
    <h3>🔧 Restoration projects${projectNew > 0 ? ` <span class="chip" style="color:var(--series-1)">🔔 ${projectNew} new</span>` : ''}</h3>
    <div class="section-sub" style="margin-bottom:14px;">${projectVehicles.length} project${projectVehicles.length === 1 ? '' : 's'}</div>
    <div class="meter-remaining">${projectVehicles.length}</div>
  `;
  projectCard.addEventListener('click', () => navigate({ screen: 'list', ownership, vehicleType: 'project', vehicleId: null, tab: 'budget' }));
  grid.appendChild(projectCard);

  const maintNew = maintenanceVehicles.reduce((s, v) => s + totalNewActivity(v), 0);
  const maintCard = document.createElement('div');
  maintCard.className = 'card';
  maintCard.innerHTML = `
    <h3>🛠️ General maintenance${maintNew > 0 ? ` <span class="chip" style="color:var(--series-1)">🔔 ${maintNew} new</span>` : ''}</h3>
    <div class="section-sub" style="margin-bottom:14px;">${maintenanceVehicles.length} vehicle${maintenanceVehicles.length === 1 ? '' : 's'}</div>
    <div class="meter-remaining">${maintenanceVehicles.length}</div>
  `;
  maintCard.addEventListener('click', () => navigate({ screen: 'list', ownership, vehicleType: 'maintenance', vehicleId: null, tab: 'budget' }));
  grid.appendChild(maintCard);

  wrap.appendChild(grid);
  return wrap;
}

function renderList() {
  const wrap = document.createElement('div');
  const ownership = currentView.ownership || 'mine';
  const vehicleType = currentView.vehicleType || 'project';

  const back = document.createElement('a');
  back.className = 'back-link';
  back.textContent = ownership === 'mine' ? '← Your projects' : '← Shared with you';
  back.addEventListener('click', () => navigate({ screen: 'category', ownership }));
  wrap.appendChild(back);

  const vehicles = ownershipVehicles(ownership).filter(v => vehicleType === 'maintenance' ? v.vehicleType === 'maintenance' : v.vehicleType !== 'maintenance');
  const header = document.createElement('div');
  header.className = 'section-header';
  const label = vehicleType === 'maintenance' ? 'General maintenance' : 'Restoration projects';
  const sharedNewTotal = vehicles.reduce((s, v) => s + totalNewActivity(v), 0);
  header.innerHTML = `<h3>${label}</h3><span class="section-sub">${sharedNewTotal > 0 ? `🔔 ${sharedNewTotal} new since you last looked` : (ownership === 'mine' ? '' : 'Projects other people have shared with you')}</span>`;
  wrap.appendChild(header);

  if (vehicles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = ownership === 'mine' ? 'No vehicles here yet. Click "+ New Vehicle Project" to add one.' : 'Nothing here yet.';
    wrap.appendChild(empty);
    return wrap;
  }

  const grid = document.createElement('div');
  grid.className = 'grid';
  vehicles.forEach(v => grid.appendChild(renderVehicleCard(v)));
  wrap.appendChild(grid);
  return wrap;
}

function renderDetail(vehicleId) {
  const v = data.vehicles.find(x => x.id === vehicleId);
  const wrap = document.createElement('div');
  if (!v) { wrap.innerHTML = '<div class="empty-state">Vehicle not found.</div>'; return wrap; }

  const isOwner = v.ownerId === currentUser.id;
  const backOwnership = isOwner ? 'mine' : 'shared';
  const backType = v.vehicleType === 'maintenance' ? 'maintenance' : 'project';
  const back = document.createElement('a');
  back.className = 'back-link';
  back.textContent = `← ${backType === 'maintenance' ? 'General maintenance' : 'Restoration projects'}`;
  back.addEventListener('click', () => navigate({ screen: 'list', ownership: backOwnership, vehicleType: backType, vehicleId: null, tab: 'budget' }));
  wrap.appendChild(back);

  const header = document.createElement('div');
  header.className = 'detail-header';
  header.innerHTML = `
    ${v.coverPhoto ? `<img class="lazy-photo detail-cover" data-photo-path="${v.coverPhoto}">` : ''}
    <div>
      <h2>${v.year} ${escapeHtml(v.make)} ${escapeHtml(v.model)}${v.trim ? ' ' + escapeHtml(v.trim) : ''}</h2>
      <div class="vin">${v.vin ? 'VIN: ' + escapeHtml(v.vin) : 'No VIN entered'} &middot; <span class="chip">${v.vehicleType === 'maintenance' ? 'Maintenance' : 'Project'}</span>${!isOwner ? ' <span class="chip">Shared with you</span>' : ''}${maintenanceAlertCount(v) > 0 ? ` <span class="chip" style="color:var(--serious)">⚠ ${maintenanceAlertCount(v)} due</span>` : ''}</div>
      <div class="vin">${v.vehicleType === 'maintenance' ? 'Ongoing' : `${v.startDate ? formatDate(v.startDate) : '?'} &rarr; ${v.targetDate ? formatDate(v.targetDate) : 'no target date'}`}</div>
    </div>
  `;
  const headerBtns = document.createElement('div');
  headerBtns.className = 'actions';
  const shareBtn = document.createElement('button');
  shareBtn.textContent = isOwner ? 'Share project' : `Collaborators (${v.collaborators.length})`;
  shareBtn.addEventListener('click', () => openCollaboratorsModal(v, isOwner));
  headerBtns.appendChild(shareBtn);
  if (isOwner) {
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit details';
    editBtn.addEventListener('click', () => openVehicleModal(v));
    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = 'Delete project';
    delBtn.addEventListener('click', () => deleteVehicle(v));
    headerBtns.appendChild(editBtn);
    headerBtns.appendChild(delBtn);
  }
  header.appendChild(headerBtns);
  wrap.appendChild(header);

  const activity = newActivityCounts(v);
  const activityTotal = activity.parts + activity.journal + activity.notes + activity.fuel;
  if (activityTotal > 0) {
    const banner = document.createElement('div');
    banner.className = 'summary-panel';
    banner.style.marginBottom = '16px';
    const label = document.createElement('div');
    label.className = 'status-label';
    label.innerHTML = `<span class="status-dot" style="background:var(--series-1)"></span><strong>What's new since your last visit:</strong>`;
    banner.appendChild(label);

    const pillRow = document.createElement('div');
    pillRow.className = 'field-row';
    pillRow.style.marginTop = '8px';
    const addPill = (count, singular, plural, tab) => {
      if (!count) return;
      const pill = document.createElement('button');
      pill.className = 'small primary';
      pill.textContent = `${count} new ${count === 1 ? singular : plural}`;
      pill.addEventListener('click', () => {
        v.lastViewedAt = new Date().toISOString();
        navigate({ screen: 'detail', vehicleId: v.id, tab });
      });
      pillRow.appendChild(pill);
    };
    addPill(activity.parts, 'part', 'parts', 'parts');
    addPill(activity.journal, 'build log entry', 'build log entries', 'journal');
    addPill(activity.notes, 'note', 'notes', 'notes');
    addPill(activity.fuel, 'fuel log', 'fuel logs', 'journal');
    banner.appendChild(pillRow);
    wrap.appendChild(banner);
  }
  markVehicleVisited(v);

  const isMaintenance = v.vehicleType === 'maintenance';
  const tabDefs = isMaintenance
    ? [['parts', 'Parts'], ['journal', 'Build log'], ['notes', 'Notes']]
    : [['budget', 'Budget'], ['parts', 'Parts'], ['journal', 'Build log'], ['notes', 'Notes']];
  const activeTab = isMaintenance && currentView.tab === 'budget' ? 'parts' : currentView.tab;

  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  tabDefs.forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (activeTab === key ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => navigate({ screen: 'detail', vehicleId: v.id, tab: key }));
    tabs.appendChild(btn);
  });
  wrap.appendChild(tabs);

  if (activeTab === 'budget') wrap.appendChild(renderBudgetTab(v));
  else if (activeTab === 'parts') wrap.appendChild(renderPartsTab(v));
  else if (activeTab === 'notes') wrap.appendChild(renderNotesTab(v));
  else wrap.appendChild(renderJournalTab(v));

  return wrap;
}

async function deleteVehicle(v) {
  if (!confirm(`Delete "${v.year} ${v.make} ${v.model}" and everything in it? This cannot be undone.`)) return;
  const { error } = await supabase.from('vehicles').delete().eq('id', v.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  const photoPaths = [v.coverPhoto, ...v.parts.map(p => p.photo), ...v.journal.flatMap(j => j.photos)];
  await deletePhotos(photoPaths);
  data.vehicles = data.vehicles.filter(x => x.id !== v.id);
  navigate({ screen: 'list', ownership: 'mine', vehicleType: v.vehicleType === 'maintenance' ? 'maintenance' : 'project', vehicleId: null, tab: 'budget' });
}

function contactLabelFor(email) {
  const contact = data.contacts.find(c => c.email.toLowerCase() === email.toLowerCase());
  return contact && contact.nickname ? `${contact.nickname} (${email})` : email;
}

function openCollaboratorsModal(v, isOwner) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h2>${isOwner ? 'Share this project' : 'Collaborators'}</h2>
    <div class="section-sub" style="margin-bottom:14px;">${isOwner
      ? 'Invite someone by email — once they sign in with that email, they\'ll see this project and can add/edit parts, budget, notes, and more, the same as you. They can\'t rename or delete the project or manage other collaborators.'
      : 'People with access to this shared project.'}</div>
    <div id="collab-list"></div>
    ${isOwner ? `
      <div class="section" style="margin-top:16px;">
        <label class="section-sub">Quick-pick a saved contact</label>
        <select id="collab-contact-select" style="width:100%; margin-top:4px; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--page); color:var(--text-primary);">
          <option value="">— Choose a saved contact —</option>
          ${data.contacts.map(c => `<option value="${c.id}">${escapeHtml(c.nickname ? `${c.nickname} (${c.email})` : c.email)}</option>`).join('')}
        </select>
      </div>
      <div class="field-row" style="margin-top:10px;">
        <input type="email" id="collab-email" placeholder="their@email.com" style="flex:1; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--page); color:var(--text-primary);">
        <input type="text" id="collab-nickname" placeholder="Nickname (optional)" style="flex:1; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--page); color:var(--text-primary);">
        <button class="primary" id="collab-invite">Invite</button>
      </div>
    ` : ''}
    <div class="modal-actions">
      <button id="collab-close">Close</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  modal.querySelector('#collab-close').addEventListener('click', () => backdrop.remove());

  function renderList() {
    const listEl = modal.querySelector('#collab-list');
    listEl.innerHTML = '';
    const table = document.createElement('table');
    table.innerHTML = '<tbody></tbody>';
    const tbody = table.querySelector('tbody');

    const ownerTr = document.createElement('tr');
    const ownerLabel = v.ownerId === currentUser.id ? `${currentUser.email} (you)` : (v.ownerEmail || 'Project owner');
    ownerTr.innerHTML = `<td>${escapeHtml(ownerLabel)}</td><td class="section-sub">Owner</td><td></td>`;
    tbody.appendChild(ownerTr);

    v.collaborators.forEach(c => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(contactLabelFor(c.email))}</td><td class="section-sub">${formatDate(c.createdAt ? c.createdAt.slice(0, 10) : '')}</td><td class="row-actions"></td>`;
      if (isOwner) {
        const cell = tr.querySelector('.row-actions');
        const removeBtn = document.createElement('button');
        removeBtn.className = 'small danger';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', async () => {
          const { error } = await supabase.from('vehicle_collaborators').delete().eq('id', c.id);
          if (error) { alert('Could not remove: ' + error.message); return; }
          v.collaborators = v.collaborators.filter(x => x.id !== c.id);
          renderList();
        });
        cell.appendChild(removeBtn);
      }
      tbody.appendChild(tr);
    });
    listEl.appendChild(table);
  }
  renderList();

  if (isOwner) {
    const emailInput = modal.querySelector('#collab-email');
    const nicknameInput = modal.querySelector('#collab-nickname');
    modal.querySelector('#collab-contact-select').addEventListener('change', (e) => {
      const contact = data.contacts.find(c => c.id === e.target.value);
      if (contact) {
        emailInput.value = contact.email;
        nicknameInput.value = contact.nickname || '';
      }
    });

    modal.querySelector('#collab-invite').addEventListener('click', async () => {
      const email = emailInput.value.trim().toLowerCase();
      const nickname = nicknameInput.value.trim();
      if (!email || !email.includes('@')) { alert('Enter a valid email address.'); return; }
      const { data: row, error } = await supabase.from('vehicle_collaborators').insert({ vehicle_id: v.id, email }).select().single();
      if (error) {
        alert(error.code === '23505' ? 'That person already has access.' : 'Could not invite: ' + error.message);
        return;
      }
      v.collaborators.push(dbCollaboratorToLocal(row));

      const { data: contactRow, error: contactErr } = await supabase
        .from('known_collaborators')
        .upsert({ owner_id: currentUser.id, email, nickname: nickname || null }, { onConflict: 'owner_id,email' })
        .select()
        .single();
      if (!contactErr) {
        const existingContact = data.contacts.find(c => c.email.toLowerCase() === email);
        if (existingContact) Object.assign(existingContact, dbContactToLocal(contactRow));
        else data.contacts.push(dbContactToLocal(contactRow));
      }

      emailInput.value = '';
      nicknameInput.value = '';
      renderList();
    });
  }
}

// --- Budget tab ---

function renderBudgetTab(v) {
  const wrap = document.createElement('div');
  const budget = totalBudget(v);
  const spent = totalSpent(v);
  const planned = partsPlanned(v);
  const credits = creditsTotal(v);
  const remaining = remainingBudget(v);
  const status = budgetStatus(remaining, budget);

  const summary = document.createElement('div');
  summary.className = 'summary-panel';
  summary.innerHTML = `
    <div class="summary-figures">
      <div class="figure"><div class="value" style="color:${status.color}">${money(remaining)}</div><div class="label">Remaining</div></div>
      <div class="figure"><div class="value">${money(spent)}</div><div class="label">Spent (parts + paid labor)</div></div>
      <div class="figure"><div class="value">${money(planned)}</div><div class="label">Planned (not yet bought)</div></div>
      <div class="figure"><div class="value">${money(credits)}</div><div class="label">Refunds &amp; credits</div></div>
      <div class="figure"><div class="value">${money(budget)}</div><div class="label">Total budget</div></div>
    </div>
    <div class="meter-track"><div class="meter-fill" style="width:${budget > 0 ? Math.min(100, (spent / budget) * 100) : 0}%; background:${status.color}"></div></div>
    <div class="status-label"><span class="status-dot" style="background:${status.color}"></span>${status.label}${remaining - planned < 0 ? ' — buying everything still planned would put you over' : ''}</div>
  `;
  wrap.appendChild(summary);

  // Sale & profit
  const saleSection = document.createElement('div');
  saleSection.className = 'section';
  const saleHeader = document.createElement('div');
  saleHeader.className = 'section-header';
  saleHeader.innerHTML = `<h3>Sale &amp; profit</h3><span class="section-sub">Purchase price + build spending vs. what you sold it for</span>`;
  const editSaleBtn = document.createElement('button');
  editSaleBtn.textContent = 'Edit purchase/sale price';
  editSaleBtn.addEventListener('click', () => openVehicleModal(v));
  saleHeader.appendChild(editSaleBtn);
  saleSection.appendChild(saleHeader);

  const invested = netInvested(v);
  const profit = projectProfit(v);
  const hasSalePrice = v.salePrice != null;
  const saleSummary = document.createElement('div');
  saleSummary.className = 'summary-panel';
  saleSummary.innerHTML = `
    <div class="summary-figures">
      <div class="figure"><div class="value">${v.purchasePrice != null ? money(v.purchasePrice) : '—'}</div><div class="label">Purchase price</div></div>
      <div class="figure"><div class="value">${money(invested)}</div><div class="label">Net invested (purchase + build − credits)</div></div>
      <div class="figure"><div class="value">${hasSalePrice ? money(v.salePrice) : '—'}</div><div class="label">Sale price</div></div>
      <div class="figure"><div class="value" style="color:${hasSalePrice ? (profit >= 0 ? 'var(--good)' : 'var(--critical)') : 'var(--text-muted)'}">${hasSalePrice ? money(profit) : 'Not sold yet'}</div><div class="label">Profit</div></div>
    </div>
  `;
  saleSection.appendChild(saleSummary);
  wrap.appendChild(saleSection);

  // Phases
  const phaseSection = document.createElement('div');
  phaseSection.className = 'section';
  const phaseHeader = document.createElement('div');
  phaseHeader.className = 'section-header';
  phaseHeader.innerHTML = `<h3>Budget phases</h3><span class="section-sub">Split the build into rounds, e.g. Engine, Paint, Interior</span>`;
  const addPhaseBtn = document.createElement('button');
  addPhaseBtn.textContent = '+ Add phase';
  addPhaseBtn.addEventListener('click', () => openPhaseModal(v));
  phaseHeader.appendChild(addPhaseBtn);
  phaseSection.appendChild(phaseHeader);

  const phaseList = document.createElement('div');
  phaseList.className = 'phase-list';
  v.phases.forEach(ph => {
    const spentHere = phaseSpent(v, ph.id);
    const remHere = Number(ph.budget || 0) - spentHere;
    const st = budgetStatus(remHere, Number(ph.budget || 0));
    const pct = ph.budget > 0 ? Math.min(100, Math.max(0, (spentHere / ph.budget) * 100)) : 0;
    const card = document.createElement('div');
    card.className = 'phase-card';
    card.innerHTML = `
      <div class="phase-top"><span class="name">${escapeHtml(ph.name)}</span><span class="amounts">${money(remHere)} left of ${money(ph.budget)}</span></div>
      <div class="meter-track"><div class="meter-fill" style="width:${pct}%; background:${st.color}"></div></div>
    `;
    const actions = document.createElement('div');
    actions.className = 'phase-actions';
    const editP = document.createElement('button');
    editP.className = 'small';
    editP.textContent = 'Edit';
    editP.addEventListener('click', () => openPhaseModal(v, ph));
    actions.appendChild(editP);
    if (v.phases.length > 1) {
      const delP = document.createElement('button');
      delP.className = 'small danger';
      delP.textContent = 'Delete';
      delP.addEventListener('click', () => deletePhase(v, ph));
      actions.appendChild(delP);
    }
    card.appendChild(actions);
    phaseList.appendChild(card);
  });
  phaseSection.appendChild(phaseList);
  wrap.appendChild(phaseSection);

  // Labor
  const laborSection = document.createElement('div');
  laborSection.className = 'section';
  const laborHeader = document.createElement('div');
  laborHeader.className = 'section-header';
  const totalHours = v.labor.reduce((s, l) => s + Number(l.hours || 0), 0);
  laborHeader.innerHTML = `<h3>Labor</h3><span class="section-sub">${totalHours} hour${totalHours === 1 ? '' : 's'} logged &middot; ${money(paidLaborTotal(v))} paid to a shop</span>`;
  const addLaborBtn = document.createElement('button');
  addLaborBtn.textContent = '+ Log labor';
  addLaborBtn.addEventListener('click', () => openLaborModal(v));
  laborHeader.appendChild(addLaborBtn);
  laborSection.appendChild(laborHeader);

  if (v.labor.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No labor logged yet.';
    laborSection.appendChild(empty);
  } else {
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Date</th><th>Description</th><th>Hours</th><th>Paid?</th><th>Amount</th><th></th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    v.labor.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).forEach(l => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatDate(l.date)}</td>
        <td>${escapeHtml(l.description || '')}</td>
        <td>${l.hours || 0}</td>
        <td>${l.paid ? 'Paid shop labor' : 'My own time'}</td>
        <td class="cost">${l.paid ? money(l.amount) : '—'}</td>
        <td class="row-actions"></td>
      `;
      const cell = tr.querySelector('.row-actions');
      const editBtn = document.createElement('button');
      editBtn.className = 'small';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openLaborModal(v, l));
      const delBtn = document.createElement('button');
      delBtn.className = 'small danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteLabor(v, l));
      cell.appendChild(editBtn);
      cell.appendChild(delBtn);
      tbody.appendChild(tr);
    });
    laborSection.appendChild(table);
  }
  wrap.appendChild(laborSection);

  // Credits / refunds
  const creditSection = document.createElement('div');
  creditSection.className = 'section';
  const creditHeader = document.createElement('div');
  creditHeader.className = 'section-header';
  creditHeader.innerHTML = `<h3>Refunds &amp; credits</h3><span class="section-sub">Core deposits back, returns, sold take-off parts</span>`;
  const addCreditBtn = document.createElement('button');
  addCreditBtn.textContent = '+ Add credit';
  addCreditBtn.addEventListener('click', () => openCreditModal(v));
  creditHeader.appendChild(addCreditBtn);
  creditSection.appendChild(creditHeader);

  if (v.credits.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No refunds or credits recorded yet.';
    creditSection.appendChild(empty);
  } else {
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Date</th><th>Reason</th><th>Amount</th><th></th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    v.credits.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).forEach(c => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${formatDate(c.date)}</td><td>${escapeHtml(c.reason || '')}</td><td class="cost" style="color:var(--good)">+${money(c.amount)}</td><td class="row-actions"></td>`;
      const cell = tr.querySelector('.row-actions');
      const delBtn = document.createElement('button');
      delBtn.className = 'small danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteCredit(v, c));
      cell.appendChild(delBtn);
      tbody.appendChild(tr);
    });
    creditSection.appendChild(table);
  }
  wrap.appendChild(creditSection);

  return wrap;
}

async function deletePhase(v, ph) {
  const fallback = v.phases.find(p => p.id !== ph.id);
  if (!fallback) { alert('Can\'t delete the only budget phase on a project.'); return; }
  if (!confirm(`Delete phase "${ph.name}"? Parts assigned to it will move to "${fallback.name}".`)) return;
  const affectedParts = v.parts.filter(p => p.phaseId === ph.id);
  if (affectedParts.length) {
    const { error } = await supabase.from('parts').update({ phase_id: fallback.id }).eq('phase_id', ph.id);
    if (error) { alert('Could not reassign parts: ' + error.message); return; }
    affectedParts.forEach(p => p.phaseId = fallback.id);
  }
  const { error } = await supabase.from('phases').delete().eq('id', ph.id);
  if (error) { alert('Could not delete phase: ' + error.message); return; }
  v.phases = v.phases.filter(p => p.id !== ph.id);
  render();
}
async function deleteLabor(v, l) {
  const { error } = await supabase.from('labor').delete().eq('id', l.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  v.labor = v.labor.filter(x => x.id !== l.id);
  render();
}
async function deleteCredit(v, c) {
  const { error } = await supabase.from('credits').delete().eq('id', c.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  v.credits = v.credits.filter(x => x.id !== c.id);
  render();
}

// --- Parts tab ---

function renderFavoritesSection(v) {
  const section = document.createElement('div');
  section.className = 'section';
  const secHeader = document.createElement('div');
  secHeader.className = 'section-header';
  secHeader.innerHTML = `<h3>★ Favorites</h3><span class="section-sub">Parts you buy again and again — save the part number once, reuse it anytime</span>`;
  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add favorite';
  addBtn.addEventListener('click', () => openFavoriteModal(v));
  secHeader.appendChild(addBtn);
  section.appendChild(secHeader);

  if (v.favorites.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No favorites yet. Star a part below once you\'ve found the right one, or add one directly.';
    section.appendChild(empty);
    return section;
  }

  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Part</th><th>Part #</th><th>Vendor</th><th>Category</th><th></th></tr></thead><tbody></tbody>';
  const tbody = table.querySelector('tbody');
  v.favorites.forEach(fav => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(fav.name)}</td>
      <td>${escapeHtml(fav.partNumber || '')}</td>
      <td>${escapeHtml(fav.vendor || '')}</td>
      <td>${escapeHtml(fav.category)}</td>
      <td class="row-actions"></td>
    `;
    const cell = tr.querySelector('.row-actions');
    const raBtn = document.createElement('button');
    raBtn.className = 'small';
    raBtn.textContent = 'RockAuto';
    raBtn.addEventListener('click', () => window.open(rockAutoSearchUrl(v, fav), '_blank', 'noopener'));
    const amzBtn = document.createElement('button');
    amzBtn.className = 'small';
    amzBtn.textContent = 'Amazon';
    amzBtn.addEventListener('click', () => window.open(amazonSearchUrl(v, fav), '_blank', 'noopener'));
    const addToListBtn = document.createElement('button');
    addToListBtn.className = 'small primary';
    addToListBtn.textContent = '+ To shopping list';
    addToListBtn.addEventListener('click', () => addFavoriteToShoppingList(v, fav));
    const editBtn = document.createElement('button');
    editBtn.className = 'small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openFavoriteModal(v, fav));
    const delBtn = document.createElement('button');
    delBtn.className = 'small danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteFavorite(v, fav));
    cell.appendChild(raBtn);
    cell.appendChild(amzBtn);
    cell.appendChild(addToListBtn);
    cell.appendChild(editBtn);
    cell.appendChild(delBtn);
    tbody.appendChild(tr);
  });
  section.appendChild(table);
  return section;
}

async function addFavoriteToShoppingList(v, fav) {
  const phaseId = v.phases[0].id;
  const fields = {
    name: fav.name, category: fav.category, cost: 0, status: 'needed',
    phase_id: phaseId, vendor: fav.vendor || '', part_number: fav.partNumber || '', notes: fav.notes || '', photo_path: null,
  };
  const { data: row, error } = await supabase.from('parts').insert({ vehicle_id: v.id, ...fields }).select().single();
  if (error) { alert('Could not add to shopping list: ' + error.message); return; }
  v.parts.push(dbPartToLocal(row));
  render();
}

async function deleteFavorite(v, fav) {
  if (!confirm(`Remove "${fav.name}" from favorites?`)) return;
  const { error } = await supabase.from('favorite_parts').delete().eq('id', fav.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  v.favorites = v.favorites.filter(x => x.id !== fav.id);
  render();
}

async function addPartToFavorites(v, p) {
  const fields = { name: p.name, part_number: p.partNumber || '', vendor: p.vendor || '', category: p.category, notes: p.notes || '' };
  const { data: row, error } = await supabase.from('favorite_parts').insert({ vehicle_id: v.id, ...fields }).select().single();
  if (error) { alert('Could not save favorite: ' + error.message); return; }
  v.favorites.push(dbFavoriteToLocal(row));
  render();
}

function openFavoriteModal(v, existing) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const isEdit = !!existing;
  modal.innerHTML = `
    <h2>${isEdit ? 'Edit favorite' : 'Add favorite'}</h2>
    <div class="field"><label>Part name</label><input type="text" id="fav-name" value="${isEdit ? escapeHtml(existing.name) : ''}" placeholder="Oil filter"></div>
    <div class="field-row">
      <div class="field"><label>Category</label><select id="fav-category">${CATEGORIES.map(c => `<option value="${c}" ${isEdit && existing.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Part number / SKU</label><input type="text" id="fav-partnum" value="${isEdit ? escapeHtml(existing.partNumber || '') : ''}" placeholder="e.g. PH3593A"></div>
    </div>
    <div class="field"><label>Vendor</label><input type="text" id="fav-vendor" value="${isEdit ? escapeHtml(existing.vendor || '') : ''}" placeholder="RockAuto, Amazon..."></div>
    <div class="field"><label>Notes</label><input type="text" id="fav-notes" value="${isEdit ? escapeHtml(existing.notes || '') : ''}"></div>
    <div class="modal-actions">
      <button id="fav-cancel">Cancel</button>
      <button class="primary" id="fav-save">${isEdit ? 'Save changes' : 'Add favorite'}</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  modal.querySelector('#fav-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#fav-save').addEventListener('click', async () => {
    const name = modal.querySelector('#fav-name').value.trim();
    if (!name) { alert('Part name is required.'); return; }
    const fields = {
      name,
      category: modal.querySelector('#fav-category').value,
      part_number: modal.querySelector('#fav-partnum').value.trim(),
      vendor: modal.querySelector('#fav-vendor').value.trim(),
      notes: modal.querySelector('#fav-notes').value.trim(),
    };
    if (isEdit) {
      const { error } = await supabase.from('favorite_parts').update(fields).eq('id', existing.id);
      if (error) { alert('Could not save: ' + error.message); return; }
      Object.assign(existing, { name, category: fields.category, partNumber: fields.part_number, vendor: fields.vendor, notes: fields.notes });
    } else {
      const { data: row, error } = await supabase.from('favorite_parts').insert({ vehicle_id: v.id, ...fields }).select().single();
      if (error) { alert('Could not add favorite: ' + error.message); return; }
      v.favorites.push(dbFavoriteToLocal(row));
    }
    backdrop.remove();
    render();
  });
}

function renderPartsTab(v) {
  const wrap = document.createElement('div');
  wrap.appendChild(renderFavoritesSection(v));
  const header = document.createElement('div');
  header.className = 'section-header';
  header.innerHTML = `<h3>Shopping list</h3><span class="section-sub">Organized by system — add items to any section</span>`;
  const addBtn = document.createElement('button');
  addBtn.className = 'primary';
  addBtn.textContent = '+ Add part';
  addBtn.addEventListener('click', () => openPartModal(v));
  header.appendChild(addBtn);
  wrap.appendChild(header);

  const filters = currentView.partFilters || { status: 'all' };
  currentView.partFilters = filters;

  const filterRow = document.createElement('div');
  filterRow.className = 'filter-row';
  const statSelect = document.createElement('select');
  statSelect.innerHTML = '<option value="all">All statuses</option>' + STATUSES.map(s => `<option value="${s.key}" ${filters.status === s.key ? 'selected' : ''}>${s.label}</option>`).join('');
  statSelect.value = filters.status;
  statSelect.addEventListener('change', () => { filters.status = statSelect.value; render(); });
  filterRow.appendChild(statSelect);
  wrap.appendChild(filterRow);

  if (v.parts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No parts added yet. Add items to any section below to start your shopping list.';
    wrap.appendChild(empty);
  }

  CATEGORIES.forEach(category => {
    const items = v.parts
      .filter(p => p.category === category && (filters.status === 'all' || p.status === filters.status))
      .sort((a, b) => a.status.localeCompare(b.status));

    const section = document.createElement('div');
    section.className = 'section';
    const secHeader = document.createElement('div');
    secHeader.className = 'section-header';
    secHeader.innerHTML = `<h3>${escapeHtml(category)}</h3><span class="section-sub">${items.length} item${items.length === 1 ? '' : 's'}</span>`;
    const secAddBtn = document.createElement('button');
    secAddBtn.className = 'small';
    secAddBtn.textContent = '+ Add';
    secAddBtn.addEventListener('click', () => openPartModal(v, null, category));
    secHeader.appendChild(secAddBtn);
    section.appendChild(secHeader);

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.style.padding = '16px';
      empty.textContent = 'Nothing here yet.';
      section.appendChild(empty);
    } else {
      const table = document.createElement('table');
      table.innerHTML = '<thead><tr><th>Part</th><th>Part #</th><th>Cost</th><th>Status</th><th>Phase</th><th>Vendor</th><th></th></tr></thead><tbody></tbody>';
      const tbody = table.querySelector('tbody');
      items.forEach(p => {
        const st = statusInfo(p.status);
        const phase = v.phases.find(ph => ph.id === p.phaseId);
        const tr = document.createElement('tr');
        if (p.status === 'returned') tr.className = 'muted-row';
        tr.innerHTML = `
          <td>${p.photo ? `<img class="lazy-photo" data-photo-path="${p.photo}" style="width:32px;height:32px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:6px;cursor:pointer;background:var(--gridline)" data-photo-click>` : ''}${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.partNumber || '')}</td>
          <td class="cost ${p.status === 'returned' ? 'strike' : ''}">${money(p.cost)}</td>
          <td><span class="chip" style="color:${st.color}"><span class="status-dot" style="background:${st.color}"></span>${st.label}</span></td>
          <td>${escapeHtml(phase ? phase.name : '')}</td>
          <td>${escapeHtml(p.vendor || '')}</td>
          <td class="row-actions"></td>
        `;
        const photoImg = tr.querySelector('[data-photo-click]');
        if (photoImg) photoImg.addEventListener('click', () => openLightboxForPath(p.photo));
        const cell = tr.querySelector('.row-actions');
        const raBtn = document.createElement('button');
        raBtn.className = 'small';
        raBtn.textContent = 'RockAuto';
        raBtn.addEventListener('click', () => window.open(rockAutoSearchUrl(v, p), '_blank', 'noopener'));
        const amzBtn = document.createElement('button');
        amzBtn.className = 'small';
        amzBtn.textContent = 'Amazon';
        amzBtn.addEventListener('click', () => window.open(amazonSearchUrl(v, p), '_blank', 'noopener'));
        const favBtn = document.createElement('button');
        favBtn.className = 'small';
        favBtn.textContent = '☆ Favorite';
        favBtn.title = 'Save to favorites for quick reuse later';
        favBtn.addEventListener('click', () => addPartToFavorites(v, p));
        cell.appendChild(raBtn);
        cell.appendChild(amzBtn);
        cell.appendChild(favBtn);
        const editBtn = document.createElement('button');
        editBtn.className = 'small';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => openPartModal(v, p));
        const delBtn = document.createElement('button');
        delBtn.className = 'small danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => deletePart(v, p));
        cell.appendChild(editBtn);
        cell.appendChild(delBtn);
        tbody.appendChild(tr);
      });
      section.appendChild(table);
    }
    wrap.appendChild(section);
  });

  return wrap;
}

async function deletePart(v, p) {
  if (!confirm(`Delete part "${p.name}"?`)) return;
  const { error } = await supabase.from('parts').delete().eq('id', p.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  await deletePhotos([p.photo]);
  v.parts = v.parts.filter(x => x.id !== p.id);
  render();
}

// --- Journal tab ---

function renderChecklistSection(v) {
  const section = document.createElement('div');
  section.className = 'section';
  const done = v.checklist.filter(c => c.done).length;
  const total = v.checklist.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const secHeader = document.createElement('div');
  secHeader.className = 'section-header';
  secHeader.innerHTML = `<h3>Restoration checklist</h3><span class="section-sub">${total > 0 ? `${done} of ${total} tasks done (${pct}%)` : 'Break the restore down into steps you can check off'}</span>`;
  const btnGroup = document.createElement('div');
  btnGroup.className = 'actions';
  if (total === 0) {
    const loadBtn = document.createElement('button');
    loadBtn.className = 'primary';
    loadBtn.textContent = 'Load standard checklist';
    loadBtn.addEventListener('click', async () => {
      loadBtn.disabled = true;
      v.checklist = await seedChecklist(v.id);
      render();
    });
    btnGroup.appendChild(loadBtn);
  }
  const addTaskBtn = document.createElement('button');
  addTaskBtn.textContent = '+ Add task';
  addTaskBtn.addEventListener('click', () => openChecklistItemModal(v));
  btnGroup.appendChild(addTaskBtn);
  secHeader.appendChild(btnGroup);
  section.appendChild(secHeader);

  if (total > 0) {
    section.appendChild((() => {
      const track = document.createElement('div');
      track.className = 'meter-track';
      track.style.marginBottom = '16px';
      track.innerHTML = `<div class="meter-fill" style="width:${pct}%; background:var(--good)"></div>`;
      return track;
    })());

    CATEGORIES.forEach(category => {
      const items = v.checklist.filter(c => c.category === category).sort((a, b) => a.position - b.position);
      if (items.length === 0) return;
      const catBlock = document.createElement('div');
      catBlock.style.marginBottom = '16px';
      catBlock.innerHTML = `<div class="section-sub" style="margin-bottom:6px; font-weight:600; color:var(--text-secondary)">${escapeHtml(category)}</div>`;
      items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'checklist-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = item.done;
        cb.addEventListener('change', () => toggleChecklistDone(v, item, cb.checked));
        const label = document.createElement('span');
        label.className = 'task-text' + (item.done ? ' done-task' : '');
        label.textContent = item.task + (item.done && item.doneDate ? ` (${formatDate(item.doneDate)})` : '');
        const delBtn = document.createElement('button');
        delBtn.className = 'small danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => deleteChecklistItem(v, item));
        row.appendChild(cb);
        row.appendChild(label);
        row.appendChild(delBtn);
        catBlock.appendChild(row);
      });
      section.appendChild(catBlock);
    });
  }
  return section;
}

async function toggleChecklistDone(v, item, checked) {
  const doneDate = checked ? new Date().toISOString().slice(0, 10) : null;
  const { error } = await supabase.from('checklist_items').update({ done: checked, done_date: doneDate }).eq('id', item.id);
  if (error) { alert('Could not save: ' + error.message); return; }
  item.done = checked;
  item.doneDate = doneDate;
  render();
}
async function deleteChecklistItem(v, item) {
  if (!confirm(`Delete task "${item.task}"?`)) return;
  const { error } = await supabase.from('checklist_items').delete().eq('id', item.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  v.checklist = v.checklist.filter(x => x.id !== item.id);
  render();
}

function openChecklistItemModal(v, presetCategory) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h2>Add restoration task</h2>
    <div class="field"><label>Category</label><select id="chk-category">${CATEGORIES.map(c => `<option value="${c}" ${presetCategory === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    <div class="field"><label>Task</label><input type="text" id="chk-task" placeholder="Rebuild carburetor"></div>
    <div class="modal-actions">
      <button id="chk-cancel">Cancel</button>
      <button class="primary" id="chk-save">Add task</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  modal.querySelector('#chk-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#chk-save').addEventListener('click', async () => {
    const category = modal.querySelector('#chk-category').value;
    const task = modal.querySelector('#chk-task').value.trim();
    if (!task) { alert('Enter a task.'); return; }
    const position = Math.max(-1, ...v.checklist.filter(c => c.category === category).map(c => c.position)) + 1;
    const { data: row, error } = await supabase.from('checklist_items').insert({ vehicle_id: v.id, category, task, position }).select().single();
    if (error) { alert('Could not add task: ' + error.message); return; }
    v.checklist.push(dbChecklistToLocal(row));
    backdrop.remove();
    render();
  });
}

function renderMaintenanceSection(v) {
  const section = document.createElement('div');
  section.className = 'section';
  const secHeader = document.createElement('div');
  secHeader.className = 'section-header';
  const alertCount = maintenanceAlertCount(v);
  secHeader.innerHTML = `<h3>Maintenance schedule</h3><span class="section-sub">${alertCount > 0 ? `⚠ ${alertCount} item${alertCount === 1 ? '' : 's'} due soon or overdue` : 'Track recurring service by date and/or mileage'}</span>`;
  const btnGroup = document.createElement('div');
  btnGroup.className = 'actions';
  const mileageBtn = document.createElement('button');
  mileageBtn.textContent = v.currentMileage != null ? `${v.currentMileage.toLocaleString()} mi — update` : 'Set current mileage';
  mileageBtn.addEventListener('click', () => openMileageModal(v));
  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add item';
  addBtn.addEventListener('click', () => openMaintenanceModal(v));
  const printBtn = document.createElement('button');
  printBtn.textContent = 'Print maintenance history';
  printBtn.addEventListener('click', () => printMaintenanceHistory(v));
  btnGroup.appendChild(mileageBtn);
  btnGroup.appendChild(addBtn);
  btnGroup.appendChild(printBtn);
  secHeader.appendChild(btnGroup);
  section.appendChild(secHeader);

  if (v.maintenance.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No maintenance items yet. Add things like oil changes, tire rotations, or filter swaps to get due reminders.';
    section.appendChild(empty);
    return section;
  }

  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Task</th><th>Interval</th><th>Last done</th><th>Status</th><th></th></tr></thead><tbody></tbody>';
  const tbody = table.querySelector('tbody');
  v.maintenance.forEach(item => {
    const st = maintenanceStatus(v, item);
    const intervalParts = [];
    if (item.intervalDays) intervalParts.push(`${item.intervalDays}d`);
    if (item.intervalMiles) intervalParts.push(`${item.intervalMiles.toLocaleString()} mi`);
    const lastParts = [];
    if (item.lastDoneDate) lastParts.push(formatDate(item.lastDoneDate));
    if (item.lastDoneMileage != null) lastParts.push(`${item.lastDoneMileage.toLocaleString()} mi`);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(item.task)}</td>
      <td>${intervalParts.join(' / ') || '—'}</td>
      <td>${lastParts.join(' / ') || 'Never'}</td>
      <td><span class="chip" style="color:${st.color}"><span class="status-dot" style="background:${st.color}"></span>${st.label}</span></td>
      <td class="row-actions"></td>
    `;
    const cell = tr.querySelector('.row-actions');
    const doneBtn = document.createElement('button');
    doneBtn.className = 'small primary';
    doneBtn.textContent = 'Mark done today';
    doneBtn.addEventListener('click', () => markMaintenanceDone(v, item));
    const editBtn = document.createElement('button');
    editBtn.className = 'small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openMaintenanceModal(v, item));
    const delBtn = document.createElement('button');
    delBtn.className = 'small danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteMaintenanceItem(v, item));
    cell.appendChild(doneBtn);
    cell.appendChild(editBtn);
    cell.appendChild(delBtn);
    tbody.appendChild(tr);
  });
  section.appendChild(table);
  return section;
}

function printMaintenanceHistory(v) {
  const title = `${v.year} ${v.make} ${v.model}${v.trim ? ' ' + v.trim : ''}`;
  const rows = v.maintenance.slice().map(item => {
    const st = maintenanceStatus(v, item);
    const intervalParts = [];
    if (item.intervalDays) intervalParts.push(`${item.intervalDays} days`);
    if (item.intervalMiles) intervalParts.push(`${item.intervalMiles.toLocaleString()} mi`);
    const lastParts = [];
    if (item.lastDoneDate) lastParts.push(formatDate(item.lastDoneDate));
    if (item.lastDoneMileage != null) lastParts.push(`${item.lastDoneMileage.toLocaleString()} mi`);
    return `
      <tr>
        <td>${escapeHtml(item.task)}</td>
        <td>${escapeHtml(intervalParts.join(' / ') || '—')}</td>
        <td>${escapeHtml(lastParts.join(' / ') || 'Never')}</td>
        <td>${escapeHtml(st.label)}</td>
        <td>${escapeHtml(item.notes || '')}</td>
      </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — Maintenance History</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; padding: 40px; max-width: 800px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 2px; }
  .meta { color: #555; font-size: 13px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #ddd; font-size: 13px; }
  th { text-transform: uppercase; font-size: 11px; color: #666; letter-spacing: 0.03em; }
  .footer { margin-top: 32px; font-size: 11px; color: #999; }
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
  <h1>${escapeHtml(title)} — Maintenance History</h1>
  <div class="meta">
    ${v.vin ? `VIN: ${escapeHtml(v.vin)} &middot; ` : ''}${v.currentMileage != null ? `Current mileage: ${v.currentMileage.toLocaleString()} mi` : 'Mileage not recorded'}
  </div>
  ${v.maintenance.length === 0
    ? '<p>No maintenance items recorded.</p>'
    : `<table>
        <thead><tr><th>Task</th><th>Interval</th><th>Last done</th><th>Status</th><th>Notes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }
  <div class="footer">Generated ${new Date().toLocaleDateString()} from Vehicle Project Tracker</div>
</body>
</html>`;

  const printWindow = window.open('', '_blank');
  if (!printWindow) { alert('Please allow pop-ups to print the maintenance history.'); return; }
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

async function markMaintenanceDone(v, item) {
  const fields = { last_done_date: new Date().toISOString().slice(0, 10), last_done_mileage: v.currentMileage != null ? v.currentMileage : item.lastDoneMileage };
  const { error } = await supabase.from('maintenance_items').update(fields).eq('id', item.id);
  if (error) { alert('Could not save: ' + error.message); return; }
  item.lastDoneDate = fields.last_done_date;
  item.lastDoneMileage = fields.last_done_mileage;
  render();
}
async function deleteMaintenanceItem(v, item) {
  if (!confirm(`Delete "${item.task}" from the maintenance schedule?`)) return;
  const { error } = await supabase.from('maintenance_items').delete().eq('id', item.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  v.maintenance = v.maintenance.filter(x => x.id !== item.id);
  render();
}

function openMileageModal(v) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h2>Update current mileage</h2>
    <div class="field"><label>Mileage</label><input type="number" id="mi-mileage" value="${v.currentMileage != null ? v.currentMileage : ''}" placeholder="87500"></div>
    <div class="modal-actions">
      <button id="mi-cancel">Cancel</button>
      <button class="primary" id="mi-save">Save</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  modal.querySelector('#mi-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#mi-save').addEventListener('click', async () => {
    const mileage = parseInt(modal.querySelector('#mi-mileage').value, 10);
    if (isNaN(mileage) || mileage < 0) { alert('Enter a valid mileage.'); return; }
    const { error } = await supabase.from('vehicles').update({ current_mileage: mileage }).eq('id', v.id);
    if (error) { alert('Could not save: ' + error.message); return; }
    v.currentMileage = mileage;
    backdrop.remove();
    render();
  });
}

function openMaintenanceModal(v, existing) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const isEdit = !!existing;
  const matchedPreset = isEdit ? MAINTENANCE_PRESETS.find(p => p.label.toLowerCase() === existing.task.toLowerCase()) : null;
  modal.innerHTML = `
    <h2>${isEdit ? 'Edit maintenance item' : 'Add maintenance item'}</h2>
    <div class="field">
      <label>Common task</label>
      <select id="mx-preset">
        <option value="">Custom (type your own)</option>
        ${MAINTENANCE_PRESETS.map((p, i) => `<option value="${i}" ${matchedPreset === p ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
      </select>
      <div class="section-sub">Picking one fills in the suggested intervals below — tweak them if your vehicle or usage differs.</div>
    </div>
    <div class="field"><label>Task</label><input type="text" id="mx-task" value="${isEdit ? escapeHtml(existing.task) : ''}" placeholder="Oil change"></div>
    <div class="field-row">
      <div class="field"><label>Repeat every (days)</label><input type="number" id="mx-interval-days" value="${isEdit ? existing.intervalDays || '' : ''}" placeholder="180"></div>
      <div class="field"><label>Repeat every (miles)</label><input type="number" id="mx-interval-miles" value="${isEdit ? existing.intervalMiles || '' : ''}" placeholder="5000"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Last done date</label><input type="date" id="mx-last-date" value="${isEdit ? existing.lastDoneDate || '' : ''}"></div>
      <div class="field"><label>Last done mileage</label><input type="number" id="mx-last-mileage" value="${isEdit && existing.lastDoneMileage != null ? existing.lastDoneMileage : ''}" placeholder="82500"></div>
    </div>
    <div class="field"><label>Notes</label><input type="text" id="mx-notes" value="${isEdit ? escapeHtml(existing.notes || '') : ''}"></div>
    <div class="modal-actions">
      <button id="mx-cancel">Cancel</button>
      <button class="primary" id="mx-save">${isEdit ? 'Save changes' : 'Add item'}</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  modal.querySelector('#mx-preset').addEventListener('change', (e) => {
    if (e.target.value === '') return;
    const preset = MAINTENANCE_PRESETS[parseInt(e.target.value, 10)];
    modal.querySelector('#mx-task').value = preset.label;
    modal.querySelector('#mx-interval-days').value = preset.days || '';
    modal.querySelector('#mx-interval-miles').value = preset.miles || '';
  });
  modal.querySelector('#mx-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#mx-save').addEventListener('click', async () => {
    const task = modal.querySelector('#mx-task').value.trim();
    if (!task) { alert('Task name is required.'); return; }
    const intervalDaysVal = parseInt(modal.querySelector('#mx-interval-days').value, 10);
    const intervalMilesVal = parseInt(modal.querySelector('#mx-interval-miles').value, 10);
    const lastMileageVal = parseInt(modal.querySelector('#mx-last-mileage').value, 10);
    const fields = {
      task,
      interval_days: isNaN(intervalDaysVal) ? null : intervalDaysVal,
      interval_miles: isNaN(intervalMilesVal) ? null : intervalMilesVal,
      last_done_date: modal.querySelector('#mx-last-date').value || null,
      last_done_mileage: isNaN(lastMileageVal) ? null : lastMileageVal,
      notes: modal.querySelector('#mx-notes').value.trim(),
    };
    if (!fields.interval_days && !fields.interval_miles) { alert('Set at least one of: repeat every N days, repeat every N miles.'); return; }
    if (isEdit) {
      const { error } = await supabase.from('maintenance_items').update(fields).eq('id', existing.id);
      if (error) { alert('Could not save: ' + error.message); return; }
      Object.assign(existing, { task, intervalDays: fields.interval_days, intervalMiles: fields.interval_miles, lastDoneDate: fields.last_done_date, lastDoneMileage: fields.last_done_mileage, notes: fields.notes });
    } else {
      const { data: row, error } = await supabase.from('maintenance_items').insert({ vehicle_id: v.id, ...fields }).select().single();
      if (error) { alert('Could not add item: ' + error.message); return; }
      v.maintenance.push(dbMaintenanceToLocal(row));
    }
    backdrop.remove();
    render();
  });
}

function renderFuelSection(v) {
  const section = document.createElement('div');
  section.className = 'section';
  const { entries, avgMpg } = computeFuelStats(v);
  const totalCost = v.fuel.reduce((s, f) => s + f.totalCost, 0);

  const secHeader = document.createElement('div');
  secHeader.className = 'section-header';
  secHeader.innerHTML = `<h3>Fuel log</h3><span class="section-sub">${avgMpg != null ? `${avgMpg.toFixed(1)} avg MPG · ${money(totalCost)} spent on fuel` : 'Log fill-ups to track MPG'}</span>`;
  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Log fill-up';
  addBtn.addEventListener('click', () => openFuelModal(v));
  secHeader.appendChild(addBtn);
  section.appendChild(secHeader);

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No fill-ups logged yet.';
    section.appendChild(empty);
    return section;
  }

  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Date</th><th>Mileage</th><th>Gallons</th><th>Cost</th><th>MPG</th><th></th></tr></thead><tbody></tbody>';
  const tbody = table.querySelector('tbody');
  entries.forEach(entry => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(entry.date)}${entry.notes ? `<div class="section-sub">${escapeHtml(entry.notes)}</div>` : ''}</td>
      <td>${entry.mileage.toLocaleString()}${entry.fullTank ? '' : ' <span class="section-sub">(partial)</span>'}</td>
      <td>${entry.gallons.toFixed(2)}</td>
      <td class="cost">${money(entry.totalCost)}</td>
      <td>${entry.mpg != null ? entry.mpg.toFixed(1) : '—'}</td>
      <td class="row-actions"></td>
    `;
    const cell = tr.querySelector('.row-actions');
    const editBtn = document.createElement('button');
    editBtn.className = 'small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openFuelModal(v, entry));
    const delBtn = document.createElement('button');
    delBtn.className = 'small danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteFuelEntry(v, entry));
    cell.appendChild(editBtn);
    cell.appendChild(delBtn);
    tbody.appendChild(tr);
  });
  section.appendChild(table);
  return section;
}

async function updateVehicleMileageIfHigher(v, mileage) {
  if (mileage != null && (v.currentMileage == null || mileage > v.currentMileage)) {
    const { error } = await supabase.from('vehicles').update({ current_mileage: mileage }).eq('id', v.id);
    if (!error) v.currentMileage = mileage;
  }
}

async function deleteFuelEntry(v, entry) {
  if (!confirm('Delete this fill-up?')) return;
  const { error } = await supabase.from('fuel_logs').delete().eq('id', entry.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  v.fuel = v.fuel.filter(x => x.id !== entry.id);
  render();
}

function openFuelModal(v, existing) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const isEdit = !!existing;
  modal.innerHTML = `
    <h2>${isEdit ? 'Edit fill-up' : 'Log fill-up'}</h2>
    <div class="field-row">
      <div class="field"><label>Date</label><input type="date" id="fu-date" value="${isEdit ? existing.date || '' : new Date().toISOString().slice(0,10)}"></div>
      <div class="field"><label>Odometer (mi)</label><input type="number" id="fu-mileage" value="${isEdit ? existing.mileage : ''}" placeholder="87500"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Gallons</label><input type="number" step="0.01" id="fu-gallons" value="${isEdit ? existing.gallons : ''}" placeholder="12.4"></div>
      <div class="field"><label>Total cost ($)</label><input type="number" step="0.01" id="fu-cost" value="${isEdit ? existing.totalCost : ''}" placeholder="45.60"></div>
    </div>
    <div class="field checkbox-field"><label><input type="checkbox" id="fu-full" ${!isEdit || existing.fullTank ? 'checked' : ''}> Filled to full (needed for accurate MPG)</label></div>
    <div class="field"><label>Notes</label><input type="text" id="fu-notes" value="${isEdit ? escapeHtml(existing.notes || '') : ''}" placeholder="Station, fuel grade, etc."></div>
    <div class="modal-actions">
      <button id="fu-cancel">Cancel</button>
      <button class="primary" id="fu-save">${isEdit ? 'Save changes' : 'Log fill-up'}</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  modal.querySelector('#fu-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#fu-save').addEventListener('click', async () => {
    const mileage = parseInt(modal.querySelector('#fu-mileage').value, 10);
    const gallons = parseFloat(modal.querySelector('#fu-gallons').value);
    if (isNaN(mileage) || mileage < 0) { alert('Enter a valid odometer reading.'); return; }
    if (isNaN(gallons) || gallons <= 0) { alert('Enter a valid number of gallons.'); return; }
    if (parseFloat(modal.querySelector('#fu-cost').value) < 0) { alert('Total cost can\'t be negative.'); return; }
    const fields = {
      date: modal.querySelector('#fu-date').value || null,
      mileage,
      gallons,
      total_cost: parseFloat(modal.querySelector('#fu-cost').value) || 0,
      full_tank: modal.querySelector('#fu-full').checked,
      notes: modal.querySelector('#fu-notes').value.trim(),
    };
    if (isEdit) {
      const { error } = await supabase.from('fuel_logs').update(fields).eq('id', existing.id);
      if (error) { alert('Could not save: ' + error.message); return; }
      Object.assign(existing, { date: fields.date, mileage: fields.mileage, gallons: fields.gallons, totalCost: fields.total_cost, fullTank: fields.full_tank, notes: fields.notes });
    } else {
      const { data: row, error } = await supabase.from('fuel_logs').insert({ vehicle_id: v.id, ...fields }).select().single();
      if (error) { alert('Could not log fill-up: ' + error.message); return; }
      v.fuel.push(dbFuelToLocal(row));
    }
    await updateVehicleMileageIfHigher(v, mileage);
    backdrop.remove();
    render();
  });
}

// --- Voice-to-text ---

function attachSpeechToText(textareaEl, micBtn, statusEl) {
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    micBtn.disabled = true;
    micBtn.title = 'Voice input is not supported in this browser';
    if (statusEl) statusEl.textContent = 'Voice input not supported in this browser (try Chrome or Edge).';
    return;
  }
  const recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  let listening = false;
  let baseText = '';

  recognition.addEventListener('result', (e) => {
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const transcript = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += transcript;
      else interim += transcript;
    }
    if (final) baseText = (baseText + ' ' + final).trim();
    textareaEl.value = (baseText + ' ' + interim).trim();
  });
  recognition.addEventListener('error', (e) => {
    listening = false;
    micBtn.textContent = '🎤 Start voice input';
    micBtn.classList.remove('primary');
    if (statusEl) statusEl.textContent = e.error === 'not-allowed' ? 'Microphone permission denied.' : `Voice input error: ${e.error}`;
  });
  recognition.addEventListener('end', () => { if (listening) recognition.start(); });

  micBtn.addEventListener('click', () => {
    if (!listening) {
      baseText = textareaEl.value;
      listening = true;
      recognition.start();
      micBtn.textContent = '⏹ Stop dictation';
      micBtn.classList.add('primary');
      if (statusEl) statusEl.textContent = 'Listening…';
    } else {
      listening = false;
      recognition.stop();
      micBtn.textContent = '🎤 Start voice input';
      micBtn.classList.remove('primary');
      if (statusEl) statusEl.textContent = '';
    }
  });
}

// --- Notes ---

function renderNotesTab(v) {
  const wrap = document.createElement('div');
  const header = document.createElement('div');
  header.className = 'section-header';
  header.innerHTML = `<h3>Notes</h3><span class="section-sub">Back-and-forth notes with anyone sharing this project — dictate with your voice or type</span>`;
  wrap.appendChild(header);

  const composer = document.createElement('div');
  composer.className = 'summary-panel';
  composer.style.marginBottom = '20px';
  composer.innerHTML = `
    <textarea id="note-text" placeholder="Type or dictate a note…" style="width:100%; min-height:80px; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--page); color:var(--text-primary); font-family:inherit; font-size:14px; resize:vertical;"></textarea>
    <div class="field-row" style="margin-top:10px; align-items:center;">
      <button type="button" id="note-mic" class="small">🎤 Start voice input</button>
      <span class="section-sub" id="note-mic-status"></span>
    </div>
    <div class="modal-actions">
      <button class="primary" id="note-save">Add note</button>
    </div>
  `;
  wrap.appendChild(composer);

  const textarea = composer.querySelector('#note-text');
  const micBtn = composer.querySelector('#note-mic');
  const micStatus = composer.querySelector('#note-mic-status');
  attachSpeechToText(textarea, micBtn, micStatus);

  composer.querySelector('#note-save').addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) { alert('Enter or dictate a note first.'); return; }
    const { data: row, error } = await supabase.from('vehicle_notes').insert({ vehicle_id: v.id, text, created_by: currentUser.id, author_email: currentUser.email }).select().single();
    if (error) { alert('Could not save note: ' + error.message); return; }
    v.notes.push(dbNoteToLocal(row));
    render();
  });

  if (v.notes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No notes yet.';
    wrap.appendChild(empty);
    return wrap;
  }

  const list = document.createElement('div');
  list.className = 'journal-list';
  v.notes.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).forEach(note => {
    const isMine = note.authorEmail && currentUser.email && note.authorEmail.toLowerCase() === currentUser.email.toLowerCase();
    const authorLabel = note.authorEmail ? contactLabelFor(note.authorEmail) : 'Unknown';
    const card = document.createElement('div');
    card.className = 'journal-entry';
    card.innerHTML = `<div class="date"><strong>${escapeHtml(isMine ? 'You' : authorLabel)}</strong> &middot; ${new Date(note.createdAt).toLocaleString()}${note.editedAt ? ' <span class="section-sub">(edited)</span>' : ''}</div><div class="text">${escapeHtml(note.text)}</div>`;
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openNoteEditModal(v, note));
    const delBtn = document.createElement('button');
    delBtn.className = 'small danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteNote(v, note));
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);
    list.appendChild(card);
  });
  wrap.appendChild(list);
  return wrap;
}

async function deleteNote(v, note) {
  if (!confirm('Delete this note?')) return;
  const { error } = await supabase.from('vehicle_notes').delete().eq('id', note.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  v.notes = v.notes.filter(x => x.id !== note.id);
  render();
}

function openNoteEditModal(v, note) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h2>Edit note</h2>
    <textarea id="note-edit-text" style="width:100%; min-height:100px; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--page); color:var(--text-primary); font-family:inherit; font-size:14px; resize:vertical;">${escapeHtml(note.text)}</textarea>
    <div class="field-row" style="margin-top:10px; align-items:center;">
      <button type="button" id="note-edit-mic" class="small">🎤 Start voice input</button>
      <span class="section-sub" id="note-edit-mic-status"></span>
    </div>
    <div class="modal-actions">
      <button id="note-edit-cancel">Cancel</button>
      <button class="primary" id="note-edit-save">Save changes</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  const textarea = modal.querySelector('#note-edit-text');
  attachSpeechToText(textarea, modal.querySelector('#note-edit-mic'), modal.querySelector('#note-edit-mic-status'));
  modal.querySelector('#note-edit-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#note-edit-save').addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) { alert('Note text cannot be empty.'); return; }
    const editedAt = new Date().toISOString();
    const { error } = await supabase.from('vehicle_notes').update({ text, edited_at: editedAt }).eq('id', note.id);
    if (error) { alert('Could not save: ' + error.message); return; }
    note.text = text;
    note.editedAt = editedAt;
    backdrop.remove();
    render();
  });
}

function renderJournalTab(v) {
  const wrap = document.createElement('div');
  wrap.appendChild(renderFuelSection(v));
  wrap.appendChild(renderMaintenanceSection(v));
  if (v.vehicleType !== 'maintenance') wrap.appendChild(renderChecklistSection(v));

  const header = document.createElement('div');
  header.className = 'section-header';
  header.innerHTML = `<h3>Build log</h3><span class="section-sub">A dated record of what you did, with photos</span>`;
  const addBtn = document.createElement('button');
  addBtn.className = 'primary';
  addBtn.textContent = '+ Add entry';
  addBtn.addEventListener('click', () => openJournalModal(v));
  header.appendChild(addBtn);
  wrap.appendChild(header);

  if (v.journal.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No log entries yet. Document progress as you go — it doubles as your build history.';
    wrap.appendChild(empty);
    return wrap;
  }

  const list = document.createElement('div');
  list.className = 'journal-list';
  v.journal.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).forEach(entry => {
    const card = document.createElement('div');
    card.className = 'journal-entry';
    card.innerHTML = `<div class="date">${formatDate(entry.date)}</div><div class="text">${escapeHtml(entry.text)}</div>`;
    if (entry.photos && entry.photos.length) {
      const grid = document.createElement('div');
      grid.className = 'photo-grid';
      entry.photos.forEach(path => {
        const img = document.createElement('img');
        img.className = 'lazy-photo';
        img.setAttribute('data-photo-path', path);
        img.addEventListener('click', () => openLightboxForPath(path));
        grid.appendChild(img);
      });
      card.appendChild(grid);
    }
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openJournalModal(v, entry));
    const delBtn = document.createElement('button');
    delBtn.className = 'small danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteJournalEntry(v, entry));
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);
    list.appendChild(card);
  });
  wrap.appendChild(list);
  return wrap;
}

async function deleteJournalEntry(v, entry) {
  if (!confirm('Delete this log entry?')) return;
  const { error } = await supabase.from('journal_entries').delete().eq('id', entry.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  await deletePhotos(entry.photos);
  v.journal = v.journal.filter(x => x.id !== entry.id);
  render();
}

// --- Modals ---

function openModalBackdrop(contentEl) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.appendChild(contentEl);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
  return backdrop;
}

function yearOptionsHtml(existingYear) {
  const years = [];
  for (let y = CURRENT_YEAR + 1; y >= 1900; y--) years.push(y);
  if (existingYear && !years.includes(Number(existingYear))) years.unshift(Number(existingYear));
  const selected = existingYear ? String(existingYear) : '';
  return '<option value="">Select year</option>' + years.map(y => `<option value="${y}" ${String(y) === selected ? 'selected' : ''}>${y}</option>`).join('');
}
function makeOptionsHtml() {
  return '<option value="">Select make</option>' + MAKES.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('') + `<option value="${OTHER_VALUE}">Other (type it in)</option>`;
}
async function loadModelsInto(modelSelect, make, selectedModel) {
  modelSelect.disabled = true;
  modelSelect.innerHTML = '<option value="">Loading models…</option>';
  const models = await fetchModelsForMake(make);
  let html = '<option value="">Select model</option>';
  html += models.map(m => `<option value="${escapeHtml(m)}" ${m === selectedModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
  html += `<option value="${OTHER_VALUE}">Other (type it in)</option>`;
  modelSelect.innerHTML = html;
  modelSelect.disabled = false;
  if (selectedModel && !models.includes(selectedModel)) modelSelect.value = OTHER_VALUE;
}

function openVehicleModal(existing) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const isEdit = !!existing;
  const vehicleType = isEdit ? (existing.vehicleType || 'project') : 'project';
  modal.innerHTML = `
    <h2>${isEdit ? 'Edit vehicle' : 'New vehicle'}</h2>
    <div class="field">
      <label>Type</label>
      <div class="field-row">
        <label class="checkbox-field" style="flex:1"><input type="radio" name="f-type" id="f-type-project" value="project" ${vehicleType === 'project' ? 'checked' : ''}> Restoration project</label>
        <label class="checkbox-field" style="flex:1"><input type="radio" name="f-type" id="f-type-maintenance" value="maintenance" ${vehicleType === 'maintenance' ? 'checked' : ''}> General maintenance</label>
      </div>
      <div class="section-sub">A project seeds a restoration checklist and tracks a target finish date. Maintenance is ongoing — no checklist template, no target date.</div>
    </div>
    <div class="field">
      <label>VIN</label>
      <input type="text" id="f-vin" value="${isEdit ? escapeHtml(existing.vin || '') : ''}" placeholder="17-character VIN">
      <div class="field-row" style="margin-top:6px;">
        <button type="button" id="f-vin-lookup" class="small">Look up vehicle from VIN</button>
        <span class="section-sub" id="f-vin-lookup-status"></span>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Year</label><select id="f-year">${yearOptionsHtml(isEdit ? existing.year : null)}</select></div>
      <div class="field" style="flex:2">
        <label>Make</label>
        <select id="f-make-select">${makeOptionsHtml()}</select>
        <input type="text" id="f-make-other" placeholder="Enter make" style="display:none; margin-top:6px;">
      </div>
    </div>
    <div class="field">
      <label>Model</label>
      <select id="f-model-select" disabled><option value="">Select make first</option></select>
      <input type="text" id="f-model-other" placeholder="Enter model" style="display:none; margin-top:6px;">
    </div>
    <div class="field">
      <label>Trim</label>
      <input type="text" id="f-trim" value="${isEdit ? escapeHtml(existing.trim || '') : ''}" placeholder="e.g. SE, Series I, Base">
    </div>
    <div class="field"><label>Cover photo</label><input type="file" id="f-photo" accept="image/*"></div>
    <div id="f-photo-preview"></div>
    <div class="field-row">
      <div class="field"><label>Start date</label><input type="date" id="f-start" value="${isEdit ? existing.startDate || '' : ''}"></div>
      <div class="field" id="f-target-field" style="${vehicleType === 'maintenance' ? 'display:none' : ''}"><label>Target finish date</label><input type="date" id="f-target" value="${isEdit ? existing.targetDate || '' : ''}"></div>
    </div>
    ${isEdit ? `<div class="field-row">
      <div class="field"><label>Purchase price ($)</label><input type="number" step="0.01" id="f-purchase" value="${existing.purchasePrice != null ? existing.purchasePrice : ''}" placeholder="What you paid for it"></div>
      <div class="field"><label>Sale price ($)</label><input type="number" step="0.01" id="f-sale" value="${existing.salePrice != null ? existing.salePrice : ''}" placeholder="Leave blank until sold"></div>
    </div>` : ''}
    <div class="modal-actions">
      <button id="f-cancel">Cancel</button>
      <button class="primary" id="f-save">${isEdit ? 'Save changes' : (vehicleType === 'maintenance' ? 'Add vehicle' : 'Create project')}</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);

  const targetField = modal.querySelector('#f-target-field');
  const saveBtnEl = modal.querySelector('#f-save');
  modal.querySelectorAll('input[name="f-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const type = modal.querySelector('input[name="f-type"]:checked').value;
      targetField.style.display = type === 'maintenance' ? 'none' : '';
      if (!isEdit) saveBtnEl.textContent = type === 'maintenance' ? 'Add vehicle' : 'Create project';
    });
  });

  const makeSelect = modal.querySelector('#f-make-select');
  const makeOther = modal.querySelector('#f-make-other');
  const modelSelect = modal.querySelector('#f-model-select');
  const modelOther = modal.querySelector('#f-model-other');

  makeSelect.addEventListener('change', async () => {
    const val = makeSelect.value;
    if (val === OTHER_VALUE) {
      makeOther.style.display = '';
      makeOther.value = '';
      makeOther.focus();
      modelSelect.style.display = 'none';
      modelSelect.disabled = true;
      modelOther.style.display = '';
      modelOther.value = '';
    } else if (val) {
      makeOther.style.display = 'none';
      modelSelect.style.display = '';
      modelOther.style.display = 'none';
      await loadModelsInto(modelSelect, val, null);
    } else {
      modelSelect.style.display = '';
      modelSelect.disabled = true;
      modelSelect.innerHTML = '<option value="">Select make first</option>';
      modelOther.style.display = 'none';
    }
  });
  modelSelect.addEventListener('change', () => {
    modelOther.style.display = modelSelect.value === OTHER_VALUE ? '' : 'none';
    if (modelSelect.value === OTHER_VALUE) modelOther.focus();
  });

  if (isEdit) {
    const matchedMake = MAKES.find(m => m.toLowerCase() === (existing.make || '').toLowerCase());
    if (matchedMake) {
      makeSelect.value = matchedMake;
      loadModelsInto(modelSelect, matchedMake, existing.model).then(() => {
        if (modelSelect.value === OTHER_VALUE) { modelOther.style.display = ''; modelOther.value = existing.model || ''; }
      });
    } else if (existing.make) {
      makeSelect.value = OTHER_VALUE;
      makeOther.style.display = '';
      makeOther.value = existing.make;
      modelSelect.style.display = 'none';
      modelOther.style.display = '';
      modelOther.value = existing.model || '';
    }
  }

  const trimInput = modal.querySelector('#f-trim');
  function setTrimValue(value) { trimInput.value = value || ''; }

  function setMakeValue(value) {
    const matched = MAKES.find(m => m.toLowerCase() === (value || '').toLowerCase());
    if (matched) {
      makeSelect.value = matched;
      makeOther.style.display = 'none';
    } else if (value) {
      makeSelect.value = OTHER_VALUE;
      makeOther.style.display = '';
      makeOther.value = value;
      modelSelect.style.display = 'none';
    } else {
      makeSelect.value = '';
    }
  }

  const vinLookupStatus = modal.querySelector('#f-vin-lookup-status');
  modal.querySelector('#f-vin-lookup').addEventListener('click', async () => {
    const vin = modal.querySelector('#f-vin').value.trim();
    if (vin.length !== 17) { vinLookupStatus.textContent = 'Enter a full 17-character VIN first.'; return; }
    vinLookupStatus.textContent = 'Looking up…';
    const info = await decodeVehicleFromVin(vin);
    if (!info || (!info.year && !info.make && !info.model && !info.trim)) {
      vinLookupStatus.textContent = 'No data found for this VIN — enter the details manually.';
      return;
    }
    if (info.year) {
      const yearSelect = modal.querySelector('#f-year');
      const alreadyListed = Array.from(yearSelect.options).some(opt => opt.value === info.year);
      if (!alreadyListed) {
        const opt = document.createElement('option');
        opt.value = info.year;
        opt.textContent = info.year;
        yearSelect.insertBefore(opt, yearSelect.firstChild);
      }
      yearSelect.value = info.year;
    }
    if (info.make) {
      setMakeValue(info.make);
      if (makeSelect.value !== OTHER_VALUE) {
        await loadModelsInto(modelSelect, makeSelect.value, info.model);
        modelSelect.style.display = '';
        modelOther.style.display = modelSelect.value === OTHER_VALUE ? '' : 'none';
        if (modelSelect.value === OTHER_VALUE && info.model) modelOther.value = info.model;
      } else if (info.model) {
        modelOther.value = info.model;
      }
    }
    if (info.trim) setTrimValue(info.trim);
    const found = ['year', 'make', 'model', 'trim'].filter(k => info[k]).map(k => info[k]).join(' / ');
    vinLookupStatus.textContent = `Found: ${found}`;
  });

  const photoState = { path: isEdit ? existing.coverPhoto : null, blob: null, previewUrl: null };
  const photoPreview = modal.querySelector('#f-photo-preview');
  function renderPhotoPreview() {
    photoPreview.innerHTML = '';
    if (photoState.blob) {
      const item = document.createElement('div');
      item.className = 'photo-remove-item';
      item.style.marginBottom = '10px';
      const img = document.createElement('img');
      img.src = photoState.previewUrl;
      item.appendChild(img);
      const rm = document.createElement('button');
      rm.textContent = 'x';
      rm.addEventListener('click', () => { photoState.blob = null; photoState.previewUrl = null; renderPhotoPreview(); });
      item.appendChild(rm);
      photoPreview.appendChild(item);
    } else if (photoState.path) {
      const item = document.createElement('div');
      item.className = 'photo-remove-item';
      item.style.marginBottom = '10px';
      const img = document.createElement('img');
      img.className = 'lazy-photo';
      img.setAttribute('data-photo-path', photoState.path);
      item.appendChild(img);
      const rm = document.createElement('button');
      rm.textContent = 'x';
      rm.addEventListener('click', () => { photoState.path = null; renderPhotoPreview(); });
      item.appendChild(rm);
      photoPreview.appendChild(item);
      hydratePhotos(photoPreview);
    }
  }
  renderPhotoPreview();
  modal.querySelector('#f-photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const blob = await resizeImageToBlob(file, 900, 0.72);
    photoState.blob = blob;
    photoState.path = null;
    photoState.previewUrl = URL.createObjectURL(blob);
    renderPhotoPreview();
  });

  modal.querySelector('#f-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#f-save').addEventListener('click', async () => {
    const year = modal.querySelector('#f-year').value;
    const make = makeSelect.value === OTHER_VALUE ? makeOther.value.trim() : makeSelect.value;
    const model = (makeSelect.value === OTHER_VALUE || modelSelect.value === OTHER_VALUE) ? modelOther.value.trim() : modelSelect.value;
    if (!year || !make || !model) { alert('Year, make, and model are required.'); return; }
    const saveBtn = modal.querySelector('#f-save');
    saveBtn.disabled = true;
    const selectedType = modal.querySelector('input[name="f-type"]:checked').value;
    const trim = trimInput.value.trim();
    const fields = {
      year: parseInt(year, 10), make, model,
      trim,
      vin: modal.querySelector('#f-vin').value.trim(),
      start_date: modal.querySelector('#f-start').value || null,
      target_date: selectedType === 'maintenance' ? null : (modal.querySelector('#f-target').value || null),
      vehicle_type: selectedType,
    };
    if (isEdit) {
      const purchaseInput = modal.querySelector('#f-purchase').value;
      const saleInput = modal.querySelector('#f-sale').value;
      fields.purchase_price = purchaseInput !== '' ? parseFloat(purchaseInput) : null;
      fields.sale_price = saleInput !== '' ? parseFloat(saleInput) : null;
      let finalCoverPath = photoState.path;
      const oldCover = existing.coverPhoto || null;
      if (photoState.blob) {
        finalCoverPath = await uploadPhoto(existing.id, photoState.blob);
        if (oldCover) await deletePhotos([oldCover]);
      } else if (oldCover && !photoState.path) {
        await deletePhotos([oldCover]);
        finalCoverPath = null;
      }
      fields.cover_photo_path = finalCoverPath;
      const { error } = await supabase.from('vehicles').update(fields).eq('id', existing.id);
      if (error) { alert('Could not save: ' + error.message); saveBtn.disabled = false; return; }
      Object.assign(existing, { year: fields.year, make, model, trim: fields.trim, vin: fields.vin, startDate: fields.start_date, targetDate: fields.target_date, vehicleType: fields.vehicle_type, coverPhoto: finalCoverPath, purchasePrice: fields.purchase_price, salePrice: fields.sale_price });
    } else {
      const budget = 0;
      const { data: sessionData } = await supabase.auth.getSession();
      console.log('DEBUG create-vehicle session check', {
        currentUserId: currentUser.id,
        currentUserEmail: currentUser.email,
        sessionUserId: sessionData?.session?.user?.id,
        sessionUserEmail: sessionData?.session?.user?.email,
        tokenExpiresAt: sessionData?.session?.expires_at,
        now: Math.floor(Date.now() / 1000),
      });
      const { data: vRow, error } = await supabase.from('vehicles').insert({ ...fields, user_id: currentUser.id, owner_email: currentUser.email }).select().single();
      if (error) {
        console.error('vehicle insert error', error);
        alert('Could not create project: ' + error.message + (error.details ? '\nDetails: ' + error.details : '') + (error.hint ? '\nHint: ' + error.hint : ''));
        saveBtn.disabled = false;
        return;
      }
      const { data: phRow, error: phErr } = await supabase.from('phases').insert({ vehicle_id: vRow.id, name: 'General', budget }).select().single();
      if (phErr) {
        alert('Could not create budget phase: ' + phErr.message + '\nRolling back the new vehicle so it doesn\'t get left in a broken state.');
        await supabase.from('vehicles').delete().eq('id', vRow.id);
        saveBtn.disabled = false;
        return;
      }
      let coverPath = null;
      if (photoState.blob) {
        coverPath = await uploadPhoto(vRow.id, photoState.blob);
        if (coverPath) await supabase.from('vehicles').update({ cover_photo_path: coverPath }).eq('id', vRow.id);
      }
      const localVehicle = dbVehicleToLocal(vRow);
      localVehicle.coverPhoto = coverPath;
      localVehicle.phases = [dbPhaseToLocal(phRow)];
      localVehicle.checklist = selectedType === 'maintenance' ? [] : await seedChecklist(vRow.id);
      data.vehicles.push(localVehicle);
      backdrop.remove();
      navigate({ screen: 'list', ownership: 'mine', vehicleType: selectedType === 'maintenance' ? 'maintenance' : 'project', vehicleId: null, tab: 'budget' });
      return;
    }
    backdrop.remove();
    render();
  });
}

function openPhaseModal(v, existing) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const isEdit = !!existing;
  modal.innerHTML = `
    <h2>${isEdit ? 'Edit phase' : 'Add budget phase'}</h2>
    <div class="field"><label>Name</label><input type="text" id="ph-name" value="${isEdit ? escapeHtml(existing.name) : ''}" placeholder="Engine rebuild"></div>
    <div class="field"><label>Budget ($)</label><input type="number" step="0.01" id="ph-budget" value="${isEdit ? existing.budget : ''}" placeholder="3000"></div>
    <div class="modal-actions">
      <button id="ph-cancel">Cancel</button>
      <button class="primary" id="ph-save">${isEdit ? 'Save changes' : 'Add phase'}</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  modal.querySelector('#ph-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#ph-save').addEventListener('click', async () => {
    const name = modal.querySelector('#ph-name').value.trim();
    const budget = parseFloat(modal.querySelector('#ph-budget').value) || 0;
    if (!name) { alert('Phase name is required.'); return; }
    if (isEdit) {
      const { error } = await supabase.from('phases').update({ name, budget }).eq('id', existing.id);
      if (error) { alert('Could not save: ' + error.message); return; }
      existing.name = name; existing.budget = budget;
    } else {
      const { data: row, error } = await supabase.from('phases').insert({ vehicle_id: v.id, name, budget }).select().single();
      if (error) { alert('Could not add phase: ' + error.message); return; }
      v.phases.push(dbPhaseToLocal(row));
    }
    backdrop.remove();
    render();
  });
}

function openPartModal(v, existing, presetCategory) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const isEdit = !!existing;
  const defaultCategory = isEdit ? existing.category : presetCategory;
  const photoState = { path: isEdit ? existing.photo : null, blob: null, previewUrl: null };
  modal.innerHTML = `
    <h2>${isEdit ? 'Edit part' : 'Add part'}</h2>
    <div class="field"><label>Part name</label><input type="text" id="p-name" value="${isEdit ? escapeHtml(existing.name) : ''}" placeholder="Front brake pads"></div>
    <div class="field-row">
      <div class="field"><label>Category</label><select id="p-category">${CATEGORIES.map(c => `<option value="${c}" ${defaultCategory === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Cost ($)</label><input type="number" step="0.01" id="p-cost" value="${isEdit ? existing.cost : ''}" placeholder="120.00"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Status</label><select id="p-status">${STATUSES.map(s => `<option value="${s.key}" ${isEdit && existing.status === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select></div>
      <div class="field"><label>Budget phase</label><select id="p-phase">${v.phases.map(ph => `<option value="${ph.id}" ${isEdit && existing.phaseId === ph.id ? 'selected' : ''}>${escapeHtml(ph.name)}</option>`).join('')}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Vendor</label><input type="text" id="p-vendor" value="${isEdit ? escapeHtml(existing.vendor || '') : ''}" placeholder="RockAuto, LMC Truck, junkyard..."></div>
      <div class="field"><label>Part number / SKU</label><input type="text" id="p-partnum" value="${isEdit ? escapeHtml(existing.partNumber || '') : ''}" placeholder="e.g. D1234"></div>
    </div>
    <div class="field"><label>Notes (tracking, condition, etc.)</label><input type="text" id="p-notes" value="${isEdit ? escapeHtml(existing.notes || '') : ''}"></div>
    <div class="field"><label>Photo (receipt or part)</label><input type="file" id="p-photo" accept="image/*"></div>
    <div id="p-photo-preview"></div>
    <div class="field-row">
      <button type="button" id="p-search-rockauto" class="small">Search RockAuto</button>
      <button type="button" id="p-search-amazon" class="small">Search Amazon</button>
    </div>
    <div class="modal-actions">
      <button id="p-cancel">Cancel</button>
      <button class="primary" id="p-save">${isEdit ? 'Save changes' : 'Add part'}</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  const preview = modal.querySelector('#p-photo-preview');

  function currentDraftPart() {
    return {
      name: modal.querySelector('#p-name').value.trim() || (isEdit ? existing.name : ''),
      partNumber: modal.querySelector('#p-partnum').value.trim(),
    };
  }
  modal.querySelector('#p-search-rockauto').addEventListener('click', () => {
    window.open(rockAutoSearchUrl(v, currentDraftPart()), '_blank', 'noopener');
    modal.querySelector('#p-vendor').value = 'RockAuto';
  });
  modal.querySelector('#p-search-amazon').addEventListener('click', () => {
    window.open(amazonSearchUrl(v, currentDraftPart()), '_blank', 'noopener');
    modal.querySelector('#p-vendor').value = 'Amazon';
  });

  function renderPreview() {
    preview.innerHTML = '';
    const src = photoState.previewUrl || null;
    if (photoState.blob) {
      const item = document.createElement('div');
      item.className = 'photo-remove-item';
      item.style.marginBottom = '10px';
      const img = document.createElement('img');
      img.src = photoState.previewUrl;
      item.appendChild(img);
      const rm = document.createElement('button');
      rm.textContent = 'x';
      rm.addEventListener('click', () => { photoState.blob = null; photoState.previewUrl = null; renderPreview(); });
      item.appendChild(rm);
      preview.appendChild(item);
    } else if (photoState.path) {
      const item = document.createElement('div');
      item.className = 'photo-remove-item';
      item.style.marginBottom = '10px';
      const img = document.createElement('img');
      img.className = 'lazy-photo';
      img.setAttribute('data-photo-path', photoState.path);
      item.appendChild(img);
      const rm = document.createElement('button');
      rm.textContent = 'x';
      rm.addEventListener('click', () => { photoState.path = null; renderPreview(); });
      item.appendChild(rm);
      preview.appendChild(item);
      hydratePhotos(preview);
    }
  }
  renderPreview();

  modal.querySelector('#p-photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const blob = await resizeImageToBlob(file, 700, 0.7);
    photoState.blob = blob;
    photoState.path = null;
    photoState.previewUrl = URL.createObjectURL(blob);
    renderPreview();
  });
  modal.querySelector('#p-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#p-save').addEventListener('click', async () => {
    const name = modal.querySelector('#p-name').value.trim();
    if (!name) { alert('Part name is required.'); return; }
    if (parseFloat(modal.querySelector('#p-cost').value) < 0) { alert('Cost can\'t be negative.'); return; }
    const saveBtn = modal.querySelector('#p-save');
    saveBtn.disabled = true;

    let finalPath = photoState.path;
    const oldPath = isEdit ? existing.photo : null;
    if (photoState.blob) {
      finalPath = await uploadPhoto(v.id, photoState.blob);
      if (oldPath) await deletePhotos([oldPath]);
    } else if (isEdit && oldPath && !photoState.path) {
      await deletePhotos([oldPath]);
      finalPath = null;
    }

    const fields = {
      name,
      category: modal.querySelector('#p-category').value,
      cost: parseFloat(modal.querySelector('#p-cost').value) || 0,
      status: modal.querySelector('#p-status').value,
      phase_id: modal.querySelector('#p-phase').value,
      vendor: modal.querySelector('#p-vendor').value.trim(),
      part_number: modal.querySelector('#p-partnum').value.trim(),
      notes: modal.querySelector('#p-notes').value.trim(),
      photo_path: finalPath,
    };
    if (isEdit) {
      const { error } = await supabase.from('parts').update(fields).eq('id', existing.id);
      if (error) { alert('Could not save: ' + error.message); saveBtn.disabled = false; return; }
      Object.assign(existing, { name, category: fields.category, cost: fields.cost, status: fields.status, phaseId: fields.phase_id, vendor: fields.vendor, partNumber: fields.part_number, notes: fields.notes, photo: finalPath });
    } else {
      const { data: row, error } = await supabase.from('parts').insert({ vehicle_id: v.id, ...fields }).select().single();
      if (error) { alert('Could not add part: ' + error.message); saveBtn.disabled = false; return; }
      v.parts.push(dbPartToLocal(row));
    }
    backdrop.remove();
    render();
  });
}

function openLaborModal(v, existing) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const isEdit = !!existing;
  modal.innerHTML = `
    <h2>${isEdit ? 'Edit labor entry' : 'Log labor'}</h2>
    <div class="field"><label>Date</label><input type="date" id="l-date" value="${isEdit ? existing.date || '' : new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>Description</label><input type="text" id="l-desc" value="${isEdit ? escapeHtml(existing.description || '') : ''}" placeholder="Pulled engine, sent to machine shop"></div>
    <div class="field"><label>Hours</label><input type="number" step="0.25" id="l-hours" value="${isEdit ? existing.hours : ''}" placeholder="3"></div>
    <div class="field checkbox-field"><label><input type="checkbox" id="l-paid" ${isEdit && existing.paid ? 'checked' : ''}>This was paid labor (a shop invoice), not my own time</label></div>
    <div class="field" id="l-amount-field" style="${isEdit && existing.paid ? '' : 'display:none'}"><label>Amount paid ($)</label><input type="number" step="0.01" id="l-amount" value="${isEdit ? existing.amount || '' : ''}" placeholder="250"></div>
    <div class="modal-actions">
      <button id="l-cancel">Cancel</button>
      <button class="primary" id="l-save">${isEdit ? 'Save changes' : 'Add entry'}</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  const paidCheckbox = modal.querySelector('#l-paid');
  const amountField = modal.querySelector('#l-amount-field');
  paidCheckbox.addEventListener('change', () => { amountField.style.display = paidCheckbox.checked ? '' : 'none'; });
  modal.querySelector('#l-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#l-save').addEventListener('click', async () => {
    const paid = paidCheckbox.checked;
    if (paid && parseFloat(modal.querySelector('#l-amount').value) < 0) { alert('Amount paid can\'t be negative.'); return; }
    const fields = {
      date: modal.querySelector('#l-date').value || null,
      description: modal.querySelector('#l-desc').value.trim(),
      hours: parseFloat(modal.querySelector('#l-hours').value) || 0,
      paid,
      amount: paid ? (parseFloat(modal.querySelector('#l-amount').value) || 0) : 0,
    };
    if (isEdit) {
      const { error } = await supabase.from('labor').update(fields).eq('id', existing.id);
      if (error) { alert('Could not save: ' + error.message); return; }
      Object.assign(existing, fields);
    } else {
      const { data: row, error } = await supabase.from('labor').insert({ vehicle_id: v.id, ...fields }).select().single();
      if (error) { alert('Could not add entry: ' + error.message); return; }
      v.labor.push(dbLaborToLocal(row));
    }
    backdrop.remove();
    render();
  });
}

function openCreditModal(v) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h2>Add refund / credit</h2>
    <div class="field"><label>Date</label><input type="date" id="c-date" value="${new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>Amount ($)</label><input type="number" step="0.01" id="c-amount" placeholder="45.00"></div>
    <div class="field"><label>Reason</label><input type="text" id="c-reason" placeholder="Core charge refund, alternator return..."></div>
    <div class="modal-actions">
      <button id="c-cancel">Cancel</button>
      <button class="primary" id="c-save">Add credit</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  modal.querySelector('#c-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#c-save').addEventListener('click', async () => {
    const amount = parseFloat(modal.querySelector('#c-amount').value) || 0;
    const reason = modal.querySelector('#c-reason').value.trim();
    if (amount <= 0) { alert('Enter a credit amount greater than 0.'); return; }
    const fields = { date: modal.querySelector('#c-date').value || null, amount, reason };
    const { data: row, error } = await supabase.from('credits').insert({ vehicle_id: v.id, ...fields }).select().single();
    if (error) { alert('Could not add credit: ' + error.message); return; }
    v.credits.push(dbCreditToLocal(row));
    backdrop.remove();
    render();
  });
}

function openJournalModal(v, existing) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const isEdit = !!existing;
  const items = isEdit ? (existing.photos || []).map(path => ({ path, blob: null, previewUrl: null })) : [];
  modal.innerHTML = `
    <h2>${isEdit ? 'Edit log entry' : 'Add log entry'}</h2>
    <div class="field"><label>Date</label><input type="date" id="j-date" value="${isEdit ? existing.date || '' : new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>What did you do?</label><textarea id="j-text" placeholder="Pulled the front clip, found rust in the frame rails...">${isEdit ? escapeHtml(existing.text) : ''}</textarea></div>
    <div class="field"><label>Add photos</label><input type="file" id="j-photos" accept="image/*" multiple></div>
    <div id="j-photo-list" class="photo-remove-grid"></div>
    <div class="modal-actions">
      <button id="j-cancel">Cancel</button>
      <button class="primary" id="j-save">${isEdit ? 'Save changes' : 'Add entry'}</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);
  const photoList = modal.querySelector('#j-photo-list');

  function renderPhotoList() {
    photoList.innerHTML = '';
    items.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = 'photo-remove-item';
      const img = document.createElement('img');
      if (item.blob) {
        img.src = item.previewUrl;
      } else {
        img.className = 'lazy-photo';
        img.setAttribute('data-photo-path', item.path);
      }
      el.appendChild(img);
      const rm = document.createElement('button');
      rm.textContent = 'x';
      rm.addEventListener('click', () => { items.splice(idx, 1); renderPhotoList(); });
      el.appendChild(rm);
      photoList.appendChild(el);
    });
    hydratePhotos(photoList);
  }
  renderPhotoList();

  modal.querySelector('#j-photos').addEventListener('change', async (e) => {
    for (const file of Array.from(e.target.files)) {
      const blob = await resizeImageToBlob(file, 900, 0.72);
      items.push({ path: null, blob, previewUrl: URL.createObjectURL(blob) });
    }
    renderPhotoList();
    e.target.value = '';
  });
  modal.querySelector('#j-cancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#j-save').addEventListener('click', async () => {
    const text = modal.querySelector('#j-text').value.trim();
    if (!text) { alert('Add a description of what you did.'); return; }
    const saveBtn = modal.querySelector('#j-save');
    saveBtn.disabled = true;

    const originalPaths = isEdit ? (existing.photos || []) : [];
    const keptPaths = items.filter(i => i.path).map(i => i.path);
    const removedPaths = originalPaths.filter(p => !keptPaths.includes(p));
    const newBlobs = items.filter(i => i.blob);
    const uploadedPaths = [];
    for (const item of newBlobs) {
      const path = await uploadPhoto(v.id, item.blob);
      if (path) uploadedPaths.push(path);
    }
    const finalPaths = [...keptPaths, ...uploadedPaths];
    if (removedPaths.length) await deletePhotos(removedPaths);

    const fields = { date: modal.querySelector('#j-date').value || null, text, photo_paths: finalPaths };
    if (isEdit) {
      const { error } = await supabase.from('journal_entries').update(fields).eq('id', existing.id);
      if (error) { alert('Could not save: ' + error.message); saveBtn.disabled = false; return; }
      Object.assign(existing, { date: fields.date, text, photos: finalPaths });
    } else {
      const { data: row, error } = await supabase.from('journal_entries').insert({ vehicle_id: v.id, ...fields }).select().single();
      if (error) { alert('Could not add entry: ' + error.message); saveBtn.disabled = false; return; }
      v.journal.push(dbJournalToLocal(row));
    }
    backdrop.remove();
    render();
  });
}

// --- Header actions ---

document.getElementById('newVehicleBtn').addEventListener('click', () => openVehicleModal());
document.getElementById('signOutBtn').addEventListener('click', () => supabase.auth.signOut());
document.getElementById('headerBrand').addEventListener('click', () => navigate({ screen: 'home' }));
document.getElementById('navProjectsBtn').addEventListener('click', () => navigate({ screen: 'category', ownership: 'mine' }));
document.getElementById('navSharedBtn').addEventListener('click', () => navigate({ screen: 'category', ownership: 'shared' }));

// --- Header search ---

function vehicleSearchText(v) {
  return [v.year, v.make, v.model, v.trim, v.vin].filter(Boolean).join(' ').toLowerCase();
}

const searchInput = document.getElementById('headerSearch');
const searchResults = document.getElementById('headerSearchResults');

function closeSearchResults() {
  searchResults.classList.remove('open');
  searchResults.innerHTML = '';
}

searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) { closeSearchResults(); return; }

  const matches = data.vehicles.filter(v => vehicleSearchText(v).includes(query)).slice(0, 12);
  searchResults.innerHTML = '';
  if (matches.length === 0) {
    searchResults.innerHTML = '<div class="search-result-empty">No projects match that search.</div>';
  } else {
    matches.forEach(v => {
      const row = document.createElement('div');
      row.className = 'search-result';
      const isOwner = v.ownerId === currentUser.id;
      row.innerHTML = `
        <span>${escapeHtml(`${v.year} ${v.make} ${v.model}${v.trim ? ' ' + v.trim : ''}`)}</span>
        <span class="chip">${isOwner ? 'Yours' : 'Shared'}</span>
      `;
      row.addEventListener('click', () => {
        searchInput.value = '';
        closeSearchResults();
        navigate({ screen: 'detail', vehicleId: v.id, tab: 'budget' });
      });
      searchResults.appendChild(row);
    });
  }
  searchResults.classList.add('open');
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchInput.value = ''; closeSearchResults(); searchInput.blur(); }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#headerSearchWrap')) closeSearchResults();
});
document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vehicle-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// --- Boot ---

async function applySession(session, options = {}) {
  currentUser = session?.user || null;
  authReady = true;
  if (currentUser) {
    await loadAllData();
    const route = options.restoreRoute ? parseRoute() : { screen: 'home' };
    if (route.screen === 'detail' && !data.vehicles.some(v => v.id === route.vehicleId)) {
      currentView = { screen: 'home' };
      history.replaceState(null, '', '/');
    } else {
      currentView = route;
      if (!options.restoreRoute) history.replaceState(null, '', '/');
    }
  } else {
    data = { vehicles: [], contacts: [] };
    currentView = { screen: 'home' };
    history.replaceState(null, '', '/');
  }
  render();
}

let bootedOnce = false;

async function boot() {
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000));
  const sessionCheck = supabase.auth.getSession()
    .then(({ data }) => data.session)
    .catch((err) => { console.error('getSession failed:', err); return null; });

  const result = await Promise.race([sessionCheck, timeout]);
  if (result === 'timeout') {
    console.error('Timed out waiting for Supabase auth to respond.');
    authReady = true;
    authError = 'Could not reach the login service. Check your connection and reload the page.';
    render();
    bootedOnce = true;
    return;
  }
  await applySession(result, { restoreRoute: true });
  bootedOnce = true;
}

supabase.auth.onAuthStateChange((event, session) => {
  // boot() owns the very first load (including restoring the URL's route).
  // Supabase can fire more than one event while restoring a persisted session
  // (e.g. INITIAL_SESSION then SIGNED_IN) — ignore all of them until boot()
  // has finished, so a late event can't stomp on the restored route.
  if (!bootedOnce) return;

  // Supabase also fires events for routine session upkeep (token refresh on
  // tab focus, etc.) that are not a real sign-in/out. Only reset the view for
  // an actual transition between signed-out and signed-in; otherwise just
  // keep the session fresh without disturbing whatever the user is looking at.
  const wasSignedIn = !!currentUser;
  const isSignedIn = !!session?.user;
  if (wasSignedIn === isSignedIn) {
    currentUser = session?.user || null;
    return;
  }
  applySession(session);
});

boot();
render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}
