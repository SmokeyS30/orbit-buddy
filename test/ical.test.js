import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, expandEvents, zonedWallToUtcMs, wallPartsInZone, dayStartMs, DEFAULT_ZONE } from '../src/ical.js';

const ZONE = 'America/New_York';
const OCT = Date.UTC(2026, 9, 1);
const NOV = Date.UTC(2026, 10, 1);
const DEC = Date.UTC(2026, 11, 1);

test('parseIcs handles TZID events, folding, and escaped text', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:evt-1@example.com',
    'DTSTART;TZID=America/New_York:20261005T090000',
    'DTEND;TZID=America/New_York:20261005T100000',
    'SUMMARY:Team standup\\, weekly',
    'LOCATION:Room 3\\; Building A',
    'DESCRIPTION:Line one\\nLine two',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:evt-2@example.com',
    'DTSTART;VALUE=DATE:20261006',
    'SUMMARY:All-day',
    '  continued title',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const events = parseIcs(ics);
  assert.equal(events.length, 2);
  assert.equal(events[0].summary, 'Team standup, weekly');
  assert.equal(events[0].location, 'Room 3; Building A');
  assert.equal(events[0].description, 'Line one\nLine two');
  assert.deepEqual(events[0].dtstart, { allDay: false, y: 2026, mo: 10, d: 5, h: 9, mi: 0, s: 0, utc: false, tzid: 'America/New_York' });
  assert.ok(events[1].dtstart.allDay);
  assert.equal(events[1].summary, 'All-day continued title');
});

test('expandEvents keeps 9am local across the DST boundary', () => {
  const ics = [
    'BEGIN:VEVENT',
    'UID:standup@example.com',
    'DTSTART;TZID=America/New_York:20261005T090000',
    'DTEND;TZID=America/New_York:20261005T093000',
    'RRULE:FREQ=WEEKLY;COUNT=6',
    'SUMMARY:Standup',
    'END:VEVENT'
  ].join('\n');
  const events = expandEvents(parseIcs(ics), OCT, DEC, ZONE);
  assert.equal(events.length, 6);
  // Before Nov 1 (EDT, UTC-4): 9am = 13:00Z. After (EST, UTC-5): 9am = 14:00Z.
  const utcHours = events.map((e) => new Date(e.startMs).getUTCHours());
  assert.deepEqual(utcHours, [13, 13, 13, 13, 14, 14]);
  for (const e of events) {
    const wall = wallPartsInZone(e.startMs, ZONE);
    assert.equal(wall.h, 9);
    assert.equal(e.endMs - e.startMs, 30 * 60_000);
  }
});

test('expandEvents honors EXDATE', () => {
  const ics = [
    'BEGIN:VEVENT',
    'UID:daily@example.com',
    'DTSTART;TZID=America/New_York:20261005T120000',
    'DTEND;TZID=America/New_York:20261005T130000',
    'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE;TZID=America/New_York:20261006T120000',
    'SUMMARY:Lunch',
    'END:VEVENT'
  ].join('\n');
  const events = expandEvents(parseIcs(ics), OCT, NOV, ZONE);
  assert.equal(events.length, 2);
  const days = events.map((e) => wallPartsInZone(e.startMs, ZONE).d);
  assert.deepEqual(days, [5, 7]);
});

test('expandEvents applies RECURRENCE-ID overrides', () => {
  const ics = [
    'BEGIN:VEVENT',
    'UID:weekly@example.com',
    'DTSTART;TZID=America/New_York:20261005T090000',
    'DTEND;TZID=America/New_York:20261005T100000',
    'RRULE:FREQ=WEEKLY;COUNT=2',
    'SUMMARY:Class',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly@example.com',
    'RECURRENCE-ID;TZID=America/New_York:20261012T090000',
    'DTSTART;TZID=America/New_York:20261012T110000',
    'DTEND;TZID=America/New_York:20261012T120000',
    'SUMMARY:Class (moved)',
    'END:VEVENT'
  ].join('\n');
  const events = expandEvents(parseIcs(ics), OCT, NOV, ZONE);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, 'Class');
  assert.equal(events[1].title, 'Class (moved)');
  assert.equal(wallPartsInZone(events[1].startMs, ZONE).h, 11);
});

