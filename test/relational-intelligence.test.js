import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMemorySafe,
  auditRelationalResponse,
  buildRelationalDirective,
  classifyRelationalTurn,
  isProactiveMemoryAllowed,
  memoryPrivacyDecision,
  shouldLoadEmotionalHistory,
  shouldLoadPlanningContext,
} from '../src/relational-intelligence.js';

test('relational classifier chooses a conservative support mode', () => {
  assert.deepEqual(classifyRelationalTurn('I did it! The build passed.'), { intent: 'celebration', supportMode: 'celebrate', cognitiveLoad: 'low' });
  assert.equal(classifyRelationalTurn('I need to vent. Nothing works.').supportMode, 'listen_then_offer');
  assert.equal(classifyRelationalTurn('Should I take the first option or the second?').supportMode, 'clarify_then_compare');
  assert.equal(classifyRelationalTurn('What port does HTTPS use?').supportMode, 'answer_first');
  assert.equal(classifyRelationalTurn('x '.repeat(500)).cognitiveLoad, 'high');
});

test('planning context loads only when the turn can use it', () => {
  assert.equal(shouldLoadPlanningContext({ message: 'What is the weather tomorrow?' }), false);
  assert.equal(shouldLoadPlanningContext({ message: 'How are you?' }), false);
  assert.equal(shouldLoadPlanningContext({ message: 'How are my projects going?' }), true);
  assert.equal(shouldLoadPlanningContext({ message: 'Help me decide which option to choose' }), true);
  assert.equal(shouldLoadPlanningContext({ message: 'I finished a milestone today!' }), true);
  assert.equal(shouldLoadPlanningContext({ message: 'Where do things stand?' }), true);
  assert.equal(shouldLoadPlanningContext({ message: 'What homework is next?' }), true);
});

test('emotional history is loaded for support and reflection, not routine information', () => {
  assert.equal(shouldLoadEmotionalHistory({ message: 'I am overwhelmed and having a rough day' }), true);
  assert.equal(shouldLoadEmotionalHistory({ message: 'What patterns have you noticed about me?' }), true);
  assert.equal(shouldLoadEmotionalHistory({ message: 'Explain how photosynthesis works' }), false);
});

test('relational directive includes continuity and commitments without claiming feelings', () => {
  const directive = buildRelationalDirective({
    message: 'Can you help me decide what to do about class?',
    memories: [{ kind: 'preference', content: 'Prefers one recommendation instead of a long menu.' }, { kind: 'relationship', content: 'Megan is a close friend.' }],
    commitments: [{ description: 'Finish the class worksheet', due_date: '2026-10-24' }],
  });
  assert.match(directive, /Primary intent: decision/);
  assert.match(directive, /Potential continuity cues/);
  assert.match(directive, /Finish the class worksheet/);
  assert.match(directive, /not what you feel/);
});

test('memory privacy rejects credentials and identity numbers but allows ordinary memories', () => {
  assert.equal(memoryPrivacyDecision('I prefer short answers.').allowed, true);
  assert.equal(memoryPrivacyDecision('I use a password manager.').allowed, true);
  assert.equal(memoryPrivacyDecision('My password is hunter22!').allowed, false);
  assert.equal(memoryPrivacyDecision('Verification code is 123456').allowed, false);
  assert.equal(memoryPrivacyDecision('Use sk-proj-1234567890abcdefghijkl').allowed, false);
  assert.equal(memoryPrivacyDecision('My SSN is 123-45-6789').allowed, false);
  assert.equal(memoryPrivacyDecision('Card 4111 1111 1111 1111').allowed, false);
  assert.throws(() => assertMemorySafe('Password: secret123'), /password manager/);
});

test('manual-only memories are explicitly excluded from proactive use', () => {
  assert.equal(isProactiveMemoryAllowed({ proactive_allowed: 1 }), true);
  assert.equal(isProactiveMemoryAllowed({ proactive_allowed: 0 }), false);
  assert.equal(isProactiveMemoryAllowed({}), true);
});

test('response audit detects feeling claims and near-duplicate replies', () => {
  assert.deepEqual(auditRelationalResponse({ response: 'I understand. Let us work through it together.' }), { passed: true, flags: [] });
  assert.deepEqual(auditRelationalResponse({ response: "I'm worried about you." }), { passed: false, flags: ['claimed_feeling'] });
  const repeated = 'Here is the plan we can use today with one clear next step and a careful check afterward.';
  const audit = auditRelationalResponse({ response: repeated, history: [{ role: 'assistant', content: repeated }] });
  assert.equal(audit.passed, false);
  assert.ok(audit.flags.includes('near_duplicate'));
});

