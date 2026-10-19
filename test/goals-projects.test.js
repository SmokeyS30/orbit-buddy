import test from 'node:test';
import assert from 'node:assert/strict';

import {
  arcPath,
  clampPercent,
  goalStatusRule,
  goalStatusColor,
  stepStatusColor,
  groupStepsByStatus,
  splitTimelineSteps,
  KANBAN_STATUSES,
  buildGoalArc,
  buildKanbanRegion,
  buildTimelineRegion,
} from '../public/goals-projects.js';

// --- Minimal DOM stub so the arc/kanban/timeline builders can be render-
// reviewed in node (no browser). Supports what the builders use and nothing
// more.
class StubEl {
  constructor(tag, ns) {
    this.tagName = tag;
    this.namespaceURI = ns || null;
    this.children = [];
    this.attributes = {};
    this.className = '';
    this._text = '';
    this.style = {
      _props: {},
      setProperty(k, v) { this._props[k] = v; },
      getPropertyValue(k) { return this._props[k]; },
    };
    this.listeners = {};
  }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  appendChild(n) { this.children.push(n); return n; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  querySelectorAll(sel) {
    const out = [];
    const match = (node) => {
      if (sel.startsWith('.')) {
        if (String(node.className).split(' ').includes(sel.slice(1))) out.push(node);
      } else if (node.tagName === sel) {
        out.push(node);
      }
      for (const c of node.children) match(c);
    };
    match(this);
    return out;
  }
}

globalThis.document = {
  createElement: (tag) => new StubEl(tag),
  createElementNS: (ns, tag) => new StubEl(tag, ns),
};

const fakeStepRow = (step) => {
  const row = new StubEl('div');
  row.className = 'project-step';
  row.textContent = step.title;
  return row;
};
const fakeStepActions = () => {
  const actions = new StubEl('div');
  actions.className = 'mini-actions';
  return actions;
};

// Friday 2026-10-16 12:00 EDT — fixed "now" for deterministic status rules.
const NOW = new Date('2026-10-16T12:00:00-04:00').valueOf();

test('clampPercent bounds progress to 0..100', () => {
  assert.equal(clampPercent(50), 50);
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent(100), 100);
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(NaN), 0);
  assert.equal(clampPercent('nope'), 0);
  assert.equal(clampPercent(undefined), 0);
});

test('arcPath draws nothing at 0 and clamps extremes', () => {
  assert.equal(arcPath(0), '');
  assert.equal(arcPath(-5), '');
  assert.equal(arcPath(150), arcPath(100));
});

test('arcPath quarter/half/three-quarter sweeps from 12 o\'clock', () => {
  // R=26, stroke=6 -> center (32,32), start at top (32,6).
  assert.equal(arcPath(25), 'M 32 6 A 26 26 0 0 1 58 32');
  assert.equal(arcPath(50), 'M 32 6 A 26 26 0 0 1 32 58');
  assert.equal(arcPath(75), 'M 32 6 A 26 26 0 1 1 6 32');
});

test('arcPath full circle needs two arcs', () => {
  assert.equal(arcPath(100), 'M 32 6 A 26 26 0 1 1 32 58 A 26 26 0 1 1 32 6');
});

test('goalStatusRule: completed goals are never overdue', () => {
  assert.equal(goalStatusRule({ status: 'completed', progress: 100, target_date: '2026-10-15' }, NOW), 'completed');
});

test('goalStatusRule: past target date and not completed is overdue', () => {
  assert.equal(goalStatusRule({ status: 'active', progress: 90, target_date: '2026-10-15' }, NOW), 'overdue');
  assert.equal(goalStatusRule({ status: 'paused', progress: 10, target_date: '2026-10-01' }, NOW), 'overdue');
});

test('goalStatusRule: target within 7 days and progress under 70 is at-risk', () => {
  assert.equal(goalStatusRule({ status: 'active', progress: 50, target_date: '2026-10-19' }, NOW), 'at-risk');
  assert.equal(goalStatusRule({ status: 'active', progress: 0, target_date: '2026-10-16' }, NOW), 'at-risk');
});

test('goalStatusRule: on-track when far out, near-done, or dateless', () => {
  assert.equal(goalStatusRule({ status: 'active', progress: 70, target_date: '2026-10-19' }, NOW), 'on-track');
  assert.equal(goalStatusRule({ status: 'active', progress: 10, target_date: '2026-11-30' }, NOW), 'on-track');
  assert.equal(goalStatusRule({ status: 'active', progress: 10 }, NOW), 'on-track');
  assert.equal(goalStatusRule({ status: 'active', progress: 10, target_date: 'not-a-date' }, NOW), 'on-track');
});

test('status colors map to the Orbit palette', () => {
  assert.equal(goalStatusColor('on-track'), 'var(--lime)');
  assert.equal(goalStatusColor('at-risk'), 'var(--violet)');
  assert.equal(goalStatusColor('overdue'), 'var(--coral)');
  assert.equal(goalStatusColor('completed'), 'var(--lime)');
  assert.equal(stepStatusColor('in_progress'), 'var(--cyan)');
  assert.equal(stepStatusColor('mystery'), 'var(--muted)');
});

test('groupStepsByStatus fills the four kanban columns', () => {
  const steps = [
    { title: 'a', status: 'planned' },
    { title: 'b', status: 'in_progress' },
    { title: 'c', status: 'blocked' },
    { title: 'd', status: 'completed' },
    { title: 'e', status: 'mystery' },
  ];
  const groups = groupStepsByStatus(steps);
  assert.deepEqual(Object.keys(groups), KANBAN_STATUSES);
  assert.deepEqual(groups.planned.map((s) => s.title), ['a', 'e']);
  assert.deepEqual(groups.in_progress.map((s) => s.title), ['b']);
  assert.deepEqual(groups.blocked.map((s) => s.title), ['c']);
  assert.deepEqual(groups.completed.map((s) => s.title), ['d']);
});

