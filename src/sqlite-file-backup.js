import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

export async function createSqliteBackup(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size === 0) return false;

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  fs.rmSync(destinationPath, { force: true });

  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(database, destinationPath);
  } finally {
    database.close();
  }

  try { fs.chmodSync(destinationPath, 0o600); } catch (_) {}
  return true;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const [sourcePath, destinationPath] = process.argv.slice(2);
  if (!sourcePath || !destinationPath) {
    console.error('Usage: node src/sqlite-file-backup.js <source> <destination>');
    process.exitCode = 2;
  } else {
    createSqliteBackup(sourcePath, destinationPath)
      .then((created) => {
        if (!created) console.error('Database backup skipped because the source is missing or empty.');
      })
      .catch((error) => {
        console.error(`Database backup failed: ${error.message}`);
        process.exitCode = 1;
      });
  }
}
