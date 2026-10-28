// Compare event-loop delay for legacy blocking reads and async PostgreSQL
// reads against a disposable local test database. No user data is read.
import { performance } from 'node:perf_hooks';
import { createDatabase } from '../src/db/factory.mjs';

const databaseUrl=process.env.TEST_DATABASE_URL;
const parsed=databaseUrl?new URL(databaseUrl):null;
if(!parsed||!['localhost','127.0.0.1','::1'].includes(parsed.hostname)||parsed.pathname!=='/orbit_test'){
  throw new Error('Set TEST_DATABASE_URL to a local disposable /orbit_test PostgreSQL database.');
}
const db=createDatabase({databaseUrl});
async function measure(label,read){
  const started=performance.now();
  let timerLagMs=null;
  setTimeout(()=>{timerLagMs=performance.now()-started;},0);
  for(let i=0;i<100;i++)await read();
  const wallMs=performance.now()-started;
  await new Promise((resolve)=>setTimeout(resolve,10));
  return{mode:label,queries:100,wallMs:Math.round(wallMs),timerLagMs:Math.round(timerLagMs)};
}
try{
  for(let round=1;round<=3;round++){
    console.log(JSON.stringify({round,...await measure('sync',()=>db.getSetting('benchmark_read_only'))}));
    console.log(JSON.stringify({round,...await measure('async',()=>db.async.getSetting('benchmark_read_only'))}));
  }
}finally{db.close();}
