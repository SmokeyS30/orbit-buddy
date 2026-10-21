import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeBackend,nativeConfigSource,syncIos,writeNativeConfig } from '../scripts/sync-ios.mjs';

test('native build configuration defaults to production and accepts HTTPS test origins',()=>{
  assert.equal(nativeBackend(),'https://orbitbuddy.app');
  assert.equal(nativeBackend('https://test.example:8443/'),'https://test.example:8443');
  assert.match(nativeConfigSource('https://test.example'),/export const NATIVE_API_BASE = "https:\/\/test.example"/);
  for(const value of ['http://test.example','javascript:alert(1)','https://user:secret@test.example','https://test.example/path','https://test.example/?token=secret','https://test.example/#fragment','invalid'])assert.throws(()=>nativeBackend(value));
});
test('sync writes only ignored generated bundle configuration after successful Capacitor sync',()=>{
  const calls=[],writes=[];
  const backend=syncIos(['--api-base','https://test.example'],{root:'/project',run:(...a)=>{calls.push(a);return {status:0};},exists:()=>true,write:(...a)=>writes.push(a)});
  assert.equal(backend,'https://test.example');assert.equal(calls[0][1].at(-1),'ios');
  assert.equal(writes[0][0],'/project/ios/App/App/public/native-config.js');assert.match(writes[0][1],/test.example/);
  assert.throws(()=>syncIos(['--api-base','http://test.example'],{run:()=>assert.fail('must validate before sync')}));
  assert.throws(()=>syncIos([],{run:()=>({status:1}),write:()=>assert.fail('must not write after failed sync')}));
  assert.throws(()=>syncIos(['--unexpected'],{run:()=>assert.fail('invalid arguments')}));
});

test('native config writes refuse symlinks and missing outputs and replace the entire opened file',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-native-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.js'),link=path.join(dir,'symlink.js');
  fs.writeFileSync(file,'old configuration with trailing bytes');fs.symlinkSync(file,link);
  assert.throws(()=>writeNativeConfig(link,'unsafe'));assert.equal(fs.readFileSync(file,'utf8'),'old configuration with trailing bytes');
  assert.throws(()=>writeNativeConfig(path.join(dir,'missing.js'),'unsafe'));
  writeNativeConfig(file,'new');assert.equal(fs.readFileSync(file,'utf8'),'new');
});
