import {isIP} from 'node:net';

function normalizedIp(value){
  const raw=String(value||'').trim();
  const ip=raw.startsWith('[')&&raw.endsWith(']')?raw.slice(1,-1):raw;
  const family=isIP(ip);
  if(!family)return null;
  if(family===4)return ip;
  try{return new URL(`http://[${ip}]`).hostname.slice(1,-1);}
  catch{return ip.toLowerCase();}
}

export function clientIpForRateLimit(req,{trustIngress=false}={}){
  const socket=normalizedIp(req.socket?.remoteAddress)||'unknown';
  if(!trustIngress)return socket;
  // Azure Container Apps appends the connecting peer as the rightmost
  // X-Forwarded-For entry. Earlier values and CF-Connecting-IP can be supplied
  // by an internet client to the DNS-only origin.
  const forwarded=req.headers?.['x-forwarded-for'];
  const ingressIp=normalizedIp(Array.isArray(forwarded)?forwarded.at(-1)?.split(',').at(-1):String(forwarded||'').split(',').at(-1));
  return ingressIp||socket;
}
