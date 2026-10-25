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
