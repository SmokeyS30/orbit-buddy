import test from 'node:test';
import assert from 'node:assert/strict';

import { canvasScore, isCanvasWorthy, canvasTitle, isCanvasCommand, findLatestCanvasMessage } from '../public/canvas.js';

const STUDY_PLAN = [
  '# CompTIA A+ Study Plan',
  '',
  '## Week 1 — Hardware',
  '',
  '- Motherboards and chipsets',
  '- RAM types and installation',
  '- Storage: SSD vs HDD vs NVMe',
  '- Power supplies and connectors',
  '- Peripherals and cables',
  '',
  '## Week 2 — Networking',
  '',
  '- OSI model layers',
  '- TCP/IP and subnetting',
  '- Wi-Fi standards',
  '- Network troubleshooting',
  '',
  '## Week 3 — Mobile and Printers',
  '',
  '- Laptop hardware',
  '- Mobile OS features',
  '- Printer types and maintenance',
  '',
  '## Practice schedule',
  '',
  '| Day | Focus | Questions |',
  '|---|---|---|',
  '| Mon | Hardware | 50 |',
  '| Wed | Networking | 50 |',
  '| Fri | Mixed review | 100 |',
  '',
  'Aim for 85%+ on practice exams before booking the real thing. '.repeat(20),
].join('\n');

test('isCanvasWorthy detects a substantial structured document', () => {
  assert.equal(isCanvasWorthy(STUDY_PLAN), true);
});

test('isCanvasWorthy rejects short messages', () => {
  assert.equal(isCanvasWorthy(STUDY_PLAN.slice(0, 400)), false);
  assert.equal(isCanvasWorthy('# Short\n\n- one\n- two'), false);
});

test('isCanvasWorthy rejects long unstructured prose', () => {
  assert.equal(isCanvasWorthy('Lorem ipsum dolor sit amet. '.repeat(120)), false);
});

test('isCanvasWorthy accepts a long table-heavy comparison', () => {
  const table = '# Phone comparison\n\n' + '| Phone | Price | Battery |\n|---|---|---|\n' +
    Array.from({ length: 12 }, (_, i) => `| Phone ${i} | $${500 + i * 50} | ${4000 + i * 100}mAh |`).join('\n') +
    '\n\nSome concluding thoughts about the comparison above. '.repeat(30);
  assert.equal(isCanvasWorthy(table), true);
});

test('canvasTitle uses the first heading', () => {
  assert.equal(canvasTitle(STUDY_PLAN), 'CompTIA A+ Study Plan');
});

test('canvasTitle falls back to the first real line', () => {
  assert.equal(canvasTitle('Just some text without headings.\nMore here.'), 'Just some text without headings.');
});

test('canvasTitle strips markdown markers', () => {
  assert.equal(canvasTitle('## **Bold** _Title_ `x`\n\nbody'), 'Bold Title x');
});

test('isCanvasCommand matches print/share invocations', () => {
  for (const cmd of ['print this', 'Print this!', 'print the document', 'pdf it', 'make a pdf of this', 'share this', 'share the plan']) {
    assert.equal(isCanvasCommand(cmd), true, JSON.stringify(cmd));
  }
});

test('isCanvasCommand rejects ordinary text', () => {
  for (const text of ['', 'print this song', 'share this photo', 'can you print', 'the printer is broken', 'print this and that']) {
    assert.equal(isCanvasCommand(text), false, JSON.stringify(text));
  }
});

test('findLatestCanvasMessage picks the newest canvas document', () => {
  const messages = [
    { id: 'a', role: 'user', content: 'hello' },
    { id: 'b', role: 'assistant', content: STUDY_PLAN },
    { id: 'c', role: 'user', content: 'thanks' },
    { id: 'd', role: 'assistant', content: 'You are welcome!' },
  ];
  const found = findLatestCanvasMessage(messages);
  assert.equal(found && found.id, 'b');
  assert.equal(found.title, 'CompTIA A+ Study Plan');
});

test('findLatestCanvasMessage returns null when there is no document', () => {
  assert.equal(findLatestCanvasMessage([{ role: 'assistant', content: 'hi' }]), null);
  assert.equal(findLatestCanvasMessage([]), null);
  assert.equal(findLatestCanvasMessage(null), null);
});

test('canvasScore exposes structure counts', () => {
  const s = canvasScore(STUDY_PLAN);
  assert.ok(s.headings >= 4, `headings ${s.headings}`);
  assert.equal(s.tables, 1);
  assert.ok(s.lists >= 10, `lists ${s.lists}`);
  assert.ok(s.length >= 1200, `length ${s.length}`);
});
