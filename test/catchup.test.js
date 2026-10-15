// "Catch me up" digest tests: migrations, last-app-open tracking,
// seen/dismissed item keys, the digest builder, and the chat tool end-to-end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import {
  buildCatchupDigest,
  isAwayEnough,
  clampSinceMs,
  catchupIcon,
  CATCHUP_AWAY_MS,
  PROACTIVE_SENT_TYPES,
} from '../src/catchup.js';
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.js';

const ZONE = 'America/New_York';

function freshDb() {
  const db = openDatabase(':memory:');
  const user = db.createUser({
    email: 'catchup@test.local',
    displayName: 'Catchup Tester',
    passwordHash: 'h',
    passwordSalt: 's',
    role: 'owner',
  });
  return { db, userId: user.id };
}

function isoHoursAgo(h, base = Date.now()) {
  return new Date(base - h * 3600_000).toISOString();
}

test('migrations: catchup_seen table + proactive_state.last_app_open_at exist', () => {
  const { db, userId } = freshDb();
  assert.equal(db.getLastAppOpen(userId), null);
  db.setLastAppOpen(userId, '2026-10-15T10:00:00.000Z');
  assert.equal(db.getLastAppOpen(userId), '2026-10-15T10:00:00.000Z');
  db.setLastAppOpen(userId, '2026-10-15T12:00:00.000Z');
  assert.equal(db.getLastAppOpen(userId), '2026-10-15T12:00:00.000Z');
  assert.deepEqual(db.listCatchupSeenKeys(userId), []);
});

test('isAwayEnough: 6h gate, pure', () => {
  const now = Date.now();
  assert.equal(isAwayEnough(now - CATCHUP_AWAY_MS, now), true);
  assert.equal(isAwayEnough(now - CATCHUP_AWAY_MS + 1, now), false);
  assert.equal(isAwayEnough(now - 7 * 3600_000, now), true);
  assert.equal(isAwayEnough(null, now), false);
  assert.equal(isAwayEnough(NaN, now), false);
});

test('clampSinceMs: bounds to [now-30d, now], null on garbage', () => {
  const now = Date.now();
  assert.equal(clampSinceMs(now - 1000, now), now - 1000);
  assert.equal(clampSinceMs(now - 40 * 86400_000, now), now - 30 * 86400_000);
  assert.equal(clampSinceMs(now + 5000, now), now);
  assert.equal(clampSinceMs(NaN, now), null);
  assert.equal(clampSinceMs('nope', now), null);
});

test('markCatchupSeen / dismissCatchupItems: keys never reappear', () => {
  const { db, userId } = freshDb();
  db.markCatchupSeen(userId, ['evt:1', 'evt:2', 'evt:1']); // dupes collapse
  assert.deepEqual(db.listCatchupSeenKeys(userId).sort(), ['evt:1', 'evt:2']);
  // Re-marking a seen key is a no-op (dismissed_at stays null).
  db.markCatchupSeen(userId, ['evt:1']);
  assert.deepEqual(db.listCatchupSeenKeys(userId).sort(), ['evt:1', 'evt:2']);
  const n = db.dismissCatchupItems(userId, ['evt:2', 'evt:3']);
  assert.equal(n, 2);
  assert.deepEqual(db.listCatchupSeenKeys(userId).sort(), ['evt:1', 'evt:2', 'evt:3']);
  // Dismiss is idempotent.
  assert.equal(db.dismissCatchupItems(userId, ['evt:2']), 1);
});

test('listCatchupEvents: proactive + calendar types since, newest first', () => {
  const { db, userId } = freshDb();
  const e1 = db.addEvent(userId, 'smart_checkin_sent', 'Sent smart check-in.');
  db.addEvent(userId, 'calendar_feed_added', 'Connected calendar "School".');
  db.addEvent(userId, 'task_approved', 'Approved something.'); // not a digest type
  const sinceWide = isoHoursAgo(1);
  const rows = db.listCatchupEvents(userId, sinceWide, 60);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => [...PROACTIVE_SENT_TYPES, 'calendar_feed_added', 'calendar_feed_removed'].includes(r.type)));
  assert.ok(rows[0].created_at >= rows[1].created_at, 'newest first');
  // Narrow window after the events excludes everything.
  const sinceAfter = new Date(Date.now() + 60_000).toISOString();
  assert.equal(db.listCatchupEvents(userId, sinceAfter, 60).length, 0);
  assert.ok(e1.id);
});

