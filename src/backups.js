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
  // Deletion can commit on another replica while export/encryption runs.
  // Recheck after the rename so a late writer cannot leave a new archive.
  const getUser=db.async?.getUserById?.bind(db.async)||db.getUserById?.bind(db);
  if(getUser&&!(await getUser(userId))){
    try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    return null;
  }
  const files = fs.readdirSync(directory).filter((name)=>name.startsWith(`orbit-${userId}-`)&&name.endsWith('.orbitbackup')).sort().reverse();
  for (const old of files.slice(7)) fs.unlinkSync(path.join(directory, old));
  return file;
}

// Only deletions that create a queue row are cleaned here. Previously orphaned
// archives require a separate reviewed cleanup decision.
export async function cleanupDeletedUserBackups({db,dataDir,backupDir,accountRef=null}){
  const list=db.async?.listPendingBackupDeletions?.bind(db.async)||db.listPendingBackupDeletions.bind(db);
  const clear=db.async?.clearPendingBackupDeletion?.bind(db.async)||db.clearPendingBackupDeletion.bind(db);
  const getUser=db.async?.getUserById?.bind(db.async)||db.getUserById.bind(db);
  const directory=backupDir||path.join(dataDir,'backups');
  let cleaned=0,failed=0;
  for(const {account_ref:userId} of await list()){
    if(accountRef&&userId!==accountRef)continue;
    try{
      if(await getUser(userId))throw new Error('Account still exists.');
      let files;
      try{files=fs.readdirSync(directory);}
      catch(error){if(error.code==='ENOENT'&&!backupDir)files=[];else throw error;}
      for(const name of files){
        if(!name.startsWith(`orbit-${userId}-`)||!name.endsWith('.orbitbackup'))continue;
        try{fs.unlinkSync(path.join(directory,name));}
        catch(error){if(error.code!=='ENOENT')throw error;}
      }
      await clear(userId);
      cleaned++;
    }catch{failed++;}
  }
  return{cleaned,failed};
}
