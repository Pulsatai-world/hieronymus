// The login system, attacked rather than described.
//
// Every other suite here asserts that the right thing works. This one tries to make the wrong thing
// work and fails on success: it is the shape of test that catches a guard quietly removed while
// something near it was being fixed, which is how most of the holes in this area got in.
//
// A line reading BREACH is a real finding. Read the scenario next to it before changing anything.
const crypto=require('crypto'); const {register}=require('node:module'); const {pathToFileURL}=require('node:url'); const path=require('path');
register('./support/blobs-hook.mjs', pathToFileURL(__filename));
const ROOT=require('path').join(__dirname,'..');
const S=(globalThis.__BLOBS__=globalThis.__BLOBS__||{}); const store=n=>(S[n]=S[n]||{});
const load=async f=>(await import(pathToFileURL(path.resolve(ROOT,'netlify/functions/'+f)).href)).default;
const B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32d(s){let b=0,v=0;const o=[];for(const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g,'')){v=(v<<5)|B32.indexOf(c);b+=5;if(b>=8){o.push((v>>>(b-8))&255);b-=8;}}return Buffer.from(o);}
function codeAt(sec,st){const c=Buffer.alloc(8);c.writeUInt32BE(Math.floor(st/4294967296),0);c.writeUInt32BE(st>>>0,4);const m=crypto.createHmac('sha1',b32d(sec)).update(c).digest();const o=m[m.length-1]&0x0f;const b=((m[o]&0x7f)<<24)|(m[o+1]<<16)|(m[o+2]<<8)|m[o+3];return String(b%1000000).padStart(6,'0');}
const step=()=>Math.floor(Date.now()/1000/30);
const hash=pw=>{const s=crypto.randomBytes(16).toString('hex');return s+':'+crypto.scryptSync(pw,s,64).toString('hex');};
const PW='pw-123';
const POST=(fn,b)=>fn(new Request('https://x/api/x',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),{});
const GET=(fn,qs)=>fn(new Request('https://x/api/x?'+qs),{});
const DEL=(fn,qs)=>fn(new Request('https://x/api/x?'+qs,{method:'DELETE'}),{});
let held=0;
const held_ok=(n,c,d)=>{console.log((c?'  HELD    ':'  BREACH  ')+n+(c?'':'   -> '+d));if(!c)held++;};

