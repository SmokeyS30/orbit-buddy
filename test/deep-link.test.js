import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationDeepLink } from '../public/deep-link.js';

const UUID = '3f4a9c2e-7b1d-4f6a-9e2c-5d8a1b3f7e9a';

test('parses a valid conversation id from the query string', () => {
  assert.equal(parseConversationDeepLink(`?conversation=${UUID}`), UUID);
});

test('finds the param among other query params', () => {
  assert.equal(parseConversationDeepLink(`?foo=1&conversation=${UUID}&bar=2`), UUID);
});

test('returns null when the param is absent or empty', () => {
  assert.equal(parseConversationDeepLink(''), null);
  assert.equal(parseConversationDeepLink('?foo=1'), null);
  assert.equal(parseConversationDeepLink('?conversation='), null);
  assert.equal(parseConversationDeepLink(null), null);
  assert.equal(parseConversationDeepLink(undefined), null);
});

test('rejects ids outside the whitelist (path traversal, markup, spaces)', () => {
  assert.equal(parseConversationDeepLink('?conversation=../../etc/passwd'), null);
  assert.equal(parseConversationDeepLink('?conversation=<script>alert(1)</script>'), null);
  assert.equal(parseConversationDeepLink('?conversation=' + encodeURIComponent('a b')), null);
  assert.equal(parseConversationDeepLink('?conversation=' + encodeURIComponent('a;b')), null);
  assert.equal(parseConversationDeepLink('?conversation=' + encodeURIComponent('a"b')), null);
});

test('rejects overlong ids', () => {
  assert.equal(parseConversationDeepLink('?conversation=' + 'a'.repeat(121)), null);
  assert.equal(parseConversationDeepLink('?conversation=' + 'a'.repeat(120)), 'a'.repeat(120));
});

test('accepts the id charset the server actually generates (uuid)', () => {
  assert.ok(/^[0-9a-f-]{36}$/.test(UUID), 'test uuid sanity');
  assert.equal(parseConversationDeepLink(`?conversation=${UUID}`), UUID);
});
