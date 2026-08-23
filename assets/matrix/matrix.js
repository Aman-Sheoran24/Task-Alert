'use strict';

/* Four-quadrant chart and key notes
   The task board: state, classification, rendering, the add/edit/comment
   flows, drag and drop, the Notes & Ideas scratchpad, and the activity log.
   The onclick handlers in index.html's markup resolve to functions here. */
// ─── Data ────────────────────────────────────────────────────────────────────
let tasks = JSON.parse(localStorage.getItem('tm_tasks') || '[]');

// Migrate the old single `note` string (one comment per task) into a `notes`
// array (many comments per task). Runs once per task, the first time it's seen
// after this update; harmless to re-run since it only fires when `.notes` is absent.
tasks.forEach(t => {
  if (t.notes == null) {
    t.notes = t.note ? [{ id: t.id + 1, text: t.note, createdAt: t.updatedAt || t.id }] : [];
    delete t.note;
  }
});

// ─── UI refs ─────────────────────────────────────────────────────────────────
const taskInput  = document.getElementById('taskInput');
const addBtn     = document.getElementById('addBtn');
const voiceBtn   = document.getElementById('voiceBtn');
const dlModal    = document.getElementById('dlModal');
const dlInput    = document.getElementById('dlInput');
const noteModal  = document.getElementById('noteModal');
const noteInput  = document.getElementById('noteInput');
// ─── App state ───────────────────────────────────────────────────────────────
let editingId   = null;
let pendingText = '';
let dlMode      = 'add';   // 'add' (new task) | 'edit' (change an existing deadline)
let dlEditId    = null;    // task id when dlMode === 'edit'
let noteTaskId  = null;    // task id whose note is being edited

// ─── Drag state ──────────────────────────────────────────────────────────────
let dragId       = null;
let ghost        = null;
let dropQuad     = null;
let touchTimer   = null;
let touchOriginX = 0;
let touchOriginY = 0;

// ─── Voice ───────────────────────────────────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recActive = false;

if (SR) {
  rec = new SR();
  rec.continuous = false;
  rec.interimResults = false;
  rec.lang = 'en-US';
  rec.onstart  = () => { recActive = true;  voiceBtn.classList.add('on'); voiceBtn.textContent = '🛑'; };
  rec.onend    = () => { recActive = false; voiceBtn.classList.remove('on'); voiceBtn.textContent = '🎤'; };
  rec.onresult = e => { taskInput.value = Array.from(e.results).map(r => r[0].transcript).join(' ').trim(); };
  rec.onerror  = () => flash('Voice failed — type instead');
  voiceBtn.addEventListener('click', () => recActive ? rec.stop() : (taskInput.value = '', rec.start()));
} else {
  voiceBtn.style.display = 'none';
}

// ─── Add task flow ────────────────────────────────────────────────────────────
const dlTitle    = dlModal.querySelector('h3');
const dlConfirmB = document.getElementById('dlConfirm');
const dlSkipB    = document.getElementById('dlSkip');

function openAddFlow() {
  const text = taskInput.value.trim();
  if (!text) { taskInput.focus(); return; }
  dlMode = 'add'; dlEditId = null;
  pendingText = text;
  taskInput.value = '';
  dlInput.value = '';
  dlTitle.textContent    = 'Set a deadline? (optional)';
  dlConfirmB.textContent = 'Set deadline';
  dlSkipB.textContent    = 'Skip';
  dlModal.classList.add('show');
  setTimeout(() => dlInput.focus(), 60);
}

addBtn.addEventListener('click', openAddFlow);
taskInput.addEventListener('keydown', e => { if (e.key === 'Enter') openAddFlow(); });

// Reuse the same modal to change (or clear) an existing task's deadline.
function openDeadlineEditor(id) {
  const t = find(id);
  if (!t) return;
  dlMode = 'edit'; dlEditId = id;
  dlInput.value          = t.deadline ? toLocalInput(t.deadline) : '';
  dlTitle.textContent    = 'Change deadline';
  dlConfirmB.textContent = 'Save';
  dlSkipB.textContent    = 'Clear deadline';
  dlModal.classList.add('show');
  setTimeout(() => dlInput.focus(), 60);
}

// Absolute ms → the local wall-clock value <input type=datetime-local> expects.
function toLocalInput(ms) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

