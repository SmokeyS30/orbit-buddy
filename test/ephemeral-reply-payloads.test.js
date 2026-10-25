import test from 'node:test';
import assert from 'node:assert/strict';
import { EphemeralReplyPayloads } from '../src/ephemeral-reply-payloads.js';

test('location payloads require account and time metadata for expiry and account cleanup',()=>{
  const payloads=new EphemeralReplyPayloads();
  assert.throws(()=>payloads.set('missing',{message:'[Shared location]',images:[]}),/userId and createdAt/);
  let released=0;
  payloads.set('expired',{userId:'synthetic-user',message:'[Shared location]',images:[],createdAt:100,
    releaseMedia:()=>released++});
  payloads.prune(new Map(),100+30*60_000+1,30*60_000);
  assert.equal(payloads.has('expired'),false);
  assert.equal(released,1);

  payloads.set('deleted',{userId:'synthetic-user',message:'[Shared location]',images:[],createdAt:200,
    releaseMedia:()=>released++});
  payloads.set('other',{userId:'other-user',message:'[Shared location]',images:[],createdAt:200});
  payloads.clearUser('synthetic-user',new Map());
  assert.equal(payloads.has('deleted'),false);
  assert.equal(payloads.has('other'),true);
  assert.equal(released,2);
});

test('active ephemeral jobs survive pruning until execution releases them once',()=>{
  const payloads=new EphemeralReplyPayloads();
  let released=0;
  payloads.set('active',{userId:'synthetic-user',message:'[Shared location]',images:[],createdAt:100,
    releaseMedia:()=>released++});
  const active=new Map([['active',true]]);
  payloads.prune(active,100+60*60_000,30*60_000);
  payloads.clearUser('synthetic-user',active);
  assert.equal(payloads.has('active'),true);
  active.delete('active');
  payloads.prune(active,100+60*60_000,30*60_000);
  assert.equal(payloads.has('active'),false);
  assert.equal(released,1);
  payloads.drop('active');
  assert.equal(released,1);
});
