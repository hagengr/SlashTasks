'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {PGlite}=require(process.env.SLASHTASKS_PGLITE_PATH||'@electric-sql/pglite');
test('real PostgreSQL: ownership, atomic sync, conflicts, tombstones, and idempotency',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec("create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to authenticated;");
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261021042817_cloud_sync.sql'),'utf8'));
  async function user(){await db.exec('reset role');const id=randomUUID();await db.query('insert into auth.users(id) values($1)',[id]);await as(id);return id;}
  async function as(id,role='authenticated'){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec('set role '+role);}
  const pull=async(cursor=0)=>(await db.query('select public.sync_pull($1) result',[cursor])).rows[0].result;
  const push=async(mutations,id=randomUUID())=>(await db.query('select public.apply_sync_batch($1,$2::jsonb) result',[id,JSON.stringify(mutations)])).rows[0].result;
  const taskData=(title='Task')=>({title,list:'Personal',energy:'small',repeat:'none',done:false,dueDate:'',reminderDate:'',reminderTime:'',remindersEnabled:false,priority:1});
  const create=(id,data=taskData(),kind='tasks')=>({kind,id,patch:data,baseVersion:0,baseFields:{}});
  const edit=(row,patch)=>({kind:row.kind,id:row.id,patch,baseVersion:row.version,baseFields:Object.fromEntries(Object.keys(patch).map(k=>[k,row.fieldVersions[k]||0]))});
  async function get(id,kind='tasks'){return (await pull()).changes.find(r=>r.id===id&&r.kind===kind);}
  await t.test('a new email identity gets a private profile, default lists, and no example tasks',async()=>{
    const id=await user(),snapshot=await pull();
    assert.equal(snapshot.changes.filter(r=>r.kind==='profiles')[0].id,id);
    assert.equal(snapshot.changes.filter(r=>r.kind==='lists').length,3);
    assert.equal(snapshot.changes.filter(r=>r.kind==='tasks').length,0);
  });
  await t.test('row-level security isolates accounts and direct client writes are denied',async()=>{
    const a=await user();await push([create('shared',taskData('A'))]);
    const b=await user();assert.equal((await db.query('select * from public.tasks')).rows.length,0);
    await push([create('shared',taskData('B'))]);
    assert.equal((await db.query("select data->>'title' title from public.tasks")).rows[0].title,'B');
    await assert.rejects(db.query("update public.tasks set data='{}'"),/permission denied/);
    await as(a);assert.equal((await get('shared')).data.title,'A');await as(b);
  });
  await t.test('retries with the same batch return a receipt without duplicate changes',async()=>{
    await user();const id=randomUUID(),mutation=[create('idempotent')];
    const first=await push(mutation,id),cursor=(await pull()).cursor;
    assert.deepEqual(await push(mutation,id),first);assert.equal((await pull()).cursor,cursor);
    await assert.rejects(push([create('different')],id),/reused/);
  });
  await t.test('different fields merge while same-field changes require an explicit choice',async()=>{
    await user();await push([create('merge')]);const base=await get('merge');
    await push([edit(base,{title:'Remote name'})]);
    assert.equal((await push([edit(base,{done:true})])).ok,true);
    const conflict=await push([edit(base,{title:'Offline name'})]);
    assert.equal(conflict.ok,false);assert(conflict.conflicts[0].fields.includes('title'));
    const current=await get('merge');assert.equal(current.data.title,'Remote name');assert.equal(current.data.done,true);
  });
  await t.test('an action containing a conflicting task and new steps is rejected atomically',async()=>{
    await user();await push([create('atomic')]);const base=await get('atomic');
    await push([edit(base,{title:'Other device'})]);
    const result=await push([edit(base,{title:'Mine'}),create('step-atomic',{title:'New step',taskId:'atomic',done:false,position:0},'subtasks')]);
    assert.equal(result.ok,false);assert.equal(await get('step-atomic','subtasks'),undefined);
  });
  await t.test('deletes leave tombstones; a delayed edit cannot resurrect a task or its children',async()=>{
    await user();await push([create('parent'),create('child',{taskId:'parent',title:'Child',done:false,position:0},'subtasks')]);
    const task=await get('parent'),step=await get('child','subtasks');
    await push([{...edit(task,{}),delete:true}]);
    assert.equal((await get('child','subtasks')).deleted,true);
    const result=await push([edit(step,{title:'Late edit'})]);assert.equal(result.ok,false);
    assert.equal((await get('parent')).deleted,true);
  });
  await t.test('an explicit restore with the current tombstone version supports Undo',async()=>{
    await user();await push([create('restore')]);const base=await get('restore');
    await push([{...edit(base,{}),delete:true}]);const tombstone=await get('restore');
    const result=await push([{...edit(tombstone,{title:'Restored'}),restore:true}]);
    assert.equal(result.ok,true);assert.equal((await get('restore')).deleted,false);
  });
  await t.test('a step cannot attach to another account’s task',async()=>{
    const a=await user();await push([create('foreign-parent')]);await user();
    const result=await push([create('foreign-child',{taskId:'foreign-parent',title:'Child',position:0},'subtasks')]);
    assert.equal(result.ok,false);assert.equal(result.conflicts[0].reason,'parent_deleted');await as(a);
  });
  await t.test('profiles cannot be written for another identity and anonymous RPC calls are denied',async()=>{
    await user();await assert.rejects(push([create(randomUUID(),{displayName:'Intruder',timezone:'UTC',reminderTime:'09:00'},'profiles')]),/ownership/);
    await as(null,'anon');await assert.rejects(pull(),/permission denied/);
  });
  await t.test('recurrence uniqueness detects duplicate next occurrences instead of creating two',async()=>{
    await user();await push([create('next-a',{...taskData(),sourceOccurrenceId:'original'})]);
    const result=await push([create('next-b',{...taskData(),sourceOccurrenceId:'original'})]);
    assert.equal(result.ok,false);assert.equal(result.conflicts[0].reason,'recurrence_changed');
  });
  await t.test('invalid fields, malformed dates, and invalid cursors fail without writing',async()=>{
    await user();await assert.rejects(push([create('bad',{...taskData(),user_id:randomUUID()})]),/Unknown field/);
    await assert.rejects(push([create('bad-date',{...taskData(),dueDate:'2026-02-30'})]),/date|range/);
    assert.equal(await get('bad'),undefined);await assert.rejects(pull(999999),/Invalid sync cursor/);
  });
  await t.test('incremental pull includes a deletion rather than dropping it from other devices',async()=>{
    await user();await push([create('gone')]);const before=await pull(),base=await get('gone');
    await push([{...edit(base,{}),delete:true}]);
    const changes=(await pull(before.cursor)).changes;assert.equal(changes.length,1);assert.equal(changes[0].deleted,true);
  });
  await t.test('AI request allowance is per user and enforced by the database',async()=>{
    await user();
    for(let i=0;i<3;i++)assert.equal((await db.query('select public.reserve_ai_request() result')).rows[0].result.allowed,true);
    assert.equal((await db.query('select public.reserve_ai_request() result')).rows[0].result.allowed,false);
    await user();assert.equal((await db.query('select public.reserve_ai_request() result')).rows[0].result.allowed,true);
  });
});
