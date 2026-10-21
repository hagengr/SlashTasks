'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../cloud-sync.js'),M=require('../task-model.js');
const clone=v=>JSON.parse(JSON.stringify(v)),uid='user-one';
const row=(id,data,version=1,kind='tasks')=>({kind,id,data,version,fieldVersions:Object.fromEntries(Object.keys(data).map(k=>[k,version])),deleted:false});
const task=(title='Original')=>M.normalize({tasks:[{id:'task',title,dueDate:'2026-10-20'}]});
class MemoryJournal{
  constructor(doc=S.empty()){this.docs={[uid]:clone(doc)};this.chain=Promise.resolve();}
  async read(id){return clone(this.docs[id]||S.empty());}
  update(id,fn){const result=this.chain.then(()=>{const d=fn(clone(this.docs[id]||S.empty()));this.docs[id]=clone(d);return clone(d);});this.chain=result.catch(()=>{});return result;}
}
function offlineEngine(t,doc=S.empty()){
  const store=new MemoryJournal(doc);
  const engine=new S.Engine({userId:uid,store,online:()=>false,remote:{}});
  t.after(()=>engine.stop());return {store,engine};
}
test('field patches exclude untouched fields and notification flags',()=>{
  const a=task(),b=clone(a);b.tasks[0].done=true;b.tasks[0].reminderNotifiedAt='local-only';
  const changes=S.diff(S.flatten(a,uid),S.flatten(b,uid),{});
  assert.deepEqual(changes[0].patch,{done:true});
});
test('subtasks have independent records instead of replacing a steps array',()=>{
  const a=task(),b=clone(a);b.tasks[0].steps=[M.step({id:'step',title:'Call',dueTime:'10:00'})];
  const changes=S.diff(S.flatten(a,uid),S.flatten(b,uid),{});
  assert.equal(changes.length,1);assert.equal(changes[0].kind,'subtasks');assert.equal(changes[0].patch.taskId,'task');
});
test('offline operations are durable before the caller receives success and survive reload',async t=>{
  const {store,engine}=offlineEngine(t);await engine.start();
  const a=M.normalize({}),b=task('Offline');
  await engine.commit(a,b);
  const saved=await store.read(uid);assert.equal(saved.outbox.length,1);
  assert.equal(S.toState(S.overlay(saved)).tasks[0].title,'Offline');
});
test('pending edits depend on the earlier local write and rebase to its acknowledged field version',()=>{
  const d=S.empty();d.records['tasks/task']=row('task',{title:'A'},1);
  d.outbox=[{id:'first',mutations:[{kind:'tasks',id:'task',patch:{title:'B'},baseVersion:1,baseFields:{title:1}}]}];
  const observed=S.overlay(d);
  const changes=S.diff({'tasks/task':{kind:'tasks',id:'task',data:{title:'B'}}},{'tasks/task':{kind:'tasks',id:'task',data:{title:'C'}}},observed);
  d.outbox.push({id:'second',mutations:changes});
  S.applyAck(d,'first',{changes:[row('task',{title:'B'},2)]});
  assert.equal(d.outbox[0].mutations[0].baseFields.title,2);
  assert.equal(S.toState(S.overlay(d)).tasks[0].title,'C');
});
test('acknowledging a push never advances the pull cursor and misses concurrent rows',()=>{
  const d=S.empty();d.cursor=4;d.outbox=[{id:'one',mutations:[]}];
  S.applyAck(d,'one',{changes:[row('a',{title:'A'},9)]});
  assert.equal(d.cursor,4);
  S.mergeRecords(d,[row('b',{title:'Concurrent'},8)]);
  assert(d.records['tasks/b']);
});
test('an editor kept open across an acknowledgement uses the original acknowledged base, not a later remote version',async t=>{
  const d=S.empty();d.records['tasks/task']=row('task',{...S.flatten(task(),uid)['tasks/task'].data},1);
  d.outbox=[{id:'old-local',mutations:[{kind:'tasks',id:'task',patch:{title:'Local'},baseVersion:1,baseFields:{title:1}}]}];
  const openEditor=S.overlay(d),before=S.toState(openEditor);
  S.applyAck(d,'old-local',{changes:[row('task',{...d.records['tasks/task'].data,title:'Local'},2)]});
  S.mergeRecords(d,[row('task',{...d.records['tasks/task'].data,title:'Remote later'},3)]);
  const {store,engine}=offlineEngine(t,d);await engine.start();
  const after=clone(before);after.tasks[0].title='My edited draft';
  await engine.commit(before,after,openEditor);
  const queued=(await store.read(uid)).outbox[0];
  assert.equal(queued.mutations[0].baseFields.title,2);
});
test('outbox journals are separated by account',async()=>{
  const store=new MemoryJournal();await store.update('account-a',d=>{d.outbox.push({id:'private'});return d;});
  assert.equal((await store.read('account-b')).outbox.length,0);
});
test('deleting a parent hides its steps immediately without reviving them',()=>{
  const d=S.empty();d.records['tasks/task']=row('task',{title:'Parent'},1);
  d.records['subtasks/step']=row('step',{taskId:'task',title:'Child'},1,'subtasks');
  d.outbox=[{id:'del',mutations:[{kind:'tasks',id:'task',delete:true,patch:{}}]}];
  assert.equal(S.toState(S.overlay(d)).tasks.length,0);
});
test('conflicts remain queued, and explicitly keeping mine creates a new idempotency key',async t=>{
  const d=S.empty();d.records['tasks/task']=row('task',{title:'Remote'},3);
  d.outbox=[{id:'conflicted',mutations:[{kind:'tasks',id:'task',patch:{title:'Local'},baseVersion:1,baseFields:{title:1}}],
    conflicts:[{kind:'tasks',id:'task',reason:'field_conflict'}]}];
  const {store,engine}=offlineEngine(t,d);await engine.start();await engine.resolve('mine');
  const saved=await store.read(uid);assert.notEqual(saved.outbox[0].id,'conflicted');
  assert.equal(saved.outbox[0].mutations[0].baseFields.title,3);
});
test('a cloud deletion cannot be accidentally restored by Keep mine',async t=>{
  const d=S.empty();d.outbox=[{id:'bad',mutations:[],conflicts:[{reason:'deleted'}]}];
  const {engine}=offlineEngine(t,d);await engine.start();await assert.rejects(engine.resolve('mine'),/deleted elsewhere/);
});
test('Undo preserves unrelated concurrent fields and refuses an overwrite of a changed field',()=>{
  const before=task(),after=clone(before);after.tasks[0].done=true;
  const current=clone(after);current.tasks[0].title='Remote title';
  const undone=S.undoState(current,before,after,uid);
  assert.equal(undone.tasks[0].title,'Remote title');assert.equal(undone.tasks[0].done,false);
  current.tasks[0].done=false;assert.throws(()=>S.undoState(current,before,after,uid),/changed since/);
});
test('simultaneous completions create matching recurrence and step identities',()=>{
  const a=M.normalize({tasks:[{id:'repeat',title:'Daily',repeat:'daily',dueDate:'2026-10-20',steps:[{id:'original-step',title:'First'}]}]}),b=clone(a);
  M.toggleTask(a,a.tasks[0],'2026-10-20');M.toggleTask(b,b.tasks[0],'2026-10-20');
  assert.equal(a.tasks[0].id,b.tasks[0].id);assert.equal(a.tasks[0].steps[0].id,b.tasks[0].steps[0].id);
  const reloaded=M.normalize(a);M.toggleTask(reloaded,reloaded.tasks[0],'2026-10-21');
  assert(reloaded.tasks[0].steps[0].id.length<200);
});
test('a lost acknowledgement retries the same batch and removes it only after durable acknowledgement',async t=>{
  const store=new MemoryJournal(),accepted=new Map();let lose=true,requests=[];
  const remote={pull:async()=>({cursor:0,changes:[]}),push:async(id,mutations)=>{
    requests.push(id);if(!accepted.has(id))accepted.set(id,{ok:true,changes:mutations.map(m=>row(m.id,m.patch,1,m.kind))});
    if(lose){lose=false;throw new Error('Connection lost after commit');}return accepted.get(id);
  }};
  const engine=new S.Engine({userId:uid,store,remote,online:()=>true});t.after(()=>engine.stop());
  await engine.commit(M.normalize({}),task());await engine.sync();assert.equal((await store.read(uid)).outbox.length,1);
  await engine.sync();assert.equal((await store.read(uid)).outbox.length,0);
  assert.equal(requests[0],requests[1]);assert.equal(accepted.size,1);
});
test('a stopped account waiting for a network lock never starts a request with another account’s session',async()=>{
  let release,calls=0;const gate=new Promise(resolve=>release=resolve);
  const engine=new S.Engine({userId:uid,store:new MemoryJournal(),online:()=>true,lock:async(_name,work)=>{await gate;return work();},remote:{pull:async()=>{calls++;return {cursor:0,changes:[]};}}});
  const pending=engine.sync();engine.stop();release();await pending;assert.equal(calls,0);
});
