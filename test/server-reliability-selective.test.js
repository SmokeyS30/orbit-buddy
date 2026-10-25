import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createOrbitServer } from '../server.js';

async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-reliability-local-'));
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  return{app,base:`http://127.0.0.1:${app.server.address().port}`};
}

test('malformed request target returns 400 and leaves the server healthy',async t=>{
  const {app,base}=await fixture(t);
  const response=await new Promise((resolve,reject)=>{
    const socket=net.connect(app.server.address().port,'127.0.0.1');
    socket.setTimeout(5000,()=>socket.destroy(new Error('request timed out')));
    let data='';
    socket.on('connect',()=>socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    socket.on('data',chunk=>{data+=chunk;});
    socket.on('end',()=>resolve(data));
    socket.on('error',reject);
  });
  assert.match(response,/^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`${base}/healthz`)).status,200);
});

test('PDF export has separate page, stream and font objects with valid xref offsets',async t=>{
  const {app,base}=await fixture(t);
  const registration=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'})});
  assert.equal(registration.status,201);
  const {user}=await registration.json();
  const cookie=registration.headers.get('set-cookie').split(';')[0];
  for(const count of [0,1,60,120]){
    const artifact=app.db.addArtifact(user.id,{name:'export.md',content:Array.from({length:count},(_,i)=>`Line ${i+1}`).join('\n')});
    const response=await fetch(`${base}/api/artifacts/${artifact.id}?format=pdf`,{headers:{Cookie:cookie}});
    assert.equal(response.status,200);
    const pdf=Buffer.from(await response.arrayBuffer()).toString('latin1');
    const objects=new Map([...pdf.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)].map(match=>[Number(match[1]),match[2]]));
    const tree=[...objects.values()].find(body=>/\/Type \/Pages\b/.test(body));
    const pages=[...tree.match(/\/Kids \[([^\]]*)\]/)[1].matchAll(/(\d+) 0 R/g)].map(match=>Number(match[1]));
    assert.equal(pages.length,Number(tree.match(/\/Count (\d+)/)[1]));
    assert.equal(new Set(pages).size,pages.length);
    if(count>=60)assert.ok(pages.length>1);
    else assert.equal(pages.length,1);
    let text='';
    for(const id of pages){
      const page=objects.get(id);
      assert.match(page,/\/Type \/Page\b/);
      assert.equal(objects.get(Number(page.match(/\/Parent (\d+) 0 R/)[1])),tree);
      for(const font of page.matchAll(/\/F\d (\d+) 0 R/g))assert.match(objects.get(Number(font[1])),/\/Type \/Font\b/);
      const stream=objects.get(Number(page.match(/\/Contents (\d+) 0 R/)[1]));
      const content=stream.match(/\nstream\n([\s\S]*)\nendstream/)[1];
      assert.equal(Buffer.byteLength(content,'latin1'),Number(stream.match(/\/Length (\d+)/)[1]));
      text+=content;
    }
    for(let i=1;i<=count;i++)assert.equal(text.split(`(Line ${i}) Tj`).length-1,1);
    const xref=Number(pdf.match(/startxref\n(\d+)/)[1]);
    assert.equal(pdf.slice(xref,xref+4),'xref');
    const rows=pdf.slice(xref).split('\n');
    const size=Number(rows[1].split(' ')[1]);
    assert.equal(size,objects.size+1);
    for(let id=1;id<size;id++)assert.ok(pdf.slice(Number(rows[id+2].split(' ')[0])).startsWith(`${id} 0 obj\n`));
  }
});
