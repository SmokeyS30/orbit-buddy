import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const desktop = fs.readFileSync(new URL('../public/desktop.css', import.meta.url), 'utf8');
const mobile = fs.readFileSync(new URL('../public/mobile.css', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const chatScroll = fs.readFileSync(new URL('../public/chat-scroll.js', import.meta.url), 'utf8');

// The desk-mode block is appended after the stage-1 tier in desktop.css;
// everything from its media query onward is the desk surface (plus the
// small print guard that restores the stacked layout for print).
const deskStart = desktop.indexOf('@media(min-width:761px){');
const desk = deskStart >= 0 ? desktop.slice(deskStart) : '';
const beforeDesk = deskStart >= 0 ? desktop.slice(0, deskStart) : desktop;

test('desk mode activates at the 761px cutover, exactly once, unbounded above', () => {
  assert.ok(deskStart >= 0, 'desk-mode media query missing from desktop.css');
  assert.equal(desktop.split('@media(min-width:761px){').length - 1, 1);
  // No desk rules anywhere before the block, so nothing can leak into
  // the phone tier or apply at stacked widths.
  assert.ok(!beforeDesk.includes('#today.view.active'), 'desk grid must not exist before its media query');
  assert.ok(!beforeDesk.includes('grid-area:desk'), 'desk placement must not exist before its media query');
  // The desk surface is width-driven only: no max-width cap in the block
  // (the unfolded Duo CSS width is unverified and may land >=1024px).
  const deskBlock = desk.slice(0, desk.indexOf('@media print'));
  assert.ok(!deskBlock.includes('max-width'), 'desk block must not be width-capped');
});

test('desk layout puts the existing briefing surface beside the chat', () => {
  // Two-column grid on the active Today view only: hero across the top,
  // briefing column ("desk") beside the conversation panel ("chat").
  assert.match(desk, /#today\.view\.active\{display:grid;grid-template-columns:minmax\(300px,400px\) minmax\(0,1fr\);grid-template-areas:"hero hero" "desk chat"/);
  assert.match(desk, /#today>\.hero-card\{grid-area:hero\}/);
  assert.match(desk, /#today>\.conversation-panel\{grid-area:chat\}/);
  // The briefing becomes a glanceable, independently scrolling column
  // whose cards stack in a single column.
  assert.match(desk, /#today>#today-briefing\{grid-area:desk;max-height:calc\(100dvh - 150px\);overflow-y:auto/);
  assert.match(desk, /#today-briefing \.briefing-grid\{grid-template-columns:1fr\}/);
  // DOM order in index.html is what makes CSS-only placement possible:
  // hero, then #today-briefing, then the conversation panel, all direct
  // children of the Today view.
  const todayStart = index.indexOf('<section id="today"');
  const heroAt = index.indexOf('hero-card', todayStart);
  const briefingAt = index.indexOf('id="today-briefing"', todayStart);
  const chatAt = index.indexOf('conversation-panel', todayStart);
  assert.ok(todayStart >= 0 && heroAt > todayStart && briefingAt > heroAt && chatAt > briefingAt,
    'Today view DOM order changed; desk placement assumes hero < briefing < chat');
});

test('phone tier is untouched by desk mode', () => {
  assert.match(mobile, /@media\(max-width:760px\)/);
  assert.match(mobile, /@media\(max-width:380px\)/);
  assert.ok(!mobile.includes('#today'), 'mobile.css must not gain desk rules');
  assert.ok(!mobile.includes('grid-area'), 'mobile.css must not gain desk placement');
  // Views still hide/show the same way below the cutover.
  assert.match(styles, /\.view\{display:none\}\.view\.active\{display:block/);
});

test('chat stays bottom-anchored and the message composer is untouched', () => {
  // Desk mode is placement only: it must not restack the message column,
  // reorder or resize the composer, or change message scrolling.
  assert.ok(!desk.includes('.messages'), 'desk block must not touch the message list');
  assert.ok(!desk.includes('.composer'), 'desk block must not touch the composer');
  assert.ok(!desk.includes('flex-direction'), 'desk block must not change flex direction');
  assert.match(styles, /\.messages\{display:flex;flex-direction:column/);
  assert.match(chatScroll, /container\.scrollTop = Math\.max\(0, container\.scrollHeight - container\.clientHeight\)/);
});

test('desk mode is automatic and read-only: no new controls, fetches, or writes', () => {
  // Edward's UI-minimalism rule: no toggle, button, or setting was added
  // anywhere for desk mode — it is CSS placement of existing DOM.
  assert.ok(!index.includes('desk-mode') && !index.includes('id="desk') && !index.includes('class="desk'),
    'index.html must not gain desk-mode markup or controls');
  assert.ok(!appJs.includes('desk-mode') && !appJs.includes('deskMode'), 'app.js must not gain desk-mode logic');
  assert.ok(!fs.existsSync(new URL('../public/desk-mode.js', import.meta.url)), 'no new desk-mode script file');
  // The new CSS performs no network or write activity of its own.
  assert.ok(!desk.includes('url('), 'desk CSS must not load external resources');
  // The only data the panel shows still comes through the pre-existing
  // read paths in app.js — no new endpoints were introduced for it.
  assert.match(appJs, /api\('\/api\/today-briefing'\+qs\)/);
  assert.match(appJs, /api\('\/api\/catchup-digest\?since='/);
  // Calendar rendering in the panel is the briefing agenda (read-only):
  // the client calendar write path stays in approvals, unchanged.
  assert.match(appJs, /function buildAgendaCard\(data,section\)/);
  assert.match(appJs, /for\(const e of events\)card\.append\(agendaRow\(e\)\)/);
});

test('desk panel reuses the existing briefing and check-in surfaces', () => {
  // Briefing (incl. today's calendar agenda) renders into #today-briefing.
  assert.match(appJs, /function renderBriefing\(data\)\{\s*const root=\$\('#today-briefing'\)/);
  // Orbit's check-ins surface client-side as the "While you were away"
  // catch-up card, which also renders into #today-briefing — so it lands
  // in the desk column automatically, with its check-in items intact.
  assert.match(appJs, /function renderCatchupCard\(items\)\{\s*const root=\$\('#today-briefing'\)/);
  assert.match(appJs, /checkin:'💬'/);
  assert.ok(index.includes('id="today-briefing"'), 'briefing mount point missing from index.html');
});

test('print keeps the stacked layout', () => {
  assert.match(desk, /@media print\{\s*#today\.view\.active\{display:block\}/);
  assert.match(desk, /#today>#today-briefing\{max-height:none;overflow:visible/);
});
