/* VetPlus · service worker: funciona sem internet e entrega imagens salvas no banco (_blob/ID) */
const V='vp-shell-202611140844';
const SHELL=['./','index.html','fb.js','manifest.webmanifest','icon-192.png','icon-512.png','lib/firebase-app-compat.js','lib/firebase-auth-compat.js','lib/firebase-firestore-compat.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil((async()=>{for(const k of await caches.keys())if(k.startsWith('vp-shell-')&&k!==V)await caches.delete(k);await self.clients.claim()})())});

async function askPage(id,clientId){
  let list=[];const c=clientId&&await self.clients.get(clientId);if(c)list.push(c);
  for(const x of await self.clients.matchAll({type:'window'}))if(!list.includes(x))list.push(x);
  for(const cl of list){const r=await new Promise(res=>{const ch=new MessageChannel();const t=setTimeout(()=>res(null),60000);ch.port1.onmessage=e=>{clearTimeout(t);res(e.data)};cl.postMessage({t:'blob',id},[ch.port2])});if(r&&r.ok)return r}
  return null}
async function blob(req,id,clientId){
  const cache=await caches.open('vp-blobs');const key=new Request(new URL('_blob/'+id,self.registration.scope).href);
  const hit=await cache.match(key);if(hit)return hit;
  const r=await askPage(id,clientId);if(!r)return new Response('',{status:404});
  const resp=new Response(r.buf,{headers:{'Content-Type':r.type}});try{await cache.put(key,resp.clone())}catch(_){}return resp}

self.addEventListener('fetch',e=>{const req=e.request;if(req.method!=='GET')return;const u=new URL(req.url);if(u.origin!==location.origin)return;
  const m=u.pathname.match(/\/_blob\/([A-Za-z0-9_-]+)$/);if(m){e.respondWith(blob(req,m[1],e.clientId||e.resultingClientId));return}
  e.respondWith((async()=>{try{const r=await fetch(req);if(r.ok){const c=await caches.open(V);c.put(req,r.clone()).catch(()=>{})}return r}
    catch(_){const hit=await caches.match(req,{ignoreSearch:true});if(hit)return hit;if(req.mode==='navigate'){const idx=await caches.match('index.html');if(idx)return idx}return new Response('',{status:504})}})())});