test('digest: missed check-ins + calendar changes, newest first, no dupes', async () => {
  const { db, userId } = freshDb();
  const now = Date.now();
  db.addEvent(userId, 'quiet_nudge_sent', 'Sent a quiet check-in nudge.');
  db.addEvent(userId, 'calendar_feed_removed', 'Removed a calendar feed.');
  const digest = await buildCatchupDigest(db, userId, { sinceMs: now - 8 * 3600_000, nowMs: now, timeZone: ZONE });
  const kinds = digest.items.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['calendar', 'checkin']);
  const missed = digest.items.filter((i) => i.section === 'missed');
  assert.ok(missed.length >= 2);
  for (let i = 1; i < missed.length; i++) {
    assert.ok(missed[i - 1].at >= missed[i].at, 'missed items newest first');
  }
  for (const item of digest.items) {
    assert.ok(item.key && item.title && item.at, 'item shape');
  }
  // Window starting after the events were created → empty digest
  // (no tasks/feeds/radar seeded here).
  const empty = await buildCatchupDigest(db, userId, { sinceMs: Date.now(), nowMs: Date.now(), timeZone: ZONE });
  assert.equal(empty.items.filter((i) => i.section === 'missed').length, 0);
});

test('digest: radar findings exclude delivered check-ins; unrecovered CI summarized', async () => {
  const { db, userId } = freshDb();
  const now = Date.now();
  const foundAt = isoHoursAgo(7, now);
  db.storeRadarFinding({
    key: 'gh:smokeys30/orbit-buddy:run:111', repo: 'SmokeyS30/orbit-buddy',
    kind: 'run', signal: 'high', title: 'CI failed on main', foundAt,
    workflow: 'CI', branch: 'main', url: 'https://github.com/x/111',
  });
  db.storeRadarFinding({
    key: 'gh:smokeys30/orbit-buddy:run:112', repo: 'SmokeyS30/orbit-buddy',
    kind: 'run', signal: 'high', title: 'CI failed again on main', foundAt: isoHoursAgo(6, now),
    workflow: 'CI', branch: 'main', url: 'https://github.com/x/112',
  });
  db.storeRadarFinding({
    key: 'gh:smokeys30/orbit-buddy:alert:9', repo: 'SmokeyS30/orbit-buddy',
    kind: 'alert', signal: 'low', title: 'Dependabot: lodash update', foundAt,
  });
  // The alert already arrived as a check-in → digest must not repeat it.
  db.markRadarFindingDelivered('gh:smokeys30/orbit-buddy:alert:9', userId);

  const digest = await buildCatchupDigest(db, userId, { sinceMs: now - 8 * 3600_000, nowMs: now, timeZone: ZONE });
  const radarItems = digest.items.filter((i) => i.kind === 'radar');
  assert.equal(radarItems.length, 2, 'only undelivered findings');
  assert.ok(radarItems.every((i) => i.key.startsWith('radar:gh:')));
  assert.ok(!digest.items.some((i) => i.key.includes('alert:9')), 'delivered finding excluded');

  const ciItems = digest.items.filter((i) => i.kind === 'ci');
  assert.equal(ciItems.length, 1, 'one unrecovered workflow summarized once');
  assert.match(ciItems[0].title, /Still failing: CI on main/);
  assert.equal(ciItems[0].url, 'https://github.com/x/112', 'links the latest failure');

  // A recovery silences the CI item.
  db.storeRadarFinding({
    key: 'gh:smokeys30/orbit-buddy:run:113:recovered', repo: 'SmokeyS30/orbit-buddy',
    kind: 'run', signal: 'low', title: 'CI recovered on main', foundAt: isoHoursAgo(1, now),
    workflow: 'CI', branch: 'main',
  });
  const after = await buildCatchupDigest(db, userId, { sinceMs: now - 8 * 3600_000, nowMs: now, timeZone: ZONE });
  assert.equal(after.items.filter((i) => i.kind === 'ci').length, 0, 'recovered failure drops out');
});

