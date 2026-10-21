// Email bearer links must never derive their destination from an HTTP Host header.
export function authLinkOrigin(env={}) {
  let url;
  try{url=new URL(env.PUBLIC_BASE_URL||'https://orbitbuddy.app');}catch{throw new Error('PUBLIC_BASE_URL must be a canonical origin.');}
  const local=env.NODE_ENV!=='production'&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!local)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('PUBLIC_BASE_URL must be an HTTPS origin without credentials, path, query or fragment.');
  return url.origin;
}
