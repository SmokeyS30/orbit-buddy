// L2 goals/projects v2: visual progress arcs + kanban/timeline view models.
//
// Pure helpers and small DOM builders for the Goals and Projects tabs. The
// module reads from the existing snapshot fields (goal.progress,
// goal.target_date, goal.status, project.steps[].status/due_date) — no new
// server data needed. Builders reference the global `document` (the browser
// at runtime; a stub in node tests).

export const ARC_RADIUS = 26;
export const ARC_STROKE = 6;
const SVG_NS = 'http://www.w3.org/2000/svg';

export const KANBAN_STATUSES = ['planned', 'in_progress', 'blocked', 'completed'];
export const KANBAN_LABELS = {
  planned: 'Planned',
  in_progress: 'In progress',
  blocked: 'Blocked',
  completed: 'Completed',
};

const GOAL_STATUS_COLORS = {
  'on-track': 'var(--lime)',
  'at-risk': 'var(--violet)',
  overdue: 'var(--coral)',
  completed: 'var(--lime)',
};

const STEP_STATUS_COLORS = {
  planned: 'var(--muted)',
  in_progress: 'var(--cyan)',
  blocked: 'var(--coral)',
  completed: 'var(--lime)',
};

export function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// SVG path for a progress ring that starts at 12 o'clock and sweeps clockwise.
// percent 0 draws nothing (empty string); 100 needs two arcs because a single
// arc path cannot draw a complete circle.
export function arcPath(percent, radius = ARC_RADIUS, stroke = ARC_STROKE) {
  const p = clampPercent(percent);
  if (p <= 0) return '';
  const c = radius + stroke;
  const startX = c;
  const startY = c - radius;
  if (p >= 100) {
    return `M ${startX} ${startY} A ${radius} ${radius} 0 1 1 ${c} ${c + radius} A ${radius} ${radius} 0 1 1 ${startX} ${startY}`;
  }
  const angle = (p / 100) * Math.PI * 2;
  const endX = round2(c + radius * Math.sin(angle));
  const endY = round2(c - radius * Math.cos(angle));
  const large = p > 50 ? 1 : 0;
  return `M ${startX} ${startY} A ${radius} ${radius} 0 ${large} 1 ${endX} ${endY}`;
}

// Glanceable goal health. overdue = past target_date and not completed;
// at-risk = target within 7 days and progress below 70%. target_date is
// YYYY-MM-DD; comparisons are done on local calendar days so the rule is
// timezone-stable. nowMs is injectable for tests.
export function goalStatusRule(goal, nowMs = Date.now()) {
  if (goal && goal.status === 'completed') return 'completed';
  const progress = clampPercent(goal && goal.progress);
  const target = goal && typeof goal.target_date === 'string' ? goal.target_date : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return 'on-track';
  const [y, m, d] = target.split('-').map(Number);
  const targetDay = new Date(y, m - 1, d);
  targetDay.setHours(0, 0, 0, 0);
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  if (targetDay.getTime() < today.getTime()) return 'overdue';
  const daysLeft = Math.round((targetDay.getTime() - today.getTime()) / 86400000);
  if (daysLeft <= 7 && progress < 70) return 'at-risk';
  return 'on-track';
}

export function goalStatusColor(status) {
  return GOAL_STATUS_COLORS[status] || GOAL_STATUS_COLORS['on-track'];
}

export function stepStatusColor(status) {
  return STEP_STATUS_COLORS[status] || STEP_STATUS_COLORS.planned;
}

// Kanban grouping: columns per step status. Steps with an unrecognized
// status fall back to 'planned' so no step ever disappears from the board.
export function groupStepsByStatus(steps) {
  const groups = { planned: [], in_progress: [], blocked: [], completed: [] };
  for (const step of steps || []) {
    const key = step && KANBAN_STATUSES.includes(step.status) ? step.status : 'planned';
    groups[key].push(step);
  }
  return groups;
}

