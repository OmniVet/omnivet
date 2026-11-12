/* VetPlus · camada Firebase
   Substitui o ambiente do claude.ai (window.claude.use) por Firebase Auth + Firestore.
   - login por usuário e senha (usuario@vetplus.app)
   - perfis em usuarios/{uid}: papel master|equipe, ativo, equipeId, trocarSenha
   - imagens e PDFs em arquivos/{id} (partes em arquivos/{id}/p/{n}), servidos por sw.js em _blob/{id}
   - IA: Gemini com a chave salva em config/ia (dados pessoais do tutor são mascarados antes do envio) */
(function(){
'use strict';
const CFG={apiKey:"AIzaSyDcyQ5tuDCi5J_D_XcHQqJve4kkxy779yE",authDomain:"prontuario-vetplus.firebaseapp.com",projectId:"prontuario-vetplus",storageBucket:"prontuario-vetplus.firebasestorage.app",messagingSenderId:"116841563518",appId:"1:116841563518:web:7b84815518c94d5fd95f2f"};
const DOM='vetplus.app';
const COLS=['internacoes','tutores','prescricoes','execucoes','evolucoes','intercorrencias','comunicacoes','transfusoes','monitor','anestesias','cirurgias','solicitacoes','assinaturas','plantao','agenda','exclusoes','escalaImgs','medicamentos','procedimentos','protocolos','modelosCirurgicos','modelosDoc','equipe','boxes','config','usuarios'];
const PAC_COLS=['internacoes','tutores','prescricoes','execucoes','evolucoes','intercorrencias','comunicacoes','transfusoes','monitor','anestesias','cirurgias','solicitacoes','assinaturas','plantao','agenda','exclusoes'];

firebase.initializeApp(CFG);
const auth=firebase.auth();
const fs=firebase.firestore();
try{fs.settings({ignoreUndefinedProperties:true,merge:true})}catch(_){}
const persist=fs.enablePersistence({synchronizeTabs:true}).catch(()=>{});
const FP=firebase.firestore.FieldPath;

const loginToEmail=l=>{l=String(l||'').trim().toLowerCase().replace(/\s+/g,'');return l.includes('@')?l:l+'@'+DOM};
const emailToLogin=e=>{e=String(e||'');return e.endsWith('@'+DOM)?e.slice(0,-(DOM.length+1)):e};
const nowISO=()=>new Date().toISOString();
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
const rid=()=>{const a='abcdefghijklmnopqrstuvwxyz0123456789';let s='';const r=crypto.getRandomValues(new Uint8Array(20));for(const x of r)s+=a[x%36];return s};
const appS=()=>{try{return typeof S!=='undefined'?S:null}catch(_){return null}};
const appRender=()=>{try{if(typeof render==='function')render()}catch(_){}};

let ME=null,USERS=[],IA=null,EQUIPE=[];
const PERMS=[['ajustes','Pode fazer ajustes nos cadastros do paciente, do tutor e demais informações'],['exportar','Pode exportar o histórico completo do paciente (PDF/Word)'],['protocolos','Pode ajustar, cadastrar ou excluir protocolos de tratamento, descrições cirúrgicas e documentos'],['excluir','Pode excluir registros (de qualquer pessoa) e históricos'],['medicamentos','Pode ajustar, cadastrar ou excluir medicamentos (concentrações, doses e apresentações)']];
const permBoxes=(pm,dis)=>`<div style="display:flex;flex-direction:column;gap:8px"><b style="font-size:13px;color:var(--ink-2,#4A656D)">Permissões (pode marcar várias)</b>${PERMS.map(([k,l])=>`<label class="chk"><input type="checkbox" name="perm_${k}" ${pm&&pm[k]?'checked':''} ${dis?'disabled':''}> ${l}</label>`).join('')}<div class="note" style="padding:8px 10px">Todos os usuários sempre veem todos os dados do tutor e do pet, quem administrou cada medicamento e os registros do histórico, e todos lançam nas fichas dos pacientes. O master tem todas as permissões.</div></div>`;
const permRead=f=>Object.fromEntries(PERMS.map(([k])=>[k,!!(f['perm_'+k]&&f['perm_'+k].checked)]));
let resolveReady;const readyP=new Promise(r=>resolveReady=r);

/* ---------- banco: mesma interface usada pelo app ---------- */
const isPlain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function flat(o,pre,out){for(const k of Object.keys(o)){const v=o[k];if(v===undefined)continue;const p=pre.concat(k);if(isPlain(v)&&Object.keys(v).length)flat(v,p,out);else out.push(new FP(...p),v)}return out}
const logErr=e=>console.warn('db',e);
function wDoc(r){return{id:r.id,path:r.path,
  get:()=>r.get(),
  set:(d,o)=>o?r.set(d,o):r.set(d),
  update:d=>{const a=flat(d||{},[],[]);return a.length?r.update(...a):Promise.resolve()},
  delete:()=>r.delete(),
  onSnapshot:(n,e)=>r.onSnapshot(n,e||logErr),
  collection:c=>wCol(r.collection(c))}}
function wQ(q){return{where:(...a)=>wQ(q.where(...a)),orderBy:(...a)=>wQ(q.orderBy(...a)),limit:n=>wQ(q.limit(n)),get:()=>q.get(),onSnapshot:(n,e)=>q.onSnapshot(n,e||logErr)}}
function wCol(c){return Object.assign(wQ(c),{id:c.id,path:c.path,doc:id=>wDoc(id?c.doc(id):c.doc()),add:async d=>wDoc(await c.add(d))})}
const db={doc:p=>wDoc(fs.doc(p)),collection:p=>wCol(fs.collection(p))};

/* ---------- usuário ---------- */
const user={
  id:async()=>ME.uid,
  isOwner:async()=>ME.papel==='master',
  can:async()=>ME.ativo!==false,
  profiles:async ids=>{const o={};for(const i of [].concat(ids)){const u=USERS.find(x=>x.id===i);o[i]={id:i,name:u?(u.nome||u.login):''}}return o},
  search:async q=>{q=norm(q);if(!q)return[];return USERS.filter(u=>u.ativo!==false&&norm((u.nome||'')+' '+(u.login||'')).includes(q)).map(u=>({id:u.id,name:u.nome||u.login,email:null}))}
};

/* ---------- arquivos (imagens e PDFs) ---------- */
const CH=700000,MAXB=15*1024*1024;
async function b64of(blob){const u=new Uint8Array(await blob.arrayBuffer());let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s)}
function unb64(s){const b=atob(s);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
async function shrink(blob,max,type,q){const bm=await createImageBitmap(blob);const sc=Math.min(1,max/Math.max(bm.width,bm.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(bm.width*sc));c.height=Math.max(1,Math.round(bm.height*sc));c.getContext('2d').drawImage(bm,0,0,c.width,c.height);return await new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error('canvas')),type,q))}
async function cachePut(id,blob,type){try{const c=await caches.open('vp-blobs');await c.put(new Request('_blob/'+id),new Response(blob,{headers:{'Content-Type':type}}))}catch(_){}}
async function cacheDel(id){try{const c=await caches.open('vp-blobs');await c.delete(new Request('_blob/'+id))}catch(_){}}
async function writeBlob(id,blob,type){const b64=await b64of(blob);const n=Math.max(1,Math.ceil(b64.length/CH));
  for(let i=0;i<n;i++)await fs.doc(`arquivos/${id}/p/${i}`).set({b:b64.slice(i*CH,(i+1)*CH)});
  await fs.doc('arquivos/'+id).set({type,size:blob.size,n,por:ME?ME.uid:null,em:nowISO()});
  await cachePut(id,blob,type)}
