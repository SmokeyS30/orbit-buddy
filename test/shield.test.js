import test from 'node:test';
import assert from 'node:assert/strict';
import { assessShieldEvent, incidentKeyFor } from '../src/shield.js';

const base = {
  installation: { id: 91, account: { login: 'octo' } },
  repository: { id: 55, full_name: 'octo/demo' },
  sender: { login: 'SensitiveActorName' }
};

test('creates a privacy-minimized critical incident for a writable deploy key', () => {
  const result = assessShieldEvent({ eventName: 'deploy_key', action: 'created', payload: { ...base, key: { id: 7, read_only: false } }, repository: base.repository, deliveryId: 'delivery-123456' });
  assert.equal(result.severity, 'critical');
  assert.equal(result.incident.score, 80);
  assert.equal(result.incident.signals.includes('writable-deploy-key-created'), true);
  assert.equal(result.incident.actorHash.length, 16);
  assert.equal(JSON.stringify(result.incident).includes('SensitiveActorName'), false);
});

test('escalates correlated urgent changes without claiming attacker intent', () => {
  const received_at = new Date(Date.now() - 60_000).toISOString();
  const result = assessShieldEvent({ eventName: 'branch_protection_rule', action: 'deleted', payload: base, repository: base.repository, deliveryId: 'delivery-654321', recentEvents: [
    { risk: 'high', received_at }, { risk: 'critical', received_at }
  ] });
  assert.equal(result.severity, 'high');
  assert.equal(result.incident.signals.includes('urgent-event-burst'), true);
  assert.match(result.incident.evidence, /confirm intent in GitHub/i);
});

test('keeps an ordinary push below incident threshold', () => {
  const result = assessShieldEvent({ eventName: 'push', action: null, payload: base, repository: base.repository, deliveryId: 'delivery-ordinary' });
  assert.equal(result.severity, 'info');
  assert.equal(result.incident, null);
});

test('detects an admin collaborator from the permission change', () => {
  const payload = { ...base, member: { login: 'newadmin' }, changes: { permission: { from: 'write', to: 'admin' } } };
  const result = assessShieldEvent({ eventName: 'member', action: 'added', payload, repository: base.repository, deliveryId: 'delivery-admin-1' });
  assert.equal(result.incident.signals.includes('admin-collaborator-added'), true);
  assert.equal(result.incident.score, 60);
});

test('detects a regular collaborator without admin permission', () => {
  const payload = { ...base, member: { login: 'newmember' } };
  const result = assessShieldEvent({ eventName: 'member', action: 'added', payload, repository: base.repository, deliveryId: 'delivery-member-1' });
  assert.equal(result.incident.signals.includes('collaborator-added'), true);
  assert.equal(result.incident.score, 35);
});

test('incident key is stable with a delivery id and unique without one', () => {
  const args = { eventName: 'push', action: null, target: 'octo/demo', deliveryId: 'delivery-xyz', now: new Date('2026-10-01T00:00:00.000Z') };
  assert.equal(incidentKeyFor(args), incidentKeyFor(args));
  const noId = { ...args, deliveryId: undefined };
  assert.notEqual(incidentKeyFor(noId), incidentKeyFor(noId));
  assert.match(incidentKeyFor(args), /^shield:[0-9a-f]{64}$/);
});
