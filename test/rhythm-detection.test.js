import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detailedTimeBucket,
  detectActivityRhythms,
  activityRhythmSentence,
  activityRhythmKey,
} from '../src/ambient.js';
import { applyActivityRhythmDetection } from '../server.js';

const TZ = 'America/New_York';
// Friday 2026-10-16 12:00 EDT — the 30-day window starts 2026-09-16 12:00 EDT.
const NOW = new Date('2026-10-16T12:00:00-04:00').valueOf();
const at = (iso) => ({ atMs: new Date(iso).valueOf() });

test('detailedTimeBucket six-bucket partition', () => {
  assert.equal(detailedTimeBucket(22), 'night');
  assert.equal(detailedTimeBucket(0), 'night');
  assert.equal(detailedTimeBucket(4), 'night');
  assert.equal(detailedTimeBucket(5), 'early morning');
  assert.equal(detailedTimeBucket(6), 'early morning');
  assert.equal(detailedTimeBucket(7), 'morning');
  assert.equal(detailedTimeBucket(9), 'morning');
  assert.equal(detailedTimeBucket(10), 'midday');
  assert.equal(detailedTimeBucket(13), 'midday');
  assert.equal(detailedTimeBucket(14), 'afternoon');
  assert.equal(detailedTimeBucket(16), 'afternoon');
  assert.equal(detailedTimeBucket(17), 'evening');
  assert.equal(detailedTimeBucket(21), 'evening');
});

test('detectActivityRhythms fires on 3+ distinct days with plurality', () => {
  const starts = [
    at('2026-09-20T08:30:00-04:00'),
    at('2026-09-27T08:30:00-04:00'),
    at('2026-10-04T08:30:00-04:00'),
    at('2026-10-11T08:30:00-04:00'),
  ];
  const rhythms = detectActivityRhythms(starts, { nowMs: NOW, timeZone: TZ });
  assert.equal(rhythms.length, 1);
  assert.equal(rhythms[0].weekday, 'Sunday');
  assert.equal(rhythms[0].bucket, 'morning');
  assert.equal(rhythms[0].distinctDays, 4);
  assert.equal(rhythms[0].share, 1);
});

test('detectActivityRhythms ignores noise', () => {
  const starts = [
    at('2026-10-12T13:00:00-04:00'), // Mon midday
    at('2026-10-13T19:00:00-04:00'), // Tue evening
    at('2026-10-07T09:00:00-04:00'), // Wed morning
    at('2026-10-08T22:30:00-04:00'), // Thu night
    at('2026-10-16T06:00:00-04:00'), // Fri early morning
    at('2026-10-10T15:00:00-04:00'), // Sat afternoon
    at('2026-10-11T23:00:00-04:00'), // Sun night
    at('2026-10-05T10:30:00-04:00'), // Mon midday (2nd hit, different day)
  ];
  assert.deepEqual(detectActivityRhythms(starts, { nowMs: NOW, timeZone: TZ }), []);
});

test('detectActivityRhythms needs 3+ distinct days (multi-hit single day is not enough)', () => {
  const starts = [
    at('2026-10-11T08:10:00-04:00'),
    at('2026-10-11T08:30:00-04:00'),
    at('2026-10-11T08:55:00-04:00'),
    at('2026-10-11T09:05:00-04:00'),
    at('2026-10-11T09:40:00-04:00'),
    at('2026-10-04T08:30:00-04:00'), // only 2 distinct days
  ];
  assert.deepEqual(detectActivityRhythms(starts, { nowMs: NOW, timeZone: TZ }), []);
});

test('detectActivityRhythms requires 40% plurality of the activity type', () => {
  const starts = [
    at('2026-09-20T08:30:00-04:00'),
    at('2026-09-27T08:30:00-04:00'),
    at('2026-10-04T08:30:00-04:00'), // 3 Sunday mornings = 3/13 < 40%
    at('2026-10-12T13:00:00-04:00'),
    at('2026-10-13T19:00:00-04:00'),
    at('2026-10-07T09:00:00-04:00'),
    at('2026-10-08T22:30:00-04:00'),
    at('2026-10-16T06:00:00-04:00'),
    at('2026-10-10T15:00:00-04:00'),
    at('2026-10-11T23:00:00-04:00'),
    at('2026-10-05T10:30:00-04:00'),
    at('2026-09-21T08:00:00-04:00'),
    at('2026-09-22T21:00:00-04:00'),
  ];
  assert.deepEqual(detectActivityRhythms(starts, { nowMs: NOW, timeZone: TZ }), []);
});

test('detectActivityRhythms ignores activity older than ~30 days', () => {
  const starts = [
    at('2026-08-30T08:30:00-04:00'),
    at('2026-09-06T08:30:00-04:00'),
    at('2026-09-13T08:30:00-04:00'),
  ];
  assert.deepEqual(detectActivityRhythms(starts, { nowMs: NOW, timeZone: TZ }), []);
});

test('detectActivityRhythms handles empty input', () => {
  assert.deepEqual(detectActivityRhythms([], { nowMs: NOW, timeZone: TZ }), []);
  assert.deepEqual(detectActivityRhythms(null, { nowMs: NOW, timeZone: TZ }), []);
  assert.deepEqual(detectActivityRhythms([at('2026-10-11T08:30:00-04:00')], { nowMs: NaN, timeZone: TZ }), []);
});

