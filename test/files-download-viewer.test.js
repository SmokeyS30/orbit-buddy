import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

function fnBody(name, nextFn) {
  const start = appJs.indexOf(`function ${name}(`) > -1
    ? appJs.indexOf(`function ${name}(`)
    : appJs.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `${name}() must exist`);
  const end = nextFn ? appJs.indexOf(nextFn, start) : appJs.length;
  return appJs.slice(start, end === -1 ? appJs.length : end);
}

test('Files tab has no bare anchor navigation to /api/artifacts (breaks native auth)', () => {
  const body = fnBody('renderFiles', 'const whatsappUi');
  // A plain <a href="/api/artifacts/..."> does a top-level navigation with no
  // auth headers — on iOS native (Bearer-token auth) it 401s and destroys the
  // app page (splash + Today tab) instead of opening the document.
  assert.doesNotMatch(body, /createElement\('a'\)[\s\S]{0,400}\/api\/artifacts\//);
  assert.doesNotMatch(body, /href=`\/api\/artifacts\//);
});

test('Files tab Open button routes through openArtifact', () => {
  const body = fnBody('renderFiles', 'const whatsappUi');
  assert.ok(body.includes('openArtifact(file)'), 'Open button must call openArtifact(file)');
});

test('openArtifact fetches through the authenticated api() helper', () => {
  const body = fnBody('openArtifact', 'async function shareOrDownloadBlob');
  assert.match(body, /await api\(`\/api\/artifacts\/\$\{file\.id\}`\)/);
  assert.doesNotMatch(body, /location\.(href|assign|replace)/, 'must not navigate the top window');
  assert.doesNotMatch(body, /window\.open\(/, 'must not open a popup window');
});

test('openArtifact never performs a top-level navigation', () => {
  const start = appJs.indexOf('async function openArtifact(');
  const end = appJs.indexOf('function docViewerKey(', start);
  const body = appJs.slice(start, end);
  assert.doesNotMatch(body, /location\.href\s*=/);
});

test('printArtifact fetches the PDF through api() for the share sheet', () => {
  const body = fnBody('printArtifact', null);
  assert.ok(body.includes('?format=pdf'), 'print must use the server PDF renderer');
  assert.match(body, /await api\(`\/api\/artifacts\/\$\{artifactId\}\?format=pdf`\)/);
});

test('doc viewer hides the server toolbar wired for top-level navigation', () => {
  const body = fnBody('openDocViewer', 'function docViewerKey');
  assert.ok(body.includes('style="display:none"'), 'inner toolbar must be hidden in the viewer');
  assert.ok(body.includes("role','dialog'") || body.includes('role","dialog"') || body.includes("setAttribute('role','dialog')"),
    'viewer must be exposed as a dialog');
});
