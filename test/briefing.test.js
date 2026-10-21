import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeatherText, buildTodayBriefing, getBriefingPhase, BRIEFING_PHASES } from '../src/briefing.js';

const WEATHER_TEXT = [
  'Weather for Brewster, Massachusetts:',
  'CURRENT: 54°F, Partly cloudy, wind 12 mph',
  '3-DAY FORECAST (share all 3 days with the user):',
  '  Mon: Partly cloudy, high 58°F / low 44°F',
  '  Tue: Rain, high 52°F / low 41°F',
  '  Wed: Clear, high 60°F / low 45°F',
].join('\n');

test('parseWeatherText structures the toolGetWeather format', () => {
  const w = parseWeatherText(WEATHER_TEXT);
  assert.equal(w.location, 'Brewster, Massachusetts');
  assert.deepEqual(w.current, { tempF: 54, condition: 'Partly cloudy', windMph: 12 });
  assert.equal(w.forecast.length, 3);
  assert.deepEqual(w.forecast[0], { day: 'Mon', condition: 'Partly cloudy', highF: 58, lowF: 44 });
  assert.deepEqual(w.forecast[2], { day: 'Wed', condition: 'Clear', highF: 60, lowF: 45 });
});

test('parseWeatherText returns null for unparseable text', () => {
  assert.equal(parseWeatherText(''), null);
  assert.equal(parseWeatherText('Weather for Nowhere:\nno data'), null);
  assert.equal(parseWeatherText(null), null);
});

function fakeDb() {
  return {
    getPreferences: () => ({ time_zone: 'America/New_York' }),
    listGoals: () => [
      { id: 'g1', title: 'Run a marathon', status: 'active', priority: 1, progress: 40, next_step: 'Run 5 miles', target_date: '2026-12-01' },
      { id: 'g2', title: 'Read 12 books', status: 'active', priority: 2, progress: 75, next_step: null, target_date: null },
      { id: 'g3', title: 'Finished goal', status: 'completed', priority: 1, progress: 100, next_step: null, target_date: null },
    ],
    getGoalStreak: () => 3,
    listPersonalDates: () => [
      { label: "Mom's birthday", month: 10, day: 20, year: 1965, type: 'birthday' },
      { label: 'Anniversary', month: 10, day: 12, year: 2010, type: 'anniversary' },
      { label: 'Far away', month: 3, day: 5, year: null, type: 'other' },
    ],
    listApprovals: () => [{ id: 'a1', title: 'Send email', kind: 'gmail_send', status: 'pending' }],
    listTasks: () => [{ id: 't1', title: 'Plan trip', status: 'waiting_approval' }],
    listFollowUps: () => [
      { id: 'f1', description: 'dentist', due_date: '2026-10-10' },
      { id: 'f2', description: 'call bank', due_date: '2026-10-20' },
    ],
    listCalendarFeeds: () => [],
  };
}

// Mon 2026-10-12 08:30 EDT
const NOW = Date.UTC(2026, 9, 12, 12, 30);
const reliability = { chat: { successRate: 100, successful: 5, failed: 0 }, recentFailures: [], pendingApprovals: 1 };

test('buildTodayBriefing assembles the morning page', async () => {
  const b = await buildTodayBriefing(fakeDb(), 'u1', {
    getWeather: async () => WEATHER_TEXT,
    nowMs: NOW,
    reliability,
  });
  assert.equal(b.date, '2026-10-12');
  assert.equal(b.greeting, 'Good morning');
  assert.match(b.dateLabel, /Monday, October 12/);
  assert.equal(b.weather.current.tempF, 54);
  assert.equal(b.weather.forecast.length, 3);
  assert.deepEqual(b.agenda, []);
  assert.equal(b.tomorrowCount, 0);
  // Focus: active goals only, priority order
  assert.equal(b.focusGoals.length, 2);
  assert.equal(b.focusGoals[0].title, 'Run a marathon');
  assert.equal(b.focusGoals[0].streak, 3);
  assert.equal(b.focusGoals[1].title, 'Read 12 books');
  // Anniversaries: today + within 14 days, not the far one
  assert.equal(b.anniversaries.length, 2);
  assert.equal(b.anniversaries[0].label, 'Anniversary');
  assert.equal(b.anniversaries[0].when, 'today');
  assert.equal(b.anniversaries[0].years, 16);
  assert.equal(b.anniversaries[1].label, "Mom's birthday");
  // Open loops: 1 approval + 1 waiting task + 1 due follow-up (f2 is past the 3-day horizon)
  assert.equal(b.openLoopCount, 3);
  assert.equal(b.openLoops.approvals[0].title, 'Send email');
  assert.equal(b.openLoops.waitingTasks[0].title, 'Plan trip');
  assert.equal(b.openLoops.followUps.length, 1);
  assert.equal(b.openLoops.followUps[0].description, 'dentist');
  assert.equal(b.openLoops.followUps[0].overdue, true);
  // Systems line: quiet when nothing failed
  assert.equal(b.systems.ok, true);
  assert.equal(b.systems.failureCount, 0);
});

