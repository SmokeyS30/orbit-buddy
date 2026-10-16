import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// W7 code-split: voice-mode.js and canvas.js must load on first use, not on
// page load. These tests pin the loading strategy in public/app.js.

const appSrc = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('app.js has no static imports of voice-mode.js or canvas.js', () => {
  for (const chunk of ['voice-mode.js', 'canvas.js']) {
    const staticImport = new RegExp(
      `^\\s*import\\b[^;]*from\\s*['"]\\./${chunk.replace('.', '\\.')}[ '"]`,
      'm'
    );
    assert.ok(
      !staticImport.test(appSrc),
      `app.js must not statically import ./${chunk}`
    );
  }
});

test('app.js lazily loads both chunks via memoized dynamic import()', () => {
  for (const [loader, chunk] of [
    ['loadVoiceMode', './voice-mode.js'],
    ['loadCanvas', './canvas.js'],
  ]) {
    const escaped = chunk.replace('.', '\\.').replace('/', '\\/');
    assert.match(
      appSrc,
      new RegExp(`function ${loader}\\(\\)`),
      `${loader} loader must exist`
    );
    assert.match(
      appSrc,
      new RegExp(`import\\(['"]${escaped}['"]\\)`),
      `${loader} must dynamic-import('${chunk}')`
    );
  }
  // Memoization: a failed load resets the memo so the next attempt retries
  // (offline first-use must not poison the loader forever).
  assert.match(
    appSrc,
    /voiceModeModulePromise=null;throw err/,
    'voice loader must reset its memo on failure'
  );
  assert.match(
    appSrc,
    /canvasModulePromise=null;throw err/,
    'canvas loader must reset its memo on failure'
  );
});

test('voice entry points await the chunk before use', () => {
  assert.match(
    appSrc,
    /await loadVoiceMode\(\)/,
    'openVoiceMode must await the voice chunk'
  );
  assert.match(
    appSrc,
    /voiceModeApi\.isVoiceModeCommand\(message\)/,
    'sendChatMessage must check the command through the loaded module'
  );
  assert.match(
    appSrc,
    /voiceModeApi\.createVoiceMode\(/,
    'openVoiceMode must create the controller from the loaded module'
  );
});

test('canvas detection awaits the chunk before rendering', () => {
  assert.match(
    appSrc,
    /async function renderMessages/,
    'renderMessages must be async to await the canvas chunk'
  );
  assert.match(
    appSrc,
    /await loadCanvas\(\)/,
    'canvas call sites must await the chunk'
  );
  assert.match(
    appSrc,
    /canvasApi\.isCanvasWorthy\(item\.content\)/,
    'per-message detection must run through the loaded module'
  );
  assert.match(
    appSrc,
    /canvasApi\.canvasTitle\(content\)/,
    'renderCanvasDoc must title through the loaded module'
  );
  assert.match(
    appSrc,
    /canvasApi\.findLatestCanvasMessage\(/,
    'openCanvasRender must search through the loaded module'
  );
  assert.match(
    appSrc,
    /canvasApi\.isCanvasCommand\(message\)/,
    'sendChatMessage must check the canvas command through the loaded module'
  );
});

test('offline chunk failure falls back instead of breaking send/render', () => {
  // sendChatMessage: a rejected chunk load must not break the normal
  // (offline-queued) send path.
  assert.match(
    appSrc,
    /try\{\[voiceModeApi,canvasApi\]=await Promise\.all\(\[loadVoiceMode\(\),loadCanvas\(\)\]\);\s*\}catch\(_\)\{\}/,
    'command checks must tolerate chunk load failure'
  );
  // renderMessages: detection degrades to plain bubbles when the chunk
  // cannot load (offline first use), never throws.
  assert.match(
    appSrc,
    /await loadCanvas\(\)\.catch\(\(\)=>null\)/,
    'renderMessages must tolerate canvas chunk load failure'
  );
});

test('chunk modules expose the expected exports for lazy use', async () => {
  const voice = await import('../public/voice-mode.js');
  const canvas = await import('../public/canvas.js');
  for (const name of ['isVoiceModeCommand', 'createVoiceMode']) {
    assert.equal(typeof voice[name], 'function', `voice-mode.js must export ${name}`);
  }
  for (const name of ['isCanvasWorthy', 'canvasTitle', 'isCanvasCommand', 'findLatestCanvasMessage']) {
    assert.equal(typeof canvas[name], 'function', `canvas.js must export ${name}`);
  }
  // Spot-check the pure helpers still behave (guards against export rot).
  assert.equal(voice.isVoiceModeCommand('call orbit'), true);
  assert.equal(canvas.isCanvasCommand('print this'), true);
});
