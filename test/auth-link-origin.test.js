import test from 'node:test';
import assert from 'node:assert/strict';
import {authLinkOrigin} from '../src/auth-link-origin.js';
test('auth email links use a validated canonical origin with production compatibility',()=>{
  assert.equal(authLinkOrigin({}),'https://orbitbuddy.app');
  assert.equal(authLinkOrigin({PUBLIC_BASE_URL:'https://test.example/'}),'https://test.example');
  assert.equal(authLinkOrigin({PUBLIC_BASE_URL:'http://localhost:3000',NODE_ENV:'test'}),'http://localhost:3000');
  for(const url of ['https://user:password@test.example','https://test.example/path','https://test.example/?token=secret','https://test.example/#fragment','http://test.example','invalid'])assert.throws(()=>authLinkOrigin({PUBLIC_BASE_URL:url}));
  assert.throws(()=>authLinkOrigin({PUBLIC_BASE_URL:'http://localhost:3000',NODE_ENV:'production'}));
});