test('splitTimelineSteps separates dated from unscheduled and sorts', () => {
  const steps = [
    { title: 'later', due_date: '2026-11-01' },
    { title: 'floating' },
    { title: 'sooner', due_date: '2026-10-20' },
  ];
  const { dated, unscheduled } = splitTimelineSteps(steps);
  assert.deepEqual(dated.map((s) => s.title), ['sooner', 'later']);
  assert.deepEqual(unscheduled.map((s) => s.title), ['floating']);
});

test('buildGoalArc renders an accessible SVG ring', () => {
  const wrap = buildGoalArc({ title: 'Run a 5k', progress: 42, status: 'active', target_date: '2026-11-30' });
  assert.equal(wrap.className, 'goal-arc');
  assert.equal(wrap.getAttribute('role'), 'img');
  assert.match(wrap.getAttribute('aria-label'), /Run a 5k progress: 42%/);
  const [svg] = wrap.querySelectorAll('svg');
  assert.ok(svg, 'has an svg');
  const track = svg.querySelectorAll('circle')[0];
  assert.equal(track.getAttribute('stroke'), 'var(--line)');
  const arc = svg.querySelectorAll('path')[0];
  assert.equal(arc.getAttribute('d'), arcPath(42));
  assert.equal(arc.getAttribute('stroke'), 'var(--lime)');
  const label = svg.querySelectorAll('text')[0];
  assert.equal(label.textContent, '42%');
});

test('buildGoalArc colors the ring by the status rule and clamps text', () => {
  const overdue = buildGoalArc({ title: 'G', progress: 90, status: 'active', target_date: '2026-10-01' });
  assert.equal(overdue.querySelectorAll('path')[0].getAttribute('stroke'), 'var(--coral)');
  const soon = new Date(); soon.setDate(soon.getDate() + 3);
  const atRiskDate = soon.toISOString().slice(0, 10);
  const atRisk = buildGoalArc({ title: 'G', progress: 10, status: 'active', target_date: atRiskDate });
  assert.equal(atRisk.querySelectorAll('path')[0].getAttribute('stroke'), 'var(--violet)');
  const clamped = buildGoalArc({ title: 'G', progress: 150, status: 'active' });
  assert.equal(clamped.querySelectorAll('text')[0].textContent, '100%');
  const zero = buildGoalArc({ title: 'G', progress: 0, status: 'active' });
  assert.equal(zero.querySelectorAll('path').length, 0);
  assert.equal(zero.querySelectorAll('text')[0].textContent, '0%');
});

test('buildKanbanRegion renders four labeled columns with rows', () => {
  const steps = [
    { id: '1', title: 'one', status: 'planned' },
    { id: '2', title: 'two', status: 'in_progress' },
    { id: '3', title: 'three', status: 'completed' },
  ];
  const board = buildKanbanRegion(steps, fakeStepRow);
  assert.equal(board.className, 'kanban');
  const cols = board.querySelectorAll('.kanban-col');
  assert.equal(cols.length, 4);
  const heads = board.querySelectorAll('.kanban-col-head');
  assert.deepEqual(heads.map((h) => h.querySelectorAll('span')[0].textContent),
    ['Planned', 'In progress', 'Blocked', 'Completed']);
  assert.deepEqual(heads.map((h) => h.querySelectorAll('span')[1].textContent), ['1', '1', '0', '1']);
  const rows = board.querySelectorAll('.project-step');
  assert.equal(rows.length, 3);
  // Empty column shows a placeholder instead of nothing.
  assert.equal(board.querySelectorAll('.kanban-empty').length, 1);
});

test('buildTimelineRegion orders dated steps and lanes the unscheduled', () => {
  const steps = [
    { id: '1', title: 'later', status: 'planned', due_date: '2026-11-01' },
    { id: '2', title: 'floating', status: 'planned' },
    { id: '3', title: 'sooner', status: 'in_progress', due_date: '2026-10-20' },
  ];
  const region = buildTimelineRegion(steps, fakeStepRow, fakeStepActions);
  assert.equal(region.className, 'project-timeline');
  const points = region.querySelectorAll('.timeline-point');
  assert.equal(points.length, 2);
  assert.deepEqual(points.map((p) => p.querySelectorAll('time')[0].textContent),
    ['2026-10-20', '2026-11-01']);
  assert.deepEqual(points.map((p) => p.querySelectorAll('strong')[0].textContent),
    ['sooner', 'later']);
  // Status dots are colored per step status; actions are reused from list view.
  assert.equal(points[1].style.getPropertyValue('--point-color'), 'var(--muted)');
  assert.equal(points[0].style.getPropertyValue('--point-color'), 'var(--cyan)');
  assert.equal(region.querySelectorAll('.mini-actions').length, 2);
  const lane = region.querySelectorAll('.unscheduled-lane')[0];
  assert.ok(lane, 'unscheduled lane exists');
  assert.equal(lane.querySelectorAll('h4')[0].textContent, 'Unscheduled');
  assert.equal(lane.querySelectorAll('.project-step')[0].textContent, 'floating');
});

test('buildTimelineRegion with no undated steps skips the lane', () => {
  const region = buildTimelineRegion([{ id: '1', title: 'only', status: 'planned', due_date: '2026-10-20' }], fakeStepRow, fakeStepActions);
  assert.equal(region.querySelectorAll('.unscheduled-lane').length, 0);
  assert.equal(region.querySelectorAll('.timeline-point').length, 1);
});