test('expandEvents skips cancelled events and handles UNTIL and durations', () => {
  const ics = [
    'BEGIN:VEVENT',
    'UID:gone@example.com',
    'DTSTART:20261005T120000Z',
    'STATUS:CANCELLED',
    'SUMMARY:Gone',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:gym@example.com',
    'DTSTART:20261005T170000Z',
    'DURATION:PT1H30M',
    'RRULE:FREQ=DAILY;UNTIL=20261007T235959Z',
    'SUMMARY:Gym',
    'END:VEVENT'
  ].join('\n');
  const events = expandEvents(parseIcs(ics), OCT, NOV, ZONE);
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.title === 'Gym'));
  assert.ok(events.every((e) => e.endMs - e.startMs === 90 * 60_000));
});

test('zonedWallToUtcMs converts wall times with the right offset', () => {
  // Oct 5 2026: EDT (UTC-4). Jan 5 2026: EST (UTC-5).
  assert.equal(zonedWallToUtcMs({ y: 2026, mo: 10, d: 5, h: 9, mi: 0, s: 0 }, ZONE), Date.UTC(2026, 9, 5, 13, 0, 0));
  assert.equal(zonedWallToUtcMs({ y: 2026, mo: 1, d: 5, h: 9, mi: 0, s: 0 }, ZONE), Date.UTC(2026, 0, 5, 14, 0, 0));
});

test('dayStartMs computes zone day boundaries', () => {
  assert.equal(dayStartMs('2026-10-05', 0, ZONE), Date.UTC(2026, 9, 5, 4, 0, 0));
  assert.equal(dayStartMs('2026-10-05', 1, ZONE), Date.UTC(2026, 9, 6, 4, 0, 0));
  assert.equal(dayStartMs('not-a-date', 0, ZONE), null);
  assert.ok(DEFAULT_ZONE);
});

test('read_calendar merges labelled events across feeds', async () => {
  const realFetch = global.fetch;
  const { executeTool } = await import('../src/tools.js');
  const { dropFeedCache } = await import('../src/ical.js');
  const icsSchool = [
    'BEGIN:VEVENT', 'UID:s1', 'DTSTART;TZID=America/New_York:20261005T090000',
    'DTEND;TZID=America/New_York:20261005T100000', 'SUMMARY:Class', 'END:VEVENT'
  ].join('\n');
  const icsPersonal = [
    'BEGIN:VEVENT', 'UID:p1', 'DTSTART:20261005T150000Z', 'DTEND:20261005T160000Z',
    'SUMMARY:Gym', 'END:VEVENT'
  ].join('\n');
  global.fetch = async (url, options) => {
    if (String(url).includes('example.com')) {
      return {
        ok: true,
        arrayBuffer: async () => Buffer.from(String(url).includes('school') ? icsSchool : icsPersonal)
      };
    }
    return realFetch(url, options);
  };
  try {
    const ctx = {
      userId: 'user-1',
      db: {
        listCalendarFeeds: () => [
          { id: 'feed-school', label: 'School', url: 'https://example.com/school.ics' },
          { id: 'feed-personal', label: 'Personal', url: 'https://example.com/personal.ics' }
        ]
      }
    };
    const { result } = await executeTool('read_calendar', { date: '2026-10-05', days: 1 }, {}, ctx);
    assert.equal(result.date, '2026-10-05');
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].calendar, 'School');
    assert.equal(result.events[0].title, 'Class');
    assert.equal(result.events[0].start, '2026-10-05T13:00:00.000Z');
    assert.equal(result.events[1].calendar, 'Personal');
    assert.equal(result.events[1].title, 'Gym');
  } finally {
    global.fetch = realFetch;
    dropFeedCache('feed-school');
    dropFeedCache('feed-personal');
  }
});

test('read_calendar needs context and reports no feeds', async () => {
  const { executeTool } = await import('../src/tools.js');
  await assert.rejects(() => executeTool('read_calendar', {}, {}, null), /not available in this context/);
  const { result } = await executeTool('read_calendar', { date: '2026-13-45' }, {}, { userId: 'u', db: { listCalendarFeeds: () => [] } });
  assert.deepEqual(result.events, []);
  assert.match(result.note, /No calendars are connected/);
});