test('activityRhythmKey is distinct from the R3 rhythm markers', () => {
  const r = { weekday: 'Sunday', bucket: 'morning' };
  assert.equal(activityRhythmKey('chat', r), 'rhythm:chat:Sunday|morning');
  assert.equal(activityRhythmKey('task', r), 'rhythm:task:Sunday|morning');
  assert.notEqual(activityRhythmKey('chat', r), 'rhythm:Sunday|morning|');
});

test('activityRhythmSentence is warm and specific', () => {
  const r = { weekday: 'Sunday', bucket: 'morning', distinctDays: 4 };
  assert.match(activityRhythmSentence('chat', r), /starts a new chat on Sunday mornings — 4 separate days/);
  assert.match(activityRhythmSentence('task', r), /creates tasks on Sunday mornings — 4 separate days/);
});

// --- Permission gating: applyActivityRhythmDetection writes nothing unless
// `ambient_context_<user.id>` is 'granted'.

function fakeDb({ setting = null, conversations = [], tasks = [], priorMemories = [] } = {}) {
  const addedMemories = [];
  const events = [];
  return {
    addedMemories,
    events,
    db: {
      getSetting: (key) => (key === 'ambient_context_u1' ? setting : null),
      listConversations: () => conversations,
      listTasks: () => tasks,
      listMemoriesBySource: (userId, source, limit) =>
        [...addedMemories, ...priorMemories].filter((m) => m.source === source).slice(0, limit),
      addMemory: (userId, content, opts) => {
        const m = { user_id: userId, content, ...opts };
        addedMemories.push(m);
        return m;
      },
      addEvent: (userId, type, message, detail) => { events.push({ user_id: userId, type, message, detail }); },
    },
  };
}

const sundayMornings = [
  { created_at: '2026-09-20T08:30:00-04:00' },
  { created_at: '2026-09-27T08:30:00-04:00' },
  { created_at: '2026-10-04T08:30:00-04:00' },
  { created_at: '2026-10-11T08:30:00-04:00' },
];
const wednesdayEvenings = [
  { created_at: '2026-09-23T19:30:00-04:00' },
  { created_at: '2026-09-30T19:30:00-04:00' },
  { created_at: '2026-10-07T19:30:00-04:00' },
  { created_at: '2026-10-14T19:30:00-04:00' },
];
const user = { id: 'u1', display_name: 'Edward' };

test('no permission: no rhythm memories and no events even with strong signal', () => {
  for (const setting of [null, 'declined', 'pending']) {
    const f = fakeDb({ setting, conversations: sundayMornings, tasks: wednesdayEvenings });
    const res = applyActivityRhythmDetection(f.db, user, { nowMs: NOW, timeZone: TZ });
    assert.deepEqual(res, { gated: true, added: 0 });
    assert.equal(f.addedMemories.length, 0, `setting=${setting}: no memories`);
    assert.equal(f.events.length, 0, `setting=${setting}: no events`);
  }
});

test('granted: chat + task rhythms become visible, deletable memories', () => {
  const f = fakeDb({ setting: 'granted', conversations: sundayMornings, tasks: wednesdayEvenings });
  const res = applyActivityRhythmDetection(f.db, user, { nowMs: NOW, timeZone: TZ });
  assert.deepEqual(res, { gated: false, added: 2 });
  assert.equal(f.addedMemories.length, 2);
  const markers = f.addedMemories.map((m) => m.content.split(' ')[0]).sort();
  assert.deepEqual(markers, ['rhythm:chat:Sunday|morning', 'rhythm:task:Wednesday|evening']);
  for (const m of f.addedMemories) {
    assert.equal(m.kind, 'fact');
    assert.equal(m.source, 'ambient-rhythm');
    assert.match(m.content, /Edward/);
    assert.match(m.content, /observation only/);
  }
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, 'ambient_rhythm');
});

test('known rhythms are not re-stored (dedup shares the R3 namespace)', () => {
  const priorMemories = [
    { source: 'ambient-rhythm', content: 'rhythm:chat:Sunday|morning Edward often starts a new chat on Sunday mornings — 4 separate days in the last month.' },
  ];
  const f = fakeDb({ setting: 'granted', conversations: sundayMornings, tasks: wednesdayEvenings, priorMemories });
  const res = applyActivityRhythmDetection(f.db, user, { nowMs: NOW, timeZone: TZ });
  assert.deepEqual(res, { gated: false, added: 1 });
  assert.equal(f.addedMemories[0].content.split(' ')[0], 'rhythm:task:Wednesday|evening');
});

test('max 2 new rhythm memories per run', () => {
  const fridayAfternoons = [
    { created_at: '2026-09-18T14:30:00-04:00' },
    { created_at: '2026-09-25T14:30:00-04:00' },
    { created_at: '2026-10-02T14:30:00-04:00' },
  ];
  const f = fakeDb({ setting: 'granted', conversations: sundayMornings, tasks: [...wednesdayEvenings, ...fridayAfternoons] });
  const res = applyActivityRhythmDetection(f.db, user, { nowMs: NOW, timeZone: TZ });
  assert.deepEqual(res, { gated: false, added: 2 });
  assert.equal(f.addedMemories.length, 2);
});
