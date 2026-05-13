// ===== Configuration =====
const DATA_OWNER = 'Karhalll';
const DATA_REPO = 'rugby-roster-data';
const ROSTERS_PATH = 'rosters';
const STORAGE_KEY = 'urugby_roster_v1';
const TOKEN_KEY = 'urugby_gh_token';
const ACTIVE_ROSTER_KEY = 'urugby_active_roster';
const POLL_INTERVAL_MS = 3000;

// ===== State =====
let players = [];
let activeRoster = null; // { name, filename, sha }
let rosters = [];        // [{ name, filename, sha }]
let saveTimer = null;
let pollTimer = null;
let toastTimer = null;
let selectedPlayerId = null;

// ===== DOM =====
const nameInput = document.getElementById('newPlayerName');
const addBtn = document.getElementById('addPlayerBtn');
const clearBtn = document.getElementById('clearAllBtn');
const resetBtn = document.getElementById('resetBtn');
const downloadBtn = document.getElementById('downloadBtn');
const loadBtn = document.getElementById('loadBtn');
const loadFileInput = document.getElementById('loadFileInput');
const rosterSelect = document.getElementById('rosterSelect');
const newRosterBtn = document.getElementById('newRosterBtn');
const renameRosterBtn = document.getElementById('renameRosterBtn');
const deleteRosterBtn = document.getElementById('deleteRosterBtn');
const syncStatus = document.getElementById('syncStatus');
const configBtn = document.getElementById('configBtn');
const toastEl = document.getElementById('toast');
const menuToggle = document.getElementById('menuToggle');
const topbarEl = document.getElementById('topbar');

// ===== Event wiring =====
addBtn.addEventListener('click', addPlayerFromInput);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPlayerFromInput(); });
clearBtn.addEventListener('click', clearAll);
resetBtn.addEventListener('click', resetRoster);
downloadBtn.addEventListener('click', downloadJSON);
loadBtn.addEventListener('click', () => loadFileInput.click());
loadFileInput.addEventListener('change', handleFileLoad);
rosterSelect.addEventListener('change', (e) => switchRoster(e.target.value));
newRosterBtn.addEventListener('click', createNewRoster);
renameRosterBtn.addEventListener('click', renameCurrentRoster);
deleteRosterBtn.addEventListener('click', deleteCurrentRoster);
configBtn.addEventListener('click', openConfig);
menuToggle.addEventListener('click', () => {
  const expanded = topbarEl.classList.toggle('expanded');
  menuToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
});

// ===== Token / Config =====
function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

function openConfig() {
  const current = getToken();
  if (current) {
    if (confirm('Odhlásit se z databáze soupisek? Token bude odstraněn z tohoto prohlížeče. Pro další přihlášení ho budeš muset znovu vložit.')) {
      clearTimeout(saveTimer);
      stopPolling();
      clearToken();
      players = [];
      activeRoster = null;
      rosters = [];
      updateAuthButton();
      setSyncStatus('Odhlášen', '');
      setControlsEnabled(false);
      rosterSelect.innerHTML = '<option value="">(odhlášen)</option>';
      render();
    }
    return;
  }
  const v = prompt(
    'Přihlášení k databázi soupisek.\n\nVlož svůj přístupový token (Personal Access Token, začíná „github_pat_…"):',
    ''
  );
  if (v === null) return;
  const trimmed = v.trim();
  if (!trimmed) return;
  setToken(trimmed);
  updateAuthButton();
  init();
}

function updateAuthButton() {
  if (getToken()) {
    configBtn.textContent = 'Odhlásit se';
    configBtn.title = 'Odstranit token z prohlížeče a odhlásit se';
  } else {
    configBtn.textContent = 'Přihlásit se';
    configBtn.title = 'Přihlásit se přístupovým tokenem k databázi soupisek';
  }
}

