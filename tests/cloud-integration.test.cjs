'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {PGlite}=require(process.env.SLASHTASKS_PGLITE_PATH||'@electric-sql/pglite');
const S=require('../cloud-sync.js'),M=require('../task-model.js');
const clone=v=>JSON.parse(JSON.stringify(v));
class Store{
  constructor(){this.docs={};this.chain=Promise.resolve();}
  async read(id){return clone(this.docs[id]||S.empty());}
  update(id,fn){const p=this.chain.then(()=>{const d=fn(clone(this.docs[id]||S.empty()));this.docs[id]=clone(d);return clone(d);});this.chain=p.catch(()=>{});return p;}
}
test('two devices synchronize through the actual PostgreSQL RPC protocol',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec("create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;");
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/202610200001_cloud_sync.sql'),'utf8'));
  const user=randomUUID();await db.query('insert into auth.users(id) values($1)',[user]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');
  const pull=async cursor=>(await db.query('select public.sync_pull($1) result',[cursor])).rows[0].result;
  const push=async(id,mutations)=>(await db.query('select public.apply_sync_batch($1,$2::jsonb) result',[id,JSON.stringify(mutations)])).rows[0].result;
  const aStore=new Store(),bStore=new Store();let aState,bState,loseAck=false,dropOnce=false;
  const a=new S.Engine({userId:user,store:aStore,online:()=>true,remote:{pull,push:async(id,mutations)=>{const result=await push(id,mutations);if(loseAck&&!dropOnce){dropOnce=true;throw new Error('Lost response');}return result;}},onChange:s=>aState=s});
  const b=new S.Engine({userId:user,store:bStore,online:()=>true,remote:{pull,push},onChange:s=>bState=s});
  t.after(()=>{a.stop();b.stop();});await a.start();await b.start();
  let after=clone(aState);after.tasks.push(M.normalize({tasks:[{id:'task',title:'First',steps:[{id:'step',title:'Call'}]}]}).tasks[0]);
  await a.commit(aState,after);await a.sync();await b.sync();
  assert.equal(bState.tasks[0].steps[0].title,'Call');
  const aBefore=clone(aState),bBefore=clone(bState);after=clone(aBefore);after.tasks[0].title='Renamed on A';
  await a.commit(aBefore,after);after=clone(bBefore);after.tasks[0].done=true;await b.commit(bBefore,after);
  await a.sync();await b.sync();assert.equal(bState.tasks[0].title,'Renamed on A');assert.equal(bState.tasks[0].done,true);
  await a.sync();
  const beforeA=clone(aState),beforeB=clone(bState);after=clone(beforeA);after.tasks[0].title='A wants this';await a.commit(beforeA,after);
  after=clone(beforeB);after.tasks[0].title='B wants this';await b.commit(beforeB,after);
  await a.sync();await b.sync();assert(b.doc.outbox[0].conflicts);
  await b.resolve('mine');await b.sync();await a.sync();assert.equal(aState.tasks[0].title,'B wants this');
  loseAck=true;dropOnce=false;const snapshot=clone(aState);after=clone(snapshot);after.tasks[0].dueDate='2026-10-21';
  await a.commit(snapshot,after);await a.sync();assert.equal(a.doc.outbox.length,1);
  const cursor=(await pull(0)).cursor;await a.sync();assert.equal(a.doc.outbox.length,0);assert.equal((await pull(0)).cursor,cursor);
  await b.sync();const older=clone(bState);after=clone(older);after.tasks[0].steps[0].title='Edited offline';await b.commit(older,after);
  const current=clone(aState);after=clone(current);after.tasks=[];await a.commit(current,after);await a.sync();await b.sync();
  assert(b.doc.outbox[0].conflicts);assert.equal(aState.tasks.length,0);
  await b.resolve('cloud');await b.sync();assert.equal(bState.tasks.length,0);assert.equal(b.doc.outbox.length,0);
});