const assets={
  upload:async(blob,opt)=>{let type=(opt&&opt.type)||blob.type||'application/octet-stream';
    if(/^image\//.test(type)&&type!=='image/png'&&blob.size>500000){try{blob=await shrink(blob,1600,'image/jpeg',.82);type='image/jpeg'}catch(_){}}
    else if(type==='image/png'&&blob.size>700000){try{blob=await shrink(blob,1200,'image/png')}catch(_){}}
    if(blob.size>MAXB)throw{code:'too_large',message:'Arquivo maior que 15 MB'};
    const id=rid();await writeBlob(id,blob,type);return{id,url:'_blob/'+id}},
  delete:async id=>{try{const m=await fs.doc('arquivos/'+id).get();const n=m.exists?(m.data().n||0):0;for(let i=0;i<n;i++)await fs.doc(`arquivos/${id}/p/${i}`).delete();await fs.doc('arquivos/'+id).delete()}finally{await cacheDel(id)}return{deleted:true}}
};
async function readBlob(id){const m=await fs.doc('arquivos/'+id).get();if(!m.exists)return null;const {n,type}=m.data();let s='';for(let i=0;i<n;i++){const p=await fs.doc(`arquivos/${id}/p/${i}`).get();if(!p.exists)return null;s+=p.data().b}return{buf:unb64(s).buffer,type:type||'application/octet-stream'}}
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message',async e=>{const d=e.data||{};if(d.t!=='blob')return;const port=e.ports&&e.ports[0];if(!port)return;
    try{await readyP;const r=await readBlob(d.id);if(r)port.postMessage({ok:1,buf:r.buf,type:r.type},[r.buf]);else port.postMessage({ok:0})}catch(err){port.postMessage({ok:0})}});
}

/* ---------- downloads ---------- */
const downloads={save:async({filename,data,mimeType})=>{const blob=data instanceof Blob?data:new Blob([data],{type:mimeType||'application/octet-stream'});const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=filename||'arquivo';a.rel='noopener';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000);return{status:'saved'}}};

/* ---------- IA (Gemini) ---------- */
const escRe=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function piiList(){const out=[];const S_=appS();if(!S_)return out;try{
  const ps=S_.pid?[(S_.intern||[]).find(x=>x.id===S_.pid)]:[];
  for(const p of ps){if(!p)continue;for(const k of ['tutor','tutorCpf','cpf','telefone','tutorTel','email','tutorEmail','endereco','tutorEnd'])if(p[k]&&String(p[k]).trim().length>2)out.push(String(p[k]).trim());
    const t=(S_.tutores||[]).find(x=>x.id===p.tutorId);if(t)for(const k of ['nome','cpf','rg','telefone','whatsapp','email','endereco'])if(t[k]&&String(t[k]).trim().length>2)out.push(String(t[k]).trim())}
}catch(_){}return [...new Set(out)].sort((a,b)=>b.length-a.length)}
function redact(t){const map=[];let i=0;const sub=(re,tag)=>{t=t.replace(re,m=>{let k=map.find(x=>x[1].toLowerCase()===m.toLowerCase());if(!k){k=['['+tag+(++i)+']',m];map.push(k)}return k[0]})};
  for(const v of piiList())sub(new RegExp(escRe(v),'gi'),'DADO');
  sub(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,'CPF');sub(/[\w.+-]+@[\w-]+\.[\w.]+/g,'EMAIL');sub(/\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g,'TEL');
  return{text:t,map}}