dlConfirmB.addEventListener('click', () => {
  const dl = dlInput.value ? new Date(dlInput.value).getTime() : null;
  if (dlMode === 'edit') applyDeadline(dlEditId, dl);
  else                   commitAdd(pendingText, dl);
  closeDeadlineModal();
});

dlSkipB.addEventListener('click', () => {
  if (dlMode === 'edit') applyDeadline(dlEditId, null);  // button reads "Clear deadline"
  else                   commitAdd(pendingText, null);   // button reads "Skip"
  closeDeadlineModal();
});

function closeDeadlineModal() {
  dlModal.classList.remove('show');
  dlMode = 'add'; dlEditId = null;
}

// Change a task's deadline in place; persist() re-syncs its calendar event
// (creates / updates / removes it as needed on the next sync).
function applyDeadline(id, dl) {
  const t = find(id);
  if (!t) return;
  t.deadline = dl || null;
  t.updatedAt = Date.now();
  persist();
  render();
}

// ─── Note / comment editor ──────────────────────────────────────────────────────
// A task can carry several comments (t.notes is an array); this modal always adds
// a new one rather than overwriting a single note.
function openNoteEditor(id) {
  const t = find(id);
  if (!t) return;
  noteTaskId = id;
  noteInput.value = '';
  noteModal.classList.add('show');
  setTimeout(() => noteInput.focus(), 60);
}

document.getElementById('noteSave').addEventListener('click', () => {
  const t = find(noteTaskId);
  if (t) {
    const v = noteInput.value.trim();
    if (v) {
      if (!t.notes) t.notes = [];
      t.notes.push({ id: Date.now(), text: v, createdAt: Date.now() });
      t.updatedAt = Date.now();
      persist();
      render();
    }
  }
  noteModal.classList.remove('show');
  noteTaskId = null;
});

document.getElementById('noteCancel').addEventListener('click', () => {
  noteModal.classList.remove('show');
  noteTaskId = null;
});

function deleteNote(taskId, noteId) {
  const t = find(taskId);
  if (!t || !t.notes) return;
  t.notes = t.notes.filter(n => n.id !== noteId);
  t.updatedAt = Date.now();
  persist();
  render();
}

// ─── Per-task ⋮ menu ─────────────────────────────────────────────────────────────
function toggleTaskMenu(ev, id) {
  ev.stopPropagation();   // keep the document handler from closing it instantly
  const menu = document.querySelector(`.task-menu[data-menu="${id}"]`);
  const wasOpen = menu && menu.classList.contains('open');
  closeAllMenus();
  if (menu && !wasOpen) menu.classList.add('open');
}
function closeAllMenus() {
  document.querySelectorAll('.task-menu.open').forEach(m => m.classList.remove('open'));
}
document.addEventListener('click', closeAllMenus);

dlInput.addEventListener('focus', () => {
  if (!dlInput.value) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    dlInput.value = d.toISOString().slice(0, 16);
  }
});

function commitAdd(text, deadline) {
  const q = classify(text, deadline);
  tasks.push({ id: Date.now(), text, quad: q, done: false, deadline: deadline || null, eventId: null, updatedAt: Date.now() });
  persist();
  render();
  const names = ['Urgent + Important', 'Urgent', 'Important', 'Neither'];
  flash(`Added to "${names[q - 1]}"`, 2200);
}

