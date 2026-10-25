// The Node test runner executes files concurrently. Prepare the disposable
// PostgreSQL baseline before any test opens an adapter; individual tests still
// exercise additive migrations against their own isolated fixtures.
import fs from 'node:fs';
import pg from 'pg';

const raw=process.env.TEST_DATABASE_URL;
if(!raw)throw new Error('TEST_DATABASE_URL must point at disposable local PostgreSQL for npm test.');
const url=new URL(raw);
const database=decodeURIComponent(url.pathname.slice(1));
if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/^postgres(?:ql)?:$/.test(url.protocol)||!/test/i.test(database))
  throw new Error('TEST_DATABASE_URL must name a local disposable test database.');

const client=new pg.Client({connectionString:raw,ssl:url.searchParams.get('sslmode')==='disable'?false:true});
try{
  await client.connect();
  await client.query(fs.readFileSync(new URL('../src/db/postgres-schema.sql',import.meta.url),'utf8'));
}finally{await client.end();}
