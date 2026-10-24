import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encryptPortable } from './security.js';

export async function writeAutomatedBackup({ db, userId, dataDir, backupDir, passphrase }) {
  if (!passphrase) return null;
  // Use the durable Azure Files mount when configured (BACKUP_DIR env var),
  // falling back to the ephemeral dataDir for local development.
  const directory = backupDir || path.join(dataDir, 'backups');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Azure Files mounts may reject chmod; mkdir mode is sufficient */ }
  const exportUser=db.async?.exportUser?.bind(db.async)||db.exportUser.bind(db);
  const payload = await encryptPortable(await exportUser(userId), passphrase);
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const file = path.join(directory, `orbit-${userId}-${stamp}.orbitbackup`);
  const temporary=`${file}.${randomUUID()}.tmp`;
  try{
    fs.writeFileSync(temporary,payload,{mode:0o600,flag:'wx'});
    fs.renameSync(temporary,file);
  }catch(error){try{fs.unlinkSync(temporary);}catch{}throw error;}
  const files = fs.readdirSync(directory).filter((name)=>name.startsWith(`orbit-${userId}-`)&&name.endsWith('.orbitbackup')).sort().reverse();
  for (const old of files.slice(7)) fs.unlinkSync(path.join(directory, old));
  return file;
}
