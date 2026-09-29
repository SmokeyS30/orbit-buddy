import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptPortable, decryptSecret, encryptPortable, encryptSecret, hashPassword, verifyPassword } from '../src/security.js';

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