// ─── Edit ─────────────────────────────────────────────────────────────────────
function startEdit(id) {
  editingId = id;
  render();
  const el = document.querySelector(`[data-edit="${id}"]`);
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

function commitEdit(id) {
  const el  = document.querySelector(`[data-edit="${id}"]`);
  const txt = el?.value.trim();
  if (txt) {
    const t = find(id);
    if (t) { t.text = txt; t.updatedAt = Date.now(); }
    persist();
  }
  editingId = null;
  render();
}

function cancelEdit() { editingId = null; render(); }

// ─── Task actions ─────────────────────────────────────────────────────────────
// Soft-delete: keep a tombstone so the deletion syncs to other devices (and the
// calendar event gets removed on the next sync). Filtered out at render time.
function deleteTask(id) { const t = find(id); if (t) { t.deleted = true; t.updatedAt = Date.now(); persist(); render(); } }
function toggleDone(id) {
  const t = find(id);
  if (t) {
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;   // stamp completion for the activity log
    t.updatedAt = Date.now();
    persist();
    render();
  }
}
function reopenTask(id) { toggleDone(id); }   // log "↩ reopen" puts a task back on the board
function moveTask(id, q) { const t = find(id); if (t && t.quad !== q) { t.quad = q; t.updatedAt = Date.now(); persist(); render(); } }

function find(id) { return tasks.find(t => t.id === id); }

// ─── Persistence ───────────────────────────────────────────────────────────────
// Save locally (instant), then reconcile Google Calendar if connected.
function persist() {
  localStorage.setItem('tm_tasks', JSON.stringify(tasks));
  if (gcalConnected) scheduleSync();
}

// ─── Notes & Ideas (free-form, not tasks) ───────────────────────────────────────
// A separate, lightweight scratchpad for thoughts related to your tasks that
// don't belong in a task's comments or deserve a quadrant of their own.
const IDEAS_KEY = 'tm_ideas';
let ideas = JSON.parse(localStorage.getItem(IDEAS_KEY) || '[]');

function saveIdeas() { localStorage.setItem(IDEAS_KEY, JSON.stringify(ideas)); }

function renderIdeas() {
  document.getElementById('ideaCount').textContent = ideas.length;
  const wrap = document.getElementById('ideaList');
  if (!ideas.length) { wrap.innerHTML = '<div class="empty-msg">No notes yet.</div>'; return; }
  wrap.innerHTML = ideas.slice().sort((a, b) => b.createdAt - a.createdAt).map(n => `
    <div class="idea-item">
      <div class="idea-text">${esc(n.text)}</div>
      <div class="idea-bottom">
        <span class="idea-when">${new Date(n.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        <button class="idea-del" onclick="deleteIdea(${n.id})" title="Delete">✕</button>
      </div>
    </div>`).join('');
}

function deleteIdea(id) {
  ideas = ideas.filter(n => n.id !== id);
  saveIdeas();
  renderIdeas();
}

document.getElementById('ideaAdd').addEventListener('click', () => {
  const input = document.getElementById('ideaInput');
  const v = input.value.trim();
  if (!v) return;
  ideas.push({ id: Date.now(), text: v, createdAt: Date.now() });
  saveIdeas();
  input.value = '';
  renderIdeas();
});

// ─── Classification ───────────────────────────────────────────────────────────
function classify(text, deadline) {
  const t = text.toLowerCase();
  const urgent = /urgent|asap|today|deadline|rush|critical|emergency|now|immediately/i.test(t);
  const imp    = /important|goal|project|strategy|health|family|career|learning|growth|key/i.test(t);

  if (deadline) {
    const h = (deadline - Date.now()) / 3600000;
    if (h < 24) return imp ? 1 : 2;
    if (h < 72) return 1;
  }

  if (urgent && imp) return 1;
  if (urgent)        return 2;
  if (imp)           return 3;
  return 4;
}

function deadlineBadge(t) {
  if (!t.deadline) return '';
  const ms = t.deadline - Date.now();
  let text, cls;
  if (ms < 0) {
    text = 'Overdue'; cls = 'overdue';
  } else {
    const h = ms / 3600000;
    if (h < 1)        { text = Math.round(ms / 60000) + 'm left'; cls = 'overdue'; }
    else if (h < 24)  { text = Math.round(h) + 'h left'; cls = 'overdue'; }
    else { const d = Math.round(h / 24); text = d + 'd left'; cls = d < 3 ? 'soon' : 'later'; }
  }
  // Small badge showing a calendar alarm is set for this task.
  const alarm = (!t.done && t.eventId) ? '<span class="task-badge alarm">⏰ alert set</span>' : '';
  return `<span class="task-badge ${cls}">${text}</span>${alarm}`;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  for (let q = 1; q <= 4; q++) {
    // Done tasks leave the board entirely — they live in the Activity log below.
    const list = tasks.filter(t => t.quad === q && !t.deleted && !t.done);
    const el   = document.getElementById('q' + q);
    document.getElementById('cnt' + q).textContent = list.length;

    if (!list.length) {
      el.innerHTML = '<div class="empty-msg">—</div>';
    } else {
      el.innerHTML = list.map(taskCard).join('');

      el.querySelectorAll('.task[draggable]').forEach(node => {
        node.addEventListener('dragstart', onDragStart);
        node.addEventListener('dragend',   onDragEnd);
      });

      el.querySelectorAll('.task[data-id]').forEach(node => {
        node.addEventListener('touchstart', onTouchStart, { passive: true });
      });

      el.querySelectorAll('[data-edit]').forEach(node => {
        node.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(editingId); }
          if (e.key === 'Escape') cancelEdit();
        });
      });
    }
  }
  renderLog();
  updateStatus();
}

