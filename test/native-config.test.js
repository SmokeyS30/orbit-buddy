import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeBackend,nativeConfigSource,syncIos } from '../scripts/sync-ios.mjs';

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
