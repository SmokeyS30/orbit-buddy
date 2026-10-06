import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteBackup } from '../src/sqlite-file-backup.js';

test('createSqliteBackup creates a readable, consistent copy', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-backup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const source = path.join(directory, 'source.sqlite');
  const destination = path.join(directory, 'backup.sqlite');
  const sourceDatabase = new DatabaseSync(source);
  sourceDatabase.exec('PRAGMA journal_mode=WAL; CREATE TABLE notes (body TEXT NOT NULL); INSERT INTO notes VALUES (\'saved\');');

  assert.equal(await createSqliteBackup(source, destination), true);
  sourceDatabase.close();

  const backupDatabase = new DatabaseSync(destination, { readOnly: true });
  assert.equal(backupDatabase.prepare('SELECT body FROM notes').get().body, 'saved');
  backupDatabase.close();
});

test('createSqliteBackup skips a missing source', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-backup-missing-'));
  try {
    assert.equal(
      await createSqliteBackup(path.join(directory, 'missing.sqlite'), path.join(directory, 'backup.sqlite')),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
