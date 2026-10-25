import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assertPublicUrl,fetchPublicBytes } from '../src/net.js';
import { toolFetchUrl } from '../src/tools.js';
import { fetchFeedText,getEventsForRange } from '../src/ical.js';

test('URL validation rejects IPv4-mapped IPv6 private targets',async()=>{
  await assert.rejects(()=>assertPublicUrl('http://[::ffff:127.0.0.1]/'),/not publicly reachable/);
  await assert.rejects(()=>assertPublicUrl('http://[::ffff:169.254.169.254]/'),/not publicly reachable/);
  await assert.rejects(()=>assertPublicUrl('http://[2002:7f00:1::]/'),/not publicly reachable/);
  await assert.rejects(()=>assertPublicUrl('http://[2001:db8::1]/'),/not publicly reachable/);
  assert.ok((await assertPublicUrl('https://[2606:4700:4700::1111]/')).startsWith('https://'));
});

test('page fetch checks a redirect before any request to its private target',async t=>{
  const original=global.fetch;
  let calls=0;
  global.fetch=async(_url,options)=>{
    calls++;
    assert.equal(options.redirect,'manual','automatic redirects can reach private targets before validation');
    return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}});
  };
  t.after(()=>{global.fetch=original;});
  await assert.rejects(()=>toolFetchUrl({url:'https://93.184.216.34/public'}),/not publicly reachable/);
  assert.equal(calls,1);
});

test('a DNS rebind to loopback is rejected at socket connection time',async t=>{
  let reached=0;
  const server=http.createServer((_req,res)=>{reached++;res.end('private');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  let lookups=0;
  const resolve=async()=>{
    lookups++;
    return [{address:lookups===1?'93.184.216.34':'127.0.0.1',family:4}];
  };
  await assert.rejects(()=>fetchPublicBytes(`http://synthetic.invalid:${server.address().port}/`,{
    maxBytes:1000,resolve
  }),/Could not fetch/);
  assert.equal(lookups,2,'DNS was checked again by the connection lookup');
  assert.equal(reached,0,'no request reached the loopback fixture');
});

test('page responses stop reading when the byte limit is reached',async t=>{
  const original=global.fetch;
  let pulls=0,cancelled=false;
  global.fetch=async()=>new Response(new ReadableStream({
    pull(controller){pulls++;controller.enqueue(new Uint8Array(200_000));},
    cancel(){cancelled=true;}
  },{highWaterMark:0}),{headers:{'Content-Type':'text/plain'}});
  t.after(()=>{global.fetch=original;});
  await assert.rejects(()=>toolFetchUrl({url:'https://93.184.216.34/large'}),/too large/);
  assert.equal(cancelled,true);
  assert.ok(pulls<10,'the response stream must be cancelled early');
});

test('page reader still extracts readable text from a bounded response',async t=>{
  const original=global.fetch;
  global.fetch=async()=>new Response('<script>ignore()</script><h1>Hello world</h1>',{
    headers:{'Content-Type':'text/html'}
  });
  t.after(()=>{global.fetch=original;});
  const result=await toolFetchUrl({url:'https://93.184.216.34/page'});
  assert.equal(result.text,'Hello world');
});

test('calendar feed responses stop reading at their own byte limit',async t=>{
  const original=global.fetch;
  let cancelled=false;
  global.fetch=async()=>new Response(new ReadableStream({
    pull(controller){controller.enqueue(new Uint8Array(600_000));},
    cancel(){cancelled=true;}
  },{highWaterMark:0}));
  t.after(()=>{global.fetch=original;});
  await assert.rejects(()=>fetchFeedText('https://93.184.216.34/calendar.ics'),/too large/);
  assert.equal(cancelled,true);
});

test('the fetch deadline includes the first DNS lookup',async t=>{
  const original=global.fetch;
  let requests=0,release;
  global.fetch=async()=>{requests++;return new Response('unexpected');};
  t.after(()=>{global.fetch=original;});
  const resolve=()=>new Promise(done=>{release=()=>done([{address:'93.184.216.34',family:4}]);});
  await assert.rejects(()=>fetchPublicBytes('https://synthetic.invalid/',{maxBytes:100,resolve,timeoutMs:40}),/timed out/);
  release();
  await new Promise(done=>setImmediate(done));
  assert.equal(requests,0,'late DNS completion cannot start a fetch');
});

test('the fetch deadline includes redirect DNS and blocks a late second fetch',async t=>{
  const original=global.fetch;
  let requests=0,release,lookups=0;
  global.fetch=async()=>{requests++;return new Response(null,{status:302,headers:{Location:'https://next.invalid/'}});};
  t.after(()=>{global.fetch=original;});
  const resolve=()=>{
    lookups++;
    if(lookups===1)return Promise.resolve([{address:'93.184.216.34',family:4}]);
    return new Promise(done=>{release=()=>done([{address:'93.184.216.34',family:4}]);});
  };
  await assert.rejects(()=>fetchPublicBytes('https://first.invalid/',{maxBytes:100,resolve,timeoutMs:40}),/timed out/);
  release();
  await new Promise(done=>setImmediate(done));
  assert.equal(requests,1,'late redirect resolution cannot start a second fetch');
});

test('revoked calendar work cannot fetch another feed after the first response',async t=>{
  const original=global.fetch;
  let requests=0,active=true;
  global.fetch=async()=>{
    requests++;
    active=false;
    return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR');
  };
  t.after(()=>{global.fetch=original;});
  const db={listCalendarFeeds:()=>[
    {id:'paused-calendar-a',label:'A',url:'https://93.184.216.34/a.ics'},
    {id:'paused-calendar-b',label:'B',url:'https://93.184.216.34/b.ics'},
  ]};
  const assertActive=()=>{if(!active)throw Object.assign(new Error('Paused'),{code:'PROACTIVE_DEFERRED'});};
  await assert.rejects(()=>getEventsForRange(db,'synthetic',0,86_400_000,'UTC',{assertActive}),
    {code:'PROACTIVE_DEFERRED'});
  assert.equal(requests,1);
});

test('revoked work cannot follow a public calendar redirect',async t=>{
  const original=global.fetch;
  let requests=0,active=true;
  global.fetch=async()=>{
    requests++;
    active=false;
    return new Response(null,{status:302,headers:{Location:'https://93.184.216.34/next.ics'}});
  };
  t.after(()=>{global.fetch=original;});
  const assertActive=()=>{if(!active)throw Object.assign(new Error('Paused'),{code:'PROACTIVE_DEFERRED'});};
  await assert.rejects(()=>fetchFeedText('https://93.184.216.34/first.ics',{assertActive}),
    {code:'PROACTIVE_DEFERRED'});
  assert.equal(requests,1);
});
