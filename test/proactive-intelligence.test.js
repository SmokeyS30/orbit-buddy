import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutinePrompt, dueRoutines } from '../src/proactive.js';

test('dueRoutines respects local time, weekdays, weekly day, and prior runs', () => {
  const monday = Date.parse('2026-10-05T13:00:00Z'); // 09:00 New York
  const base = { enabled: 1, time_local: '08:30', last_run_date: null };
  assert.equal(dueRoutines([{ ...base, id: 'daily', cadence: 'daily' }], 'America/New_York', monday).length, 1);
  assert.equal(dueRoutines([{ ...base, id: 'weekly', cadence: 'weekly', day_of_week: 1 }], 'America/New_York', monday).length, 1);
  assert.equal(dueRoutines([{ ...base, id: 'wrong-day', cadence: 'weekly', day_of_week: 2 }], 'America/New_York', monday).length, 0);
  assert.equal(dueRoutines([{ ...base, id: 'done', cadence: 'daily', last_run_date: '2026-10-05' }], 'America/New_York', monday).length, 0);
});

test('briefing prompt prioritizes goals and includes grounded context', () => {
  const prompt = buildRoutinePrompt({
    routine: { kind: 'briefing', prompt: 'Prepare my day' }, timeZone: 'UTC', nowMs: Date.parse('2026-10-03T09:00:00Z'),
    agenda: 'Today\n- 10:00 Project review',
    goals: [{ title: 'Ship project', status: 'active', priority: 3, progress: 60, target_date: '2026-10-04', next_step: 'Review launch list' }],
    tasks: [{ title: 'Write notes', status: 'queued', schedule_at: null }],
    followUps: [{ description: 'interview', due_date: '2026-10-04', priority: 3 }]
  });
  assert.match(prompt, /at most three priorities/);
  assert.match(prompt, /Ship project/);
  assert.match(prompt, /Project review/);
  assert.match(prompt, /do not invent/i);
});
