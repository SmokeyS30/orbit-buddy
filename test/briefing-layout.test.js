import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIEFING_LAYOUTS, briefingLayoutFor } from '../public/briefing-layout.js';

// The frontend layout config: phase id → tab label, section order, card titles.
// The phase itself is computed server-side; this module never does clock math.

test('every phase has a warm tab label and a non-empty section list', () => {
  assert.deepEqual(Object.keys(BRIEFING_LAYOUTS).sort(), ['afternoon', 'evening', 'morning']);
  for (const [id, layout] of Object.entries(BRIEFING_LAYOUTS)) {
    assert.ok(typeof layout.tabLabel === 'string' && layout.tabLabel.length > 0, `${id} tabLabel`);
    assert.ok(Array.isArray(layout.sections) && layout.sections.length > 0, `${id} sections`);
    for (const s of layout.sections) {
      assert.ok(typeof s.key === 'string', `${id} section key`);
    }
  }
});

test('tab labels match the server phase labels', () => {
  assert.equal(BRIEFING_LAYOUTS.morning.tabLabel, 'Morning briefing');
  assert.equal(BRIEFING_LAYOUTS.afternoon.tabLabel, 'Afternoon check-in');
  assert.equal(BRIEFING_LAYOUTS.evening.tabLabel, 'Evening recap');
});

test('morning keeps the existing day-plan layout', () => {
  const keys = BRIEFING_LAYOUTS.morning.sections.map((s) => s.key);
  assert.deepEqual(keys, ['weather', 'agenda', 'focus', 'loops', 'anniversaries']);
  const agenda = BRIEFING_LAYOUTS.morning.sections.find((s) => s.key === 'agenda');
  assert.equal(agenda.title, 'Today');
  assert.equal(agenda.tomorrowLine, true);
});

test('afternoon leads with momentum and splits the day', () => {
  const secs = BRIEFING_LAYOUTS.afternoon.sections;
  assert.deepEqual(secs.map((s) => s.key), ['focus', 'loops', 'agenda', 'weather', 'anniversaries']);
  assert.equal(secs[0].title, 'Momentum');
  assert.equal(secs[1].title, 'Still to do');
  const agenda = secs.find((s) => s.key === 'agenda');
  assert.equal(agenda.title, 'Today so far');
  assert.equal(agenda.splitDay, true, 'afternoon agenda splits past vs upcoming');
});

test('evening recaps the day and previews tomorrow', () => {
  const secs = BRIEFING_LAYOUTS.evening.sections;
  assert.deepEqual(secs.map((s) => s.key), ['agenda', 'loops', 'focus', 'tomorrow', 'anniversaries', 'weather']);
  assert.equal(secs.find((s) => s.key === 'agenda').title, 'The day that was');
  assert.equal(secs.find((s) => s.key === 'loops').title, 'Still open');
  assert.equal(secs.find((s) => s.key === 'tomorrow').title, 'Tomorrow');
  // Weather sinks to the bottom in the evening; momentum stays visible.
  assert.ok(secs.findIndex((s) => s.key === 'weather') > secs.findIndex((s) => s.key === 'focus'));
});

test('briefingLayoutFor resolves each phase and falls back to morning', () => {
  assert.equal(briefingLayoutFor('morning').tabLabel, 'Morning briefing');
  assert.equal(briefingLayoutFor('afternoon').tabLabel, 'Afternoon check-in');
  assert.equal(briefingLayoutFor('evening').tabLabel, 'Evening recap');
  assert.equal(briefingLayoutFor('nope'), BRIEFING_LAYOUTS.morning, 'unknown id → morning');
  assert.equal(briefingLayoutFor(undefined), BRIEFING_LAYOUTS.morning, 'missing phase (stale payload) → morning');
  assert.equal(briefingLayoutFor(null), BRIEFING_LAYOUTS.morning);
});
