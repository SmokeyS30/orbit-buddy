import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, exportPKCS8, createLocalJWKSet, SignJWT } from 'jose';
import { verifyAppleIdentity, validateAppleAuthorization } from '../src/apple-auth.js';

const rsa=await generateKeyPair('RS256');
const ec=await generateKeyPair('ES256',{extractable:true});
const keys=createLocalJWKSet({keys:[{...await exportJWK(rsa.publicKey),kid:'test',alg:'RS256'}]});
const env={APPLE_CLIENT_ID:'com.test.orbit',APPLE_TEAM_ID:'TESTTEAM',APPLE_KEY_ID:'test',APPLE_PRIVATE_KEY:await exportPKCS8(ec.privateKey)};
export async function token(claims={}){return new SignJWT({sub:'subject-one',nonce:'server-nonce',email:'apple@example.com',email_verified:true,...claims}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://appleid.apple.com').setAudience(env.APPLE_CLIENT_ID).setIssuedAt().setExpirationTime('5m').sign(rsa.privateKey);}

test('Apple cryptographic validation rejects issuer, audience, nonce, expiry, signature and algorithm failures',async()=>{
  const valid=await token();assert.equal((await verifyAppleIdentity(valid,{audience:env.APPLE_CLIENT_ID,nonce:'server-nonce',keys})).sub,'subject-one');
  for(const jwt of [valid.slice(0,-20)+'a'.repeat(20),await token({nonce:'wrong'}),await token({sub:''})])await assert.rejects(verifyAppleIdentity(jwt,{audience:env.APPLE_CLIENT_ID,nonce:'server-nonce',keys}));
  await assert.rejects(verifyAppleIdentity(valid,{audience:'wrong',nonce:'server-nonce',keys}));
  for(const claims of [{iss:'wrong'},{exp:1},{iat:1},{}]){
    const invalid=await new SignJWT({sub:'subject',nonce:'server-nonce',iss:'https://appleid.apple.com',aud:env.APPLE_CLIENT_ID,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60,...claims}).setProtectedHeader({alg:claims.exp?'RS256':'RS256',kid:'test'}).sign(rsa.privateKey);
    if(Object.keys(claims).length)await assert.rejects(verifyAppleIdentity(invalid,{audience:env.APPLE_CLIENT_ID,nonce:'server-nonce',keys}));
  }
  const hs=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).sign(new Uint8Array(32));
  await assert.rejects(verifyAppleIdentity(hs,{audience:env.APPLE_CLIENT_ID,nonce:'server-nonce',keys}));
});

test('Apple authorization code exchange is mandatory and binds the exchanged subject and nonce',async()=>{
  const jwt=await token();const input={identityToken:jwt,authorizationCode:'one-use-code',nonce:'server-nonce'};
  let called=false;
  const result=await validateAppleAuthorization(input,env,{keys,fetchImpl:async(url,options)=>{called=true;assert.equal(url,'https://appleid.apple.com/auth/token');assert.equal(options.body.get('code'),'one-use-code');assert.equal(options.redirect,'error');return Response.json({id_token:jwt});}});
  assert.ok(called);assert.equal(result.subject,'subject-one');
  for(const response of [new Response('',{status:400}),Response.json({id_token:await token({sub:'different'})}),Response.json({id_token:await token({nonce:'different'})}),Response.json({})])await assert.rejects(validateAppleAuthorization(input,env,{keys,fetchImpl:async()=>response}));
  await assert.rejects(validateAppleAuthorization({...input,authorizationCode:''},env,{keys}));
  await assert.rejects(validateAppleAuthorization(input,{}, {keys}));
});
