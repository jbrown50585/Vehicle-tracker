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
let data = { vehicles: [] };
let currentView = { screen: 'list', vehicleId: null, tab: 'budget' };

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
    phases: [], parts: [], labor: [], credits: [], journal: [], checklist: [],
  };
}
function dbPhaseToLocal(row) { return { id: row.id, vehicleId: row.vehicle_id, name: row.name, budget: Number(row.budget) }; }
function dbPartToLocal(row) {
  return {
    id: row.id, vehicleId: row.vehicle_id, phaseId: row.phase_id, name: row.name, category: row.category,
    cost: Number(row.cost), status: row.status, vendor: row.vendor, notes: row.notes, photo: row.photo_path,
    partNumber: row.part_number,
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
function dbLaborToLocal(row) {
  return { id: row.id, vehicleId: row.vehicle_id, date: row.date, description: row.description, hours: Number(row.hours), paid: row.paid, amount: Number(row.amount) };
}
function dbCreditToLocal(row) { return { id: row.id, vehicleId: row.vehicle_id, date: row.date, amount: Number(row.amount), reason: row.reason }; }
function dbJournalToLocal(row) { return { id: row.id, vehicleId: row.vehicle_id, date: row.date, text: row.text, photos: row.photo_paths || [] }; }
function dbChecklistToLocal(row) {
  return { id: row.id, vehicleId: row.vehicle_id, category: row.category, task: row.task, done: row.done, doneDate: row.done_date, position: row.position };
}

async function loadAllData() {
  const [vehiclesRes, phasesRes, partsRes, laborRes, creditsRes, journalRes, checklistRes] = await Promise.all([
    supabase.from('vehicles').select('*').order('created_at'),
    supabase.from('phases').select('*'),
    supabase.from('parts').select('*'),
    supabase.from('labor').select('*'),
    supabase.from('credits').select('*'),
    supabase.from('journal_entries').select('*'),
    supabase.from('checklist_items').select('*'),
  ]);
  const vehicles = (vehiclesRes.data || []).map(dbVehicleToLocal);
  vehicles.forEach(v => {
    v.phases = (phasesRes.data || []).filter(r => r.vehicle_id === v.id).map(dbPhaseToLocal);
    v.parts = (partsRes.data || []).filter(r => r.vehicle_id === v.id).map(dbPartToLocal);
    v.labor = (laborRes.data || []).filter(r => r.vehicle_id === v.id).map(dbLaborToLocal);
    v.credits = (creditsRes.data || []).filter(r => r.vehicle_id === v.id).map(dbCreditToLocal);
    v.journal = (journalRes.data || []).filter(r => r.vehicle_id === v.id).map(dbJournalToLocal);
    v.checklist = (checklistRes.data || []).filter(r => r.vehicle_id === v.id).map(dbChecklistToLocal);
  });
  data = { vehicles };
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
    app.innerHTML = '<div class="loading-state">Loading…</div>';
    return;
  }
  if (!currentUser) {
    app.appendChild(renderAuthScreen());
    return;
  }
  if (currentView.screen === 'list') app.appendChild(renderList());
  else if (currentView.screen === 'detail') app.appendChild(renderDetail(currentView.vehicleId));

  hydratePhotos(app);
}

function updateHeaderForAuth() {
  const signedIn = !!currentUser;
  document.getElementById('signedInBar').style.display = signedIn ? 'inline-flex' : 'none';
  document.getElementById('newVehicleBtn').style.display = signedIn ? '' : 'none';
  document.getElementById('exportBtn').style.display = signedIn ? '' : 'none';
  if (signedIn) document.getElementById('userEmail').textContent = currentUser.email;
}

// --- Auth screen ---

function renderAuthScreen() {
  const wrap = document.createElement('div');
  wrap.className = 'auth-wrap';
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

function renderList() {
  const wrap = document.createElement('div');
  if (data.vehicles.length === 0) {
    wrap.innerHTML = '<div class="empty-state">No vehicle projects yet. Click "+ New Vehicle Project" to add your first one.</div>';
    return wrap;
  }
  const grid = document.createElement('div');
  grid.className = 'grid';
  data.vehicles.forEach(v => {
    const budget = totalBudget(v);
    const spent = totalSpent(v);
    const remaining = remainingBudget(v);
    const pctUsed = budget > 0 ? Math.min(100, Math.max(0, (spent / budget) * 100)) : 0;
    const status = budgetStatus(remaining, budget);

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      ${v.coverPhoto ? `<img class="lazy-photo card-cover" data-photo-path="${v.coverPhoto}">` : ''}
      <h3>${v.year} ${escapeHtml(v.make)} ${escapeHtml(v.model)}${v.trim ? ' ' + escapeHtml(v.trim) : ''}</h3>
      <div class="vin">${v.vin ? 'VIN: ' + escapeHtml(v.vin) : 'No VIN entered'}</div>
      <div class="timeframe">${v.startDate ? formatDate(v.startDate) : '?'} &rarr; ${v.targetDate ? formatDate(v.targetDate) : 'no target date'}</div>
      <div class="meter-row">
        <span class="meter-remaining">${money(remaining)}</span>
        <span class="meter-total">remaining of ${money(budget)}</span>
      </div>
      <div class="meter-track"><div class="meter-fill" style="width:${pctUsed}%; background:${status.color}"></div></div>
      <div class="status-label"><span class="status-dot" style="background:${status.color}"></span>${status.label} &middot; ${v.parts.length} part${v.parts.length === 1 ? '' : 's'}</div>
    `;
    card.addEventListener('click', () => { currentView = { screen: 'detail', vehicleId: v.id, tab: 'budget' }; render(); });
    grid.appendChild(card);
  });
  wrap.appendChild(grid);
  return wrap;
}

function renderDetail(vehicleId) {
  const v = data.vehicles.find(x => x.id === vehicleId);
  const wrap = document.createElement('div');
  if (!v) { wrap.innerHTML = '<div class="empty-state">Vehicle not found.</div>'; return wrap; }

  const back = document.createElement('a');
  back.className = 'back-link';
  back.textContent = '← All vehicle projects';
  back.addEventListener('click', () => { currentView = { screen: 'list', vehicleId: null, tab: 'budget' }; render(); });
  wrap.appendChild(back);

  const header = document.createElement('div');
  header.className = 'detail-header';
  header.innerHTML = `
    ${v.coverPhoto ? `<img class="lazy-photo detail-cover" data-photo-path="${v.coverPhoto}">` : ''}
    <div>
      <h2>${v.year} ${escapeHtml(v.make)} ${escapeHtml(v.model)}${v.trim ? ' ' + escapeHtml(v.trim) : ''}</h2>
      <div class="vin">${v.vin ? 'VIN: ' + escapeHtml(v.vin) : 'No VIN entered'}</div>
      <div class="vin">${v.startDate ? formatDate(v.startDate) : '?'} &rarr; ${v.targetDate ? formatDate(v.targetDate) : 'no target date'}</div>
    </div>
  `;
  const headerBtns = document.createElement('div');
  headerBtns.className = 'actions';
  const editBtn = document.createElement('button');
  editBtn.textContent = 'Edit details';
  editBtn.addEventListener('click', () => openVehicleModal(v));
  const delBtn = document.createElement('button');
  delBtn.className = 'danger';
  delBtn.textContent = 'Delete project';
  delBtn.addEventListener('click', () => deleteVehicle(v));
  headerBtns.appendChild(editBtn);
  headerBtns.appendChild(delBtn);
  header.appendChild(headerBtns);
  wrap.appendChild(header);

  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  [['budget', 'Budget'], ['parts', 'Parts'], ['journal', 'Build log']].forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (currentView.tab === key ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => { currentView.tab = key; render(); });
    tabs.appendChild(btn);
  });
  wrap.appendChild(tabs);

  if (currentView.tab === 'budget') wrap.appendChild(renderBudgetTab(v));
  else if (currentView.tab === 'parts') wrap.appendChild(renderPartsTab(v));
  else wrap.appendChild(renderJournalTab(v));

  return wrap;
}

async function deleteVehicle(v) {
  if (!confirm(`Delete "${v.year} ${v.make} ${v.model}" and everything in it? This cannot be undone.`)) return;
  const photoPaths = [v.coverPhoto, ...v.parts.map(p => p.photo), ...v.journal.flatMap(j => j.photos)];
  await deletePhotos(photoPaths);
  const { error } = await supabase.from('vehicles').delete().eq('id', v.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  data.vehicles = data.vehicles.filter(x => x.id !== v.id);
  currentView = { screen: 'list', vehicleId: null, tab: 'budget' };
  render();
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

function renderPartsTab(v) {
  const wrap = document.createElement('div');
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
        cell.appendChild(raBtn);
        cell.appendChild(amzBtn);
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

function renderJournalTab(v) {
  const wrap = document.createElement('div');
  wrap.appendChild(renderChecklistSection(v));

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
  modal.innerHTML = `
    <h2>${isEdit ? 'Edit vehicle project' : 'New vehicle project'}</h2>
    <div class="field-row">
      <div class="field"><label>Year</label><select id="f-year">${yearOptionsHtml(isEdit ? existing.year : null)}</select></div>
      <div class="field" style="flex:2">
        <label>Make</label>
        <select id="f-make-select">${makeOptionsHtml()}</select>
        <input type="text" id="f-make-other" placeholder="Enter make" style="display:none; margin-top:6px;">
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Model</label>
        <select id="f-model-select" disabled><option value="">Select make first</option></select>
        <input type="text" id="f-model-other" placeholder="Enter model" style="display:none; margin-top:6px;">
      </div>
      <div class="field"><label>Trim</label><input type="text" id="f-trim" value="${isEdit ? escapeHtml(existing.trim || '') : ''}" placeholder="TRD Off-Road"></div>
    </div>
    <div class="field"><label>VIN</label><input type="text" id="f-vin" value="${isEdit ? escapeHtml(existing.vin || '') : ''}" placeholder="17-character VIN"></div>
    <div class="field"><label>Cover photo</label><input type="file" id="f-photo" accept="image/*"></div>
    <div id="f-photo-preview"></div>
    <div class="field-row">
      <div class="field"><label>Start date</label><input type="date" id="f-start" value="${isEdit ? existing.startDate || '' : ''}"></div>
      <div class="field"><label>Target finish date</label><input type="date" id="f-target" value="${isEdit ? existing.targetDate || '' : ''}"></div>
    </div>
    ${isEdit ? '' : `<div class="field"><label>Starting budget ($)</label><input type="number" step="0.01" id="f-budget" placeholder="5000"></div><div class="section-sub">You can split this into more phases later from the Budget tab.</div>`}
    <div class="modal-actions">
      <button id="f-cancel">Cancel</button>
      <button class="primary" id="f-save">${isEdit ? 'Save changes' : 'Create project'}</button>
    </div>
  `;
  const backdrop = openModalBackdrop(modal);

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
    const fields = {
      year: parseInt(year, 10), make, model,
      trim: modal.querySelector('#f-trim').value.trim(),
      vin: modal.querySelector('#f-vin').value.trim(),
      start_date: modal.querySelector('#f-start').value || null,
      target_date: modal.querySelector('#f-target').value || null,
    };
    if (isEdit) {
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
      Object.assign(existing, { year: fields.year, make, model, trim: fields.trim, vin: fields.vin, startDate: fields.start_date, targetDate: fields.target_date, coverPhoto: finalCoverPath });
    } else {
      const budget = parseFloat(modal.querySelector('#f-budget').value) || 0;
      const { data: vRow, error } = await supabase.from('vehicles').insert(fields).select().single();
      if (error) { alert('Could not create project: ' + error.message); saveBtn.disabled = false; return; }
      const { data: phRow, error: phErr } = await supabase.from('phases').insert({ vehicle_id: vRow.id, name: 'General', budget }).select().single();
      if (phErr) { alert('Could not create budget phase: ' + phErr.message); saveBtn.disabled = false; return; }
      let coverPath = null;
      if (photoState.blob) {
        coverPath = await uploadPhoto(vRow.id, photoState.blob);
        if (coverPath) await supabase.from('vehicles').update({ cover_photo_path: coverPath }).eq('id', vRow.id);
      }
      const localVehicle = dbVehicleToLocal(vRow);
      localVehicle.coverPhoto = coverPath;
      localVehicle.phases = [dbPhaseToLocal(phRow)];
      localVehicle.checklist = await seedChecklist(vRow.id);
      data.vehicles.push(localVehicle);
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
  modal.querySelector('#p-search-rockauto').addEventListener('click', () => window.open(rockAutoSearchUrl(v, currentDraftPart()), '_blank', 'noopener'));
  modal.querySelector('#p-search-amazon').addEventListener('click', () => window.open(amazonSearchUrl(v, currentDraftPart()), '_blank', 'noopener'));

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

async function applySession(session) {
  currentUser = session?.user || null;
  authReady = true;
  if (currentUser) {
    await loadAllData();
  } else {
    data = { vehicles: [] };
  }
  currentView = { screen: 'list', vehicleId: null, tab: 'budget' };
  render();
}

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
    return;
  }
  await applySession(result);
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'INITIAL_SESSION') return;
  applySession(session);
});

boot();
render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}
