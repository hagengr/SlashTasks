'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const env=name=>({APP_ORIGINS:'https://tasks.example.com',SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public-key',OPENAI_API_KEY:'server-only-key'})[name];
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const request=(body={title:'Plan the trip'},auth='Bearer session')=>new Request('https://project.supabase.co/functions/v1/suggest-subtasks',{method:'POST',headers:{Origin:'https://tasks.example.com','Content-Type':'application/json',...(auth?{Authorization:auth}:{})},body:JSON.stringify(body)});
test('the hosted AI function verifies user sessions and quotas before spending on AI',async()=>{
  const {createHandler}=await import('../supabase/functions/suggest-subtasks/handler.mjs');
  const calls=[],handler=createHandler({env,fetchImpl:async(url,options)=>{
    calls.push(url);
    if(url.includes('/auth/'))return json({id:'authenticated-user'});
    if(url.includes('reserve_ai'))return json({allowed:true});
    const sent=JSON.parse(options.body);assert.equal(sent.store,false);
    return json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({steps:['Open a map','Open a map','Pick a day']})}]}]});
  }});
  const response=await handler(request());
  assert.equal(response.status,200);assert.deepEqual((await response.json()).steps,['Open a map','Pick a day']);
  assert.equal(calls.length,3);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://tasks.example.com');
});
test('unauthenticated and foreign-origin requests do not reach OpenAI',async()=>{
  const {createHandler}=await import('../supabase/functions/suggest-subtasks/handler.mjs');
  let calls=0;const handler=createHandler({env,fetchImpl:async()=>{calls++;return json({});}});
  assert.equal((await handler(request({},''))).status,401);
  const foreign=new Request('https://project.supabase.co/functions/v1/suggest-subtasks',{method:'POST',headers:{Origin:'https://other.example'}});
  assert.equal((await handler(foreign)).status,403);assert.equal(calls,0);
});
test('expired sessions and exhausted user allowances produce actionable failures',async()=>{
  const {createHandler}=await import('../supabase/functions/suggest-subtasks/handler.mjs');
  let calls=0;
  const rejected=createHandler({env,fetchImpl:async()=>json({},401)});
  assert.equal((await rejected(request())).status,401);
  const limited=createHandler({env,fetchImpl:async url=>{calls++;return url.includes('/auth/')?json({id:'user'}):json({allowed:false,reason:'daily_limit'});}});
  const response=await limited(request());assert.equal(response.status,429);assert.equal(calls,2);
});
test('private API errors do not expose service credentials or personal data',async()=>{
  const {createHandler}=await import('../supabase/functions/suggest-subtasks/handler.mjs');
  const handler=createHandler({env,fetchImpl:async url=>url.includes('/auth/')?json({id:'user'}):url.includes('reserve_ai')?json({allowed:true}):json({error:{code:'insufficient_quota',message:'server-only-key'}},429)});
  const response=await handler(request());assert.equal(response.status,503);assert(!(await response.text()).includes('server-only-key'));
});
