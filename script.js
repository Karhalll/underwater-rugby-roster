const STORAGE_KEY = 'urugby_roster_v1';

// Player: { id, name, team: 'A'|'B'|'UNASSIGNED'|'UNDECIDED', role: 'Goalkeeper'|'Defender'|'Attacker'|'None' }
let players = loadFromLocalStorage();

const nameInput = document.getElementById('newPlayerName');
const addBtn = document.getElementById('addPlayerBtn');
const clearBtn = document.getElementById('clearAllBtn');
const resetBtn = document.getElementById('resetBtn');
const downloadBtn = document.getElementById('downloadBtn');
const loadBtn = document.getElementById('loadBtn');
const loadFileInput = document.getElementById('loadFileInput');

addBtn.addEventListener('click', addPlayerFromInput);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addPlayerFromInput();
});
clearBtn.addEventListener('click', () => {
  if (!confirm('Opravdu chcete trvale smazat VŠECHNY hráče? Tato akce je nevratná.')) return;
  players = [];
  persist();
  render();
});
resetBtn.addEventListener('click', () => {
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
});
downloadBtn.addEventListener('click', downloadJSON);
loadBtn.addEventListener('click', () => loadFileInput.click());
loadFileInput.addEventListener('change', handleFileLoad);

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

// ---------- Persistence ----------

function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(players));
}

function downloadJSON() {
  const stamp = new Date().toISOString().slice(0, 10);
  const suggested = `soupiska-${stamp}`;
  const input = prompt('Název souboru soupisky:', suggested);
  if (input === null) return; // cancelled
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
      // Light sanity check on shape
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
  // Reset input so the same file can be re-selected later
  e.target.value = '';
}

// ---------- Rendering ----------

function render() {
  document.querySelectorAll('.drop-list').forEach((list) => {
    list.innerHTML = '';
  });

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
}

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
    // If drop didn't fire on a valid zone, re-render to revert the DOM
    // from the dragover preview back to the persisted array order.
    render();
  });

  return card;
}

function getDragAfterElement(list, y) {
  const cards = [...list.querySelectorAll('.player-card:not(.dragging)')];
  return cards.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
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
render();
