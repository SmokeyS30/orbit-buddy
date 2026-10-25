import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';

export const FETCH_TIMEOUT_MS = 10_000;

const specialIpv6=new BlockList();
for(const [base,prefix] of [
  ['2001::',32], // Teredo tunnels can reach embedded IPv4 targets.
  ['2001:2::',48],['2001:10::',28],['2001:20::',28],
  ['2001:db8::',32],['2002::',16], // Documentation and 6to4 transition ranges.
])specialIpv6.addSubnet(base,prefix,'ipv6');

function ipIsPrivate(ip) {
  const family=isIP(ip);
  if(family===6){
    // IPv4-mapped, NAT64, link-local, unique-local and other transition
    // addresses are excluded by allowing only global 2000::/3 addresses.
    const first=Number.parseInt(ip.split(':')[0]||'0',16);
    return first<0x2000||first>0x3fff||specialIpv6.check(ip,'ipv6');
  }
  if(family!==4)return true;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a,b,c]=parts;
  return a===0||a===10||a===127||a>=224||
    (a===100&&b>=64&&b<=127)||
    (a===169&&b===254)||
    (a===172&&b>=16&&b<=31)||
    (a===192&&(b===0&&[0,2].includes(c)||b===168||b===88&&c===99))||
    (a===198&&(b===18||b===19||b===51&&c===100))||
    (a===203&&b===0&&c===113);
}

// Validate the address selected by the actual socket connection as well as
// the preliminary DNS answer. A changed DNS answer cannot rebind the request
// to an internal address between URL validation and fetch().
export function createPublicLookup(resolve=lookup){
  return (host,options,callback)=>{
    Promise.resolve().then(()=>resolve(host,{...options,all:true})).then(addresses=>{
      if(!addresses?.length||addresses.some(entry=>ipIsPrivate(entry.address))){
        callback(new Error('That address is not publicly reachable.'));return;
      }
      if(options.all)callback(null,addresses);
      else callback(null,addresses[0].address,addresses[0].family);
    }).catch(()=>callback(new Error('Could not resolve that hostname.')));
  };
}

// Blocks server-side request forgery: the caller must never fetch internal,
// link-local, or otherwise non-public addresses, including via redirects.
export async function assertPublicUrl(raw,resolve=lookup) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (ipIsPrivate(host)) throw new Error('That address is not publicly reachable.');
    return url.toString();
  }
  let addresses;
  try {
    addresses = await resolve(host, { all: true });
  } catch {
    throw new Error('Could not resolve that hostname.');
  }
  if (!addresses.length || addresses.some((entry) => ipIsPrivate(entry.address))) {
    throw new Error('That address is not publicly reachable.');
  }
  return url.toString();
}

async function readBoundedResponse(response,maxBytes,sizeError,signal){
  const claimed=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(claimed)&&claimed>maxBytes){await response.body?.cancel?.();throw new Error(sizeError);}
  if(!response.body?.getReader){
    // Test doubles without Web Streams retain the same logical size check.
    const buffer=Buffer.from(await response.arrayBuffer());
    if(buffer.length>maxBytes)throw new Error(sizeError);
    return buffer;
  }
  const reader=response.body.getReader();
  const chunks=[];
  let size=0;
  const onAbort=()=>{reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',onAbort,{once:true});
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>maxBytes){await reader.cancel();throw new Error(sizeError);}
      chunks.push(value);
    }
  }finally{signal.removeEventListener('abort',onAbort);reader.releaseLock();}
  return Buffer.concat(chunks,size);
}

function beforeDeadline(action,signal){
  const timeout=()=>new Error('That request timed out.');
  if(signal.aborted)return Promise.reject(timeout());
  return new Promise((resolve,reject)=>{
    const onAbort=()=>{signal.removeEventListener('abort',onAbort);reject(timeout());};
    signal.addEventListener('abort',onAbort,{once:true});
    Promise.resolve().then(()=>{
      if(signal.aborted)throw timeout();
      return action();
    }).then(value=>{
      signal.removeEventListener('abort',onAbort);
      if(signal.aborted)reject(timeout());else resolve(value);
    },error=>{
      signal.removeEventListener('abort',onAbort);
      reject(signal.aborted?timeout():error);
    });
  });
}

export async function fetchPublicBytes(raw,{
  headers={},maxBytes,maxRedirects=5,sizeError='That response is too large.',
  contentTypePattern=null,contentTypeError='That URL did not return readable text.',
  networkErrorPrefix='Could not fetch that URL',resolve=lookup,timeoutMs=FETCH_TIMEOUT_MS,
  assertActive=null
}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw new Error('A positive response limit is required.');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>FETCH_TIMEOUT_MS)
    throw new Error('Invalid request timeout.');
  // The same deadline covers DNS validation, socket connection, every redirect
  // lookup and body reads. DNS resolvers do not accept AbortSignal, so race the
  // lookup and refuse to start another request after the deadline.
  const signal=AbortSignal.timeout(timeoutMs);
  let current=await beforeDeadline(()=>{assertActive?.();return assertPublicUrl(raw,resolve);},signal);
  const agent=new Agent({connect:{lookup:createPublicLookup(resolve)},maxResponseSize:maxBytes});
  try{
    for(let hop=0;hop<=maxRedirects;hop++){
      assertActive?.();
      let response;
      try{
        response=await beforeDeadline(()=>globalThis.fetch(current,{headers,redirect:'manual',dispatcher:agent,signal}),signal);
      }catch(error){throw new Error(`${networkErrorPrefix}: ${error.message}`);}
      if(response.status>=300&&response.status<400){
        const location=response.headers?.get?.('location');
        await beforeDeadline(()=>response.body?.cancel?.(),signal);
        if(!location)throw new Error('That redirect had no target.');
        if(hop===maxRedirects)throw new Error('That URL redirected too many times.');
        current=await beforeDeadline(()=>{assertActive?.();return assertPublicUrl(new URL(location,current).toString(),resolve);},signal);
        continue;
      }
      if(contentTypePattern&&!contentTypePattern.test(response.headers?.get?.('content-type')||'')){
        await beforeDeadline(()=>response.body?.cancel?.(),signal);
        throw new Error(contentTypeError);
      }
      const buffer=await beforeDeadline(()=>readBoundedResponse(response,maxBytes,sizeError,signal),signal);
      return {url:current,status:response.status,ok:response.ok,headers:response.headers,buffer};
    }
  }finally{agent.destroy().catch(()=>{});}
}