(async()=>{
  const login=await load('login.js'), enroll=await load('enroll.js');
  const results=await load('results.js'), intake=await load('intake.js'), codes=await load('intake-codes.js');
  const keys=await load('customer-keys.js');

  const seed=()=>{Object.keys(S).forEach(k=>delete S[k]);
    store('hieronymus-staff-users')['rene']={username:'rene',role:'admin',passwordHash:hash(PW),createdAt:'2026-08-29T00:00:00Z'};
    store('hieronymus-intake-codes')['acme']={company:'Acme',members:[{username:'acme',role:'full',passwordHash:hash(PW)}]};
    store('hieronymus-intake-codes')['globex']={company:'Globex',members:[{username:'globex',role:'full',passwordHash:hash(PW)}]};
    store('hieronymus-intake')['globex']={intake:{secretPlan:'GLOBEX-CONFIDENTIAL'}};
  };
  const enrol=async u=>{const s=await(await POST(enroll,{username:u,password:PW})).json();
    const d=await(await POST(enroll,{username:u,password:PW,code:codeAt(s.secret,step())})).json();return {secret:s.secret,...d};};

  console.log('Trying to get in:');
  seed(); const cust=await enrol('acme');
  held_ok('password alone mints no session',(await POST(login,{username:'acme',password:PW})).status===401,'let in');
  held_ok('a forged session token is refused',(await GET(login,'session='+crypto.randomBytes(32).toString('hex'))).status===401,'accepted');
  held_ok('an empty session is refused',(await GET(login,'session=')).status===401,'accepted');

  // replay
  seed(); const c2=await enrol('acme'); const st=step()+1; const code=codeAt(c2.secret,st);
  const first=await POST(login,{username:'acme',password:PW,code});
  const replay=await POST(login,{username:'acme',password:PW,code});
  held_ok('a code cannot be used twice',first.status===200&&replay.status===403,'first='+first.status+' replay='+replay.status);

  // recovery reuse + does a wrong one get consumed
  seed(); const c3=await enrol('acme'); const rc=c3.recoveryCodes;
  await POST(login,{username:'acme',password:PW,code:rc[0]});
  held_ok('a recovery code cannot be used twice',(await POST(login,{username:'acme',password:PW,code:rc[0]})).status===403,'reused');
  const before=JSON.stringify(store('hieronymus-intake-codes')['acme']);
  await POST(login,{username:'acme',password:PW,code:'ZZZZZ-ZZZZZ'});
  const rem=(store('hieronymus-intake-codes')['acme'].members[0]['authenticator_v3'].recovery||[]).filter(x=>!x.usedAt).length;
  held_ok('a wrong recovery code consumes none',rem===9,'remaining='+rem);

  // lockout
  seed(); const c4=await enrol('acme');
  for(let i=0;i<5;i++) await POST(login,{username:'acme',password:PW,code:'000000'});
  const lockedGood=await POST(login,{username:'acme',password:PW,code:codeAt(c4.secret,step()+2)});
  held_ok('lockout survives a CORRECT code',lockedGood.status===429,'status '+lockedGood.status+' — lock bypassed by a good code');
  const lockedRec=await POST(login,{username:'acme',password:PW,code:c4.recoveryCodes[0]});
  held_ok('lockout is not bypassed by a recovery code',lockedRec.status===429,'status '+lockedRec.status);

  // takeover: stolen password replaces a proven authenticator?
  seed(); const c5=await enrol('acme');
  await POST(login,{username:'acme',password:PW,code:codeAt(c5.secret,step()+1)});   // prove it
  const swap=await POST(enroll,{username:'acme',password:PW});
  held_ok('a stolen password cannot swap in a new authenticator',swap.status===403,'status '+swap.status+' — takeover with password alone');

  console.log('\nTrying to reach data:');
  seed(); const acme=await enrol('acme'); const staff=await enrol('rene');
  const noCred=await GET(intake,'company=Globex');
  held_ok('/api/intake with no credentials',noCred.status===401||noCred.status===403,'status '+noCred.status);
  const cross=await GET(intake,'company=Globex&session='+acme.session);
  held_ok("a customer cannot read another company's intake",cross.status===403||cross.status===404,'status '+cross.status+' BODY '+(await cross.text()).slice(0,80));
  const listing=await GET(codes,'session='+acme.session);
  held_ok('a customer cannot list every customer',listing.status===403,'status '+listing.status);
  const keysGet=await GET(keys,'company=Acme&session='+acme.session);
  held_ok('a customer cannot read the keys endpoint',keysGet.status===403,'status '+keysGet.status);
  const oldScheme=await GET(intake,'company=Globex&username=acme&password='+PW);
  held_ok('the old username/password scheme is not still accepted',oldScheme.status===401||oldScheme.status===403,'status '+oldScheme.status);
  const postRows=await POST(results,{company:'Globex',rows:[{run_id:'x'}]});
  held_ok('POST /api/results rejects an unauthenticated write',postRows.status===401||postRows.status===403,'status '+postRows.status);

  console.log('\nActing as someone else, and the redirect guard:');
  const staffUsers=await load('staff-users.js');
  Object.keys(S).forEach(k=>delete S[k]);
  store('hieronymus-staff-users')['rene']={username:'rene',role:'admin',passwordHash:hash(PW)};
  store('hieronymus-staff-users')['roy']={username:'roy',role:'user',passwordHash:hash(PW)};
  store('hieronymus-intake-codes')['acme']={company:'Acme',members:[{username:'acme',role:'full',passwordHash:hash(PW)}]};
  store('hieronymus-intake-codes')['globex']={company:'Globex',members:[{username:'globex',role:'full',passwordHash:hash(PW)}]};
  const acme2=await enrol('acme'), roy=await enrol('roy');

  const asOther=await GET(login,'session='+acme2.session+'&as=globex');
  const asBody=await asOther.json();
  console.log('    as=globex returned -> company: '+JSON.stringify(asBody.company)+'  username: '+JSON.stringify(asBody.username));
  held_ok('a customer using as= gets only their OWN record', asBody.company==='Acme' && asBody.username==='acme', 'LEAKED: '+JSON.stringify(asBody).slice(0,120));
  const nonAdminReset=await POST(enroll,{action:'reset',username:'globex',session:roy.session});
  held_ok('a non-admin staff cannot clear someone\'s authenticator',nonAdminReset.status===403,'status '+nonAdminReset.status);
  const custReset=await POST(enroll,{action:'reset',username:'globex',session:acme2.session});
  held_ok('a customer cannot clear another account\'s authenticator',custReset.status===403,'status '+custReset.status);
  const stealCodes=await POST(enroll,{action:'recovery',username:'globex',session:acme2.session});
  held_ok('a customer cannot mint recovery codes for another account',stealCodes.status===403,'status '+stealCodes.status);
  const sessionOnly=await POST(enroll,{action:'recovery',username:'acme',session:acme2.session});
  held_ok('a session alone mints no recovery codes',sessionOnly.status===401,'status '+sessionOnly.status);
  const withPw=await POST(enroll,{action:'recovery',username:'acme',session:acme2.session,password:PW});
  held_ok('but the owner with their password can',withPw.status===200,'status '+withPw.status);
  const promote=await POST(staffUsers,{username:'acme2',password:PW,role:'admin',session:acme2.session});
  held_ok('a customer cannot create a staff account',promote.status===401||promote.status===403,'status '+promote.status);

  console.log('\nThe ?next= redirect guard, against nastier input:');
  const safe=v=>/^\/[^/\\]/.test(String(v||''));
  const cases=[['//evil.test',false],['/\\evil.test',false],['/\tevil',true],['\t//evil',false],['https://evil',false],['HTTPS://evil',false],
   ['/%2F%2Fevil',true],['///evil',false],['/ /evil',true],['java\nscript:alert(1)',false],['javascript:alert(1)',false],
   ['/portal.html',true],['/a//evil.test',true],['\\\\evil.test',false],['/',false]];
  for(const [v,want] of cases){const got=safe(v);held_ok('next='+JSON.stringify(v)+' -> '+(got?'allowed':'refused'),got===want,'expected '+(want?'allowed':'refused'));}



  console.log('\nEndpoints that answered anyone who named a company:');
  {
    const audit=await load('run-audit-background.js'), gen=await load('generate-prompts-background.js');
    const aj=await load('audit-job.js'), gj=await load('generate-job.js');
    const pr=await load('prompts.js'), su2=await load('staff-users.js');
    let calls=0; const realFetch=globalThis.fetch;
    globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({content:[{type:'text',text:'{}'}]}),{status:200,headers:{'Content-Type':'application/json'}});};

    Object.keys(S).forEach(k=>delete S[k]);
    store('hieronymus-intake')['victim']={intake:{a:1}};
    store('hieronymus-customer-keys')['victim']={claude:'sk-VICTIM'};
    store('hieronymus-prompts')['victim']={promptsText:'q1\nq2',approvedAt:'2026-01-01'};
    store('hieronymus-audit-jobs')['victim']={status:'running',startIndex:5};
    store('hieronymus-generate-jobs')['victim']={status:'running'};

    held_ok('POST /api/generate-prompts refuses an anonymous caller',
      (await POST(gen,{company:'Victim',count:50})).status===401,'it ran');
    held_ok('and spends nothing doing so', calls===0, calls+' calls were made on the customer key');
    held_ok('POST /api/run-audit refuses an anonymous caller',
      (await POST(audit,{company:'Victim'})).status===401,'it ran');
    held_ok("the customer's approved prompt set is untouched",
      store('hieronymus-prompts')['victim'].approvedAt==='2026-01-01','it was replaced');
    held_ok('DELETE /api/audit-job refuses an anonymous caller',
      !!store('hieronymus-audit-jobs')['victim'] && (await DEL(aj,'company=Victim')).status===401 && !!store('hieronymus-audit-jobs')['victim'],
      'the job was deleted');
    held_ok('DELETE /api/generate-job refuses an anonymous caller',
      (await DEL(gj,'company=Victim')).status===401 && !!store('hieronymus-generate-jobs')['victim'],
      'the job was deleted');
    held_ok('/api/prompts does not reveal which companies exist',
      (await GET(pr,'company=Victim')).status===(await GET(pr,'company=NoSuchCo')).status,
      'existing and unknown answer differently');
    store('hieronymus-staff-users')['known']={username:'known',role:'admin',passwordHash:'x:y'};
    held_ok('/api/staff-users does not reveal which staff usernames exist',
      (await POST(su2,{username:'known',password:'aaaaaa'})).status===(await POST(su2,{username:'unknown-person',password:'aaaaaa'})).status,
      'existing and unknown answer differently');
    globalThis.fetch=realFetch;
  }

  console.log('\nTaking an account over with a password alone:');
  {
    Object.keys(S).forEach(k=>delete S[k]);
    store('hieronymus-staff-users')['victim']={username:'victim',role:'user',passwordHash:hash(PW)};
    const v=await enrol('victim');
    const grab=await POST(enroll,{username:'victim',password:PW});
    const gb=await grab.json();
    held_ok('a stolen password cannot ask for a new secret right after enrollment',
      grab.status===403 && !gb.secret,'status '+grab.status+' secret='+(gb.secret?'ISSUED':'none'));
    held_ok('the victim can still sign in',
      (await POST(login,{username:'victim',password:PW,code:codeAt(v.secret,step()+1)})).status===200,'locked out');

    const spent=codeAt(v.secret,step()+2);
    await POST(login,{username:'victim',password:PW,code:spent});
    held_ok('a code spent at /api/login cannot buy a session at /api/enroll',
      (await POST(enroll,{username:'victim',password:PW,code:spent})).status!==200,'it minted one');
  }

  console.log('\nA setup window a login would refuse:');
  {
    Object.keys(S).forEach(k=>delete S[k]);
    store('hieronymus-staff-users')['skew']={username:'skew',role:'user',passwordHash:hash(PW)};
    const st=await(await POST(enroll,{username:'skew',password:PW})).json();
    const far=await POST(enroll,{username:'skew',password:PW,code:codeAt(st.secret,step()+5)});
    held_ok('a badly skewed clock is refused AT SETUP, not after it',far.status!==200,
      'enrolled an account that could never sign in');
  }

  console.log('\n'+(held?held+' BREACH(ES)':'all attacks held'));
  process.exit(held?1:0);
})();
