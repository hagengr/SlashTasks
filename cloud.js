/* Supabase auth + cloud UI. The journal in cloud-sync.js is independent of this SDK. */
(() => {
  'use strict';
  const $=s=>document.querySelector(s);
  const S=window.SlashTasksSync;
  let client,engine,callbacks={},accountId=null,journal,channel,realtime,sessionEpoch=0,sendAfter=0,config={},profileDraft=null;
  const escape=text=>String(text??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const requestControllers=new Set();
  function errorText(error) {
    const code=error?.code||'';
    if(/email_address_not_authorized/.test(code))return 'The email sender is still in private testing. Please use the email on your Supabase account.';
    if(/over_email_send_rate_limit|over_request_rate_limit/.test(code))return 'Please wait before requesting another email. Check your inbox and spam folder for the earlier code.';
    if(/otp_expired/.test(code))return 'That code expired or was already used. Request a new code.';
    return error?.message||'Could not connect. Please check your internet connection.';
  }
  async function rpc(name,args,expectedUser) {
    const controller=new AbortController();requestControllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),20000);
    try{
      const {data:sessionData,error:sessionError}=await client.auth.getSession();
      if(sessionError||sessionData.session?.user.id!==expectedUser||controller.signal.aborted)throw new Error('Sign in again to synchronize this account.');
      const response=await fetch(config.url+'/rest/v1/rpc/'+name,{method:'POST',signal:controller.signal,
        headers:{apikey:config.publishableKey,Authorization:'Bearer '+sessionData.session.access_token,'Content-Type':'application/json'},
        body:JSON.stringify(args)});
      const data=await response.json();
      if(!response.ok)throw new Error(data.code==='PGRST202'?'Cloud storage is still being configured. Your offline changes are kept.':data.message||'Could not synchronize. Your offline changes are kept.');
      return data;
    }finally{clearTimeout(timer);requestControllers.delete(controller);}
  }
  function showStatus(status) {
    const conflict=status.conflict;
    $('#syncStatus').textContent=conflict?'Review a sync conflict':status.error?'Connection interrupted · Changes kept on this device':
      status.offline?'Offline · Changes kept on this device':status.pending?status.pending+' change'+(status.pending===1?'':'s')+' waiting to sync':'Saved to cloud';
    if(!status.lastSync&&!status.pending&&!conflict&&!status.offline)$('#syncStatus').textContent='Connecting to your cloud…';
    $('#syncStatus').classList.toggle('error',!!conflict||!!status.error);
    $('#syncDetail').textContent=status.error||'';
    $('#syncConflict').hidden=!conflict;
    if(conflict) {
      const labels={title:'Name',dueDate:'Due date',dueTime:'Time',done:'Completion',list:'List',energy:'Energy',reminderDate:'Reminder date',reminderTime:'Reminder time'};
      $('#conflictItems').innerHTML=conflict.conflicts.map(c=>{
        const mutation=conflict.mutations.find(m=>m.kind===c.kind&&m.id===c.id);
        const local=engine?.observed[S.keyOf(c)];
        return '<article><strong>'+escape(local?.data.title||local?.data.name||'Profile')+'</strong><p>'+
          (c.reason==='deleted'||c.reason==='parent_deleted'?'This item or its parent was deleted on another device.':
          c.reason==='record_changed'?'This item changed on another device before your deletion.':'Both devices edited the same field.')+'</p>'+
          (c.fields||[]).map(field=>'<div class="conflict-values"><span>'+escape(labels[field]||field)+'</span><span>Your change: '+escape(mutation?.patch[field])+
          '</span><span>Cloud: '+escape(c.remote?.data?.[field])+'</span></div>').join('')+'</article>';
      }).join('');
      $('#keepLocalChange').disabled=conflict.conflicts.some(c=>['deleted','parent_deleted','missing','recurrence_changed'].includes(c.reason));
    }
    callbacks.status?.(status);
  }
  async function activate(session) {
    const uid=session?.user?.id||null;
    if(uid===accountId&&engine)return;
    sessionEpoch++;
    engine?.stop();engine=null;
    if(realtime){client.removeChannel(realtime);realtime=null;}
    accountId=uid;
    callbacks.account?.(session?.user||null);
    $('#authPanel').hidden=!!uid;$('#appShell').hidden=!uid;
    if(!uid)return;
    $('#accountEmail').textContent=session.user.email||'Your account';
    $('#accountName').textContent='Your profile';
    journal ||= new S.IndexedJournal(globalThis.indexedDB,'slashtasks-cloud-'+new URL(config.url).hostname);
    const epoch=sessionEpoch;
    engine=new S.Engine({
      userId:uid,store:journal,online:()=>navigator.onLine!==false,
      remote:{pull:cursor=>rpc('sync_pull',{p_cursor:cursor},uid),push:(id,mutations)=>rpc('apply_sync_batch',{p_batch_id:id,p_mutations:mutations},uid),
        cancel:()=>{for(const controller of requestControllers)controller.abort();requestControllers.clear();}},
      lock:async(name,work)=>navigator.locks?navigator.locks.request(name,{mode:'exclusive'},work):work(),
      broadcast:()=>channel?.postMessage({userId:uid}),
      onChange:(state,profile)=>{if(epoch!==sessionEpoch)return;$('#accountName').textContent=profile.displayName||'Your profile';callbacks.state?.(state,profile);},
      onStatus:status=>{if(epoch===sessionEpoch)showStatus(status);}
    });
    try{
      await engine.start();
      if(epoch!==sessionEpoch)return;
      realtime=client.channel('account-'+uid).on('postgres_changes',{event:'UPDATE',schema:'public',table:'sync_heads',filter:'user_id=eq.'+uid},()=>engine?.sync()).subscribe();
    }catch(error){
      if(epoch!==sessionEpoch)return;
      $('#syncStatus').textContent='Offline storage unavailable';$('#syncDetail').textContent=errorText(error);
      callbacks.locked?.(true);
    }
  }
  async function start(handlers) {
    callbacks=handlers;
    $('#appShell').hidden=true;$('#authPanel').hidden=false;
    try{
      config=window.SLASHTASKS_CLOUD||{};
      if(!config.url&&location.protocol!=='file:'){
        const response=await fetch('/api/cloud-config',{cache:'no-store'});
        if(response.ok)config=await response.json();
      }
      if(!config.url||!config.publishableKey){
        $('#authStatus').textContent='Your cloud workspace is not configured yet. The project connection needs to be set up before signing in.';
        $('#emailSignInForm').hidden=true;return;
      }
      client=window.supabase.createClient(config.url,config.publishableKey,{
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:'slashtasks-auth-'+new URL(config.url).hostname}
      });
      channel=typeof BroadcastChannel==='function'?new BroadcastChannel('slashtasks-cloud'):null;
      if(channel)channel.onmessage=event=>{if(event.data?.userId===accountId)engine?.reload();};
      client.auth.onAuthStateChange((_event,session)=>setTimeout(()=>activate(session),0));
      const {data,error}=await client.auth.getSession();
      if(error)throw error;
      await activate(data.session);
      $('#authStatus').textContent='';
      window.addEventListener('online',()=>engine?.sync());
      window.addEventListener('offline',()=>engine?.reload());
      window.addEventListener('focus',()=>engine?.sync());
      document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')engine?.sync();});
    }catch(error){$('#authStatus').textContent=errorText(error);}
  }
  $('#emailSignInForm').addEventListener('submit',async event=>{
    event.preventDefault();if(!client)return;
    if(Date.now()<sendAfter){$('#authStatus').textContent='Check your email, or wait a moment before requesting another code.';return;}
    const email=$('#signInEmail').value.trim();
    $('#sendCode').disabled=true;$('#authStatus').textContent='Sending your sign-in code…';
    try{
      const {error}=await client.auth.signInWithOtp({email,options:{shouldCreateUser:true}});
      if(error)throw error;
      sendAfter=Date.now()+60000;$('#verifyCodeForm').hidden=false;$('#authStatus').textContent='Check your inbox for your sign-in code.';$('#signInCode').focus();
    }catch(error){$('#authStatus').textContent=errorText(error);}
    finally{$('#sendCode').disabled=false;}
  });
  $('#verifyCodeForm').addEventListener('submit',async event=>{
    event.preventDefault();if(!client)return;
    $('#verifyCode').disabled=true;
    try{
      const {error}=await client.auth.verifyOtp({email:$('#signInEmail').value.trim(),token:$('#signInCode').value.trim(),type:'email'});
      if(error)throw error;
      $('#signInCode').value='';
    }catch(error){$('#authStatus').textContent=errorText(error);}
    finally{$('#verifyCode').disabled=false;}
  });
  $('#signOut').addEventListener('click',async()=>{
    if(engine?.doc.outbox.length&&!confirm('Your unsynced changes will stay on this device for this account. Sign out?'))return;
    const {error}=await client.auth.signOut({scope:'local'});
    if(error){$('#syncDetail').textContent=errorText(error);return;}
    $('#settingsDialog').close();await activate(null);
  });
  $('#syncNow').addEventListener('click',()=>engine?.sync());
  for(const [id,choice] of [['keepLocalChange','mine'],['useCloudChange','cloud']]){
    $('#'+id).addEventListener('click',async()=>{try{await engine?.resolve(choice);}catch(error){$('#syncDetail').textContent=errorText(error);}});
  }
  $('#profileForm').addEventListener('submit',async event=>{
    event.preventDefault();if(!engine)return;
    $('#profileStatus').textContent='Saving…';
    try{
      const current=engine.observed['profiles/'+accountId]?.data||{};
      const next={...current,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'};
      const draft=profileDraft?.data||current;
      const name=$('#profileName').value.trim(),time=$('#profileReminderTime').value||'09:00';
      if(name!==(draft.displayName||''))next.displayName=name;
      if(time!==(draft.reminderTime||'09:00'))next.reminderTime=time;
      const state=S.toState(engine.observed,engine.doc.alerts);
      await engine.commit(state,state,profileDraft?.observed,current,next);
      profileDraft={data:{...next},observed:copyObserved()};
      $('#profileStatus').textContent='Saved on this device. Cloud sync will follow.';
    }catch(error){$('#profileStatus').textContent=errorText(error);}
  });
  window.SlashTasksCloud={
    start,
    captureProfileDraft(){profileDraft={data:{...(engine?.observed['profiles/'+accountId]?.data||{})},observed:engine?copyObserved():{}};},
    get engine(){return engine;},
    get userId(){return accountId;},
    get configured(){return !!client;},
    get aiEnabled(){return !!config.aiEnabled;},
    get observed(){return engine?copyObserved():{};},
    commit:(before,after,expected)=>{if(!engine)throw new Error('Sign in before making changes.');return engine.commit(before,after,expected);},
    async suggest(body,signal){
      const {data,error}=await client.auth.getSession();if(error||!data.session)throw new Error('Sign in to request suggestions.');
      return fetch(config.url+'/functions/v1/suggest-subtasks',{method:'POST',signal,headers:{'Content-Type':'application/json',apikey:config.publishableKey,Authorization:'Bearer '+data.session.access_token},body:JSON.stringify(body)});
    }
  };
  function copyObserved(){return JSON.parse(JSON.stringify(engine.observed));}
})();
