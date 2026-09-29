const state = { token: sessionStorage.getItem('orbit-token') || '', snapshot: null, status: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}`, ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) throw Object.assign(new Error('Authentication required.'), { auth: true });
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
}

function formatDate(value) {
  if (!value) return 'Ready now';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function renderMessages(messages) {
  const root = $('#messages'); root.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = 'Start with a question, a decision, or something you want to make progress on.'; root.append(empty); return;
  }
  for (const item of messages) {
    const message = document.createElement('div'); message.className = `message ${item.role}`; message.textContent = item.content; root.append(message);
  }
  root.scrollTop = root.scrollHeight;
}

function makeButton(label, className, onClick) {
  const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; button.addEventListener('click', onClick); return button;
}

function renderTasks(tasks) {
  const root = $('#tasks-list'); root.replaceChildren();
  const active = tasks.filter((task) => !['completed', 'cancelled'].includes(task.status)).length;
  $('#task-count').textContent = String(active);
  if (!tasks.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No tasks yet. Give Orbit one clear outcome to prepare.'; root.append(empty); return; }
  for (const task of tasks) {
    const card = document.createElement('article'); card.className = 'item-card';
    const header = document.createElement('header'); const titleWrap = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = task.title;
    const prompt = document.createElement('p'); prompt.textContent = task.prompt; titleWrap.append(title, prompt);
    const status = document.createElement('span'); status.className = `badge ${task.status}`; status.textContent = task.status.replaceAll('_', ' '); header.append(titleWrap, status); card.append(header);
    const meta = document.createElement('div'); meta.className = 'meta';
    for (const text of [task.risk === 'external' ? 'approval gated' : 'think only', task.recurrence, formatDate(task.schedule_at)]) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = text; meta.append(badge); }
    card.append(meta);
    if (task.result) { const result = document.createElement('p'); result.className = 'result'; result.textContent = task.result; card.append(result); }
    if (task.status === 'waiting_approval') {
      const actions = document.createElement('div'); actions.className = 'mini-actions';
      actions.append(makeButton('Approve plan', 'primary', () => taskAction(task.id, 'approve')), makeButton('Cancel', 'danger', () => taskAction(task.id, 'cancel'))); card.append(actions);
    } else if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
      const actions = document.createElement('div'); actions.className = 'mini-actions'; actions.append(makeButton('Cancel', 'danger', () => taskAction(task.id, 'cancel'))); card.append(actions);
    }
    root.append(card);
  }
}

function renderMemories(memories) {
  const root = $('#memory-list'); root.replaceChildren();
  if (!memories.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Nothing saved. Orbit only remembers what you add here.'; root.append(empty); return; }
  for (const memory of memories) {
    const card = document.createElement('article'); card.className = 'item-card'; const header = document.createElement('header');
    const text = document.createElement('p'); text.textContent = memory.content;
    header.append(text, makeButton('Delete', 'danger', () => deleteMemory(memory.id))); card.append(header); root.append(card);
  }
}

function renderActivity(events) {
  const root = $('#activity-list'); root.replaceChildren();
  if (!events.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Activity will appear here.'; root.append(empty); return; }
  for (const event of events) {
    const item = document.createElement('div'); item.className = 'timeline-item'; const message = document.createElement('p'); message.textContent = event.message;
    const time = document.createElement('time'); time.dateTime = event.created_at; time.textContent = formatDate(event.created_at); item.append(message, time); root.append(item);
  }
}

function render() {
  if (!state.snapshot) return;
  renderMessages(state.snapshot.messages); renderTasks(state.snapshot.tasks); renderMemories(state.snapshot.memories); renderActivity(state.snapshot.events);
}

async function refresh() {
  state.snapshot = await api('/api/snapshot'); render();
}

async function connect() {
  try {
    state.status = await api('/api/status'); await refresh();
    $('#brand-name').textContent = state.status.buddyName; $('#status-text').textContent = 'Online'; $('.status').classList.add('online');
    $('#model-pill').textContent = state.status.modelConfigured ? state.status.model : 'Demo mode · add an API key';
    $('#login-dialog').close();
  } catch (error) { if (error.auth) $('#login-dialog').showModal(); else toast(error.message); throw error; }
}

async function taskAction(id, action) { try { await api(`/api/tasks/${id}/${action}`, { method: 'POST' }); await refresh(); toast(action === 'approve' ? 'Task approved.' : 'Task cancelled.'); } catch (error) { toast(error.message); } }
async function deleteMemory(id) { try { await api(`/api/memories/${id}`, { method: 'DELETE' }); await refresh(); toast('Memory deleted.'); } catch (error) { toast(error.message); } }

$$('.tab').forEach((button) => button.addEventListener('click', () => {
  $$('.tab').forEach((item) => item.classList.toggle('active', item === button));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === button.dataset.view));
  location.hash = button.dataset.view;
}));

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); state.token = $('#token-input').value; sessionStorage.setItem('orbit-token', state.token); $('#login-error').textContent = '';
  try { await connect(); } catch (error) { $('#login-error').textContent = error.auth ? 'That access token was not accepted.' : error.message; }
});

$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; const input = $('#chat-input'); const message = input.value.trim(); if (!message) return;
  button.disabled = true; input.disabled = true;
  try { await api('/api/chat', { method: 'POST', body: JSON.stringify({ message }) }); input.value = ''; await refresh(); }
  catch (error) { toast(error.message); } finally { button.disabled = false; input.disabled = false; input.focus(); }
});

$('#new-task-button').addEventListener('click', () => $('#task-form').classList.remove('hidden'));
$('#cancel-task').addEventListener('click', () => $('#task-form').classList.add('hidden'));
$('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const dateValue = $('#task-date').value;
  const body = { title: $('#task-title').value, prompt: $('#task-prompt').value, recurrence: $('#task-recurrence').value, risk: $('#task-risk').value, scheduleAt: dateValue ? new Date(dateValue).toISOString() : null };
  try { await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) }); event.target.reset(); event.target.classList.add('hidden'); await refresh(); toast('Task created.'); }
  catch (error) { toast(error.message); }
});

$('#memory-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const input = $('#memory-input');
  try { await api('/api/memories', { method: 'POST', body: JSON.stringify({ content: input.value }) }); input.value = ''; await refresh(); toast('Memory saved.'); }
  catch (error) { toast(error.message); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
connect().catch(() => {});
setInterval(() => { if (state.token && !$('#login-dialog').open) refresh().catch(() => {}); }, 5000);