const unredact=(t,map)=>{for(const [k,v] of map)t=t.split(k).join(v);return t};
async function sample(prompt,o){o=o||{};if(!IA||!IA.key)throw{code:'ia_off',message:'IA não configurada'};
  const {text,map}=redact(String(prompt));
  const models=[...new Set([IA.modelo||'gemini-flash-latest','gemini-2.5-flash','gemini-flash-latest'])];let last;
  for(const m of models){
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(IA.key)}`,{method:'POST',headers:{'Content-Type':'application/json'},signal:o.signal,
      body:JSON.stringify({contents:[{role:'user',parts:[{text}]}],generationConfig:{temperature:.4}})});
    if(r.status===404){last=new Error('modelo '+m+' indisponível');continue}
    if(!r.ok){let msg='';try{msg=(await r.json()).error.message}catch(_){}throw{code:'ia_'+r.status,message:'IA: '+(msg||r.status)}}
    const rd=r.body.getReader();const dec=new TextDecoder();let buf='',full='';
    for(;;){const {value,done}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
      while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line.startsWith('data:'))continue;
        try{const j=JSON.parse(line.slice(5));const parts=(((j.candidates||[])[0]||{}).content||{}).parts||[];const d=parts.filter(p=>!p.thought).map(p=>p.text||'').join('');
          if(d){full+=d;o.onText&&o.onText({text:unredact(full,map),delta:d})}}catch(_){}}}
    return{text:unredact(full,map),truncated:false}}
  throw last||new Error('IA indisponível')}
sample.json=async(p,o)=>{const r=await sample(p,o);const m=r.text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);return m?JSON.parse(m[0]):null};

/* ---------- window.claude ---------- */
window.claude={use:async n=>{await readyP;switch(n){case'db':return db;case'user':return user;case'assets':return assets;case'downloads':return downloads;case'sample':return IA&&IA.key?sample:null;default:return null}}};

/* ---------- interface: login e conta ---------- */
const CSS=`
#fbGate{position:fixed;inset:0;z-index:9999;background:var(--bg,#EDF3F3);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto}
#fbGate[hidden]{display:none}
.fb-card{width:100%;max-width:380px;background:var(--surface,#fff);border:1px solid var(--line,#D5E3E3);border-radius:14px;box-shadow:var(--shadow);padding:28px 24px;display:flex;flex-direction:column;gap:14px;font-family:var(--f-body,system-ui)}
.fb-card img{width:84px;height:84px;object-fit:contain;align-self:center}
.fb-card h1{font-family:var(--f-display,system-ui);font-size:21px;margin:0;text-align:center;color:var(--ink,#13303A)}
.fb-card p{margin:0;color:var(--ink-2,#4A656D);font-size:14px;text-align:center;line-height:1.45}
.fb-card label{display:flex;flex-direction:column;gap:5px;font-size:13px;font-weight:600;color:var(--ink-2,#4A656D)}
.fb-card input,.fb-m input,.fb-m select{font:inherit;font-size:16px;padding:10px 12px;border:1px solid var(--line,#D5E3E3);border-radius:8px;background:var(--surface,#fff);color:var(--ink,#13303A);min-width:0}
.fb-card input:focus,.fb-m input:focus,.fb-m select:focus{outline:2px solid var(--brand,#0A8F84);outline-offset:1px}
.fb-btn{font:inherit;font-weight:700;font-size:15px;border:0;border-radius:8px;padding:11px 14px;background:var(--brand,#0A8F84);color:var(--brand-ink,#fff);cursor:pointer}
.fb-btn:disabled{opacity:.6;cursor:default}
.fb-btn.sec{background:var(--surface-2,#F5F9F9);color:var(--ink,#13303A);border:1px solid var(--line,#D5E3E3)}
.fb-btn.sm{font-size:13px;padding:7px 10px;font-weight:600}
.fb-btn.dan{background:var(--crit-soft,#FAE0E4);color:var(--crit,#C9304A)}
.fb-err{color:var(--crit,#C9304A);font-size:13.5px;text-align:center;min-height:1em}
.fb-ok{color:var(--ok,#1B8F4E);font-size:13.5px;text-align:center}
.fb-link{background:none;border:0;color:var(--brand-text,#077369);font:inherit;font-size:13.5px;cursor:pointer;text-decoration:underline;align-self:center}
#fbAcct{padding:10px 14px 14px;display:flex;flex-direction:column;gap:8px}
.fb-me{display:flex;align-items:center;gap:10px;background:var(--surface-2,#F5F9F9);border:1px solid var(--line,#D5E3E3);border-radius:10px;padding:8px 10px;cursor:pointer;font:inherit;color:inherit;text-align:left;width:100%}
.fb-av{width:30px;height:30px;border-radius:50%;background:var(--brand,#0A8F84);color:var(--brand-ink,#fff);display:grid;place-items:center;font-weight:800;font-size:12.5px;flex:none}
.fb-me b{display:block;font-size:13.5px;line-height:1.2}.fb-me small{display:block;font-size:12px;color:var(--ink-3,#7B9197)}
#fbAcctTop{display:none}
@media (max-width:900px){#fbAcctTop{display:inline-grid;margin-left:auto}}
.fb-ov{position:fixed;inset:0;z-index:9998;background:var(--overlay,rgba(12,30,36,.42));display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow:auto}
.fb-m{width:100%;max-width:640px;background:var(--surface,#fff);color:var(--ink,#13303A);border-radius:14px;box-shadow:var(--shadow);font-family:var(--f-body,system-ui);display:flex;flex-direction:column}
.fb-m header{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--line,#D5E3E3)}
.fb-m header h2{font-family:var(--f-display,system-ui);font-size:18px;margin:0;flex:1}
.fb-m .x{background:none;border:0;font-size:22px;cursor:pointer;color:var(--ink-2,#4A656D);line-height:1;padding:4px 8px}
.fb-m .bd{padding:16px 18px;display:flex;flex-direction:column;gap:14px}
.fb-m .row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.fb-m label{display:flex;flex-direction:column;gap:5px;font-size:13px;font-weight:600;color:var(--ink-2,#4A656D)}
.fb-m .chk{flex-direction:row;align-items:center;gap:8px;font-weight:500;color:var(--ink,#13303A)}
.fb-m .note{font-size:13px;color:var(--ink-2,#4A656D);line-height:1.5;background:var(--surface-2,#F5F9F9);border:1px solid var(--line-2,#E6EFEF);border-radius:8px;padding:10px 12px}
.fb-m .menu{display:flex;flex-direction:column;gap:8px}
.fb-m .menu button{text-align:left}
.fb-u{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--line,#D5E3E3);border-radius:10px;padding:10px 12px}
.fb-u .nm{flex:1;min-width:160px}.fb-u .nm b{display:block}.fb-u .nm small{color:var(--ink-3,#7B9197);font-size:12.5px}
.fb-tag{font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:99px;background:var(--brand-soft,#DAF1EE);color:var(--brand-text,#077369)}
.fb-tag.off{background:var(--crit-soft,#FAE0E4);color:var(--crit,#C9304A)}
.fb-prog{font-size:13px;color:var(--ink-2,#4A656D)}
@media (max-width:520px){.fb-m .row{grid-template-columns:minmax(0,1fr)}}
`;
function injectCSS(){const st=document.createElement('style');st.textContent=CSS;document.head.appendChild(st)}
const LOGO='icon-512.png';
function gate(){let g=document.getElementById('fbGate');if(!g){g=document.createElement('div');g.id='fbGate';document.body.appendChild(g)}g.hidden=false;return g}
function hideGate(){const g=document.getElementById('fbGate');if(g)g.hidden=true}
function gateMsg(title,msg,btn){const g=gate();g.innerHTML=`<div class="fb-card"><img src="${LOGO}" alt=""><h1>${esc(title)}</h1><p>${msg}</p>${btn?`<button class="fb-btn sec" id="fbOut">Sair</button>`:''}</div>`;const b=document.getElementById('fbOut');if(b)b.onclick=()=>logout()}
function showLogin(err){const g=gate();
  g.innerHTML=`<form class="fb-card" id="fbLogin" autocomplete="on"><img src="${LOGO}" alt=""><h1>Prontuário VetPlus</h1><p>Entre com o seu usuário e senha.</p>
   <label>Usuário<input name="u" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
   <label>Senha<input name="p" type="password" autocomplete="current-password" required></label>
   <div class="fb-err" id="fbErr">${esc(err||'')}</div><button class="fb-btn" id="fbGo">Entrar</button>
   <button type="button" class="fb-link" id="fbEsq">Esqueci a senha</button></form>`;
  const f=document.getElementById('fbLogin');f.u.focus();
  document.getElementById('fbEsq').onclick=()=>{document.getElementById('fbErr').textContent='Peça ao master para criar uma nova senha para você.'};
  f.onsubmit=async e=>{e.preventDefault();const b=document.getElementById('fbGo');b.disabled=true;b.textContent='Entrando…';
    try{await auth.signInWithEmailAndPassword(loginToEmail(f.u.value),f.p.value)}catch(er){b.disabled=false;b.textContent='Entrar';document.getElementById('fbErr').textContent=authMsg(er)}}}
function authMsg(e){const c=e&&e.code||'';
  if(/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(c))return'Usuário ou senha incorretos.';
  if(/too-many-requests/.test(c))return'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
  if(/network/.test(c))return'Sem conexão com a internet.';
  if(/weak-password/.test(c))return'A senha precisa ter pelo menos 6 caracteres.';
  if(/email-already-in-use/.test(c))return'Esse usuário já existe.';
  if(/requires-recent-login/.test(c))return'Por segurança, saia e entre de novo antes de trocar a senha.';
  return'Não foi possível concluir ('+(c||e&&e.message||'erro')+').'}
function showTroca(primeira){const g=gate();
  g.innerHTML=`<form class="fb-card" id="fbTr"><img src="${LOGO}" alt=""><h1>${primeira?'Crie sua senha':'Trocar senha'}</h1><p>${primeira?'É o seu primeiro acesso. Escolha uma senha só sua, com pelo menos 8 caracteres.':'Escolha uma nova senha com pelo menos 8 caracteres.'}</p>
   <label>Nova senha<input name="a" type="password" autocomplete="new-password" minlength="8" required></label>
   <label>Repita a nova senha<input name="b" type="password" autocomplete="new-password" minlength="8" required></label>
   <div class="fb-err" id="fbErr"></div><button class="fb-btn" id="fbGo">Salvar senha</button></form>`;
  const f=document.getElementById('fbTr');f.a.focus();
  f.onsubmit=async e=>{e.preventDefault();const er=document.getElementById('fbErr');if(f.a.value!==f.b.value){er.textContent='As senhas não conferem.';return}if(f.a.value.length<8){er.textContent='Use pelo menos 8 caracteres.';return}
    const b=document.getElementById('fbGo');b.disabled=true;b.textContent='Salvando…';
    try{await auth.currentUser.updatePassword(f.a.value);await fs.doc('usuarios/'+auth.currentUser.uid).update({trocarSenha:false,senhaTrocadaEm:nowISO()});location.reload()}
    catch(x){b.disabled=false;b.textContent='Salvar senha';er.textContent=authMsg(x)}}}
async function logout(){try{await caches.delete('vp-blobs')}catch(_){}try{await auth.signOut()}catch(_){}try{localStorage.removeItem('vp_resp')}catch(_){}location.reload()}

function initials(n){return String(n||'?').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase()||'?'}
function paintAcct(){const box=document.getElementById('fbAcct');if(box&&ME){box.innerHTML=`<button class="fb-me" type="button" id="fbMe"><span class="fb-av">${esc(initials(ME.nome||ME.login))}</span><span style="min-width:0"><b>${esc(ME.nome||ME.login)}</b><small>${ME.papel==='master'?'Master':'Equipe'} · ${esc(ME.login)}</small></span></button>`;document.getElementById('fbMe').onclick=menu}
  const t=document.getElementById('fbAcctTop');if(t){t.onclick=menu;t.innerHTML=`<span class="fb-av" style="width:28px;height:28px;font-size:12px">${esc(initials(ME&&(ME.nome||ME.login)))}</span>`}}
function modal(title,body){close();const ov=document.createElement('div');ov.className='fb-ov';ov.id='fbOv';ov.innerHTML=`<div class="fb-m" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button class="x" type="button" aria-label="Fechar">×</button></header><div class="bd">${body}</div></div>`;
  ov.addEventListener('click',e=>{if(e.target===ov||e.target.closest('.x'))close()});document.body.appendChild(ov);return ov}
function close(){const o=document.getElementById('fbOv');if(o)o.remove()}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('fbOv'))close()});

function menu(){const m=ME.papel==='master';
  const ov=modal('Minha conta',`<div class="note"><b>${esc(ME.nome||ME.login)}</b> · usuário <b>${esc(ME.login)}</b> · ${m?'Master':'Equipe'}</div>
   <div class="menu">
    <button class="fb-btn sec" data-a="senha">Trocar minha senha</button>
    ${m?`<button class="fb-btn sec" data-a="users">Usuários e senhas da equipe</button>
    <button class="fb-btn sec" data-a="ia">Configurar IA (Gemini)</button>
    <button class="fb-btn sec" data-a="backup">Baixar cópia de segurança</button>
    <button class="fb-btn sec" data-a="import">Importar dados</button>`:''}
    <button class="fb-btn dan" data-a="sair">Sair</button></div>`);
  ov.querySelector('.menu').onclick=e=>{const a=e.target.closest('[data-a]')?.dataset.a;if(!a)return;
    if(a==='sair')logout();if(a==='senha')trocaSenha();if(a==='users')usersPanel();if(a==='ia')iaPanel();if(a==='backup')backupPanel();if(a==='import')importPanel()}}

function trocaSenha(){const ov=modal('Trocar minha senha',`<form id="fbTS" class="bd" style="padding:0">
   <label>Senha atual<input name="o" type="password" autocomplete="current-password" required></label>
   <div class="row"><label>Nova senha<input name="a" type="password" autocomplete="new-password" minlength="8" required></label><label>Repita<input name="b" type="password" autocomplete="new-password" minlength="8" required></label></div>
   <div class="fb-err" id="fbTSe"></div><button class="fb-btn">Salvar</button></form>`);
  const f=ov.querySelector('#fbTS');f.o.focus();f.onsubmit=async e=>{e.preventDefault();const er=ov.querySelector('#fbTSe');if(f.a.value!==f.b.value){er.textContent='As senhas não conferem.';return}
    try{const u=auth.currentUser;await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email,f.o.value));await u.updatePassword(f.a.value);await fs.doc('usuarios/'+u.uid).update({trocarSenha:false,senhaTrocadaEm:nowISO()});er.className='fb-ok';er.textContent='Senha alterada.';setTimeout(close,1200)}
    catch(x){er.className='fb-err';er.textContent=authMsg(x)}}}

/* ---------- usuários (master) ---------- */
function eqOpts(sel){return `<option value="">— nenhum —</option>`+EQUIPE.filter(e=>e.ativo!==false||e.id===sel).map(e=>`<option value="${esc(e.id)}" ${e.id===sel?'selected':''}>${esc(e.nome)}${e.funcao?' · '+esc(e.funcao):''}</option>`).join('')}
async function loadEquipe(){try{const s=await fs.collection('equipe').get();EQUIPE=s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.nome).localeCompare(String(b.nome)))}catch(_){}}
const waitUsers=async ok=>{for(let i=0;i<30&&!ok();i++)await new Promise(r=>setTimeout(r,100))};
async function usersPanel(){await loadEquipe();
  const list=[...USERS].sort((a,b)=>(a.ativo===false)-(b.ativo===false)||String(a.nome||a.login).localeCompare(String(b.nome||b.login)));
  const ov=modal('Usuários e senhas',`<div class="note">Você cadastra o e-mail (ou um nome de usuário) e a senha de cada pessoa e marca o que ela pode fazer. Para mudar as permissões depois, clique em <b>Editar</b> no nome dela. Se alguém esquecer a senha, desative o cadastro antigo e crie um novo com outro e-mail ou usuário; os registros antigos continuam no nome da pessoa.</div>
   <div style="display:flex;flex-direction:column;gap:8px">${list.map(u=>`<div class="fb-u"><div class="nm"><b>${esc(u.nome||u.login)}</b><small>usuário: ${esc(u.login)}${u.equipeId?' · '+esc((EQUIPE.find(e=>e.id===u.equipeId)||{}).nome||u.equipeId):''}${u.papel!=='master'?'<br>Pode: '+(PERMS.filter(([k])=>u.perm&&u.perm[k]).map(([k])=>({ajustes:'ajustar cadastros',exportar:'exportar histórico',protocolos:'protocolos/descrições/documentos',excluir:'excluir registros',medicamentos:'medicamentos'})[k]).join(', ')||'só lançar nas fichas'):''}${u.ultimoAcesso?' · último acesso '+esc(new Date(u.ultimoAcesso).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})):' · ainda não entrou'}</small></div>
     <span class="fb-tag ${u.ativo===false?'off':''}">${u.ativo===false?'Desativado':u.papel==='master'?'Master':'Equipe'}</span>
     ${u.id!==ME.uid?`<button class="fb-btn sec sm" data-e="${esc(u.id)}">Editar</button>`:''}</div>`).join('')||'<div class="note">Nenhum usuário.</div>'}</div>
   <form id="fbNU" style="display:flex;flex-direction:column;gap:12px;border-top:1px solid var(--line,#D5E3E3);padding-top:14px"><b>Novo usuário</b>
    <div class="row"><label>Nome completo<input name="nome" required></label><label>E-mail ou usuário (para entrar)<input name="login" autocapitalize="none" spellcheck="false" placeholder="ex.: katia@gmail.com ou katia.viana" required pattern="[a-zA-Z0-9._@+\\-]{3,80}" title="Sem espaços"></label></div>
    <div class="row"><label>Senha<input name="senha" minlength="6" required placeholder="mínimo 6 caracteres"></label><label>Perfil<select name="papel"><option value="equipe">Equipe</option><option value="master">Master</option></select></label></div>
    <label>Vincular ao cadastro da equipe (nome e CRMV nos documentos)<select name="equipeId">${eqOpts('')}</select></label>
    ${permBoxes({},false)}
    <label class="chk"><input type="checkbox" name="troca"> Pedir para a pessoa trocar a senha no primeiro acesso</label>
    <div class="fb-err" id="fbNUe"></div><button class="fb-btn">Criar usuário</button></form>`);
  ov.querySelectorAll('[data-e]').forEach(b=>b.onclick=()=>editUser(b.dataset.e));
  const f=ov.querySelector('#fbNU');f.onsubmit=async e=>{e.preventDefault();const er=ov.querySelector('#fbNUe');const login=f.login.value.trim().toLowerCase();
    if(USERS.some(u=>u.login===login)){er.textContent='Esse usuário já existe.';return}
    const btn=f.querySelector('button');btn.disabled=true;btn.textContent='Criando…';
    try{const sec=firebase.apps.find(a=>a.name==='sec')||firebase.initializeApp(CFG,'sec');const sa=sec.auth();await sa.setPersistence(firebase.auth.Auth.Persistence.NONE);
      const c=await sa.createUserWithEmailAndPassword(loginToEmail(login),f.senha.value);const uid=c.user.uid;await sa.signOut();
      await fs.doc('usuarios/'+uid).set({login,nome:f.nome.value.trim(),papel:f.papel.value,equipeId:f.equipeId.value||null,perm:permRead(f),ativo:true,trocarSenha:!!f.troca.checked,criadoEm:nowISO(),criadoPor:ME.uid});
      await waitUsers(()=>USERS.some(x=>x.id===uid));usersPanel()}catch(x){btn.disabled=false;btn.textContent='Criar usuário';er.textContent=authMsg(x)}}}
async function editUser(id){const u=USERS.find(x=>x.id===id);if(!u)return;await loadEquipe();
  const ov=modal('Editar usuário',`<form id="fbEU" style="display:flex;flex-direction:column;gap:12px"><div class="note">Usuário: <b>${esc(u.login)}</b></div>
   <label>Nome completo<input name="nome" value="${esc(u.nome||'')}" required></label>
   <div class="row"><label>Perfil<select name="papel"><option value="equipe" ${u.papel!=='master'?'selected':''}>Equipe</option><option value="master" ${u.papel==='master'?'selected':''}>Master</option></select></label>
   <label>Vínculo com a equipe<select name="equipeId">${eqOpts(u.equipeId||'')}</select></label></div>
   ${permBoxes(u.perm||{},false)}
   <label class="chk"><input type="checkbox" name="ativo" ${u.ativo!==false?'checked':''}> Pode entrar no sistema (desmarque para bloquear o acesso)</label>
   <div class="fb-err" id="fbEUe"></div><div style="display:flex;gap:8px"><button type="button" class="fb-btn sec" id="fbBack">Voltar</button><button class="fb-btn" style="flex:1">Salvar</button></div></form>`);
  ov.querySelector('#fbBack').onclick=usersPanel;
  const f=ov.querySelector('#fbEU');f.onsubmit=async e=>{e.preventDefault();try{await fs.doc('usuarios/'+id).update({nome:f.nome.value.trim(),papel:f.papel.value,equipeId:f.equipeId.value||null,perm:permRead(f),ativo:f.ativo.checked,alteradoEm:nowISO()});const at=nowISO();await waitUsers(()=>{const x=USERS.find(z=>z.id===id);return x&&x.alteradoEm&&x.alteradoEm>=at.slice(0,16)});usersPanel()}catch(x){ov.querySelector('#fbEUe').textContent='Não foi possível salvar ('+(x.code||x.message)+').'}}}

window.__vpUsers=()=>{if(ME&&ME.papel==='master')usersPanel()};
/* ---------- IA (master) ---------- */
function iaPanel(){const ov=modal('Configurar IA (Gemini)',`<div class="note">Cole aqui a chave gratuita do Gemini (Google AI Studio → <i>Get API key</i>). Antes de enviar qualquer texto para a IA, o sistema troca nome, CPF, telefone, e-mail e endereço do tutor por códigos e só devolve os dados reais depois, no seu aparelho.</div>
  <form id="fbIA" style="display:flex;flex-direction:column;gap:12px"><label>Chave da API<input name="key" value="${esc(IA&&IA.key||'')}" autocomplete="off" spellcheck="false" placeholder="AIza…"></label>
  <label>Modelo<input name="modelo" value="${esc(IA&&IA.modelo||'gemini-flash-latest')}" spellcheck="false"></label>
  <div class="fb-err" id="fbIAe"></div><div style="display:flex;gap:8px"><button type="button" class="fb-btn sec" id="fbIAt">Testar</button><button class="fb-btn" style="flex:1">Salvar</button></div></form>`);
  const f=ov.querySelector('#fbIA');const er=ov.querySelector('#fbIAe');
  ov.querySelector('#fbIAt').onclick=async()=>{const old=IA;IA={key:f.key.value.trim(),modelo:f.modelo.value.trim()};er.className='fb-prog';er.textContent='Testando…';try{const r=await sample('Responda apenas: OK');er.className='fb-ok';er.textContent='Funcionou: '+r.text.slice(0,60)}catch(x){er.className='fb-err';er.textContent=x.message||'Falhou'}IA=old};
  f.onsubmit=async e=>{e.preventDefault();try{await fs.doc('config/ia').set({key:f.key.value.trim(),modelo:f.modelo.value.trim()||'gemini-flash-latest',em:nowISO(),por:ME.uid});close()}catch(x){er.className='fb-err';er.textContent='Não foi possível salvar.'}}}

/* ---------- backup e importação (master) ---------- */
function dl(name,obj){downloads.save({filename:name,data:new Blob([JSON.stringify(obj)],{type:'application/json'})})}
function backupPanel(){const ov=modal('Cópia de segurança',`<div class="note">Baixa um arquivo com todos os dados do prontuário (pacientes, prescrições, evoluções, cadastros, usuários). Guarde em local seguro: ele contém dados pessoais dos tutores.</div>
  <label class="chk"><input type="checkbox" id="fbBkA" checked> Incluir fotos, imagens e anexos (arquivo maior)</label><div class="fb-prog" id="fbBkP"></div><button class="fb-btn" id="fbBkGo">Baixar cópia</button>`);
  ov.querySelector('#fbBkGo').onclick=async()=>{const p=ov.querySelector('#fbBkP');const b=ov.querySelector('#fbBkGo');b.disabled=true;const out={_vetplus:1,em:nowISO(),cols:{},assets:{}};
    try{for(const c of COLS){p.textContent='Lendo '+c+'…';const s=await fs.collection(c).get({source:'server'}).catch(()=>fs.collection(c).get());out.cols[c]={};for(const d of s.docs)out.cols[c][d.id]=d.data()}
      if(ov.querySelector('#fbBkA').checked){const s=await fs.collection('arquivos').get();let i=0;for(const d of s.docs){p.textContent=`Lendo arquivos ${++i}/${s.size}…`;const r=await readBlob(d.id);if(r){let bin='';const u=new Uint8Array(r.buf);for(let k=0;k<u.length;k+=0x8000)bin+=String.fromCharCode.apply(null,u.subarray(k,k+0x8000));out.assets[d.id]={type:r.type,b64:btoa(bin)}}}}
      dl('VetPlus_backup_'+new Date().toISOString().slice(0,10)+'.json',out);p.textContent='Pronto.'}catch(x){p.textContent='Erro: '+(x.code||x.message)}b.disabled=false}}
function importPanel(){const ov=modal('Importar dados',`<div class="note">Use para trazer os dados do sistema antigo ou restaurar uma cópia de segurança. Registros com o mesmo código são substituídos; nada é apagado.</div>
  <label>Arquivo (.json)<input type="file" id="fbImF" accept=".json,application/json"></label>
  <label class="chk"><input type="checkbox" id="fbImC" checked> Cadastros: medicamentos, protocolos, documentos, descrições cirúrgicas, procedimentos, equipe, boxes, dados da clínica</label>
  <label class="chk"><input type="checkbox" id="fbImP"> Pacientes e registros clínicos (internações, tutores, prescrições, evoluções, termos…)</label>
  <label class="chk"><input type="checkbox" id="fbImU"> Usuários (só ao restaurar uma cópia deste sistema)</label>
  <div class="fb-prog" id="fbImS"></div><button class="fb-btn" id="fbImGo">Importar</button>`);
  ov.querySelector('#fbImGo').onclick=async()=>{const st=ov.querySelector('#fbImS');const f=ov.querySelector('#fbImF').files[0];if(!f){st.textContent='Escolha o arquivo.';return}
    const b=ov.querySelector('#fbImGo');b.disabled=true;
    try{const data=JSON.parse(await f.text());const cols=data.cols||{};const wantC=ov.querySelector('#fbImC').checked,wantP=ov.querySelector('#fbImP').checked,wantU=ov.querySelector('#fbImU').checked;
      const sel=Object.keys(cols).filter(c=>c==='usuarios'?wantU:PAC_COLS.includes(c)?wantP:wantC);
      let n=0,batch=fs.batch(),k=0;const flush=async()=>{if(k){await batch.commit();batch=fs.batch();k=0}};
      for(const c of sel)for(const [id,d] of Object.entries(cols[c])){batch.set(fs.doc(c+'/'+id),d);k++;n++;if(k>=300){st.textContent=`Gravando… ${n}`;await flush()}}
      await flush();let na=0;const as=data.assets||{};
      for(const [id,a] of Object.entries(as)){st.textContent=`Gravando arquivos ${++na}/${Object.keys(as).length}…`;await writeBlob(id,new Blob([unb64(a.b64)],{type:a.type}),a.type)}
      st.className='fb-ok';st.textContent=`Importado: ${n} registros e ${na} arquivos.`}catch(x){st.className='fb-err';st.textContent='Erro: '+(x.code||x.message)}b.disabled=false}}

/* ---------- sessão ---------- */
function start(){injectCSS();
  if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
  gateMsg('Prontuário VetPlus','Carregando…');
  auth.onAuthStateChanged(async u=>{
    if(!u){showLogin();return}
    if(ME){return}
    try{await persist;
      const ref=fs.doc('usuarios/'+u.uid);let s=await ref.get().catch(()=>null);
      const login=emailToLogin(u.email);
      if(!s||!s.exists){/* primeiro acesso do master: as regras do servidor só permitem isso ao login master */try{await ref.set({login,nome:'Hernani Bezerra',papel:'master',equipeId:'hernani-bezerra',ativo:true,trocarSenha:false,criadoEm:nowISO()});s=await ref.get()}catch(_){s=null}}
      if(!s||!s.exists){gateMsg('Acesso não liberado','Seu usuário ainda não foi liberado pelo master da clínica.',true);return}
      const d=s.data();if(d.ativo===false){gateMsg('Acesso bloqueado','Seu usuário está desativado. Fale com o master da clínica.',true);return}
      if(d.trocarSenha){showTroca(true);return}
      ME={uid:u.uid,...d,login:d.login||login};window.__vpPerm=ME.papel==='master'?Object.fromEntries(PERMS.map(([k])=>[k,true])):(ME.perm||{});
      try{if(ME.equipeId)localStorage.setItem('vp_resp',JSON.stringify(ME.equipeId))}catch(_){}
      ref.update({ultimoAcesso:nowISO()}).catch(()=>{});
      fs.collection('usuarios').onSnapshot(x=>{USERS=x.docs.map(d=>({id:d.id,...d.data()}));const me=USERS.find(z=>z.id===ME.uid);if(me&&me.ativo===false)logout();if(me&&me.papel!=='master'){window.__vpPerm=me.perm||{};appRender()}},()=>{});
      await new Promise(res=>{let first=true;fs.doc('config/ia').onSnapshot(x=>{IA=x.exists?x.data():null;const S_=appS();if(S_&&!first){S_.sample=IA&&IA.key?sample:null;appRender()}if(first){first=false;res()}},()=>{if(first){first=false;res()}})});
      if('serviceWorker' in navigator&&navigator.serviceWorker.controller==null){await Promise.race([new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true})),new Promise(r=>setTimeout(r,2500))])}
      paintAcct();hideGate();resolveReady()}
    catch(x){console.error(x);gateMsg('Não foi possível entrar','Verifique a internet e tente de novo. ('+esc(x.code||x.message)+')',true)}
  })}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
