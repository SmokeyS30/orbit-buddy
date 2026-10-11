import fs from 'node:fs';
import path from 'node:path';
import { encryptPortable } from './security.js';

export async function writeAutomatedBackup({ db, userId, dataDir, backupDir, passphrase }) {
  if (!passphrase) return null;
  // Use the durable Azure Files mount when configured (BACKUP_DIR env var),
  // falling back to the ephemeral dataDir for local development.
  const directory = backupDir || path.join(dataDir, 'backups');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Azure Files mounts may reject chmod; mkdir mode is sufficient */ }
  const payload = await encryptPortable(db.exportUser(userId), passphrase);
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const file = path.join(directory, `orbit-${userId}-${stamp}.orbitbackup`);
  fs.writeFileSync(file, payload, { mode: 0o600 });
  const files = fs.readdirSync(directory).filter((name)=>name.startsWith(`orbit-${userId}-`)).sort().reverse();
  for (const old of files.slice(7)) fs.unlinkSync(path.join(directory, old));
  return file;
}
