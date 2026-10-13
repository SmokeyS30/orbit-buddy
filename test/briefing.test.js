import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeatherText, buildTodayBriefing } from '../src/briefing.js';

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
