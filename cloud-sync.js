/* Durable per-account journal + deterministic sync protocol. No UI or SDK dependency. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./task-model.js'));
  else root.SlashTasksSync = factory(root.SlashTasksModel);
})(globalThis, function(M) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const equal = (a,b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const keyOf = row => row.kind + '/' + row.id;
  const taskFields = ['title','list','energy','dueDate','reminderDate','reminderTime','remindersEnabled','repeat','done','priority','seriesId','nextOccurrenceId','sourceOccurrenceId','snoozedUntil'];
  const stepFields = ['title','dueDate','dueTime','done','seriesStepId'];
  const pick = (object, fields) => Object.fromEntries(fields.filter(k => object[k] !== undefined).map(k => [k,object[k]]));
  function empty() { return { cursor: 0, records: {}, outbox: [], alerts: {}, acknowledged: {}, lastSync: null }; }
  function flatten(state, userId, profile) {
    const rows = {};
    const put = row => { rows[keyOf(row)] = row; };
    for (const name of state.lists) put({ kind:'lists', id:'list:' + name, data:{name} });
    for (const task of state.tasks) {
      put({ kind:'tasks',id:task.id,data:pick(task,taskFields) });
      task.steps.forEach((s,position) => put({ kind:'subtasks',id:s.id,data:{...pick(s,stepFields),taskId:task.id,position} }));
    }
    if (profile) put({ kind:'profiles',id:userId,data:pick(profile,['displayName','timezone','reminderTime']) });
    return rows;
  }
  function overlay(doc) {
    const rows = copy(doc.records);
    for (const batch of doc.outbox) for (const mutation of batch.mutations) {
      const k = keyOf(mutation), previous = rows[k] || { ...mutation, data:{}, fieldVersions:{},version:0 };
      const next = { ...previous, data:{...previous.data,...mutation.patch},fieldVersions:{...previous.fieldVersions},version:'local:' + batch.id,
        deleted:!!mutation.delete };
      for (const field of Object.keys(mutation.patch)) next.fieldVersions[field] = 'local:' + batch.id;
      rows[k] = next;
      if (mutation.kind === 'tasks' && mutation.delete) {
        for (const child of Object.values(rows)) if (child.kind === 'subtasks' && child.data.taskId === mutation.id) child.deleted = true;
      }
    }
    return rows;
  }
  function toState(rows, alerts = {}) {
    const tasks = Object.values(rows).filter(r => r.kind==='tasks' && !r.deleted).map(row => {
      const task = {id:row.id,...row.data,steps:[]};
      task.steps = Object.values(rows).filter(s => s.kind==='subtasks' && !s.deleted && s.data.taskId===row.id)
        .sort((a,b) => a.data.position-b.data.position || a.id.localeCompare(b.id)).map(s => ({id:s.id,...s.data}));
      return task;
    });
    const state = M.normalize({ tasks,lists:Object.values(rows).filter(r => r.kind==='lists'&&!r.deleted).map(r => r.data.name) });
    for (const task of state.tasks) {
      const signature = [task.reminderDate,task.reminderTime,task.remindersEnabled,task.snoozedUntil].join('|');
      const alert = alerts['tasks/'+task.id];
      task.reminderNotifiedAt = alert?.signature === signature ? alert.stamp : null;
      for (const step of task.steps) {
        const entry=alerts['subtasks/'+step.id], stepSignature=[step.dueDate,step.dueTime,task.reminderTime,task.remindersEnabled].join('|');
        step.reminderNotifiedAt=entry?.signature===stepSignature?entry.stamp:null;
      }
    }
    return state;
  }
  function diff(before, after, observed) {
    const mutations = [];
    for (const k of new Set([...Object.keys(before),...Object.keys(after)])) {
      const a=before[k], b=after[k], base=observed[k];
      if (!b) { if(a) mutations.push({kind:a.kind,id:a.id,delete:true,patch:{},baseVersion:base?.version||0,baseFields:{}}); continue; }
      const patch = {};
      for (const field of new Set([...Object.keys(a?.data||{}),...Object.keys(b.data)])) {
        if (!equal(a?.data[field],b.data[field])) patch[field] = b.data[field] ?? null;
      }
      if (!Object.keys(patch).length && a) continue;
      mutations.push({kind:b.kind,id:b.id,patch,baseVersion:base?.version||0,
        baseFields:Object.fromEntries(Object.keys(patch).map(field=>[field,base?.fieldVersions?.[field]||0])),
        ...(base?.deleted ? {restore:true} : {})});
    }
    return mutations;
  }
  function mergeRecords(doc, changes) {
    for (const row of changes) {
      if (!row || !['tasks','subtasks','lists','profiles'].includes(row.kind) || !Number.isSafeInteger(row.version)) throw new Error('Unreadable cloud response.');
      const k=keyOf(row);
      if (!doc.records[k] || row.version>=doc.records[k].version) doc.records[k]=copy(row);
    }
  }
  function rebaseRefs(doc, oldId, changes, replacementId) {
    const rows=Object.fromEntries(changes.map(row=>[keyOf(row),row])), token='local:'+oldId;
    for (const batch of doc.outbox) for (const m of batch.mutations) {
      const row=rows[keyOf(m)]||doc.records[keyOf(m)];
      if (m.baseVersion===token) m.baseVersion=replacementId?'local:'+replacementId:(row?.version||0);
      for (const field of Object.keys(m.baseFields)) if (m.baseFields[field]===token) m.baseFields[field]=replacementId?'local:'+replacementId:(row?.fieldVersions?.[field]||0);
    }
  }
  function applyAck(doc, batchId, result) {
    mergeRecords(doc,result.changes);
    doc.acknowledged ||= {};
    doc.acknowledged[batchId]=Object.fromEntries(result.changes.map(row=>[keyOf(row),{version:row.version,fieldVersions:row.fieldVersions}]));
    rebaseRefs(doc,batchId,result.changes);
    doc.outbox=doc.outbox.filter(batch=>batch.id!==batchId);
    // A write acknowledgement is not a pull cursor: unseen concurrent rows may exist.
    return doc;
  }
  function undoState(current, before, after, userId) {
    const present=flatten(current,userId), old=flatten(before,userId), changed=flatten(after,userId), rows=copy(present);
    for (const m of diff(old,changed,{})) {
      const k=keyOf(m), live=present[k], expected=changed[k];
      if (m.delete) {
        if (live) throw new Error('This item has changed since that action. Open it to review.');
        rows[k]=old[k]; continue;
      }
      if (!old[k]) {
        if (!equal(live?.data,expected?.data)) throw new Error('This item has changed since that action. Open it to review.');
        delete rows[k]; continue;
      }
      for (const field of Object.keys(m.patch)) {
        if (!equal(live?.data[field],expected.data[field])) throw new Error('This item has changed since that action. Open it to review.');
        rows[k].data[field]=old[k].data[field]??null;
      }
    }
    return toState(rows);
  }

  class IndexedJournal {
    constructor(indexedDB = globalThis.indexedDB, name = 'slashtasks-cloud-v1') {
      this.ready = new Promise((resolve,reject)=>{
        if (!indexedDB) return reject(new Error('This browser cannot store an offline copy.'));
        const open=indexedDB.open(name,1);
        open.onupgradeneeded=()=>open.result.createObjectStore('accounts');
        open.onsuccess=()=>resolve(open.result);
        open.onerror=()=>reject(open.error);
        open.onblocked=()=>reject(new Error('Close older SlashTasks tabs and try again.'));
      });
    }
    async update(userId, change) {
      const db=await this.ready;
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('accounts','readwrite'), store=tx.objectStore('accounts'), request=store.get(userId);
        let result;
        request.onsuccess=()=>{
          try { result=change(request.result||empty()); store.put(result,userId); }
          catch(error) { tx.abort(); reject(error); }
        };
        tx.oncomplete=()=>resolve(copy(result));
        tx.onerror=()=>reject(tx.error||new Error('Could not save the offline queue.'));
        tx.onabort=()=>reject(tx.error||new Error('Offline save was canceled.'));
      });
    }
    async read(userId) {
      const db=await this.ready;
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('accounts','readonly'), request=tx.objectStore('accounts').get(userId);
        request.onsuccess=()=>resolve(copy(request.result||empty()));
        request.onerror=()=>reject(request.error);
      });
    }
  }
  class Engine {
    constructor({userId,store,remote,onChange=()=>{},onStatus=()=>{},online=()=>true,lock=async(_name,work)=>work(),broadcast=()=>{}}) {
      Object.assign(this,{userId,store,remote,onChange,onStatus,online,lock,broadcast});
      this.doc=empty();this.observed={};this.stopped=false;this.running=null;this.retry=0;this.timer=null;this.epoch=0;
    }
    publish(doc) {
      if(this.stopped)return;
      this.doc=doc;this.observed=overlay(doc);
      const profile=this.observed['profiles/'+this.userId]?.data||{displayName:'',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,reminderTime:'09:00'};
      this.onChange(toState(this.observed,doc.alerts),copy(profile));
      this.onStatus({pending:doc.outbox.length,conflict:doc.outbox.find(b=>b.conflicts),lastSync:doc.lastSync,offline:!this.online()});
    }
    async start() { this.publish(await this.store.read(this.userId)); return this.sync(); }
    async reload() { if(!this.stopped)this.publish(await this.store.read(this.userId)); }
    async commit(before,after,expected,profileBefore,profileAfter) {
      if(this.stopped) throw new Error('Sign in before making changes.');
      const observed=copy(expected||this.observed);
      const mutations=diff(flatten(before,this.userId,profileBefore),flatten(after,this.userId,profileAfter),observed);
      if(mutations.length>200||new TextEncoder().encode(JSON.stringify(mutations)).length>250000){
        throw new Error('This change is too large to save at once. Save fewer steps, or import a smaller backup.');
      }
      const batch={id:M.id(),mutations,createdAt:new Date().toISOString()};
      const alerts={};
      for(const task of after.tasks) {
        alerts['tasks/'+task.id]={signature:[task.reminderDate,task.reminderTime,task.remindersEnabled,task.snoozedUntil].join('|'),stamp:task.reminderNotifiedAt||null};
        for(const s of task.steps) alerts['subtasks/'+s.id]={signature:[s.dueDate,s.dueTime,task.reminderTime,task.remindersEnabled].join('|'),stamp:s.reminderNotifiedAt||null};
      }
      const doc=await this.store.update(this.userId,current=>{
        for(const mutation of mutations){
          const resolve=(value,field)=>{
            if(typeof value!=='string')return value;
            const receipt=current.acknowledged?.[value.slice(6)];
            if(receipt){const row=receipt[keyOf(mutation)];return field?(row?.fieldVersions?.[field]||0):(row?.version||0);}
            if(current.outbox.some(b=>'local:'+b.id===value))return value;
            throw new Error('This draft refers to an older pending change. Keep a copy, then reopen the editor.');
          };
          mutation.baseVersion=resolve(mutation.baseVersion);
          for(const field of Object.keys(mutation.baseFields))mutation.baseFields[field]=resolve(mutation.baseFields[field],field);
        }
        if(mutations.length)current.outbox.push(batch);
        current.alerts={...current.alerts,...alerts};return current;
      });
      this.publish(doc);this.broadcast();
      if(mutations.length)this.schedule(0);
      return batch;
    }
    schedule(delay) { clearTimeout(this.timer); if(!this.stopped)this.timer=setTimeout(()=>this.sync(),delay); }
    async sync() {
      if(this.stopped||!this.online()) { if(!this.stopped)this.publish(await this.store.read(this.userId));return; }
      if(this.running)return this.running;
      this.running=this.lock('slashtasks-sync-'+this.userId,()=>this.flush());
      try{await this.running;}finally{this.running=null;}
    }
    async pull() {
      if(this.stopped)return;
      const current=await this.store.read(this.userId), result=await this.remote.pull(current.cursor);
      if(this.stopped)return;
      const doc=await this.store.update(this.userId,d=>{
        if(!Number.isSafeInteger(result.cursor)||result.cursor<0)throw new Error('Cloud sync returned an invalid cursor.');
        mergeRecords(d,result.changes);d.cursor=Math.max(d.cursor,result.cursor);return d;
      });
      this.publish(doc);
    }
    async flush() {
      if(this.stopped)return;
      try {
        await this.pull();
        while(!this.stopped) {
          let doc=await this.store.read(this.userId), batch=doc.outbox[0];
          if(!batch||batch.conflicts)break;
          if(batch.mutations.some(m=>typeof m.baseVersion==='string'||Object.values(m.baseFields).some(v=>typeof v==='string')))throw new Error('A pending change is waiting for its earlier save.');
          const result=await this.remote.push(batch.id,batch.mutations);
          if(this.stopped)return;
          if(!result.ok) {
            if(!Array.isArray(result.conflicts)||!result.conflicts.length)throw new Error('Unreadable cloud conflict response.');
            doc=await this.store.update(this.userId,d=>{const pending=d.outbox.find(b=>b.id===batch.id);if(pending)pending.conflicts=result.conflicts;return d;});
            this.publish(doc);this.broadcast();break;
          }
          doc=await this.store.update(this.userId,d=>applyAck(d,batch.id,result));this.publish(doc);this.broadcast();
        }
        if(this.stopped)return;
        await this.pull();
        const doc=await this.store.update(this.userId,d=>{d.lastSync=new Date().toISOString();return d;});
        this.publish(doc);this.retry=0;this.schedule(30000);
      } catch(error) {
        if(this.stopped)return;
        this.onStatus({error:error.message||'Cloud unavailable. Changes are saved on this device.',pending:this.doc.outbox.length,conflict:this.doc.outbox.find(b=>b.conflicts),offline:!this.online(),lastSync:this.doc.lastSync});
        this.retry=Math.min(this.retry+1,7);this.schedule(Math.min(60000,1000*2**this.retry)+Math.random()*500);
      }
    }
    async resolve(choice) {
      const doc=await this.store.update(this.userId,d=>{
        const batch=d.outbox[0];
        if(!batch?.conflicts)return d;
        if(choice==='mine') {
          if(batch.conflicts.some(c=>['deleted','parent_deleted','missing','recurrence_changed'].includes(c.reason)))throw new Error('This item was deleted elsewhere. Use the cloud version, or export your offline copy first.');
          const old=batch.id;batch.id=M.id();delete batch.conflicts;
          for(const mutation of batch.mutations) {
            const row=d.records[keyOf(mutation)];mutation.baseVersion=row?.version||0;
            mutation.baseFields=Object.fromEntries(Object.keys(mutation.patch).map(field=>[field,row?.fieldVersions?.[field]||0]));
          }
          rebaseRefs(d,old,[],batch.id);
        }else {
          d.acknowledged ||= {};
          d.acknowledged[batch.id]=Object.fromEntries(batch.mutations.map(m=>[keyOf(m),{version:d.records[keyOf(m)]?.version||0,fieldVersions:d.records[keyOf(m)]?.fieldVersions||{}}]));
          rebaseRefs(d,batch.id,[]);
          d.outbox.shift();
        }
        return d;
      });
      this.publish(doc);this.broadcast();this.schedule(0);
    }
    stop(){this.stopped=true;this.epoch++;clearTimeout(this.timer);this.remote.cancel?.();}
  }
  return {IndexedJournal,Engine,empty,flatten,overlay,toState,diff,mergeRecords,applyAck,rebaseRefs,undoState,keyOf,equal};
});