test('buildTodayBriefing degrades gracefully when weather fails', async () => {
  const b = await buildTodayBriefing(fakeDb(), 'u1', {
    getWeather: async () => { throw new Error('no network'); },
    nowMs: NOW,
    reliability,
  });
  assert.equal(b.weather, null);
  assert.equal(b.focusGoals.length, 2); // rest of the briefing still builds
});

test('buildTodayBriefing flags recent failures for the systems line', async () => {
  const b = await buildTodayBriefing(fakeDb(), 'u1', {
    getWeather: async () => WEATHER_TEXT,
    nowMs: NOW,
    reliability: { ...reliability, recentFailures: [{ id: 'e1' }, { id: 'e2' }] },
  });
  assert.equal(b.systems.ok, false);
  assert.equal(b.systems.failureCount, 2);
});

test('resolveBriefingCoords validates and falls back to home', async () => {
  const { resolveBriefingCoords, HOME_COORDS } = await import('../src/briefing.js');
  assert.deepEqual(HOME_COORDS, { latitude: 41.76, longitude: -70.08 });
  assert.deepEqual(resolveBriefingCoords(42.36, -71.06), { latitude: 42.36, longitude: -71.06 });
  assert.deepEqual(resolveBriefingCoords('999', '0'), HOME_COORDS, 'out-of-range lat → home');
  assert.deepEqual(resolveBriefingCoords('abc', null), HOME_COORDS, 'garbage → home');
});

test('buildTodayBriefing passes coords to getWeather, home location when absent', async () => {
  const { buildTodayBriefing } = await import('../src/briefing.js');
  const seen = [];
  const b = await buildTodayBriefing(fakeDb(), 'u1', {
    getWeather: async (args) => { seen.push(args); return WEATHER_TEXT; },
    nowMs: NOW,
    coords: { latitude: 42.36, longitude: -71.06 },
  });
  assert.deepEqual(seen[0], { latitude: 42.36, longitude: -71.06 }, 'coords forwarded as numbers');
  assert.equal(b.weather.current.tempF, 54);

  seen.length = 0;
  const b2 = await buildTodayBriefing(fakeDb(), 'u1', {
    getWeather: async (args) => { seen.push(args); return WEATHER_TEXT; },
    nowMs: NOW,
  });
  assert.deepEqual(seen[0], { location: 'Brewster, MA' }, 'absent coords → home location');
  assert.equal(b2.weather.current.tempF, 54);

  seen.length = 0;
  await buildTodayBriefing(fakeDb(), 'u1', {
    getWeather: async (args) => { seen.push(args); return WEATHER_TEXT; },
    nowMs: NOW,
    coords: { latitude: 999, longitude: 0 },
  });
  assert.deepEqual(seen[0], { location: 'Brewster, MA' }, 'invalid coords → home location');
});

// ---------------------------------------------------------------------------
// Time-aware briefing phases (Edward's request 2026-10-14)
// ---------------------------------------------------------------------------

const ZONE = 'America/New_York';
const atEdt = (h, m = 0, day = 12) => new Date(Date.UTC(2026, 9, day, h + 4, m)); // EDT = UTC-4

test('BRIEFING_PHASES is the single source of boundaries', () => {
  assert.deepEqual(BRIEFING_PHASES.map((p) => p.id), ['morning', 'afternoon', 'evening']);
  assert.deepEqual(BRIEFING_PHASES.map((p) => p.startHour), [5, 12, 17]);
  assert.deepEqual(BRIEFING_PHASES.map((p) => p.tabLabel), ['Morning briefing', 'Afternoon check-in', 'Evening recap']);
});

test('getBriefingPhase follows clock boundaries (brief spec cases)', () => {
  assert.equal(getBriefingPhase(atEdt(9), null, ZONE).id, 'morning');
  assert.equal(getBriefingPhase(atEdt(12), null, ZONE).id, 'afternoon', '12pm boundary → afternoon');
  assert.equal(getBriefingPhase(atEdt(16, 59), null, ZONE).id, 'afternoon', '4:59pm → afternoon');
  assert.equal(getBriefingPhase(atEdt(17), null, ZONE).id, 'evening', '5pm boundary → evening');
  assert.equal(getBriefingPhase(new Date(Date.UTC(2026, 9, 13, 3, 0)), null, ZONE).id, 'evening', '11pm → evening');
});

test('getBriefingPhase wraps the small hours into the evening recap', () => {
  assert.equal(getBriefingPhase(atEdt(3), null, ZONE).id, 'evening', '3am → evening (probe expectation)');
  assert.equal(getBriefingPhase(atEdt(4, 59), null, ZONE).id, 'evening');
  assert.equal(getBriefingPhase(atEdt(5), null, ZONE).id, 'morning', '5am boundary → morning');
});

