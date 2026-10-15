import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { clearSessionCookie, decryptPortable, decryptSecret, encryptPortable, encryptSecret, hashPassword, sessionCookie, verifyPassword } from '../src/security.js';

test('password hashes verify without storing the password', async () => {
  const password = 'correct horse battery staple';
  const saved = await hashPassword(password);
  assert.equal(await verifyPassword(password, saved.hash, saved.salt), true);
  assert.equal(await verifyPassword('not the password', saved.hash, saved.salt), false);
  assert.equal(saved.hash.includes(password), false);
});

test('connector credentials are encrypted at rest', () => {
  const key = randomBytes(32);
  const ciphertext = encryptSecret('secret-token', key);
  assert.equal(ciphertext.includes('secret-token'), false);
  assert.equal(decryptSecret(ciphertext, key), 'secret-token');
  assert.throws(() => decryptSecret(ciphertext, randomBytes(32)));
});

test('portable backups require the correct passphrase', async () => {
  const ciphertext = await encryptPortable({ version: 2, messages: ['safe'] }, 'a very long backup passphrase');
  assert.deepEqual(await decryptPortable(ciphertext, 'a very long backup passphrase'), { version: 2, messages: ['safe'] });
  await assert.rejects(() => decryptPortable(ciphertext, 'a different long passphrase'));
});

test('session cookie defaults to SameSite=Strict', () => {
  const header = sessionCookie('tok');
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
});

test('session cookie can be issued SameSite=None (Secure forced on)', () => {
  // SameSite=None is rejected by browsers without Secure — forced even when secure:false.
  const header = sessionCookie('tok', { secure: false, sameSite: 'None' });
  assert.match(header, /SameSite=None/);
  assert.match(header, /Secure/);
  assert.doesNotMatch(header, /SameSite=Strict/);
});

test('clearSessionCookie mirrors the sameSite option', () => {
  assert.match(clearSessionCookie(), /SameSite=Strict/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
  const native = clearSessionCookie({ secure: false, sameSite: 'None' });
  assert.match(native, /SameSite=None/);
  assert.match(native, /Secure/);
  assert.match(native, /Max-Age=0/);
});
