import test from 'node:test';
import assert from 'node:assert/strict';

import { canvasScore, isCanvasWorthy, canvasTitle, isCanvasCommand, findLatestCanvasMessage, lineDiff } from '../public/canvas.js';

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

test('lineDiff marks added, removed and unchanged lines', () => {
  const oldText = 'line one\nline two\nline three';
  const newText = 'line one\nline TWO\nline four';
  const ops = lineDiff(oldText, newText);
  assert.deepEqual(ops[0], { type: 'same', text: 'line one' });
  assert.equal(ops.filter((o) => o.type === 'del').map((o) => o.text).join('\n'), 'line two\nline three');
  assert.equal(ops.filter((o) => o.type === 'add').map((o) => o.text).join('\n'), 'line TWO\nline four');
  assert.equal(ops.filter((o) => o.type !== 'add').map((o) => o.text).join('\n'), oldText);
  assert.equal(ops.filter((o) => o.type !== 'del').map((o) => o.text).join('\n'), newText);
});

test('lineDiff of identical texts is all unchanged', () => {
  const ops = lineDiff('a\nb', 'a\nb');
  assert.ok(ops.length === 2 && ops.every((o) => o.type === 'same'));
});

test('lineDiff handles empty inputs', () => {
  assert.deepEqual(lineDiff('', ''), [{ type: 'same', text: '' }]);
  assert.deepEqual(lineDiff('', 'x'), [{ type: 'del', text: '' }, { type: 'add', text: 'x' }]);
});

test('lineDiff reconstructs both sides from the op list', () => {
  const oldText = ['# Doc', '', '- one', '- two', '', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n');
  const newText = ['# Doc', '', '- one', '- THREE', '- four', '', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n');
  const ops = lineDiff(oldText, newText);
  assert.equal(ops.filter((o) => o.type !== 'add').map((o) => o.text).join('\n'), oldText);
  assert.equal(ops.filter((o) => o.type !== 'del').map((o) => o.text).join('\n'), newText);
  assert.ok(ops.some((o) => o.type === 'del' && o.text === '- two'));
  assert.ok(ops.some((o) => o.type === 'add' && o.text === '- THREE'));
});