test('getBriefingPhase returns the warm tab label per phase', () => {
  assert.equal(getBriefingPhase(atEdt(9), null, ZONE).tabLabel, 'Morning briefing');
  assert.equal(getBriefingPhase(atEdt(14), null, ZONE).tabLabel, 'Afternoon check-in');
  assert.equal(getBriefingPhase(atEdt(20), null, ZONE).tabLabel, 'Evening recap');
});

test('getBriefingPhase honors a rhythm override (D4 seam)', () => {
  const rhythm = { morningStart: 7, afternoonStart: 13, eveningStart: 19 };
  assert.equal(getBriefingPhase(atEdt(6, 30), rhythm, ZONE).id, 'evening', 'personalized small hours → evening');
  assert.equal(getBriefingPhase(atEdt(8), rhythm, ZONE).id, 'morning');
  assert.equal(getBriefingPhase(atEdt(14), rhythm, ZONE).id, 'afternoon');
  assert.equal(getBriefingPhase(atEdt(18), rhythm, ZONE).id, 'afternoon');
  assert.equal(getBriefingPhase(atEdt(20), rhythm, ZONE).id, 'evening');
});

test('getBriefingPhase degrades sanely on garbage rhythm input', () => {
  assert.equal(getBriefingPhase(atEdt(9), { morningStart: 'x' }, ZONE).id, 'morning', 'non-numeric ignored');
  const reversed = getBriefingPhase(atEdt(9), { morningStart: 12, afternoonStart: 8 }, ZONE);
  assert.ok(['morning', 'afternoon', 'evening'].includes(reversed.id), 'unordered starts still resolve');
});

test('getBriefingPhase uses the user timezone, not the server clock', () => {
  const instant = new Date(Date.UTC(2026, 9, 12, 16, 30)); // 12:30 EDT / 9:30 PDT
  assert.equal(getBriefingPhase(instant, null, 'America/New_York').id, 'afternoon');
  assert.equal(getBriefingPhase(instant, null, 'America/Los_Angeles').id, 'morning');
});

test('getBriefingPhase works with no arguments', () => {
  const p = getBriefingPhase();
  assert.ok(['morning', 'afternoon', 'evening'].includes(p.id));
  assert.ok(typeof p.tabLabel === 'string' && p.tabLabel.length > 0);
});

test('buildTodayBriefing carries the phase on the payload', async () => {
  const morning = await buildTodayBriefing(fakeDb(), 'u1', { getWeather: async () => WEATHER_TEXT, nowMs: NOW });
  assert.deepEqual(morning.phase, { id: 'morning', tabLabel: 'Morning briefing' });
  const afternoon = await buildTodayBriefing(fakeDb(), 'u1', { getWeather: async () => WEATHER_TEXT, nowMs: Date.UTC(2026, 9, 12, 18, 0) });
  assert.deepEqual(afternoon.phase, { id: 'afternoon', tabLabel: 'Afternoon check-in' });
  const evening = await buildTodayBriefing(fakeDb(), 'u1', { getWeather: async () => WEATHER_TEXT, nowMs: Date.UTC(2026, 9, 12, 23, 0) });
  assert.deepEqual(evening.phase, { id: 'evening', tabLabel: 'Evening recap' });
});

test('buildTodayBriefing keeps tomorrow events and startMs for phase views', async () => {
  const { dropFeedCache } = await import('../src/ical.js');
  // HTTP is mocked; a public literal avoids an unrelated external DNS dependency.
  const realFetch = global.fetch;
  const ics = [
    'BEGIN:VEVENT', 'UID:today1', 'DTSTART;TZID=America/New_York:20261012T090000',
    'DTEND;TZID=America/New_York:20261012T100000', 'SUMMARY:Standup', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:tmr1', 'DTSTART;TZID=America/New_York:20261013T140000',
    'DTEND;TZID=America/New_York:20261013T150000', 'SUMMARY:Dentist', 'END:VEVENT',
  ].join('\n');
  global.fetch = async (url) => String(url) === 'https://93.184.216.34/cal.ics'
    ? { ok: true, arrayBuffer: async () => Buffer.from(ics) }
    : realFetch(url);
  const db = { ...fakeDb(), listCalendarFeeds: () => [{ id: 'f1', label: 'Cal', url: 'https://93.184.216.34/cal.ics' }] };
  try {
    const b = await buildTodayBriefing(db, 'u1', { getWeather: async () => WEATHER_TEXT, nowMs: NOW });
    assert.equal(b.agenda.length, 1);
    assert.equal(b.agenda[0].title, 'Standup');
    assert.ok(Number.isFinite(b.agenda[0].startMs), 'agenda items carry startMs for the afternoon split');
    assert.equal(b.tomorrowCount, 1);
    assert.equal(b.tomorrowAgenda.length, 1);
    assert.equal(b.tomorrowAgenda[0].title, 'Dentist');
    assert.ok(Number.isFinite(b.tomorrowAgenda[0].startMs));
  } finally {
    global.fetch = realFetch;
    dropFeedCache('f1');
  }
});
