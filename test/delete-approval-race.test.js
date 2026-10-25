import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openPostgres } from '../src/db/postgres-adapter.js';
import { hashToken } from '../src/security.js';

const DATABASE_URL=process.env.TEST_DATABASE_URL;

async function ensureSchema(){
  const pool=new pg.Pool({connectionString:DATABASE_URL,ssl:DATABASE_URL.includes('sslmode=disable')?false:true});
  try{
    const schema=readFileSync(new URL('../src/db/postgres-schema.sql',import.meta.url),'utf8');
    for(const statement of schema.split(';').map(part=>part.trim()).filter(Boolean))await pool.query(statement);
  }finally{await pool.end();}
}

async function waitForBlockedQuery(pool,appName,pattern){
  const deadline=Date.now()+4000;
  while(Date.now()<deadline){
    const rows=(await pool.query("SELECT query FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[appName])).rows;
    if(rows.some(row=>pattern.test(row.query)))return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error(`The expected ${appName} query never blocked on a PostgreSQL lock.`);
}

test('PostgreSQL deletion approval is atomic with target edits and newer chat turns',async()=>{
  assert.ok(DATABASE_URL,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  await ensureSchema();
  const appName=`delete_race_${randomUUID().replaceAll('-','')}`;
  const url=new URL(DATABASE_URL);
  url.searchParams.set('application_name',appName);
  const db=await openPostgres(url.toString());
  const pool=new pg.Pool({connectionString:DATABASE_URL,ssl:DATABASE_URL.includes('sslmode=disable')?false:true});
  const blocker=await pool.connect();
  let userId=null,inBlockerTransaction=false,triggerName=null;
  const stage=async()=>{
    const conversation=await db.createConversation(userId,'Synthetic deletion race');
    const source=await db.addMessage(userId,conversation.id,'user','Delete this exact goal');
    const goal=await db.addGoal(userId,{title:'Synthetic goal'});
    const approval=await db.addApproval(userId,{
      kind:'delete_goal',title:`Delete goal “${goal.title}”`,summary:'Synthetic goal deletion preview',
      payload:{id:goal.id,title:goal.title,objectType:'goal',targetFingerprint:hashToken(JSON.stringify(goal))},
      sourceMessageId:source.id
    });
    return{conversation,goal,approval};
  };
  try{
    const user=await db.createUser({email:`${appName}@example.test`,displayName:'Synthetic user',passwordHash:'test',passwordSalt:'test',role:'member'});
    userId=user.id;

    const once=await stage();
    assert.equal((await db.executeDeleteApprovalIfCurrent(userId,once.approval.id)).status,'executed');
    assert.equal(await db.getGoal(userId,once.goal.id),null);
    assert.equal((await db.executeDeleteApprovalIfCurrent(userId,once.approval.id)).status,'already');

    const edited=await stage();
    await blocker.query('BEGIN');inBlockerTransaction=true;
    await blocker.query('UPDATE goals SET progress=50,updated_at=$1 WHERE id=$2 AND user_id=$3',[new Date().toISOString(),edited.goal.id,userId]);
    const editAttempt=db.executeDeleteApprovalIfCurrent(userId,edited.approval.id);
    try{await waitForBlockedQuery(pool,appName,/goals.*FOR UPDATE/is);}finally{await blocker.query('COMMIT');inBlockerTransaction=false;}
    assert.equal((await editAttempt).status,'stale','the committed edit must be visible after the row lock clears');
    assert.equal((await db.getGoal(userId,edited.goal.id)).progress,50);
    assert.equal((await db.getApproval(userId,edited.approval.id)).status,'rejected');

    const cancelled=await stage();
    await blocker.query('BEGIN');inBlockerTransaction=true;
    await blocker.query('INSERT INTO messages(id,user_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(),userId,cancelled.conversation.id,'user','Cancel the deletion',new Date(Date.parse(cancelled.goal.created_at)-60_000).toISOString()]);
    const cancelAttempt=db.executeDeleteApprovalIfCurrent(userId,cancelled.approval.id);
    try{await waitForBlockedQuery(pool,appName,/LOCK TABLE messages IN SHARE MODE/is);}finally{await blocker.query('COMMIT');inBlockerTransaction=false;}
    assert.equal((await cancelAttempt).status,'stale','the committed cancellation must be visible after the table lock clears');
    assert.ok(await db.getGoal(userId,cancelled.goal.id));
    assert.equal((await db.getApproval(userId,cancelled.approval.id)).status,'rejected');

    // Hold DELETE inside a test-only trigger after it has read the approval,
    // target and chat turn. A second connection then tries to edit the target
    // and a third tries to append a cancellation. Both must wait until the
    // deletion commits; neither can slip between validation and deletion.
    const inFlight=await stage();
    triggerName=`delete_gate_${randomUUID().replaceAll('-','')}`;
    const pauseKey=BigInt(`0x${randomUUID().replaceAll('-','').slice(0,14)}`).toString();
    await pool.query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.id='${inFlight.goal.id}' THEN PERFORM pg_advisory_xact_lock(${pauseKey}); END IF; RETURN OLD; END $$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE DELETE ON goals FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`);
    await blocker.query('BEGIN');inBlockerTransaction=true;
    await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)',[pauseKey]);
    const deletion=db.executeDeleteApprovalIfCurrent(userId,inFlight.approval.id);
    const editor=await pool.connect(),canceller=await pool.connect();
    try{
      await waitForBlockedQuery(pool,appName,/DELETE FROM goals/is);
      const editorName=`editor_${triggerName}`;
      const cancellerName=`canceller_${triggerName}`;
      await editor.query('SELECT set_config($1,$2,false)',['application_name',editorName]);
      await canceller.query('SELECT set_config($1,$2,false)',['application_name',cancellerName]);
      const edit=editor.query('UPDATE goals SET progress=70 WHERE id=$1 AND user_id=$2',[inFlight.goal.id,userId]);
      const cancel=canceller.query('INSERT INTO messages(id,user_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(),userId,inFlight.conversation.id,'user','Cancel now',new Date().toISOString()]);
      await waitForBlockedQuery(pool,editorName,/UPDATE goals/is);
      await waitForBlockedQuery(pool,cancellerName,/INSERT INTO messages/is);
      await blocker.query('COMMIT');inBlockerTransaction=false;
      assert.equal((await deletion).status,'executed');
      assert.equal((await edit).rowCount,0,'the edit occurs only after the goal is deleted');
      assert.equal((await cancel).rowCount,1,'the newer message occurs only after deletion commits');
      assert.equal(await db.getGoal(userId,inFlight.goal.id),null);
    }finally{
      if(inBlockerTransaction){await blocker.query('ROLLBACK');inBlockerTransaction=false;}
      editor.release();canceller.release();
    }
  }finally{
    if(inBlockerTransaction)await blocker.query('ROLLBACK');
    if(triggerName){await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON goals`);await pool.query(`DROP FUNCTION IF EXISTS ${triggerName}()`);}
    blocker.release();
    if(userId)await db.deleteUserAccount(userId);
    await db.close();
    await pool.end();
  }
});
