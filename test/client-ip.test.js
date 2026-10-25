import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { clientIpForRateLimit } from '../src/client-ip.js';

test('trusted ingress uses only Azure-appended rightmost address and ignores spoofed Cloudflare header',()=>{
  const req={socket:{remoteAddress:'10.0.0.7'},headers:{
    'cf-connecting-ip':'198.51.100.42',
    'x-forwarded-for':'203.0.113.1, 192.0.2.9',
  }};
  assert.equal(clientIpForRateLimit(req,{trustIngress:true}),'192.0.2.9');
  assert.equal(clientIpForRateLimit(req,{trustIngress:false}),'10.0.0.7');
  req.headers['x-forwarded-for']='forged,invalid';
  assert.equal(clientIpForRateLimit(req,{trustIngress:true}),'10.0.0.7');
});

test('anonymous reset rate limit cannot be evaded by rotating client-supplied IP headers',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-ip-limit-'));
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  for(let i=1;i<=11;i++){
    const response=await fetch(`${base}/api/auth/reset-password`,{
      method:'POST',headers:{'Content-Type':'application/json','cf-connecting-ip':`203.0.113.${i}`,'x-forwarded-for':`198.51.100.${i}`},body:'{}',
    });
    assert.equal(response.status,i===11?429:400,`request ${i}`);
  }
});

test('production mode keys anonymous limits on a synthetic ingress-appended rightmost IP',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-ip-prod-limit-'));
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'production',MAINTENANCE_MODE:'0'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  for(let i=1;i<=11;i++){
    const response=await fetch(`${base}/api/auth/reset-password`,{
      method:'POST',headers:{'Content-Type':'application/json','cf-connecting-ip':`203.0.113.${i}`,
        'x-forwarded-for':`198.51.100.${i}, 192.0.2.42`},body:'{}',
    });
    assert.equal(response.status,i===11?429:400,`request ${i}`);
  }
});
