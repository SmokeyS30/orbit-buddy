import assert from 'node:assert/strict';

// Legacy AI behavior tests explicitly choose to allow sharing. Consent tests
// leave new accounts unconsented to exercise the actual default.
export async function allowAiSharing(base, {cookie,csrf}) {
  const response=await fetch(`${base}/api/ai-sharing-consent`,{
    method:'POST',
    headers:{Cookie:cookie,'X-Orbit-CSRF':csrf,'Content-Type':'application/json'},
    body:'{"accepted":true}'
  });
  assert.equal(response.status,200,'synthetic account opted into AI for this test');
}