// Timeline split: steps with a due_date, ascending, plus an unscheduled lane
// for everything without a date.
export function splitTimelineSteps(steps) {
  const dated = [];
  const unscheduled = [];
  for (const step of steps || []) {
    if (step && typeof step.due_date === 'string' && step.due_date) dated.push(step);
    else unscheduled.push(step);
  }
  dated.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
  return { dated, unscheduled };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// SVG progress ring for a goal card: percentage in the center, ring colored by
// the status rule. Keeps an aria-label with the percentage for screen readers.
export function buildGoalArc(goal) {
  const progress = clampPercent(goal && goal.progress);
  const status = goalStatusRule(goal);
  const wrap = el('div', 'goal-arc');
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', `${(goal && goal.title) || 'Goal'} progress: ${progress}%`);
  const size = (ARC_RADIUS + ARC_STROKE) * 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  const c = ARC_RADIUS + ARC_STROKE;
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('cx', String(c));
  track.setAttribute('cy', String(c));
  track.setAttribute('r', String(ARC_RADIUS));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'var(--line)');
  track.setAttribute('stroke-width', String(ARC_STROKE));
  svg.appendChild(track);
  const d = arcPath(progress);
  if (d) {
    const arc = document.createElementNS(SVG_NS, 'path');
    arc.setAttribute('d', d);
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', goalStatusColor(status));
    arc.setAttribute('stroke-width', String(ARC_STROKE));
    arc.setAttribute('stroke-linecap', 'round');
    svg.appendChild(arc);
  }
  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('x', String(c));
  label.setAttribute('y', String(c));
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('dominant-baseline', 'central');
  label.setAttribute('fill', 'var(--text)');
  label.setAttribute('font-size', '14');
  label.setAttribute('font-weight', '750');
  label.textContent = `${progress}%`;
  svg.appendChild(label);
  wrap.appendChild(svg);
  const caption = el('div', 'arc-caption');
  caption.appendChild(el('span', 'arc-status', status.replace('-', ' ')));
  wrap.appendChild(caption);
  return wrap;
}

// Kanban board: one column per step status, reusing the list-view step row
// builder so the per-step action buttons behave identically everywhere.
export function buildKanbanRegion(steps, makeStepRow) {
  const groups = groupStepsByStatus(steps);
  const board = el('div', 'kanban');
  board.setAttribute('aria-label', 'Project steps by status');
  for (const status of KANBAN_STATUSES) {
    const col = el('div', 'kanban-col');
    const head = el('div', 'kanban-col-head');
    head.appendChild(el('span', null, KANBAN_LABELS[status]));
    head.appendChild(el('span', 'count', String(groups[status].length)));
    col.appendChild(head);
    if (!groups[status].length) col.appendChild(el('p', 'kanban-empty', 'Empty'));
    for (const step of groups[status]) col.appendChild(makeStepRow(step));
    board.appendChild(col);
  }
  return board;
}

// Timeline: horizontal lane of dated steps (ascending) with status dots, then
// an unscheduled lane for steps without due dates.
export function buildTimelineRegion(steps, makeStepRow, makeStepActions) {
  const { dated, unscheduled } = splitTimelineSteps(steps);
  const region = el('div', 'project-timeline');
  const points = el('div', 'timeline-points');
  points.setAttribute('aria-label', 'Project steps by due date');
  for (const step of dated) {
    const point = el('div', 'timeline-point');
    point.style.setProperty('--point-color', stepStatusColor(step.status));
    point.appendChild(el('time', null, step.due_date));
    point.appendChild(el('strong', null, step.title));
    const badge = el('span', 'badge', String(step.status).replaceAll('_', ' '));
    point.appendChild(badge);
    point.appendChild(makeStepActions(step));
    points.appendChild(point);
  }
  region.appendChild(points);
  if (unscheduled.length) {
    const lane = el('div', 'unscheduled-lane');
    lane.appendChild(el('h4', null, 'Unscheduled'));
    const list = el('div', 'project-steps');
    for (const step of unscheduled) list.appendChild(makeStepRow(step));
    lane.appendChild(list);
    region.appendChild(lane);
  }
  return region;
}