// ─── Completed-task activity log ────────────────────────────────────────────────
// Lists every finished task below the matrix, with timing: how long after it was
// added it got done, and (if it had a deadline) whether it was on time or late.
function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const min = Math.round(ms / 60000);
  if (min < 1)   return 'under a minute';
  if (min < 60)  return min + ' min';
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24)    return h + 'h' + (m ? ' ' + m + 'm' : '');
  const d = Math.floor(h / 24), hh = h % 24;
  return d + 'd' + (hh ? ' ' + hh + 'h' : '');
}

function renderLog() {
  const done = tasks
    .filter(t => t.done && !t.deleted)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  document.getElementById('logCount').textContent = done.length;
  const wrap = document.getElementById('logList');

  if (!done.length) {
    wrap.innerHTML = '<div class="empty-msg">No completed tasks yet.</div>';
    return;
  }

  wrap.innerHTML = done.map(t => {
    const when = t.completedAt
      ? new Date(t.completedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';

    let badge = '<span class="log-badge done">Completed</span>';
    const parts = [];

    if (t.deadline && t.completedAt) {
      const diff = t.completedAt - t.deadline;   // +ve = finished after deadline
      if (diff > 60000) {
        badge = '<span class="log-badge late">Delayed</span>';
        parts.push('Finished <b>' + fmtDuration(diff) + '</b> after the deadline.');
      } else {
        badge = '<span class="log-badge ontime">On time</span>';
        parts.push('Finished ' + fmtDuration(-diff) + ' before the deadline.');
      }
    }
    if (t.completedAt && t.id) {
      parts.push('Took ' + fmtDuration(t.completedAt - t.id) + ' from when it was added.');
    }

    return `
      <div class="log-item">
        <div class="log-top">${badge}<span class="log-when">${when}</span></div>
        <div class="log-text">${esc(t.text)}</div>
        ${taskNotesHtml(t)}
        ${parts.length ? `<div class="log-detail">${parts.join(' ')}</div>` : ''}
        <button class="log-reopen" onclick="reopenTask(${t.id})">↩ reopen</button>
      </div>`;
  }).join('');
}

// Activity log is collapsed by default — only the title + count badge show;
// the list itself is opt-in via the toggle, and the choice is remembered.
const LOG_COLLAPSED_KEY = 'tm_log_collapsed';
let logCollapsed = localStorage.getItem(LOG_COLLAPSED_KEY) !== '0';

function applyLogCollapsed() {
  document.getElementById('logList').classList.toggle('collapsed', logCollapsed);
  document.getElementById('logToggleBtn').textContent = logCollapsed ? 'Show' : 'Hide';
}

function toggleLogCollapsed() {
  logCollapsed = !logCollapsed;
  localStorage.setItem(LOG_COLLAPSED_KEY, logCollapsed ? '1' : '0');
  applyLogCollapsed();
}

document.getElementById('logToggle').addEventListener('click', toggleLogCollapsed);
document.getElementById('logToggleBtn').addEventListener('click', toggleLogCollapsed);

// "Clear completed" — soft-delete every done task (tombstones, so the clear syncs
// to other devices and the calendar events get cleaned up on the next sync).
document.getElementById('logClear').addEventListener('click', () => {
  const done = tasks.filter(t => t.done && !t.deleted);
  if (!done.length) return;
  if (!confirm('Clear ' + done.length + ' completed task(s) from the log?')) return;
  const now = Date.now();
  done.forEach(t => { t.deleted = true; t.updatedAt = now; });
  persist();
  render();
});

function taskCard(t) {
  if (editingId === t.id) {
    return `
      <div class="task" data-id="${t.id}">
        <textarea class="task-edit" data-edit="${t.id}" rows="2">${esc(t.text)}</textarea>
        <div class="task-actions">
          <button class="task-btn green" onclick="commitEdit(${t.id})">Save</button>
          <button class="task-btn" onclick="cancelEdit()">Cancel</button>
        </div>
      </div>`;
  }

  return `
    <div class="task" draggable="true" data-id="${t.id}">
      <span class="task-handle" title="Hold to drag">⠿⠿</span>
      <div class="task-text">${esc(t.text)}</div>
      ${taskNotesHtml(t)}
      ${deadlineBadge(t)}
      <div class="task-actions">
        <button class="task-btn green" onclick="toggleDone(${t.id})" title="Mark done">✓</button>
        <button class="task-btn dots" onclick="toggleTaskMenu(event, ${t.id})" title="More">⋮</button>
        <button class="task-btn red" onclick="deleteTask(${t.id})" title="Delete">✕</button>
      </div>
      <div class="task-menu" data-menu="${t.id}">
        <button onclick="startEdit(${t.id})">✏️ Edit text</button>
        <button onclick="openNoteEditor(${t.id})">💬 ${t.notes && t.notes.length ? 'Add another comment' : 'Add comment'}</button>
        <button onclick="openDeadlineEditor(${t.id})">⏰ ${t.deadline ? 'Change deadline' : 'Set deadline'}</button>
      </div>
    </div>`;
}

function taskNotesHtml(t) {
  if (!t.notes || !t.notes.length) return '';
  return `<div class="task-notes">${t.notes.map(n => `
    <div class="task-note">
      <span class="note-text">${esc(n.text)}</span>
      <button class="note-del" onclick="deleteNote(${t.id}, ${n.id})" title="Delete comment">✕</button>
    </div>`).join('')}</div>`;
}


// ─── Mouse drag ─────────────────────────────────────────────────────────────
function onDragStart(e) {
  dragId = this.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => this.classList.add('dragging'), 0);
}

