import test from 'node:test';
import assert from 'node:assert/strict';

test('parseSuggestMarkers extracts up to 2 suggestions', async () => {
  const server = await import('../server.js');
  const text = 'Nice chat.\n[SUGGEST_MEMORY: Edward prefers morning briefings with tomorrow preview]\n[SUGGEST_MEMORY: Edward is studying for CompTIA Security+]\n[SUGGEST_MEMORY: third one should be capped]';
  const out = server.parseSuggestMarkers(text);
  assert.equal(out.length, 2);
  assert.equal(out[0], 'Edward prefers morning briefings with tomorrow preview');
  assert.equal(out[1], 'Edward is studying for CompTIA Security+');
});

test('parseSuggestMarkers handles empty and marker-free text', async () => {
  const server = await import('../server.js');
  assert.deepEqual(server.parseSuggestMarkers('no markers here'), []);
  assert.deepEqual(server.parseSuggestMarkers(''), []);
  assert.deepEqual(server.parseSuggestMarkers(null), []);
});

test('stripModelMarkers removes model and citation marker types', async () => {
  const server = await import('../server.js');
  const text = 'See you then. \uE200cite\uE202turn0search0\uE201\n[SUGGEST_MEMORY: something to remember]\n[FOLLOWUP: call mom on 2026-10-10]';
  const stripped = server.stripModelMarkers(text);
  assert.ok(!stripped.includes('SUGGEST_MEMORY'), 'suggest marker removed');
  assert.ok(!stripped.includes('FOLLOWUP'), 'followup marker removed');
  assert.ok(!stripped.includes('turn0search0'), 'citation marker removed');
  assert.ok(stripped.includes('See you then.'), 'visible text kept');
});
