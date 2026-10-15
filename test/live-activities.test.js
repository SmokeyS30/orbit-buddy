import test from 'node:test';
import assert from 'node:assert/strict';

import {
  liveActivitiesSupported,
  startVoiceActivity,
  endVoiceActivity,
  startTaskActivity,
  endTaskActivity,
} from '../public/live-activities.js';

// Outside the native iOS app (node here, web/Android in production) every
// entry point must no-op and never throw or reject.
test('live-activities helpers no-op without the native plugin', async () => {
  assert.equal(await startVoiceActivity(), null);
  assert.equal(await startVoiceActivity({ buddyName: 'Orbit' }), null);
  assert.equal(await endVoiceActivity(), null);
  assert.equal(await startTaskActivity({ title: 'Test task' }), null);
  assert.equal(await endTaskActivity(), null);
  assert.equal(await liveActivitiesSupported(), false);
});