function onDragEnd() {
  this.classList.remove('dragging');
  clearHighlight();
}

document.querySelectorAll('.task-list').forEach(zone => {
  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.closest('.quadrant').classList.add('drag-over');
  });
  zone.addEventListener('dragleave', e => {
    if (!zone.closest('.quadrant').contains(e.relatedTarget)) {
      zone.closest('.quadrant').classList.remove('drag-over');
    }
  });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    clearHighlight();
    if (dragId) { moveTask(parseInt(dragId), parseInt(zone.dataset.quad)); dragId = null; }
  });
});

function clearHighlight() {
  document.querySelectorAll('.quadrant').forEach(q => q.classList.remove('drag-over'));
}

// ─── Touch drag ───────────────────────────────────────────────────────────────
function onTouchStart(e) {
  if (e.target.closest('button, textarea')) return;
  const taskEl = this;
  const touch  = e.touches[0];
  touchOriginX = touch.clientX;
  touchOriginY = touch.clientY;

  touchTimer = setTimeout(() => {
    dragId = taskEl.dataset.id;
    taskEl.classList.add('dragging');

    ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = taskEl.querySelector('.task-text')?.textContent || '';
    document.body.appendChild(ghost);
    placeGhost(touchOriginX, touchOriginY);
  }, 300);
}

document.addEventListener('touchmove', e => {
  if (touchTimer) {
    const t = e.touches[0];
    if (Math.abs(t.clientX - touchOriginX) > 8 || Math.abs(t.clientY - touchOriginY) > 8) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
  }

  if (!ghost || !dragId) return;
  e.preventDefault();

  const { clientX, clientY } = e.touches[0];
  placeGhost(clientX, clientY);

  ghost.style.visibility = 'hidden';
  const hit = document.elementFromPoint(clientX, clientY);
  ghost.style.visibility = '';

  clearHighlight();
  const quad = hit?.closest('.quadrant');
  if (quad) { quad.classList.add('drag-over'); dropQuad = quad; }
  else dropQuad = null;

}, { passive: false });

document.addEventListener('touchend', () => {
  clearTimeout(touchTimer); touchTimer = null;

  if (ghost) { ghost.remove(); ghost = null; }
  document.querySelectorAll('.task').forEach(t => t.classList.remove('dragging'));
  clearHighlight();

  if (dragId && dropQuad) {
    const zone = dropQuad.querySelector('.task-list');
    if (zone) moveTask(parseInt(dragId), parseInt(zone.dataset.quad));
  }

  dragId = null; dropQuad = null;
});

function placeGhost(x, y) {
  if (!ghost) return;
  ghost.style.left = x + 'px';
  ghost.style.top  = (y - 60) + 'px';
}

