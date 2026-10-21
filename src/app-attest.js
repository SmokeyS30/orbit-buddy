import { X509Certificate } from 'node:crypto';
import cbor from 'cbor';
import { verifyAttestation, verifyAssertion } from 'node-app-attest';

export function appAttestReady(env) { return Boolean(env.APPLE_TEAM_ID && env.APPLE_APP_BUNDLE_ID); }
export function decodeAttestObject(value) {
  if(typeof value !== 'string' || value.length > 24000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid attestation encoding.');
  const bytes=Buffer.from(value,'base64');
  const decoded=cbor.decodeAllSync(bytes,{max_depth:12});
  if(decoded.length!==1) throw new Error('Invalid attestation object.');
  return {bytes,object:decoded[0]};
}
export function verifyAppAttestation({attestation,keyId,challenge},env) {
  if(!appAttestReady(env)) throw new Error('Attestation is unavailable.');
  const {bytes,object}=decodeAttestObject(attestation);
  // The underlying verifier checks signatures and Apple root pinning. Also
  // enforce certificate lifetime and chain ordering before admitting a key.
  if(object.attStmt?.x5c?.length!==2 || !Buffer.isBuffer(object.authData) || object.authData.length<87) throw new Error('Invalid attestation.');
  const [leaf,intermediate]=object.attStmt.x5c.map(c=>new X509Certificate(c));
  for(const cert of [leaf,intermediate]) if(Date.now()<Date.parse(cert.validFrom)||Date.now()>Date.parse(cert.validTo)) throw new Error('Expired attestation.');
  if(leaf.ca || !intermediate.ca || !leaf.checkIssued(intermediate)) throw new Error('Invalid certificate chain.');
  return verifyAttestation({attestation:bytes,keyId,challenge,bundleIdentifier:env.APPLE_APP_BUNDLE_ID,
    teamIdentifier:env.APPLE_TEAM_ID,allowDevelopmentEnvironment:env.NODE_ENV!=='production'&&env.APP_ATTEST_ALLOW_DEVELOPMENT==='true'});
}
export function verifyAppAssertion({assertion,payload,key},env) {
  const {bytes,object}=decodeAttestObject(assertion);
  if(!Buffer.isBuffer(object.authenticatorData)||object.authenticatorData.length!==37||!Buffer.isBuffer(object.signature)) throw new Error('Invalid assertion.');
  return verifyAssertion({assertion:bytes,payload,publicKey:key.public_key,bundleIdentifier:env.APPLE_APP_BUNDLE_ID,
    teamIdentifier:env.APPLE_TEAM_ID,signCount:Number(key.sign_count)}).signCount;
}
