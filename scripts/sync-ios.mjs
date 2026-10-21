import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function nativeBackend(value = 'https://orbitbuddy.app') {
  let url;
  try { url = new URL(value); } catch { throw new Error('Native backend must be an HTTPS origin.'); }
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash || !url.hostname)
    throw new Error('Native backend must be an HTTPS origin without credentials, path, query or fragment.');
  return url.origin;
}
export function nativeConfigSource(value) {
  return '// Generated at build time; contains no credentials.\nexport const NATIVE_API_BASE = '+JSON.stringify(nativeBackend(value))+';\n';
}
export function syncIos(args, { run=spawnSync, write=writeFileSync, exists=existsSync, root=fileURLToPath(new URL('../',import.meta.url)) }={}) {
  if(args.length!==0 && !(args.length===2&&args[0]==='--api-base'))throw new Error('Usage: npm run ios:sync -- [--api-base https://approved-test-host]');
  const source=nativeConfigSource(args.length?args[1]:undefined);
  const result=run(process.execPath,[path.join(root,'node_modules/@capacitor/cli/bin/capacitor'),'sync','ios'],{cwd:root,stdio:'inherit'});
  if(result.error||result.status!==0)throw new Error('Capacitor sync failed; no backend configuration was written.');
  const destination=path.join(root,'ios/App/App/public/native-config.js');
  if(!exists(destination))throw new Error('Generated iOS assets are missing; do not archive this build.');
  write(destination,source,{encoding:'utf8'});
  return nativeBackend(args.length?args[1]:undefined);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log('iOS bundle backend:',syncIos(process.argv.slice(2)));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
