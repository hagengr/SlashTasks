'use strict';
// Build a static release with a strict allowlist: local settings/server files never enter dist.
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),target=path.join(root,'dist');
const {parseEnv}=require('../server.js');
let file={};
try{file=parseEnv(fs.readFileSync(path.join(root,'.env'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const url=process.env.SUPABASE_URL||file.SUPABASE_URL;
const publishableKey=process.env.SUPABASE_PUBLISHABLE_KEY||file.SUPABASE_PUBLISHABLE_KEY;
const aiEnabled=(process.env.SLASHTASKS_AI_ENABLED||file.SLASHTASKS_AI_ENABLED)==='true';
if(!url||!publishableKey)throw new Error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY before building.');
const origin=new URL(url).origin;
if(!origin.startsWith('https://')||origin!==url.replace(/\/$/,''))throw new Error('SUPABASE_URL must be an HTTPS project origin.');
if(publishableKey.startsWith('sb_secret_'))throw new Error('Use the public publishable key, never a secret key.');
if(!publishableKey.startsWith('sb_publishable_')){
  try{if(JSON.parse(Buffer.from(publishableKey.split('.')[1],'base64url').toString()).role!=='anon')throw new Error();}
  catch{throw new Error('Use a publishable key or a legacy anon key. A service-role key cannot be published.');}
}
if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw new Error('Refusing to build into a linked release directory.');
fs.mkdirSync(target,{recursive:true});
const files=['index.html','styles.css','app.js','task-model.js','cloud-sync.js','cloud.js','favicon.svg','vendor/supabase-2.118.0.js','vendor/supabase-LICENSE'];
// Remove only a previous generated release; reject links so the cleanup cannot escape this directory.
for(const entry of fs.readdirSync(target,{withFileTypes:true})){
  if(entry.isSymbolicLink())throw new Error('Refusing to build over a linked release file.');
  fs.rmSync(path.join(target,entry.name),{recursive:true,force:true});
}
for(const name of files){fs.mkdirSync(path.dirname(path.join(target,name)),{recursive:true});fs.copyFileSync(path.join(root,name),path.join(target,name));}
fs.writeFileSync(path.join(target,'cloud-config.js'),'window.SLASHTASKS_CLOUD='+JSON.stringify({url:origin,publishableKey,aiEnabled})+';\n');
const websocket=origin.replace('https:','wss:');
fs.writeFileSync(path.join(target,'_headers'),'/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Content-Security-Policy: default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\' '+origin+' '+websocket+'; object-src \'none\'; base-uri \'none\'; frame-ancestors \'none\'\n\n/cloud-config.js\n  Cache-Control: no-cache\n');
console.log('Cloud release ready in dist. No server files or private keys were included.');
