import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDeepResearch } from '../src/tools.js';

test('deep research reads structured search URLs and presents fetched text',async t=>{
  const requests=[];
  const original=globalThis.fetch;
  globalThis.fetch=async(input)=>{
    const url=String(input);requests.push(url);
    if(url.startsWith('https://api.search.brave.com/'))
      return Response.json({web:{results:[{url:'https://8.8.8.8/article',title:'Synthetic climate source',description:'A source summary.'}]}});
    if(url==='https://8.8.8.8/article'){
      const response=new Response('<html><body>Synthetic verified source text.</body></html>',{headers:{'Content-Type':'text/html'}});
      Object.defineProperty(response,'url',{value:url});
      return response;
    }
    throw new Error('Unexpected external request in synthetic test');
  };
  t.after(()=>{globalThis.fetch=original;});
  const report=await toolDeepResearch({topic:'synthetic climate topic'},{BRAVE_SEARCH_API_KEY:'synthetic-no-network-key'});
  assert.match(report,/Synthetic climate source/);
  assert.match(report,/https:\/\/8\.8\.8\.8\/article/);
  assert.match(report,/Synthetic verified source text/);
  assert.ok(requests.includes('https://8.8.8.8/article'));
  assert.doesNotMatch(report,/\[object Object\]/);
});

test('deep research reports incomplete work when every search fails',async t=>{
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('synthetic search outage');};
  t.after(()=>{globalThis.fetch=original;});
  await assert.rejects(()=>toolDeepResearch({topic:'synthetic outage',angles:'history,science'},{}),
    /Research incomplete: no search sources/);
  assert.equal(calls,6,'each of three search angles uses only the two stubbed free backends');
});

test('deep research reports incomplete work when search succeeds but every page read fails',async t=>{
  const original=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async input=>{
    const url=String(input);requests.push(url);
    if(url.startsWith('https://api.search.brave.com/'))
      return Response.json({web:{results:[{url:'https://8.8.8.8/unreadable',title:'Synthetic source',description:'Only a search snippet.'}]}});
    if(url==='https://8.8.8.8/unreadable')throw new Error('synthetic page outage');
    throw new Error('Unexpected external request in synthetic test');
  };
  t.after(()=>{globalThis.fetch=original;});
  await assert.rejects(()=>toolDeepResearch({topic:'synthetic source outage'},{BRAVE_SEARCH_API_KEY:'synthetic-no-network-key'}),
    /Research incomplete: no source pages could be read/);
  assert.ok(requests.includes('https://8.8.8.8/unreadable'));
});