// ===== GitHub API =====
async function gh(path, opts = {}) {
  const token = getToken();
  if (!token) { const e = new Error('NO_TOKEN'); e.code = 'NO_TOKEN'; throw e; }
  const res = await fetch(`https://api.github.com/repos/${DATA_OWNER}/${DATA_REPO}/${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`API ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToUtf8(b64) {
  const bin = atob((b64 || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function listRosters() {
  try {
    const items = await gh(`contents/${ROSTERS_PATH}`);
    if (!Array.isArray(items)) return [];
    return items
      .filter((i) => i.type === 'file' && i.name.toLowerCase().endsWith('.json'))
      .map((i) => ({
        name: i.name.replace(/\.json$/i, ''),
        filename: i.name,
        sha: i.sha,
      }));
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

async function readRosterFile(filename) {
  const item = await gh(`contents/${ROSTERS_PATH}/${encodeURIComponent(filename)}`);
  const text = b64ToUtf8(item.content || '');
  const data = text.trim() ? JSON.parse(text) : [];
  return { players: Array.isArray(data) ? data : [], sha: item.sha };
}

async function writeRosterFile(filename, playersToSave, sha) {
  const text = JSON.stringify(playersToSave, null, 2);
  const body = { message: `Update ${filename}`, content: utf8ToB64(text) };
  if (sha) body.sha = sha;
  const result = await gh(`contents/${ROSTERS_PATH}/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return result.content.sha;
}

async function deleteRosterFile(filename, sha) {
  await gh(`contents/${ROSTERS_PATH}/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Delete ${filename}`, sha }),
  });
}

// ===== Roster management =====
function safeFilename(raw) {
  const name = raw.trim().replace(/\.json$/i, '').replace(/[\\/]/g, '-').replace(/\s+/g, '-');
  return name + '.json';
}

function populateRosterSelect() {
  rosterSelect.innerHTML = '';
  for (const r of rosters) {
    const opt = document.createElement('option');
    opt.value = r.filename;
    opt.textContent = r.name;
    if (activeRoster && r.filename === activeRoster.filename) opt.selected = true;
    rosterSelect.appendChild(opt);
  }
}

async function switchRoster(filename) {
  if (!filename) return;
  try {
    setSyncStatus('Načítám…', 'busy');
    const data = await readRosterFile(filename);
    players = data.players;
    const found = rosters.find((r) => r.filename === filename);
    if (found) {
      found.sha = data.sha;
      activeRoster = found;
    }
    localStorage.setItem(ACTIVE_ROSTER_KEY, filename);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(players));
    render();
    setSyncStatus('Načteno', 'connected');
  } catch (err) {
    handleApiError(err, 'Načtení selhalo');
  }
}

async function createNewRoster() {
  const suggested = `soupiska-${new Date().toISOString().slice(0, 10)}`;
  const raw = prompt('Název nové soupisky (zkopíruje aktuální stav):', suggested);
  if (raw === null) return;
  if (!raw.trim()) return;
  const filename = safeFilename(raw);
  if (rosters.some((r) => r.filename === filename)) {
    alert('Soupiska s tímto názvem už existuje.');
    return;
  }
  try {
    setSyncStatus('Vytvářím…', 'busy');
    const sha = await writeRosterFile(filename, players, null);
    const entry = { name: filename.replace(/\.json$/i, ''), filename, sha };
    rosters.push(entry);
    rosters.sort((a, b) => a.name.localeCompare(b.name));
    activeRoster = entry;
    localStorage.setItem(ACTIVE_ROSTER_KEY, filename);
    populateRosterSelect();
    setSyncStatus('Vytvořeno ✓', 'connected');
  } catch (err) {
    handleApiError(err, 'Vytvoření selhalo');
  }
}

async function renameCurrentRoster() {
  if (!activeRoster) return;
  const raw = prompt('Nový název soupisky:', activeRoster.name);
  if (raw === null) return;
  if (!raw.trim()) return;
  const newFilename = safeFilename(raw);
  if (newFilename === activeRoster.filename) return;
  if (rosters.some((r) => r.filename === newFilename)) {
    alert('Soupiska s tímto názvem už existuje.');
    return;
  }
  const oldFilename = activeRoster.filename;
  const oldSha = activeRoster.sha;
  try {
    setSyncStatus('Přejmenovávám…', 'busy');
    const newSha = await writeRosterFile(newFilename, players, null);
    await deleteRosterFile(oldFilename, oldSha);
    rosters = rosters.filter((r) => r.filename !== oldFilename);
    const entry = { name: newFilename.replace(/\.json$/i, ''), filename: newFilename, sha: newSha };
    rosters.push(entry);
    rosters.sort((a, b) => a.name.localeCompare(b.name));
    activeRoster = entry;
    localStorage.setItem(ACTIVE_ROSTER_KEY, newFilename);
    populateRosterSelect();
    setSyncStatus('Přejmenováno ✓', 'connected');
  } catch (err) {
    handleApiError(err, 'Přejmenování selhalo');
  }
}

async function deleteCurrentRoster() {
  if (!activeRoster) return;
  if (rosters.length <= 1) {
    alert('Nelze smazat poslední soupisku.');
    return;
  }
  if (!confirm(`Smazat soupisku "${activeRoster.name}" ze serveru? Akce je nevratná.`)) return;
  const toDelete = activeRoster;
  try {
    setSyncStatus('Mažu…', 'busy');
    await deleteRosterFile(toDelete.filename, toDelete.sha);
    rosters = rosters.filter((r) => r.filename !== toDelete.filename);
    const next = rosters[0];
    activeRoster = next;
    populateRosterSelect();
    await switchRoster(next.filename);
  } catch (err) {
    handleApiError(err, 'Smazání selhalo');
  }
}

// ===== Auto-save =====
function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(players));
  scheduleSync();
}

function scheduleSync() {
  if (!getToken() || !activeRoster) return;
  clearTimeout(saveTimer);
  setSyncStatus('Změna…', 'busy');
  saveTimer = setTimeout(syncToGitHub, 800);
}

async function syncToGitHub() {
  if (!activeRoster) return;
  try {
    setSyncStatus('Ukládám…', 'busy');
    const sha = await writeRosterFile(activeRoster.filename, players, activeRoster.sha);
    activeRoster.sha = sha;
    setSyncStatus('Uloženo ✓', 'connected');
  } catch (err) {
    if (err.status === 409) {
      // Conflict: refresh SHA and retry once
      try {
        const fresh = await readRosterFile(activeRoster.filename);
        activeRoster.sha = fresh.sha;
        const sha = await writeRosterFile(activeRoster.filename, players, fresh.sha);
        activeRoster.sha = sha;
        setSyncStatus('Uloženo ✓ (po konfliktu)', 'connected');
        return;
      } catch (err2) {
        handleApiError(err2, 'Konflikt při ukládání');
        return;
      }
    }
    handleApiError(err, 'Ukládání selhalo');
  }
}

function handleApiError(err, prefix) {
  console.error(prefix, err);
  if (err.code === 'NO_TOKEN') {
    setSyncStatus('Token nenastaven', 'error');
    return;
  }
  if (err.status === 401 || err.status === 403) {
    setSyncStatus('Token neplatný – přihlas se znovu', 'error');
    return;
  }
  if (err.status === 404) {
    setSyncStatus(`${prefix}: soubor neexistuje`, 'error');
    return;
  }
  const short = (err.message || '').slice(0, 80);
  setSyncStatus(`${prefix}: ${short}`, 'error');
}

function setSyncStatus(text, cls = '') {
  syncStatus.textContent = text;
  syncStatus.className = 'sync-status' + (cls ? ' ' + cls : '');
}

function setControlsEnabled(enabled) {
  rosterSelect.disabled = !enabled;
  newRosterBtn.disabled = !enabled;
  renameRosterBtn.disabled = !enabled;
  deleteRosterBtn.disabled = !enabled;
}

function showToast(message, type = 'info') {
  toastEl.textContent = message;
  toastEl.classList.remove('error', 'warn');
  if (type === 'error') toastEl.classList.add('error');
  else if (type === 'warn') toastEl.classList.add('warn');
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4500);
}

// ===== Polling for remote changes =====
function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollForChanges, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function isUserBusy() {
  if (document.querySelector('.player-card.dragging')) return true;
  if (document.querySelector('.player-card .name[contenteditable="true"]')) return true;
  return false;
}

async function pollForChanges() {
  if (!getToken() || !activeRoster) return;
  if (saveTimer) return; // a local save is queued — let it finish first
  if (isUserBusy()) return;

  const headers = {
    'Authorization': `Bearer ${getToken()}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // Conditional request: 304 responses don't count against the rate limit.
  if (activeRoster.etag) headers['If-None-Match'] = activeRoster.etag;

  let res;
  try {
    res = await fetch(
      `https://api.github.com/repos/${DATA_OWNER}/${DATA_REPO}/contents/${ROSTERS_PATH}/${encodeURIComponent(activeRoster.filename)}`,
      { headers, cache: 'no-store' }
    );
  } catch (err) {
    console.warn('Poll network error:', err);
    return;
  }

  if (res.status === 304) return; // unchanged, free

  if (res.status === 404) {
    showToast('Tato soupiska byla na serveru smazána. Načítám seznam…', 'warn');
    stopPolling();
    try { rosters = await listRosters(); } catch {}
    if (rosters.length > 0) {
      activeRoster = rosters[0];
      populateRosterSelect();
      await switchRoster(rosters[0].filename);
      startPolling();
    } else {
      activeRoster = null;
      populateRosterSelect();
      players = [];
      render();
    }
    return;
  }

  if (res.status === 401 || res.status === 403) {
    stopPolling();
    setSyncStatus('Token neplatný – přihlas se znovu', 'error');
    return;
  }

  if (!res.ok) {
    console.warn('Poll failed with status', res.status);
    return;
  }

  // 200 OK — content changed
  activeRoster.etag = res.headers.get('etag') || activeRoster.etag;
  const item = await res.json();
  if (item.sha === activeRoster.sha) return;
  const text = b64ToUtf8(item.content || '');
  const newPlayers = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(newPlayers)) return;
  players = newPlayers;
  activeRoster.sha = item.sha;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(players));
  render();
  showToast('Soupiska byla aktualizována ze serveru.');
}

// ===== Init =====
async function init() {
  updateAuthButton();
  stopPolling();
  if (!getToken()) {
    setSyncStatus('Odhlášen – klikni "Přihlásit se"', 'error');
    setControlsEnabled(false);
    rosterSelect.innerHTML = '<option value="">(odhlášen)</option>';
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      players = raw ? JSON.parse(raw) : [];
    } catch { players = []; }
    render();
    return;
  }
  setControlsEnabled(true);
  try {
    setSyncStatus('Načítám seznam…', 'busy');
    rosters = await listRosters();
    if (rosters.length === 0) {
      // No rosters yet — create a default one with current local players (if any)
      const localRaw = localStorage.getItem(STORAGE_KEY);
      const localPlayers = (() => { try { return localRaw ? JSON.parse(localRaw) : []; } catch { return []; } })();
      const sha = await writeRosterFile('default.json', localPlayers, null);
      rosters = [{ name: 'default', filename: 'default.json', sha }];
    }
    rosters.sort((a, b) => a.name.localeCompare(b.name));
    const lastFile = localStorage.getItem(ACTIVE_ROSTER_KEY);
    const target = rosters.find((r) => r.filename === lastFile) || rosters[0];
    activeRoster = target;
    populateRosterSelect();
    await switchRoster(target.filename);
    startPolling();
  } catch (err) {
    handleApiError(err, 'Inicializace selhala');
  }
}

// ===== Player actions =====
function addPlayerFromInput() {
  const name = nameInput.value.trim();
  if (!name) return;
  players.push({
    id: crypto.randomUUID(),
    name,
    team: 'UNASSIGNED',
    role: 'None',
  });
  nameInput.value = '';
  persist();
  render();
  nameInput.focus();
}

function clearAll() {
  if (!confirm('Opravdu chcete trvale smazat VŠECHNY hráče v této soupisce? Tato akce je nevratná.')) return;
  players = [];
  persist();
  render();
}

function resetRoster() {
  const affected = players.filter((p) => p.team === 'A' || p.team === 'B').length;
  if (affected === 0) {
    alert('V týmech A a B nejsou žádní hráči k resetu.');
    return;
  }
  if (!confirm(`Resetovat soupisku? ${affected} hráč(ů) z týmů A a B se přesune do Nepřiřazení. Nerozhodnutí zůstanou. Pokračovat?`)) return;
  for (const p of players) {
    if (p.team === 'A' || p.team === 'B') {
      p.team = 'UNASSIGNED';
      p.role = 'None';
    }
  }
  persist();
  render();
}

function downloadJSON() {
  const stamp = new Date().toISOString().slice(0, 10);
  const suggested = activeRoster ? `${activeRoster.name}-${stamp}` : `soupiska-${stamp}`;
  const input = prompt('Název souboru soupisky:', suggested);
  if (input === null) return;
  const trimmed = input.trim() || suggested;
  const filename = trimmed.toLowerCase().endsWith('.json') ? trimmed : trimmed + '.json';

  const blob = new Blob([JSON.stringify(players, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function handleFileLoad(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed)) throw new Error('JSON není pole hráčů.');
      for (const p of parsed) {
        if (typeof p.name !== 'string' || typeof p.team !== 'string' || typeof p.role !== 'string') {
          throw new Error('Neplatný formát hráče.');
        }
        if (!p.id) p.id = crypto.randomUUID();
      }
      players = parsed;
      persist();
      render();
    } catch (err) {
      alert('Nepodařilo se načíst soubor: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ===== Rendering =====
function render() {
  document.querySelectorAll('.drop-list').forEach((list) => { list.innerHTML = ''; });

  for (const player of players) {
    const selector = `.drop-list[data-team="${player.team}"][data-role="${player.role}"]`;
    const target = document.querySelector(selector);
    if (target) target.appendChild(makeCard(player));
  }

  document.querySelectorAll('.role-zone').forEach((zone) => {
    const list = zone.querySelector('.drop-list');
    const countEl = zone.querySelector('.count');
    if (countEl) countEl.textContent = `(${list.children.length})`;
  });

  applySelection();
}

function applySelection() {
  document.querySelectorAll('.player-card.selected').forEach((c) => c.classList.remove('selected'));
  if (!selectedPlayerId) return;
  const card = document.querySelector(`.player-card[data-id="${selectedPlayerId}"]`);
  if (card) card.classList.add('selected');
  else selectedPlayerId = null;
}

// Tapping outside any player card deselects.
document.addEventListener('click', (e) => {
  if (!selectedPlayerId) return;
  if (e.target.closest('.player-card')) return;
  selectedPlayerId = null;
  applySelection();
});

function makeCard(player) {
  const card = document.createElement('div');
  card.className = 'player-card';
  card.draggable = true;
  card.dataset.id = player.id;

  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = player.name;
  nameEl.spellcheck = false;

  const editBtn = document.createElement('button');
  editBtn.className = 'edit';
  editBtn.textContent = '✎';
  editBtn.title = 'Upravit jméno';
  editBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startEdit();
  });

  function startEdit() {
    nameEl.contentEditable = 'true';
    card.draggable = false;
    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  nameEl.addEventListener('blur', () => {
    if (nameEl.contentEditable !== 'true') return;
    nameEl.contentEditable = 'false';
    card.draggable = true;
    const next = nameEl.textContent.trim();
    if (!next) {
      nameEl.textContent = player.name;
      return;
    }
    if (next !== player.name) {
      player.name = next;
      persist();
    }
  });
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      nameEl.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      nameEl.textContent = player.name;
      nameEl.blur();
    }
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove';
  removeBtn.textContent = '×';
  removeBtn.title = 'Odstranit hráče';
  removeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!confirm(`Odstranit hráče „${player.name}"?`)) return;
    players = players.filter((p) => p.id !== player.id);
    persist();
    render();
  });

  card.appendChild(nameEl);
  card.appendChild(editBtn);
  card.appendChild(removeBtn);

  card.addEventListener('dragstart', (e) => {
    card.classList.add('dragging');
    e.dataTransfer.setData('text/plain', player.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.role-zone.over').forEach((z) => z.classList.remove('over'));
    render();
  });

  attachTouchDrag(card, player);

  return card;
}

// ===== Touch drag-and-drop (mobile) =====
function attachTouchDrag(card, player) {
  let touchStart = null;
  let longPressTimer = null;
  let dragActive = false;
  let wasTap = false;
  let ghost = null;
  let currentZone = null;

  card.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.target;
    if (t.closest('.edit, .remove')) return;
    if (t.matches('.name') && t.contentEditable === 'true') return;
    const touch = e.touches[0];
    touchStart = { x: touch.clientX, y: touch.clientY };
    wasTap = true;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      wasTap = false;
      beginDrag(touch);
    }, 220);
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    if (longPressTimer && touchStart) {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y) > 10) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        touchStart = null;
        wasTap = false;
      }
    }
  }, { passive: true });

  card.addEventListener('touchend', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    if (wasTap && !dragActive) {
      const id = card.dataset.id;
      selectedPlayerId = selectedPlayerId === id ? null : id;
      applySelection();
    }
    wasTap = false;
    touchStart = null;
  });

  function beginDrag(touch) {
    dragActive = true;
    card.classList.add('dragging');
    if (navigator.vibrate) try { navigator.vibrate(20); } catch {}
    const rect = card.getBoundingClientRect();
    ghost = card.cloneNode(true);
    ghost.classList.remove('dragging');
    ghost.classList.add('drag-ghost');
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    document.body.appendChild(ghost);
    document.addEventListener('touchmove', onDocMove, { passive: false });
    document.addEventListener('touchend', onDocEnd);
    document.addEventListener('touchcancel', onDocEnd);
    moveGhostTo(touch);
  }

  function moveGhostTo(touch) {
    if (!ghost) return;
    ghost.style.left = (touch.clientX - ghost.offsetWidth / 2) + 'px';
    ghost.style.top = (touch.clientY - ghost.offsetHeight / 2) + 'px';
    ghost.style.display = 'none';
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    ghost.style.display = '';
    document.querySelectorAll('.role-zone.over').forEach((z) => z.classList.remove('over'));
    const zone = el ? el.closest('.role-zone') : null;
    if (!zone) { currentZone = null; return; }
    zone.classList.add('over');
    currentZone = zone;
    const list = zone.querySelector('.drop-list');
    const afterEl = getDragAfterElement(list, touch.clientY);
    if (afterEl == null) {
      if (list.lastElementChild !== card) list.appendChild(card);
    } else if (afterEl !== card) {
      list.insertBefore(card, afterEl);
    }
  }

  function onDocMove(e) {
    if (!dragActive) return;
    e.preventDefault();
    moveGhostTo(e.touches[0]);
  }

  function onDocEnd() {
    if (!dragActive) return;
    dragActive = false;
    card.classList.remove('dragging');
    document.querySelectorAll('.role-zone.over').forEach((z) => z.classList.remove('over'));
    if (ghost) { ghost.remove(); ghost = null; }
    document.removeEventListener('touchmove', onDocMove);
    document.removeEventListener('touchend', onDocEnd);
    document.removeEventListener('touchcancel', onDocEnd);
    if (currentZone) {
      const list = currentZone.querySelector('.drop-list');
      player.team = list.dataset.team;
      player.role = list.dataset.role;
      syncOrderFromDOM();
      persist();
    }
    currentZone = null;
    render();
  }
}

function getDragAfterElement(list, y) {
  const cards = [...list.querySelectorAll('.player-card:not(.dragging)')];
  return cards.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function syncOrderFromDOM() {
  const order = new Map();
  document.querySelectorAll('.drop-list .player-card').forEach((card, i) => {
    order.set(card.dataset.id, i);
  });
  players.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
}

function setupDropZones() {
  document.querySelectorAll('.role-zone').forEach((zone) => {
    const list = zone.querySelector('.drop-list');
    const team = list.dataset.team;
    const role = list.dataset.role;

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('over');
      const dragging = document.querySelector('.player-card.dragging');
      if (!dragging) return;
      const afterEl = getDragAfterElement(list, e.clientY);
      if (afterEl == null) {
        if (list.lastElementChild !== dragging) list.appendChild(dragging);
      } else if (afterEl !== dragging) {
        list.insertBefore(dragging, afterEl);
      }
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('over');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const id = e.dataTransfer.getData('text/plain');
      const player = players.find((p) => p.id === id);
      if (!player) return;
      player.team = team;
      player.role = role;
      syncOrderFromDOM();
      persist();
      render();
    });
  });
}

setupDropZones();
init();