test('digest: tasks due today/tomorrow appear under upcoming; seen items vanish', async () => {
  const { db, userId } = freshDb();
  const now = Date.now();
  const tomorrowNoon = new Date(now + 20 * 3600_000).toISOString();
  const nextWeek = new Date(now + 8 * 86400_000).toISOString();
  const due = db.addTask(userId, { title: 'File DTA paperwork', prompt: 'p', scheduleAt: tomorrowNoon });
  db.addTask(userId, { title: 'Someday task', prompt: 'p', scheduleAt: nextWeek });
  const done = db.addTask(userId, { title: 'Done task', prompt: 'p', scheduleAt: tomorrowNoon });
  db.setTaskStatus(userId, done.id, 'completed');

  const digest = await buildCatchupDigest(db, userId, { sinceMs: now - 8 * 3600_000, nowMs: now, timeZone: ZONE });
  const tasks = digest.items.filter((i) => i.kind === 'task');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].key, `task:${due.id}`);
  assert.equal(tasks[0].section, 'upcoming');
  assert.deepEqual(tasks[0].deepLink, { view: 'tasks' });

  // Mark seen → gone from the next digest.
  db.markCatchupSeen(userId, digest.items.map((i) => i.key));
  const again = await buildCatchupDigest(db, userId, { sinceMs: now - 8 * 3600_000, nowMs: now, timeZone: ZONE });
  assert.equal(again.items.length, 0, 'seen items never reappear');
});

test('digest: dismissed items never reappear; deep-links present', async () => {
  const { db, userId } = freshDb();
  const now = Date.now();
  db.addEvent(userId, 'smart_checkin_sent', 'Sent smart check-in.');
  const digest = await buildCatchupDigest(db, userId, { sinceMs: now - 8 * 3600_000, nowMs: now, timeZone: ZONE });
  assert.ok(digest.items.length > 0);
  const checkin = digest.items.find((i) => i.kind === 'checkin');
  assert.deepEqual(checkin.deepLink, { view: 'today' });
  db.dismissCatchupItems(userId, digest.items.map((i) => i.key));
  const again = await buildCatchupDigest(db, userId, { sinceMs: now - 8 * 3600_000, nowMs: now, timeZone: ZONE });
  assert.equal(again.items.length, 0, 'dismissed items never reappear');
});

test('catchupIcon covers kinds', () => {
  for (const kind of ['checkin', 'radar', 'ci', 'calendar', 'agenda', 'task']) {
    assert.ok(catchupIcon(kind).length > 0, kind);
  }
  assert.equal(catchupIcon('nope'), '•');
});

test('catch_me_up tool: definition, execution, marks items seen', async () => {
  const def = TOOL_DEFINITIONS.find((d) => d.name === 'catch_me_up');
  assert.ok(def, 'tool defined');
  assert.match(def.description, /catch me up/i);

  const { db, userId } = freshDb();
  const ctx = { db, userId, timeZone: ZONE };
  db.addEvent(userId, 'smart_checkin_sent', 'Sent smart check-in.');
  db.setLastAppOpen(userId, isoHoursAgo(8));

  const { result, summary } = await executeTool('catch_me_up', {}, {}, ctx);
  assert.equal(result.empty, false);
  assert.ok(result.items.length > 0, 'items returned');
  assert.match(summary, /Catch-up digest/);
  assert.ok(result.items.every((i) => i.key && i.kind && i.title && i.at));

  // Second call: the first call marked everything seen → empty.
  const second = await executeTool('catch_me_up', {}, {}, ctx);
  assert.equal(second.result.empty, true);
  assert.deepEqual(second.result.items, []);
});

test('catch_me_up tool: empty digest when nothing new', async () => {
  const { db, userId } = freshDb();
  const ctx = { db, userId, timeZone: ZONE };
  db.setLastAppOpen(userId, isoHoursAgo(8));
  const { result } = await executeTool('catch_me_up', {}, {}, ctx);
  assert.equal(result.empty, true);
  assert.deepEqual(result.items, []);
});
