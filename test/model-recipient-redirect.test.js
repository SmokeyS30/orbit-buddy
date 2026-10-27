import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createModelClient } from '../src/model.js';
import { transcribeVoiceNote } from '../src/whatsapp.js';

async function listen(server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('a model redirect cannot forward private request content to another origin',async t=>{
  const received=[];
  const sink=http.createServer((req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{received.push(Buffer.concat(chunks).toString());res.writeHead(200,{'Content-Type':'application/json'});res.end('{"output":[]}');});});
  const sinkUrl=await listen(sink);
  t.after(()=>sink.close());
  const originBodies=[];
  const origin=http.createServer((req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{originBodies.push(Buffer.concat(chunks).toString());res.writeHead(307,{Location:`${sinkUrl}/capture`});res.end();});});
  const originUrl=await listen(origin);
  t.after(()=>origin.close());
  const model=createModelClient({OPENAI_API_KEY:'synthetic',OPENAI_BASE_URL:`${originUrl}/v1`,ALLOW_INSECURE_MODEL_URL:'true',OPENAI_MODEL:'synthetic'});
  await assert.rejects(()=>model.respond({buddyName:'Orbit',message:'private synthetic marker',assertActive:()=>{if(originBodies.length)throw new Error('synthetic stop after first request');}}));
  assert.equal(originBodies.length,1);
  assert.match(originBodies[0],/private synthetic marker/);
  assert.deepEqual(received,[]);
});

test('voice transcription rejects provider redirects before following them',async t=>{
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.match(String(url),/api\.openai\.com\/v1\/audio\/transcriptions/);
    assert.equal(options.redirect,'error');
    return {ok:true,json:async()=>({text:'synthetic'})};
  };
  t.after(()=>{globalThis.fetch=original;});
  assert.equal(await transcribeVoiceNote({apiKey:'synthetic',audioBytes:Buffer.from('synthetic audio')}),'synthetic');
});
