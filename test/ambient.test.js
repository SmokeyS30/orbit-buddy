import test from 'node:test';
import assert from 'node:assert/strict';

import {
  timeBucket, weekdayInZone, hourInZone, dayInZone, extractPlaceLabel,
  ambientSnapshot, ambientMemoryContent, parseAmbientMemory,
  detectRhythms, rhythmSentence, rhythmKey,
} from '../src/ambient.js';

test('timeBucket buckets hours', () => {
  assert.equal(timeBucket(6), 'morning');
  assert.equal(timeBucket(11), 'morning');
  assert.equal(timeBucket(12), 'afternoon');
  assert.equal(timeBucket(16), 'afternoon');
  assert.equal(timeBucket(18), 'evening');
  assert.equal(timeBucket(21), 'evening');
  assert.equal(timeBucket(23), 'night');
  assert.equal(timeBucket(2), 'night');
});

test('zone helpers agree on a known timestamp', () => {
  // 2026-10-12 20:00 EDT = Monday evening in America/New_York
  const ms = new Date('2026-10-13T00:00:00Z').valueOf();
  assert.equal(weekdayInZone(ms, 'America/New_York'), 'Monday');
  assert.equal(hourInZone(ms, 'America/New_York'), 20);
  assert.equal(timeBucket(hourInZone(ms, 'America/New_York')), 'evening');
  assert.equal(dayInZone(ms, 'America/New_York'), '2026-10-12');
});

test('extractPlaceLabel catches explicit self-location', () => {
  assert.equal(extractPlaceLabel("I'm at the cabin"), 'the cabin');
  assert.equal(extractPlaceLabel("I'm in Boston for the weekend"), 'boston for the weekend'.slice(0, 40).split(/\s+/).slice(0, 4).join(' '));
  assert.equal(extractPlaceLabel('on the train, heading home'), 'the train');
  assert.equal(extractPlaceLabel('working at the office today, call me'), 'the office');
});

test('extractPlaceLabel rejects non-location "at" phrases', () => {
  assert.equal(extractPlaceLabel("I'm at a loss for words"), null);
  assert.equal(extractPlaceLabel('look at the cabin photos'), null);
  assert.equal(extractPlaceLabel('the meeting is at the office'), null);
  assert.equal(extractPlaceLabel('remind me at 5 to call mom'), null);
  assert.equal(extractPlaceLabel('at the end of the day, it works'), null);
  assert.equal(extractPlaceLabel('hello there'), null);
  assert.equal(extractPlaceLabel(''), null);
});

test('ambientSnapshot combines clock and place', () => {
  const ms = new Date('2026-10-13T00:00:00Z').valueOf();
  const s = ambientSnapshot({ message: "I'm at the cabin", nowMs: ms, timeZone: 'America/New_York' });
  assert.deepEqual(s, { weekday: 'Monday', bucket: 'evening', place: 'the cabin', day: '2026-10-12' });
});

test('ambient memory content round-trips through the parser', () => {
  const content = ambientMemoryContent({ weekday: 'Sunday', bucket: 'morning', place: 'the cabin' });
  assert.match(content, /^Ambient context \[Sunday\|morning\|the cabin\]:/);
  assert.deepEqual(parseAmbientMemory(content), { weekday: 'Sunday', bucket: 'morning', place: 'the cabin' });
  const noPlace = ambientMemoryContent({ weekday: 'Sunday', bucket: 'morning', place: null });
  assert.deepEqual(parseAmbientMemory(noPlace), { weekday: 'Sunday', bucket: 'morning', place: null });
  assert.equal(parseAmbientMemory('just a normal memory'), null);
});

test('detectRhythms needs 3+ distinct days', () => {
  const obs = [
    { weekday: 'Sunday', bucket: 'morning', place: null, day: '2026-10-04' },
    { weekday: 'Sunday', bucket: 'morning', place: null, day: '2026-10-11' },
    { weekday: 'Sunday', bucket: 'morning', place: null, day: '2026-10-18' },
    { weekday: 'Sunday', bucket: 'morning', place: null, day: '2026-10-18' }, // same day twice
    { weekday: 'Monday', bucket: 'evening', place: 'the cabin', day: '2026-10-05' },
    { weekday: 'Monday', bucket: 'evening', place: 'the cabin', day: '2026-10-12' },
  ];
  const rhythms = detectRhythms(obs);
  assert.equal(rhythms.length, 1);
  assert.equal(rhythms[0].weekday, 'Sunday');
  assert.equal(rhythms[0].count, 3);
  assert.match(rhythmSentence(rhythms[0]), /Sunday mornings/);
  assert.equal(rhythmKey(rhythms[0]), 'rhythm:Sunday|morning|');
});

test('detectRhythms separates places', () => {
  const obs = [
    { weekday: 'Friday', bucket: 'evening', place: 'the cabin', day: '2026-10-02' },
    { weekday: 'Friday', bucket: 'evening', place: 'the cabin', day: '2026-10-09' },
    { weekday: 'Friday', bucket: 'evening', place: 'the cabin', day: '2026-10-16' },
    { weekday: 'Friday', bucket: 'evening', place: null, day: '2026-10-23' },
    { weekday: 'Friday', bucket: 'evening', place: null, day: '2026-10-30' },
    { weekday: 'Friday', bucket: 'evening', place: null, day: '2026-11-06' },
  ];
  const rhythms = detectRhythms(obs);
  assert.equal(rhythms.length, 2);
});
