import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// App Review guideline 2.1(b): the four in-app purchases must be locatable
// by a signed-in reviewer. Before this fix the membership chooser could
// only be opened from the quota paywall nudge — which never appears while
// subscription enforcement is off/fail-open — so the plans were
// unreachable in the reviewed build.
test('signed-in users can reach Plans from the Safety view without a quota error', () => {
  const safety = index.slice(index.indexOf('id="safety"'), index.indexOf('id="delete-account-panel"'));
  assert.ok(safety.includes('id="membership-panel"'), 'Safety view carries a Membership panel');
  assert.ok(safety.includes('id="view-plans-button"'), 'the panel has a View plans button');
  assert.match(app, /\$\('#view-plans-button'\)\?\.addEventListener\('click',\(\)=>openMembershipExperience\(\)\)/);
});

test('the membership chooser still lists all four preserved product IDs', () => {
  for (const id of [
    'com.smokeys30.orbitbuddy.basic.monthly',
    'com.smokeys30.orbitbuddy.standard.monthly',
    'com.smokeys30.orbitbuddy.standard.yearly',
    'com.smokeys30.orbitbuddy.pro.monthly',
  ]) assert.ok(app.includes(id), `${id} is in the client catalog`);
});