async function serverFixture(extraEnv = {}) {
  const { createOrbitServer } = await import('../server.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ical-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-5.4-mini', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function registerUser(base, email = 'owner@example.com') {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, displayName: 'Owner', password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf };
}

const authHeaders = ({ cookie, csrf }) => ({ Cookie: cookie, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' });

test('calendar feed endpoints: add, list masked, reject bad feeds, delete', async (t) => {
  const realFetch = global.fetch;
  const { app, base } = await serverFixture(); t.after(() => { app.close(); global.fetch = realFetch; });
  const auth = await registerUser(base);
  const ics = ['BEGIN:VEVENT', 'UID:e1', 'DTSTART:20261005T120000Z', 'SUMMARY:Test', 'END:VEVENT'].join('\n');
  global.fetch = async (url, options) => {
    if (String(url).includes('example.com')) {
      return { ok: true, arrayBuffer: async () => Buffer.from(ics) };
    }
    return realFetch(url, options);
  };

  // add
  const addRes = await fetch(`${base}/api/calendar-feeds`, {
    method: 'POST', headers: authHeaders(auth),
    body: JSON.stringify({ label: 'School', url: 'https://example.com/feed.ics?secret=s3cr3t-token' })
  });
  assert.equal(addRes.status, 201);
  const added = await addRes.json();
  assert.equal(added.feed.label, 'School');
  assert.equal(added.eventsFound, 1);
  assert.ok(!added.feed.url.includes('s3cr3t-token'), 'full feed URL must never be exposed');

  // list via dedicated endpoint and via snapshot
  const list = await (await fetch(`${base}/api/calendar-feeds`, { headers: authHeaders(auth) })).json();
  assert.equal(list.feeds.length, 1);
  const snapshot = await (await fetch(`${base}/api/snapshot`, { headers: authHeaders(auth) })).json();
  assert.equal(snapshot.calendarFeeds.length, 1);
  assert.equal(snapshot.calendarFeeds[0].label, 'School');

  // reject non-calendar content
  global.fetch = async (url, options) => {
    if (String(url).includes('example.com')) {
      return { ok: true, arrayBuffer: async () => Buffer.from('hello world') };
    }
    return realFetch(url, options);
  };
  const badContent = await fetch(`${base}/api/calendar-feeds`, {
    method: 'POST', headers: authHeaders(auth),
    body: JSON.stringify({ label: 'Bad', url: 'https://example.com/not-ics' })
  });
  assert.equal(badContent.status, 400);

  // reject non-http URLs without any network access
  const badProto = await fetch(`${base}/api/calendar-feeds`, {
    method: 'POST', headers: authHeaders(auth),
    body: JSON.stringify({ label: 'Bad', url: 'ftp://example.com/feed.ics' })
  });
  assert.equal(badProto.status, 400);

  // delete
  const del = await fetch(`${base}/api/calendar-feeds/${added.feed.id}`, { method: 'DELETE', headers: authHeaders(auth) });
  assert.equal(del.status, 200);
  const after = await (await fetch(`${base}/api/calendar-feeds`, { headers: authHeaders(auth) })).json();
  assert.equal(after.feeds.length, 0);
  const delMissing = await fetch(`${base}/api/calendar-feeds/${added.feed.id}`, { method: 'DELETE', headers: authHeaders(auth) });
  assert.equal(delMissing.status, 404);
});

test('calendar feed endpoints require auth', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  assert.equal((await fetch(`${base}/api/calendar-feeds`)).status, 401);
  assert.equal((await fetch(`${base}/api/calendar-feeds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});

test('normalizeFeedUrl converts webcal schemes to https', async () => {
  const { normalizeFeedUrl } = await import('../src/ical.js');
  assert.equal(normalizeFeedUrl('webcal://example.com/cal.ics'), 'https://example.com/cal.ics');
  assert.equal(normalizeFeedUrl('webcals://example.com/cal.ics'), 'https://example.com/cal.ics');
  assert.equal(normalizeFeedUrl('WEBCAL://example.com/cal.ics'), 'https://example.com/cal.ics');
  assert.equal(normalizeFeedUrl('https://example.com/cal.ics'), 'https://example.com/cal.ics');
  assert.equal(normalizeFeedUrl('  webcal://example.com/cal.ics  '), 'https://example.com/cal.ics');
});
