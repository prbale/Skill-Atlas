(function(){
'use strict';
/* ---------------- helpers ---------------- */
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4);
const store={
  get(k,ss){try{const v=(ss?sessionStorage:localStorage).getItem(k);return v?JSON.parse(v):null}catch(e){return null}},
  set(k,v,ss){try{(ss?sessionStorage:localStorage).setItem(k,JSON.stringify(v));return true}catch(e){return false}},
  del(k,ss){try{(ss?sessionStorage:localStorage).removeItem(k)}catch(e){}}
};
const activity=(()=>{
  let serial=0,showTimer=null,hideTimer=null,visible=false;
  const pending=new Map();
  const update=()=>{
    const indicator=$('#activityIndicator');
    if(!indicator)return;
    const latest=Array.from(pending.values()).pop();
    if(latest)$('#activityLabel').textContent=latest;
    if(pending.size){
      clearTimeout(hideTimer);hideTimer=null;
      if(!visible&&!showTimer)showTimer=setTimeout(()=>{showTimer=null;if(!pending.size)return;visible=true;indicator.hidden=false;requestAnimationFrame(()=>indicator.classList.add('is-visible'))},180);
    }else{
      clearTimeout(showTimer);showTimer=null;
      if(visible){visible=false;indicator.classList.remove('is-visible');hideTimer=setTimeout(()=>{if(!pending.size)indicator.hidden=true},180)}
    }
  };
  return{
    start(label){const id=++serial;pending.set(id,label);update();return id},
    end(id){pending.delete(id);update()}
  };
})();
function activityLabel(method,path){
  if(path==='/login'||path==='/register')return method==='POST'?'Signing in…':'Working…';
  if(path==='/me'||path==='/config')return 'Checking your account…';
  if(path==='/data')return method==='GET'?'Loading your maps…':'Saving your maps…';
  if(path.startsWith('/data/history'))return method==='GET'?'Loading history…':'Restoring version…';
  if(path.startsWith('/admin'))return method==='GET'?'Loading administration…':'Updating administration…';
  if(path.startsWith('/me/'))return 'Updating account security…';
  return 'Working…';
}
const API={
  async req(method,path,body){
    const task=activity.start(activityLabel(method,path));
    try{
      const headers={'Accept':'application/json'};const opts={method,headers,credentials:'same-origin'};
      if(method!=='GET'){headers['Content-Type']='application/json';opts.body=JSON.stringify(body===undefined?{}:body)}
      let r;try{r=await fetch('/api'+path,opts)}catch(e){const er=new Error('offline');er.offline=true;throw er}
      let json=null;try{json=await r.json()}catch(_){}
      const err=()=>Object.assign(new Error((json&&json.error)||('Server error ('+r.status+')')),{status:r.status,code:json&&json.code,body:json});
      const authPath=path==='/login'||path==='/register';
      if(r.status===401&&!authPath){const e=err();e.auth=true;if(!json||!json.error||json.error==='Please sign in.')e.message='Your session has ended. Please sign in again.';throw e}
      if(!r.ok)throw err();
      return json;
    }finally{activity.end(task)}
  }
};
/* Only http(s) links are ever rendered or saved (blocks javascript:, data: and similar). */
function safeUrl(u){try{const p=new URL(String(u||'').trim());return (p.protocol==='https:'||p.protocol==='http:')&&!p.username&&!p.password&&p.href.length<=2048?p.href:null}catch(e){return null}}
function cleanLinks(d){let removed=0;for(const m of (d&&d.maps)||[]){for(const id in (m.nodes||{})){const n=m.nodes[id];if(!Array.isArray(n.links)){n.links=[];continue}const before=n.links.length;n.links=n.links.filter(l=>l&&safeUrl(l.url)).map(l=>Object.assign({},l,{url:safeUrl(l.url)}));removed+=before-n.links.length}}return removed}
const fmtTime=t=>t?new Date(t).toLocaleString([],{dateStyle:'medium',timeStyle:'short'}):'unknown time';
const P=d=>`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON={
  menu:P('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  plus:P('<path d="M12 5v14M5 12h14"/>'),
  minus:P('<path d="M5 12h14"/>'),
  child:P('<path d="M6 4v7a4 4 0 0 0 4 4h9"/><path d="m15 11 4 4-4 4"/>'),
  sib:P('<path d="M4 6h10M4 12h10M4 18h6M18 14v8M14 18h8"/>'),
  trash:P('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  undo:P('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  redo:P('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
  fit:P('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  tidy:P('<circle cx="5" cy="12" r="2"/><path d="M7 12h3M10 12c3 0 3-6 6-6h2M10 12c3 0 3 6 6 6h2M10 12h8"/>'),
  sun:P('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon:P('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>'),
  more:P('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  x:P('<path d="M6 6l12 12M18 6 6 18"/>'),
  link:P('<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>'),
  notes:P('<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5"/>'),
  logout:P('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>'),
  collapse:P('<path d="m7 14 5-5 5 5"/><path d="M5 19h14"/>'),
  expand:P('<path d="m7 10 5 5 5-5"/><path d="M5 5h14"/>'),
  download:P('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  upload:P('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  copy:P('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  dup:P('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M14 11v6M11 14h6M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  key:P('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>'),
  eye:P('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>')
};
const PALETTE=['b1','b2','b3','b4','b5','b6','b7','b8'];
const STATUS={todo:'To learn',learning:'Learning',done:'Done'};
const HG=64, VG=14, NH=40;

/* ---------------- state ---------------- */
let session=null, data=null, sel=null, sizes={}, hist=[], fut=[], filter='all', matches=[], matchSet=new Set(), matchIdx=-1, saveT=null, editing=false;
let prefs=store.get('atlas:prefs')||{};
const view={tx:0,ty:0,s:1};

const cur=()=>data.maps.find(m=>m.id===data.currentId)||data.maps[0];
const N=id=>cur().nodes[id];
const cacheKey=()=>'atlas:v2:'+session.user.id;
let rev=0,isDirty=false,adminMfaRequired=false;
function writeCache(){if(!session||!data)return;store.set(cacheKey(),{data,baseRevision:rev,dirty:isDirty,at:Date.now()})}
function clearCache(){if(session)store.del(cacheKey())}
function purgeOldCaches(){try{for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i);if(k&&k.indexOf('atlas:v1:')===0)localStorage.removeItem(k)}}catch(_){}}

/* ---------------- model ---------------- */
function makeNode(m,parentId,topic,extra){
  const n=Object.assign({id:uid(),parent:parentId,children:[],topic:topic||'New topic',desc:'',pointers:[],links:[],tags:[],status:'todo',color:null,collapsed:false,x:0,y:0},extra||{});
  m.nodes[n.id]=n; if(parentId) m.nodes[parentId].children.push(n.id); return n;
}
function newMap(title){
  const m={id:uid(),rootId:null,nodes:{},auto:true,created:Date.now(),updated:Date.now()};
  const r=makeNode(m,null,title||'New skill',{status:'learning'}); m.rootId=r.id; return m;
}
function fromSpec(m,pid,s){
  const n=makeNode(m,pid,s.t,{desc:s.d||'',status:s.s||'todo',tags:s.g||[],
    links:(s.l||[]).map(([title,url])=>({id:uid(),title,url})),
    pointers:(s.p||[]).map(x=>Array.isArray(x)?{id:uid(),text:x[0],done:!!x[1]}:{id:uid(),text:x,done:false})});
  (s.c||[]).forEach(c=>fromSpec(m,n.id,c)); return n;
}
function sampleMap(){
  const m={id:uid(),rootId:null,nodes:{},auto:true,created:Date.now(),updated:Date.now()};
  const r=fromSpec(m,null,{t:'Machine Learning',s:'learning',d:'Example map: my roadmap from maths basics to shipping models. Click any topic to open its notes, pointers and links. Rename, restructure or delete anything.',c:[
    {t:'Math foundations',s:'learning',c:[
      {t:'Linear algebra',s:'done',d:'Vectors, matrices and the transformations behind every model.',p:[['Vectors and dot products',true],['Matrix multiplication as a transformation',true],'Eigenvalues and eigenvectors'],l:[['Essence of Linear Algebra – 3Blue1Brown','https://www.3blue1brown.com/topics/linear-algebra']]},
      {t:'Probability & statistics',s:'learning',p:['Bayes theorem','Normal, binomial and Poisson distributions','Expectation and variance'],l:[['Khan Academy – Statistics and probability','https://www.khanacademy.org/math/statistics-probability']]},
      {t:'Calculus for gradients',p:['Partial derivatives','Chain rule → backpropagation']}]},
    {t:'Python toolkit',s:'learning',c:[
      {t:'NumPy',s:'done',l:[['NumPy: the absolute basics','https://numpy.org/doc/stable/user/absolute_beginners.html']]},
      {t:'pandas',s:'learning',l:[['10 minutes to pandas','https://pandas.pydata.org/docs/user_guide/10min.html']]},
      {t:'Matplotlib'}]},
    {t:'Classical ML',s:'learning',c:[
      {t:'Linear & logistic regression',s:'done',l:[['Machine Learning Specialization – Coursera','https://www.coursera.org/specializations/machine-learning-introduction']]},
      {t:'Decision trees & ensembles',s:'learning',p:['Gini impurity vs entropy','Random forests reduce variance','Gradient boosting: XGBoost, LightGBM']},
      {t:'Clustering',p:['k-means','DBSCAN']},
      {t:'scikit-learn',s:'learning',l:[['scikit-learn User Guide','https://scikit-learn.org/stable/user_guide.html']]}]},
    {t:'Deep learning',c:[
      {t:'Neural network basics',l:[['Practical Deep Learning – fast.ai','https://course.fast.ai/']]},
      {t:'PyTorch',l:[['PyTorch Tutorials','https://pytorch.org/tutorials/']]},
      {t:'Transformers & LLMs',p:['Self-attention','Tokenisation','Fine-tuning vs prompting'],l:[['Hugging Face LLM Course','https://huggingface.co/learn/llm-course']]}]},
    {t:'Practice',g:['projects'],c:[
      {t:'Kaggle Learn courses',l:[['Kaggle Learn','https://www.kaggle.com/learn']]},
      {t:'Project: house price predictor',d:'End to end: clean the data, train a model, ship a small web demo.'}]}
  ]});
  m.rootId=r.id; return m;
}
const subtree=id=>{const out=[];const w=i=>{out.push(i);(N(i).children||[]).forEach(w)};w(id);return out};
const descCount=id=>subtree(id).length-1;
function progress(m){const ids=Object.keys(m.nodes).filter(i=>i!==m.rootId);const done=ids.filter(i=>m.nodes[i].status==='done').length;return{total:ids.length,done,pct:ids.length?Math.round(done/ids.length*100):0}}
function visible(m){const out=[];const w=(id,d)=>{const n=m.nodes[id];if(!n)return;out.push([id,d]);if(!n.collapsed)n.children.forEach(c=>w(c,d+1))};w(m.rootId,0);return out}
function depthOf(m,id){let d=0,n=m.nodes[id];while(n&&n.parent){d++;n=m.nodes[n.parent]}return d}
function branchKey(m,id){let n=m.nodes[id];while(n){if(n.color)return n.color;if(!n.parent)return null;if(n.parent===m.rootId){const i=m.nodes[m.rootId].children.indexOf(n.id);return PALETTE[i%PALETTE.length]}n=m.nodes[n.parent]}return null}
const branchVar=(m,id)=>{const k=branchKey(m,id);return k?`var(--${k})`:'var(--accent)'};
const sideOf=(m,id)=>id===m.rootId?1:(m.nodes[id].x<m.nodes[m.rootId].x?-1:1);
const W=id=>(sizes[id]&&sizes[id].w)||130, H=id=>(sizes[id]&&sizes[id].h)||NH;

/* ---------------- layout ---------------- */
function subH(m,id){const n=m.nodes[id];const h=H(id);if(n.collapsed||!n.children.length)return h;const s=n.children.reduce((a,c)=>a+subH(m,c),0)+VG*(n.children.length-1);return Math.max(h,s)}
function placeKids(m,id,dir){const n=m.nodes[id];if(n.collapsed||!n.children.length)return;const hs=n.children.map(c=>subH(m,c));const tot=hs.reduce((a,b)=>a+b,0)+VG*(hs.length-1);let y=n.y-tot/2;n.children.forEach((c,i)=>{const k=m.nodes[c];k.x=n.x+dir*(W(id)/2+HG+W(c)/2);k.y=y+hs[i]/2;y+=hs[i]+VG;placeKids(m,c,dir)})}
function tidy(m,rebalance){
  const r=m.nodes[m.rootId];const kids=r.children.map(c=>m.nodes[c]);
  const fresh=rebalance||kids.every(k=>k.x===r.x&&k.y===r.y);
  const R=[],L=[];let rh=0,lh=0;
  kids.forEach(k=>{const h=subH(m,k.id);const dir=fresh?(rh<=lh?1:-1):(k.x<r.x?-1:1);if(dir>0){R.push(k.id);rh+=h}else{L.push(k.id);lh+=h}});
  const gap=VG*2;
  [[R,1],[L,-1]].forEach(([ids,dir])=>{const hs=ids.map(c=>subH(m,c));const tot=hs.reduce((a,b)=>a+b,0)+gap*Math.max(0,hs.length-1);let y=r.y-tot/2;ids.forEach((c,i)=>{const k=m.nodes[c];k.x=r.x+dir*(W(r.id)/2+HG+24+W(c)/2);k.y=y+hs[i]/2;y+=hs[i]+gap;placeKids(m,c,dir)})});
}

/* ---------------- rendering ---------------- */
function renderNodes(){
  const m=cur();const vis=visible(m);let html='';const showMarks=prefs.marks!==false;
  for(const [id,d] of vis){
    const n=m.nodes[id];const cls=['node','d'+Math.min(d,3),'st-'+n.status];
    if(id===sel)cls.push('sel'); if(matchSet.has(id))cls.push('hit');
    if(filter!=='all'&&id!==m.rootId&&n.status!==filter)cls.push('dim');
    let marks='';
    if(showMarks){ if(n.links.length) marks=`<span class="mk" title="${n.links.length} learning link${n.links.length>1?'s':''}">${ICON.link}${n.links.length}</span>`;
      else if(n.desc.trim()||n.pointers.length) marks=`<span class="mk" title="Has notes">${ICON.notes}</span>`; }
    let tog='';
    if(n.children.length&&d>0){const side=sideOf(m,id)<0?'left':'right';tog=`<button class="tog ${side} ${n.collapsed?'':'open'}" data-tog="${id}" aria-label="${n.collapsed?'Expand':'Collapse'} ${esc(n.topic)}" title="${n.collapsed?'Show':'Hide'} subtopics">${n.collapsed?'+'+descCount(id):'−'}</button>`}
    html+=`<div class="${cls.join(' ')}" data-id="${id}" style="left:${n.x}px;top:${n.y}px;--branch:${branchVar(m,id)}"><span class="sd" aria-hidden="true"></span><span class="label">${esc(n.topic)}</span>${marks}${tog}</div>`;
  }
  const layer=$('#nodes');layer.innerHTML=html;
  $$('.node',layer).forEach(el=>{sizes[el.dataset.id]={w:el.offsetWidth,h:el.offsetHeight}});
  drawEdges();
}
function positionNodes(){const m=cur();$$('#nodes .node').forEach(el=>{const n=m.nodes[el.dataset.id];if(n){el.style.left=n.x+'px';el.style.top=n.y+'px'}});drawEdges()}
function drawEdges(){
  const m=cur();let p='';
  for(const [id,d] of visible(m)){const n=m.nodes[id];if(!n.parent)continue;const pa=m.nodes[n.parent];const dir=n.x>=pa.x?1:-1;
    const sx=pa.x+dir*W(pa.id)/2,sy=pa.y,ex=n.x-dir*W(id)/2,ey=n.y,mx=sx+(ex-sx)*.55;
    const dim=filter!=='all'&&n.status!==filter;
    p+=`<path class="${dim?'dim':''}" d="M${sx} ${sy}C${mx} ${sy} ${sx+(ex-sx)*.45} ${ey} ${ex} ${ey}" style="stroke:${branchVar(m,id)};stroke-width:${d===1?3.2:2}"/>`}
  $('#edges').innerHTML=p;
}
function refresh(){renderNodes();const m=cur();if(m.auto){tidy(m);positionNodes()}renderTop();renderSidebar()}

function applyView(){$('#world').style.transform=`translate(${view.tx}px,${view.ty}px) scale(${view.s})`;const st=$('#stage');const g=22*view.s;st.style.backgroundSize=`${g}px ${g}px`;st.style.backgroundPosition=`${view.tx}px ${view.ty}px`;$('#zoomPct').textContent=Math.round(view.s*100)+'%'}
function zoomAt(f,cx,cy){const s2=Math.min(2.5,Math.max(.15,view.s*f));const k=s2/view.s;view.tx=cx-(cx-view.tx)*k;view.ty=cy-(cy-view.ty)*k;view.s=s2;applyView()}
function zoomCenter(f){const r=$('#stage').getBoundingClientRect();zoomAt(f,r.width/2,r.height/2)}
function fit(){
  const m=cur();const st=$('#stage').getBoundingClientRect();if(!st.width)return;let a=1e9,b=1e9,c=-1e9,d=-1e9;
  for(const [id] of visible(m)){const n=m.nodes[id];a=Math.min(a,n.x-W(id)/2);b=Math.min(b,n.y-H(id)/2);c=Math.max(c,n.x+W(id)/2);d=Math.max(d,n.y+H(id)/2)}
  const pad=56;const s=Math.min(1.15,Math.max(.15,Math.min((st.width-pad*2)/Math.max(1,c-a),(st.height-pad*2)/Math.max(1,d-b))));
  view.s=s;view.tx=st.width/2-(a+c)/2*s;view.ty=st.height/2-(b+d)/2*s;applyView();
}
function centerOn(id){const n=N(id);if(!n)return;const st=$('#stage').getBoundingClientRect();view.tx=st.width/2-n.x*view.s;view.ty=st.height/2-n.y*view.s;applyView()}
function ensureVisible(id){const n=N(id);const st=$('#stage').getBoundingClientRect();const x=n.x*view.s+view.tx,y=n.y*view.s+view.ty;if(x<80||x>st.width-80||y<60||y>st.height-60)centerOn(id)}

function renderTop(){
  const m=cur();const r=m.nodes[m.rootId];const t=$('#mapTitle');if(document.activeElement!==t)t.value=r.topic;
  const p=progress(m);$('#progTxt').innerHTML=`${p.done}/${p.total}<span class="lbl"> done</span>`;
  $('#ringFg').setAttribute('stroke-dashoffset',(69.1*(1-p.pct/100)).toFixed(1));
  $('#tUndo').disabled=!hist.length;$('#tRedo').disabled=!fut.length;
  const auto=$('#tAuto');auto.setAttribute('aria-pressed',String(!!m.auto));
  const nsel=sel&&N(sel);$('#tDel').disabled=!nsel||sel===m.rootId;$('#tSib').disabled=!nsel;
}
function renderSidebar(){
  $('#mapList').innerHTML=data.maps.map(m=>{const p=progress(m);return `<li><button class="map-item ${m.id===data.currentId?'on':''}" data-map="${m.id}"><span class="mi-name">${esc(m.nodes[m.rootId].topic)}</span><span class="mi-meta"><span class="bar"><i style="width:${p.pct}%"></i></span>${p.done}/${p.total}</span></button></li>`}).join('');
}

/* ---------------- details panel ---------------- */
function host(u){try{return new URL(u).hostname.replace(/^www\./,'')}catch(e){return u}}
function renderPanel(){
  const app=$('#app');const pn=$('#panel');const m=cur();const n=sel&&m.nodes[sel];
  app.classList.toggle('panel-open',!!n);
  const prevBody=$('.p-body',pn);const keepScroll=prevBody&&pn.dataset.for===sel?prevBody.scrollTop:0;
  if(!n){pn.innerHTML='';pn.dataset.for='';return}
  pn.dataset.for=sel;
  const path=[];let x=n;while(x){path.unshift(x);x=x.parent?m.nodes[x.parent]:null}
  const done=n.pointers.filter(q=>q.done).length;
  pn.innerHTML=`
  <div class="p-head"><nav class="crumbs" aria-label="Topic path">${path.length>1?path.slice(0,-1).map(q=>`<button data-goto="${q.id}">${esc(q.topic)}</button>`).join('<span aria-hidden="true">›</span>'):'<span>Central topic</span>'}</nav><button class="icon-btn" id="pClose" aria-label="Close details" title="Close (Esc)">${ICON.x}</button></div>
  <div class="p-body">
    <div><label class="sr" for="fTopic">Topic</label><textarea id="fTopic" maxlength="200" class="f-topic" rows="1">${esc(n.topic)}</textarea></div>
    <div class="seg" role="radiogroup" aria-label="Learning status">${Object.entries(STATUS).map(([k,v])=>`<button type="button" role="radio" aria-checked="${n.status===k}" data-status="${k}" class="st-${k}"><span class="sd"></span>${v}</button>`).join('')}</div>
    <section><h3><label for="fDesc">Description</label></h3><textarea id="fDesc" maxlength="20000" placeholder="What is this topic about? Summaries, examples, things to remember…">${esc(n.desc)}</textarea></section>
    <section><h3>Key pointers <span class="count">${n.pointers.length?done+' of '+n.pointers.length+' understood':''}</span></h3>
      <ul class="pointers">${n.pointers.map(q=>`<li data-pid="${q.id}" class="${q.done?'done':''}"><input type="checkbox" id="pc-${q.id}" ${q.done?'checked':''} aria-label="Mark as understood"><input type="text" id="pt-${q.id}" maxlength="500" value="${esc(q.text)}" aria-label="Pointer text"><button class="icon-btn sm" data-delp="${q.id}" aria-label="Remove pointer">${ICON.x}</button></li>`).join('')}</ul>
      <label class="sr" for="newPointer">New pointer</label><input id="newPointer" maxlength="500" type="text" placeholder="Add a pointer, then press Enter"></section>
    <section><h3>Learning links <span class="count">${n.links.length||''}</span></h3>
      <ul class="links">${n.links.map(l=>`<li data-lid="${l.id}"><span class="fav" aria-hidden="true">${esc((host(l.url)[0])||'?')}</span><div class="lk"><a href="${esc(safeUrl(l.url)||'#')}" target="_blank" rel="noopener noreferrer">${esc(l.title||host(l.url))}</a><small>${esc(host(l.url))}</small></div><button class="icon-btn sm" data-dell="${l.id}" aria-label="Remove link">${ICON.x}</button></li>`).join('')}</ul>
      <form id="linkForm" class="link-form" novalidate><label class="sr" for="lTitle">Link title</label><input id="lTitle" maxlength="200" type="text" placeholder="Title, e.g. Official docs (optional)"><label class="sr" for="lUrl">Link address</label><input id="lUrl" maxlength="2048" type="text" inputmode="url" placeholder="https://…"><button class="btn" type="submit">${ICON.plus}Add</button></form>
      <p class="err" id="lErr" hidden></p></section>
    <section><h3>Tags</h3><div class="tags">${n.tags.map((t,i)=>`<span class="tag">${esc(t)}<button data-delt="${i}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('')}<label class="sr" for="newTag">New tag</label><input id="newTag" maxlength="40" type="text" placeholder="Add tag, press Enter"></div></section>
    <section><h3>Branch colour</h3><div class="swatches"><button class="sw inherit ${!n.color?'on':''}" data-color="" aria-label="Automatic colour">Auto</button>${PALETTE.map((k,i)=>`<button class="sw ${n.color===k?'on':''}" data-color="${k}" style="background:var(--${k})" aria-label="Colour ${i+1}"></button>`).join('')}</div></section>
  </div>
  <div class="p-foot"><button class="btn" id="pAdd">${ICON.child}Add subtopic</button><button class="btn danger-ghost" id="pDel" ${n.id===m.rootId?'disabled':''}>${ICON.trash}Delete</button></div>`;
  const body=$('.p-body',pn);body.scrollTop=keepScroll;
  const ft=$('#fTopic');const grow=()=>{ft.style.height='auto';ft.style.height=ft.scrollHeight+'px'};requestAnimationFrame(grow);
  ft.addEventListener('input',()=>{editStart();n.topic=ft.value.replace(/\s*\n\s*/g,' ');grow();const lb=$(`.node[data-id="${n.id}"] .label`);if(lb){lb.textContent=n.topic||' ';const el=lb.parentNode;sizes[n.id]={w:el.offsetWidth,h:el.offsetHeight};drawEdges()}if(n.id===m.rootId)$('#mapTitle').value=n.topic;queueSave()});
  ft.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();ft.blur()}});
  ft.addEventListener('blur',()=>{editEnd();if(!n.topic.trim()){n.topic='Untitled';ft.value=n.topic}refresh()});
  const fd=$('#fDesc');fd.addEventListener('input',()=>{editStart();n.desc=fd.value;queueSave()});fd.addEventListener('blur',()=>{editEnd();renderNodes()});
}
function panelClick(e){
  const m=cur();const n=sel&&m.nodes[sel];if(!n)return;const t=e.target.closest('button');if(!t)return;
  if(t.id==='pClose'){select(null);return}
  if(t.id==='pAdd'){addChild(n.id);return}
  if(t.id==='pDel'){removeNode(n.id);return}
  if(t.dataset.goto){select(t.dataset.goto);centerOn(t.dataset.goto);return}
  if(t.dataset.status){pushHist();n.status=t.dataset.status;refresh();renderPanel();return}
  if(t.dataset.delp){pushHist();n.pointers=n.pointers.filter(q=>q.id!==t.dataset.delp);afterDetail();return}
  if(t.dataset.dell){pushHist();n.links=n.links.filter(l=>l.id!==t.dataset.dell);afterDetail();return}
  if(t.dataset.delt!=null){pushHist();n.tags.splice(+t.dataset.delt,1);afterDetail();return}
  if(t.dataset.color!=null){pushHist();n.color=t.dataset.color||null;refresh();renderPanel();return}
}
function afterDetail(){queueSave();renderNodes();renderPanel()}
function panelChange(e){
  const n=sel&&N(sel);if(!n)return;const t=e.target;
  if(t.type==='checkbox'&&t.id.startsWith('pc-')){pushHist();const q=n.pointers.find(p=>'pc-'+p.id===t.id);if(q){q.done=t.checked;afterDetail()}}
}
function panelInput(e){
  const n=sel&&N(sel);if(!n)return;const t=e.target;
  if(t.id&&t.id.startsWith('pt-')){editStart();const q=n.pointers.find(p=>'pt-'+p.id===t.id);if(q){q.text=t.value;queueSave()}}
}
function panelFocusOut(e){
  const n=sel&&N(sel);if(!n)return;const t=e.target;
  if(t.id&&t.id.startsWith('pt-')){editEnd();const q=n.pointers.find(p=>'pt-'+p.id===t.id);if(q&&!q.text.trim()){n.pointers=n.pointers.filter(p=>p!==q);queueSave();setTimeout(renderPanel,0)}}
}
function panelKey(e){
  const n=sel&&N(sel);if(!n)return;const t=e.target;
  if(t.id==='newPointer'&&e.key==='Enter'){e.preventDefault();const v=t.value.trim();if(!v)return;pushHist();n.pointers.push({id:uid(),text:v,done:false});afterDetail();$('#newPointer').focus()}
  if(t.id==='newTag'&&(e.key==='Enter'||e.key===',')){e.preventDefault();const v=t.value.trim().replace(/,$/,'');if(!v)return;if(!n.tags.some(x=>x.toLowerCase()===v.toLowerCase())){pushHist();n.tags.push(v);afterDetail()}else t.value='';$('#newTag').focus()}
  if(t.id&&t.id.startsWith('pt-')&&e.key==='Enter'){e.preventDefault();$('#newPointer').focus()}
}
function panelSubmit(e){
  if(e.target.id!=='linkForm')return;e.preventDefault();const n=sel&&N(sel);if(!n)return;
  const err=$('#lErr');let u=$('#lUrl').value.trim();const title=$('#lTitle').value.trim();
  if(!u){err.textContent='Paste the web address of the course, article or video.';err.hidden=false;return}
  if(!/^https?:\/\//i.test(u))u='https://'+u;
  let ok=false;try{const p=new URL(u);ok=/\./.test(p.hostname)}catch(_){}
  if(!ok){err.textContent='That address doesn’t look right. Try something like https://developer.android.com';err.hidden=false;return}
  pushHist();n.links.push({id:uid(),title,url:u});afterDetail();setTimeout(()=>{const f=$('#lUrl');f&&f.focus()},0);
}

/* ---------------- history & saving ---------------- */
const snap=()=>JSON.stringify(cur().nodes);
function pushHist(){hist.push(snap());if(hist.length>120)hist.shift();fut=[];renderTop()}
function editStart(){if(!editing){pushHist();editing=true}}
function editEnd(){editing=false}
function restoreNodes(s){cur().nodes=JSON.parse(s);if(sel&&!N(sel))sel=null}
function undo(){if(!hist.length)return;fut.push(snap());restoreNodes(hist.pop());afterHist()}
function redo(){if(!fut.length)return;hist.push(snap());restoreNodes(fut.pop());afterHist()}
function afterHist(){renderNodes();positionNodes();renderTop();renderSidebar();renderPanel();queueSave()}
function queueSave(){isDirty=true;$('#saveState').textContent='Saving…';clearTimeout(saveT);saveT=setTimeout(saveNow,350)}
let saving=false,savePending=false,retryT=null,conflictOpen=false;
async function saveNow(opts){
  if(!session||!data||conflictOpen)return;cur().updated=Date.now();data.savedAt=Date.now();writeCache();
  if(saving){savePending=true;return}saving=true;clearTimeout(retryT);
  try{
    const res=await API.req('PUT','/data',{baseRevision:rev,doc:data,overwrite:!!(opts&&opts.overwrite)});
    rev=res.revision;isDirty=false;writeCache();$('#saveState').textContent='Saved';$('#whoSync').textContent='Synced with server';
    if(res.removedLinks){cleanLinks(data);renderNodes();renderPanel();toast(res.removedLinks+' unsafe link(s) removed. Only http and https links are allowed.')}
  }catch(e){
    if(e.auth){forceLogout(e.message,true);return}
    if(e.code==='conflict'){saving=false;resolveConflict();return}
    if(e.code==='password_change_required'){showForcedPassword();return}
    $('#saveState').textContent=e.offline?'Offline: kept on this device, will sync':'Not synced: '+e.message;$('#whoSync').textContent='Waiting to sync';
    if(e.offline||e.status>=500||e.status===429)retryT=setTimeout(saveNow,6000);
  }finally{saving=false;if(savePending&&!conflictOpen){savePending=false;saveNow()}}
}
function downloadJson(obj,name){const url=URL.createObjectURL(new Blob([JSON.stringify(obj,null,1)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
async function resolveConflict(){
  if(conflictOpen)return;let remote;
  try{remote=await API.req('GET','/data')}catch(e){toast('Could not load the other version: '+e.message);return}
  conflictOpen=true;const mine=data,rm=(remote.doc.maps||[]).length,lm=mine.maps.length;
  openModal(`<h2>Your maps changed on another device</h2><p>This device has changes that weren’t saved yet, and a newer version was saved from somewhere else. Choose which version to keep. Whichever you choose, the server keeps a copy of the replaced version in Version history.</p><div class="choice-row"><div><b>This device</b><small>${lm} map${lm===1?'':'s'} · edited ${esc(fmtTime(mine.savedAt))}</small></div><div><b>Other device</b><small>${rm} map${rm===1?'':'s'} · saved ${esc(fmtTime(remote.doc.savedAt))}</small></div></div><div class="row"><button class="btn" data-dl>Download this device’s version</button><button class="btn" data-theirs>Use the other version</button><button class="btn primary" data-mine>Keep this device’s version</button></div>`,c=>{
    c.querySelector('[data-dl]').onclick=()=>downloadJson({type:'skill-atlas-backup',version:1,maps:mine.maps},'skill-atlas-this-device-'+new Date().toISOString().slice(0,10)+'.json');
    c.querySelector('[data-theirs]').onclick=()=>{conflictOpen=false;closeModal(true);loadDoc(remote);isDirty=false;writeCache();toast('Loaded the newer version from your other device')};
    c.querySelector('[data-mine]').onclick=()=>{conflictOpen=false;rev=remote.revision;closeModal(true);saveNow({overwrite:true})};
  },{locked:true});
}
function loadDoc(remote){
  data=remote.doc&&Array.isArray(remote.doc.maps)?remote.doc:{maps:[],currentId:null};rev=remote.revision||0;
  const removed=cleanLinks(data);if(removed)toast(removed+' unsafe link(s) were removed from your maps.');
  if(!data.maps.length)data={maps:[sampleMap()],currentId:null,savedAt:Date.now()};
  if(!data.maps.some(m=>m.id===data.currentId))data.currentId=data.maps[0].id;
  sel=null;hist=[];fut=[];renderNodes();const m=cur();if(m.auto){tidy(m);positionNodes()}renderTop();renderSidebar();renderPanel();requestAnimationFrame(fit);
}
function forceLogout(msg,keepDirty){
  clearTimeout(saveT);clearTimeout(retryT);
  if(session){if(keepDirty&&isDirty)writeCache();else clearCache()}
  session=null;data=null;rev=0;isDirty=false;$('#app').hidden=true;closeSide();closeModal(true);showLogin();
  if(msg){const err=$('#lgErr');err.textContent=msg;err.hidden=false}
}

/* ---------------- actions ---------------- */
function select(id){
  sel=id;$$('#nodes .node').forEach(el=>el.classList.toggle('sel',el.dataset.id===id));
  renderPanel();renderTop();$('#emptyHint').hidden=true;
  if(window.innerWidth<=860&&id)setTimeout(()=>ensureVisibleAbovePanel(id),230);
}
function ensureVisibleAbovePanel(id){const n=N(id);if(!n)return;const st=$('#stage').getBoundingClientRect();const pn=$('#panel').getBoundingClientRect();const limit=pn.top-st.top-40;const y=n.y*view.s+view.ty;if(y>limit){view.ty-= (y-limit*0.5);applyView()}}
function placeNew(m,n){
  const p=m.nodes[n.parent];let dir;
  if(p.id===m.rootId){let R=0,L=0;p.children.forEach(c=>{if(c===n.id)return;m.nodes[c].x<p.x?L++:R++});dir=R<=L?1:-1}else dir=sideOf(m,p.id);
  const sibs=p.children.filter(c=>c!==n.id&&(p.id!==m.rootId||(m.nodes[c].x<p.x?-1:1)===dir));
  n.x=p.x+dir*(W(p.id)/2+HG+65);
  if(sibs.length){const last=m.nodes[sibs[sibs.length-1]];n.x=last.x;n.y=last.y+H(last.id)/2+VG+NH/2+4}else n.y=p.y;
}
function addChild(pid){const m=cur();pid=pid||sel||m.rootId;const p=m.nodes[pid];pushHist();const wasCollapsed=p.collapsed;p.collapsed=false;const n=makeNode(m,pid,'New topic');placeNew(m,n);sel=n.id;refresh();if(wasCollapsed&&!m.auto)positionNodes();renderPanel();ensureVisible(n.id);setTimeout(()=>ensureVisible(n.id),240);startRename(n.id);queueSave()}
function addSibling(id){const m=cur();if(!id||id===m.rootId){addChild(m.rootId);return}const s=m.nodes[id];const p=m.nodes[s.parent];pushHist();const n=makeNode(m,p.id,'New topic');p.children.pop();p.children.splice(p.children.indexOf(id)+1,0,n.id);n.x=s.x;n.y=s.y+H(id)/2+VG+NH/2+4;sel=n.id;refresh();renderPanel();ensureVisible(n.id);setTimeout(()=>ensureVisible(n.id),240);startRename(n.id);queueSave()}
function removeNode(id){
  const m=cur();if(!id)return;if(id===m.rootId){toast('The central topic can’t be deleted. Rename it, or delete the whole map from the More menu.');return}
  const n=m.nodes[id];pushHist();const ids=subtree(id);const p=m.nodes[n.parent];p.children=p.children.filter(c=>c!==id);ids.forEach(i=>delete m.nodes[i]);
  sel=p.id;runSearch(true);refresh();renderPanel();queueSave();
  toast(`Deleted “${n.topic}”${ids.length>1?' and '+(ids.length-1)+' subtopic'+(ids.length>2?'s':''):''}`,'Undo',undo);
}
function toggleCollapse(id){const n=N(id);if(!n||!n.children.length||id===cur().rootId)return;n.collapsed=!n.collapsed;refresh();queueSave()}
function setAllCollapsed(v){const m=cur();Object.values(m.nodes).forEach(n=>{if(n.id!==m.rootId&&n.children.length)n.collapsed=v});if(v&&sel&&!visible(m).some(([i])=>i===sel))sel=null;refresh();renderPanel();fit();queueSave()}
function expandTo(id){let n=N(id);while(n&&n.parent){n=N(n.parent);n.collapsed=false}}
function isDesc(anc,id){let n=N(id);while(n){if(n.id===anc)return true;n=n.parent?N(n.parent):null}return false}
function reparent(id,tid){
  const m=cur();if(id===m.rootId||isDesc(id,tid))return false;const n=m.nodes[id],t=m.nodes[tid];if(n.parent===tid)return false;
  const op=m.nodes[n.parent];op.children=op.children.filter(c=>c!==id);t.children.push(id);n.parent=tid;t.collapsed=false;
  if(!m.auto){const dir=tid===m.rootId?(n.x<t.x?-1:1):sideOf(m,tid);const sibs=t.children.filter(c=>c!==id);const nx=t.x+dir*(W(tid)/2+HG+W(id)/2);const ny=sibs.length?Math.max(...sibs.map(c=>m.nodes[c].y))+NH+VG:t.y;const dx=nx-n.x,dy=ny-n.y;subtree(id).forEach(i=>{m.nodes[i].x+=dx;m.nodes[i].y+=dy})}
  toast(`Moved “${n.topic}” under “${t.topic}”`,'Undo',undo);return true;
}
function moveSibling(id,delta){const m=cur();const n=m.nodes[id];if(!n||!n.parent)return;const p=m.nodes[n.parent];const i=p.children.indexOf(id),j=i+delta;if(j<0||j>=p.children.length)return;pushHist();p.children.splice(i,1);p.children.splice(j,0,id);if(m.auto)refresh();else{const o=m.nodes[p.children[i]];const ty=o.y;const dy=ty-n.y;subtree(o.id).forEach(k=>m.nodes[k].y-=dy);subtree(id).forEach(k=>m.nodes[k].y+=dy);refresh()}queueSave()}
function navigate(key){
  const m=cur();if(!sel){select(m.rootId);return}const n=m.nodes[sel];const side=sideOf(m,sel);
  const firstKid=dir=>{if(n.collapsed)return null;const ks=n.children.filter(c=>sel!==m.rootId||(m.nodes[c].x<n.x?-1:1)===dir);return ks[0]||null};
  let t=null;
  if(key==='ArrowLeft')t=sel===m.rootId?firstKid(-1):(side>0?n.parent:firstKid(-1));
  if(key==='ArrowRight')t=sel===m.rootId?firstKid(1):(side<0?n.parent:firstKid(1));
  if((key==='ArrowUp'||key==='ArrowDown')&&n.parent){const sib=m.nodes[n.parent].children.filter(c=>n.parent!==m.rootId||sideOf(m,c)===side);const i=sib.indexOf(sel);t=sib[i+(key==='ArrowUp'?-1:1)]||null}
  if(t){select(t);ensureVisible(t)}
}
function startRename(id){
  const el=$(`.node[data-id="${id}"] .label`);if(!el)return;const n=N(id);const old=n.topic;
  el.contentEditable='true';el.spellcheck=false;el.focus();
  const rg=document.createRange();rg.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(rg);
  let done=false;
  const finish=commit=>{if(done)return;done=true;el.contentEditable='false';const v=el.textContent.replace(/\s+/g,' ').trim();if(commit&&v&&v!==old){pushHist();n.topic=v;queueSave()}else if(!v){el.textContent=old}refresh();renderPanel()};
  el.onkeydown=e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();finish(true)}else if(e.key==='Escape'){e.preventDefault();el.textContent=old;finish(false)}else if(e.key==='Tab'){e.preventDefault();finish(true);addChild(id)}};
  el.oninput=()=>{const p=el.parentNode;sizes[id]={w:p.offsetWidth,h:p.offsetHeight};drawEdges()};
  el.onpaste=e=>{e.preventDefault();const t=(e.clipboardData||window.clipboardData).getData('text');document.execCommand('insertText',false,t.replace(/\s+/g,' '))};
  el.onblur=()=>finish(true);
}

/* ---------------- search & filter ---------------- */
function runSearch(silent){
  const q=$('#search').value.trim().toLowerCase();const m=cur();matches=[];
  if(q){for(const [id] of visible(m).concat(Object.keys(m.nodes).map(i=>[i]))){if(matches.includes(id))continue;const n=m.nodes[id];const hay=[n.topic,n.desc,n.tags.join(' '),n.pointers.map(p=>p.text).join(' '),n.links.map(l=>l.title+' '+l.url).join(' ')].join(' ').toLowerCase();if(hay.includes(q))matches.push(id)}}
  matchSet=new Set(matches);matchIdx=-1;$('#searchCount').textContent=q?(matches.length?matches.length+'':'0'):'';
  if(!silent)renderNodes();
}
function nextMatch(back){if(!matches.length)return;matchIdx=(matchIdx+(back?-1:1)+matches.length)%matches.length;const id=matches[matchIdx];expandTo(id);refresh();select(id);centerOn(id);$('#searchCount').textContent=`${matchIdx+1}/${matches.length}`}

/* ---------------- menus, modals, toasts ---------------- */
function toast(msg,action,fn){const t=document.createElement('div');t.className='toast';t.innerHTML=`<span>${esc(msg)}</span>`;if(action){const b=document.createElement('button');b.textContent=action;b.onclick=()=>{fn();t.remove()};t.appendChild(b)}const box=$('#toasts');box.appendChild(t);while(box.children.length>3)box.firstChild.remove();setTimeout(()=>t.remove(),5200)}
let modalLocked=false;
function openModal(html,mount,opts){modalLocked=!!(opts&&opts.locked);const c=$('#modalCard');c.innerHTML=html;$('#modal').hidden=false;mount&&mount(c);const f=c.querySelector('[autofocus],textarea,input,button');f&&f.focus()}
function closeModal(force){if(modalLocked&&force!==true)return;modalLocked=false;if(conflictOpen)conflictOpen=false;$('#modal').hidden=true;$('#modalCard').innerHTML=''}
function confirmBox(title,text,okLabel,fn){openModal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="row"><button class="btn" data-x>Cancel</button><button class="btn danger" data-ok>${esc(okLabel)}</button></div>`,c=>{c.querySelector('[data-x]').onclick=closeModal;c.querySelector('[data-ok]').onclick=()=>{closeModal();fn()};c.querySelector('[data-ok]').focus()})}
async function copyText(text,ta){try{await navigator.clipboard.writeText(text);toast('Copied to clipboard')}catch(e){if(ta){ta.focus();ta.select();toast('Press Ctrl+C (or ⌘C) to copy the selected text')}else toast('Copy is blocked here. Open Export to copy the text by hand.')}}
let menuEl=null;
function closeMenu(){if(menuEl){menuEl.remove();menuEl=null}}
function openMore(btn){
  if(menuEl){closeMenu();return}
  const r=btn.getBoundingClientRect();menuEl=document.createElement('div');menuEl.className='menu';menuEl.setAttribute('role','menu');
  menuEl.innerHTML=`<button data-a="export" role="menuitem">${ICON.download}Export or back up…</button><button data-a="import" role="menuitem">${ICON.upload}Import a map…</button><button data-a="history" role="menuitem">${ICON.undo}Version history…</button><button data-a="outline" role="menuitem">${ICON.copy}Copy as Markdown outline</button><hr><button data-a="dup" role="menuitem">${ICON.dup}Duplicate this map</button><button data-a="balance" role="menuitem">${ICON.tidy}Rebalance left and right</button><button data-a="marks" role="menuitem">${ICON.eye}${prefs.marks===false?'Show':'Hide'} link and note markers</button><button data-a="keys" role="menuitem">${ICON.key}Keyboard shortcuts</button><hr><button data-a="delmap" class="danger" role="menuitem">${ICON.trash}Delete this map</button>`;
  document.body.appendChild(menuEl);const mw=menuEl.offsetWidth;menuEl.style.top=(r.bottom+6)+'px';menuEl.style.left=Math.max(12,Math.min(r.right-mw,window.innerWidth-mw-12))+'px';
  menuEl.onclick=e=>{const b=e.target.closest('button');if(!b)return;closeMenu();menuAction(b.dataset.a)};
}
function outline(m){const lines=[];const w=(id,d)=>{const n=m.nodes[id];const ind='  '.repeat(Math.max(0,d-1));if(d===0)lines.push('# '+n.topic);else lines.push(`${ind}- **${n.topic}**${n.status!=='todo'?' _('+STATUS[n.status]+')_':''}`);const sub='  '.repeat(d);if(n.desc.trim())lines.push(`${sub}${d?'  ':''}${n.desc.trim().replace(/\n+/g,' ')}`);n.pointers.forEach(p=>lines.push(`${sub}${d?'  ':''}- [${p.done?'x':' '}] ${p.text}`));n.links.forEach(l=>lines.push(`${sub}${d?'  ':''}- [${l.title||host(l.url)}](${l.url})`));if(d===0)lines.push('');n.children.forEach(c=>w(c,d+1))};w(m.rootId,0);return lines.join('\n')}
function normalizeMap(raw){
  if(!raw||typeof raw!=='object'||!raw.nodes||!raw.rootId||!raw.nodes[raw.rootId])return null;
  const m={id:uid(),rootId:raw.rootId,nodes:{},auto:raw.auto!==false,created:Date.now(),updated:Date.now()};
  for(const [id,n] of Object.entries(raw.nodes)){m.nodes[id]={id,parent:n.parent||null,children:Array.isArray(n.children)?n.children.filter(c=>raw.nodes[c]):[],topic:String(n.topic||'Untitled').slice(0,200),desc:String(n.desc||'').slice(0,20000),pointers:Array.isArray(n.pointers)?n.pointers.slice(0,100).map(p=>({id:p.id||uid(),text:String(p.text||'').slice(0,500),done:!!p.done})):[],links:Array.isArray(n.links)?n.links.filter(l=>l&&safeUrl(l.url)).slice(0,50).map(l=>({id:l.id||uid(),title:String(l.title||'').slice(0,200),url:safeUrl(l.url)})):[],tags:Array.isArray(n.tags)?n.tags.slice(0,30).map(t=>String(t).slice(0,40)):[],status:STATUS[n.status]?n.status:'todo',color:PALETTE.includes(n.color)?n.color:null,collapsed:!!n.collapsed,x:+n.x||0,y:+n.y||0}}
  return m;
}
function menuAction(a){
  const m=cur();
  if(a==='export'){
    const one=()=>JSON.stringify({type:'skill-atlas-map',version:1,map:m},null,1);
    const all=()=>JSON.stringify({type:'skill-atlas-backup',version:1,maps:data.maps},null,1);
    openModal(`<h2>Export or back up</h2><p>Download a .json file or copy the text, and keep it somewhere safe. Use Import to bring maps back on any Skill Atlas server.</p><div class="seg" role="radiogroup" aria-label="What to export"><button role="radio" aria-checked="true" data-w="one">This map</button><button role="radio" aria-checked="false" data-w="all">All ${data.maps.length} maps</button></div><label class="sr" for="exportText">Export data</label><textarea id="exportText" readonly></textarea><div class="row"><button class="btn" data-x>Close</button><button class="btn" data-dl>${ICON.download}Download .json</button><button class="btn primary" data-copy>${ICON.copy}Copy</button></div>`,c=>{const ta=c.querySelector('#exportText');ta.value=one();c.querySelector('[data-dl]').onclick=()=>{const all=c.querySelector('[data-w="all"]').getAttribute('aria-checked')==='true';const name=(all?'skill-atlas-backup':'skill-atlas-'+(m.nodes[m.rootId].topic.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'map'))+'-'+new Date().toISOString().slice(0,10)+'.json';const url=URL.createObjectURL(new Blob([ta.value],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Downloaded '+name)};c.querySelectorAll('[data-w]').forEach(b=>b.onclick=()=>{c.querySelectorAll('[data-w]').forEach(x=>x.setAttribute('aria-checked',String(x===b)));ta.value=b.dataset.w==='one'?one():all()});c.querySelector('[data-x]').onclick=closeModal;c.querySelector('[data-copy]').onclick=()=>copyText(ta.value,ta)});
  }
  if(a==='import'){
    openModal(`<h2>Import a map</h2><p>Paste text you exported from Skill Atlas, or choose a saved .json file. Imported maps are added next to your existing ones.</p><label class="sr" for="importText">Import data</label><textarea id="importText" placeholder='{"type":"skill-atlas-map", …}'></textarea><input type="file" id="importFile" accept=".json,application/json,text/plain"><p class="err" id="importErr" hidden></p><div class="row"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Import</button></div>`,c=>{
      const ta=c.querySelector('#importText');c.querySelector('#importFile').onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{ta.value=String(r.result)};r.readAsText(f)};
      c.querySelector('[data-x]').onclick=closeModal;
      c.querySelector('[data-ok]').onclick=()=>{const err=c.querySelector('#importErr');let obj;try{obj=JSON.parse(ta.value)}catch(e){err.textContent='This isn’t valid export text. Copy the whole block from Export and try again.';err.hidden=false;return}
        const raw=obj.type==='skill-atlas-backup'?obj.maps:obj.type==='skill-atlas-map'?[obj.map]:[obj];const maps=(raw||[]).map(normalizeMap).filter(Boolean);
        if(!maps.length){err.textContent='No maps found in this text.';err.hidden=false;return}
        data.maps.push(...maps);closeModal();switchMap(maps[0].id);toast(`Imported ${maps.length} map${maps.length>1?'s':''}`)};
    });
  }
  if(a==='outline')copyText(outline(m));
  if(a==='dup'){const c=normalizeMap(JSON.parse(JSON.stringify(m)));c.nodes[c.rootId].topic+=' (copy)';data.maps.push(c);switchMap(c.id);toast('Map duplicated')}
  if(a==='balance'){pushHist();tidy(m,true);positionNodes();fit();queueSave()}
  if(a==='marks'){prefs.marks=prefs.marks===false;store.set('atlas:prefs',prefs);renderNodes()}
  if(a==='keys')showKeys();
  if(a==='history')showHistory();
  if(a==='delmap'){const name=m.nodes[m.rootId].topic;confirmBox('Delete this map?',`“${name}” and all ${Object.keys(m.nodes).length} topics in it will be removed from this browser. This can’t be undone.`,'Delete map',()=>{data.maps=data.maps.filter(x=>x.id!==m.id);if(!data.maps.length)data.maps.push(newMap('My first skill'));switchMap(data.maps[0].id);toast(`Deleted map “${name}”`)})}
}
function showKeys(){const k=(keys,label)=>`<span>${keys.map(x=>`<span class="kbd">${x}</span>`).join('')}</span><span>${label}</span>`;
  openModal(`<h2>Keyboard shortcuts</h2><div class="keys">${k(['Tab'],'Add a subtopic to the selected topic')}${k(['Enter'],'Add a sibling topic')}${k(['F2'],'Rename (or double-click a topic)')}${k(['Del'],'Delete topic and its subtopics')}${k(['Space'],'Fold or unfold a branch')}${k(['←','→','↑','↓'],'Move between topics')}${k(['Alt','↑/↓'],'Reorder among siblings')}${k(['Ctrl','Z'],'Undo')}${k(['Ctrl','Y'],'Redo')}${k(['Ctrl','F'],'Search')}${k(['+','−'],'Zoom in or out')}${k(['0'],'Fit the whole map')}${k(['Esc'],'Close details')}</div><p>Drag empty space to pan. Scroll or pinch to zoom. Drag a topic onto another topic to move it there.</p><div class="row"><button class="btn primary" data-x>Got it</button></div>`,c=>{c.querySelector('[data-x]').onclick=closeModal});
}

/* ---------------- account: password, two-step verification ---------------- */
function pwFields(prefix,withCurrent){return `${withCurrent?`<div class="field"><label for="${prefix}Cur">Current password</label><input id="${prefix}Cur" type="password" autocomplete="current-password" maxlength="128" required></div>`:''}<div class="field"><label for="${prefix}New">New password</label><input id="${prefix}New" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><small class="hint-text">At least 12 characters. A few unrelated words work well.</small></div><div class="field"><label for="${prefix}Conf">Confirm new password</label><input id="${prefix}Conf" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div>`}
function showChangePassword(forced){
  openModal(`<h2>${forced?'Choose a new password':'Change password'}</h2><p>${forced?'Your account has a temporary password. Choose your own password to continue.':'Other devices signed in to your account will be signed out.'}</p><form id="pwForm">${pwFields('pw',true)}<p class="err" id="pwErr" hidden></p><div class="row">${forced?'<button class="btn" type="button" data-out>Sign out</button>':'<button class="btn" type="button" data-x>Cancel</button>'}<button class="btn primary" type="submit">Save password</button></div></form>`,c=>{
    const x=c.querySelector('[data-x]');if(x)x.onclick=()=>closeModal();
    const out=c.querySelector('[data-out]');if(out)out.onclick=async()=>{try{await API.req('POST','/logout')}catch(_){}forceLogout()};
    c.querySelector('#pwForm').onsubmit=async e=>{
      e.preventDefault();const err=c.querySelector('#pwErr');const cur_=c.querySelector('#pwCur').value,nw=c.querySelector('#pwNew').value;
      if(nw.length<12){err.textContent='Choose a password with at least 12 characters.';err.hidden=false;return}
      if(nw!==c.querySelector('#pwConf').value){err.textContent='The new passwords do not match.';err.hidden=false;return}
      try{await API.req('POST','/me/password',{currentPassword:cur_,newPassword:nw});session.user.mustChangePassword=false;closeModal(true);toast('Password updated. Other devices were signed out.');if(forced)enterApp()}
      catch(ex){if(ex.auth){forceLogout(ex.message);return}err.textContent=ex.message;err.hidden=false}
    };
  },{locked:!!forced});
}
function showForcedPassword(){$('#login').hidden=true;showChangePassword(true)}

function showMfa(){
  const u=session.user;
  if(u.mfaEnabled){
    const mustKeep=u.role==='admin'&&adminMfaRequired;
    openModal(`<h2>Two-step verification is on</h2><p>Signing in needs your password and a 6-digit code from your authenticator app.</p>${mustKeep?'<p>Administrators must keep two-step verification on. If you lose your phone, another administrator can reset it, or run <code>node scripts/admin-cli.js reset-mfa '+esc(u.username)+'</code> on the server.</p><div class="row"><button class="btn primary" data-x>Done</button></div>':`<form id="mfaOff"><div class="field"><label for="mfaOffPw">Password</label><input id="mfaOffPw" type="password" autocomplete="current-password" required></div><div class="field"><label for="mfaOffCode">Current 6-digit code</label><input id="mfaOffCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div><p class="err" id="mfaOffErr" hidden></p><div class="row"><button class="btn" type="button" data-x>Keep it on</button><button class="btn danger" type="submit">Turn off</button></div></form>`}`,c=>{
      c.querySelectorAll('[data-x]').forEach(b=>b.onclick=()=>closeModal());
      const f=c.querySelector('#mfaOff');if(f)f.onsubmit=async e=>{e.preventDefault();const err=c.querySelector('#mfaOffErr');try{await API.req('POST','/me/mfa/disable',{password:c.querySelector('#mfaOffPw').value,code:c.querySelector('#mfaOffCode').value});u.mfaEnabled=false;closeModal();toast('Two-step verification turned off')}catch(ex){err.textContent=ex.message;err.hidden=false}};
    });return;
  }
  openModal(`<h2>Turn on two-step verification</h2><p>After this, signing in needs your password and a code from an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password. A stolen password alone won’t be enough.</p><form id="mfaStart"><div class="field"><label for="mfaPw">Confirm your password</label><input id="mfaPw" type="password" autocomplete="current-password" required></div><p class="err" id="mfaErr" hidden></p><div class="row"><button class="btn" type="button" data-x>Cancel</button><button class="btn primary" type="submit">Continue</button></div></form>`,c=>{
    c.querySelector('[data-x]').onclick=()=>closeModal();
    c.querySelector('#mfaStart').onsubmit=async e=>{
      e.preventDefault();const err=c.querySelector('#mfaErr');let setup;
      try{setup=await API.req('POST','/me/mfa/setup',{password:c.querySelector('#mfaPw').value})}catch(ex){err.textContent=ex.message;err.hidden=false;return}
      let qr='';try{const q=qrcode(0,'M');q.addData(setup.uri);q.make();qr=q.createSvgTag(4,2)}catch(_){}
      const grouped=setup.secret.match(/.{1,4}/g).join(' ');
      openModal(`<h2>Scan with your authenticator app</h2><div class="mfa-setup"><div class="qr" aria-label="QR code for your authenticator app">${qr}</div><div><p>Can’t scan? Add an account manually with this key:</p><code class="code-box" id="mfaKey">${esc(grouped)}</code><button class="btn" type="button" data-copy>Copy key</button></div></div><form id="mfaVerify"><div class="field"><label for="mfaCode">Enter the 6-digit code the app shows</label><input id="mfaCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div><p class="err" id="mfaVErr" hidden></p><div class="row"><button class="btn" type="button" data-x>Cancel</button><button class="btn primary" type="submit">Turn on</button></div></form>`,c2=>{
        c2.querySelector('[data-x]').onclick=()=>closeModal();
        c2.querySelector('[data-copy]').onclick=()=>copyText(setup.secret,null);
        c2.querySelector('#mfaVerify').onsubmit=async ev=>{ev.preventDefault();const er=c2.querySelector('#mfaVErr');try{await API.req('POST','/me/mfa/enable',{code:c2.querySelector('#mfaCode').value.trim()});session.user.mfaEnabled=true;closeModal();toast('Two-step verification is on');renderAccount()}catch(ex){er.textContent=ex.message;er.hidden=false}};
      });
    };
  });
}
function renderAccount(){
  const u=session&&session.user;if(!u)return;
  $('#avatar').textContent=u.username[0].toUpperCase();$('#whoName').textContent=u.username;
  $('#whoSync').textContent=u.role==='admin'?'Administrator':'Personal account';
  $('#adminUsers').hidden=u.role!=='admin';
  $('#mfaBtn').textContent=u.mfaEnabled?'Two-step: on':'Turn on two-step';
}

/* ---------------- password confirmation for sensitive admin actions ---------------- */
function askPassword(title,text,okLabel,danger){
  return new Promise(resolve=>{
    openModal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><form id="askPw"><div class="field"><label for="askPwIn">Your password</label><input id="askPwIn" type="password" autocomplete="current-password" required></div><div class="row"><button class="btn" type="button" data-x>Cancel</button><button class="btn ${danger?'danger':'primary'}" type="submit">${esc(okLabel)}</button></div></form>`,c=>{
      c.querySelector('[data-x]').onclick=()=>{closeModal();resolve(null)};
      c.querySelector('#askPw').onsubmit=e=>{e.preventDefault();resolve(c.querySelector('#askPwIn').value)};
    });
  });
}

/* ---------------- administration ---------------- */
const AUDIT_LABELS={'login.success':'Signed in','login.failed':'Failed sign-in','login.mfa_failed':'Wrong two-step code','login.locked':'Sign-in blocked (locked)','logout':'Signed out','account.registered':'Registered','password.changed':'Changed password','password.change_failed':'Wrong current password','password.change_blocked':'Password change blocked','mfa.enabled':'Turned on two-step','mfa.disabled':'Turned off two-step','admin.user_created':'Created account','admin.user_updated':'Changed account','admin.user_deleted':'Deleted account','admin.password_reset':'Reset password','admin.mfa_reset':'Reset two-step','admin.user_unlocked':'Unlocked account','admin.invite_created':'Created invite','admin.invite_revoked':'Revoked invite','admin.legacy_assigned':'Assigned old maps','admin.legacy_deleted':'Deleted old maps','admin.reauth_failed':'Failed password confirmation','data.deleted':'Deleted all maps','data.restored':'Restored a version','cli.password_reset':'Reset password (server)','cli.mfa_reset':'Reset two-step (server)','cli.unlock':'Unlocked (server)','cli.promote':'Promoted (server)'};
async function showAdmin(tab){
  if(!session||session.user.role!=='admin')return;
  if(adminMfaRequired&&!session.user.mfaEnabled){
    openModal(`<h2>Turn on two-step verification first</h2><p>Administrator tools need two-step verification, so a stolen password alone can’t take over this server.</p><div class="row"><button class="btn" data-x>Not now</button><button class="btn primary" data-go>Set it up</button></div>`,c=>{c.querySelector('[data-x]').onclick=()=>closeModal();c.querySelector('[data-go]').onclick=showMfa});return;
  }
  const tabs=[['users','Users'],['invites','Invites'],['audit','Activity log'],['legacy','Old maps']];
  openModal(`<h2>Administration</h2><div class="tabs" role="tablist">${tabs.map(([k,l])=>`<button type="button" role="tab" aria-selected="${k===tab}" data-tab="${k}">${l}</button>`).join('')}</div><div id="adminBody" class="admin-body">Loading…</div><div class="row"><button class="btn" data-x>Close</button></div>`,c=>{
    c.querySelector('[data-x]').onclick=()=>closeModal();
    c.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>showAdmin(b.dataset.tab));
  });
  const body=$('#adminBody');
  try{
    if(tab==='users')await adminUsersTab(body);
    else if(tab==='invites')await adminInvitesTab(body);
    else if(tab==='audit')await adminAuditTab(body);
    else await adminLegacyTab(body);
  }catch(ex){if(ex.auth){forceLogout(ex.message);return}body.innerHTML=`<p class="err">${esc(ex.message)}</p>`}
}
async function adminAction(fn,okMsg,back){try{await fn();toast(okMsg)}catch(ex){if(ex.auth){forceLogout(ex.message);return}toast(ex.message)}showAdmin(back)}
async function adminUsersTab(body){
  const {users}=await API.req('GET','/admin/users');
  body.innerHTML=`<div class="admin-users">${users.map(u=>{const me=u.id===session.user.id;return `<div class="admin-user"><div class="admin-user-info"><b>${esc(u.username)}${me?' (you)':''}</b><small>${u.role==='admin'?'Administrator':'User'} · ${u.disabled?'Disabled':'Active'} · ${u.mfaEnabled?'Two-step on':'Two-step off'}${u.mustChangePassword?' · Temporary password':''}${u.lastLoginAt?' · Last sign-in '+esc(fmtTime(u.lastLoginAt)):''}</small></div><div class="admin-user-actions">${me?'':`<button class="btn" data-action="role" data-id="${u.id}">${u.role==='admin'?'Make user':'Make admin'}</button><button class="btn" data-action="state" data-id="${u.id}">${u.disabled?'Enable':'Disable'}</button><button class="btn" data-action="reset" data-id="${u.id}">Reset password</button>${u.mfaEnabled?`<button class="btn" data-action="mfa" data-id="${u.id}">Reset two-step</button>`:''}<button class="btn" data-action="unlock" data-id="${u.id}">Unlock</button><button class="btn danger-ghost" data-action="delete" data-id="${u.id}">Delete</button>`}</div></div>`}).join('')}</div>
  <form id="adminCreateForm" class="admin-form"><h3>Create an account</h3><p>The person must change this temporary password the first time they sign in.</p><div class="field"><label for="adminNewName">Username</label><input id="adminNewName" autocomplete="off" required minlength="2" maxlength="40"></div><div class="field"><label for="adminNewPassword">Temporary password (12+ characters)</label><input id="adminNewPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></div><p class="err" id="adminCreateErr" hidden></p><button class="btn primary" type="submit">Create account</button></form>`;
  body.querySelector('#adminCreateForm').onsubmit=async e=>{e.preventDefault();const er=body.querySelector('#adminCreateErr');try{await API.req('POST','/admin/users',{username:body.querySelector('#adminNewName').value,password:body.querySelector('#adminNewPassword').value});toast('Account created');showAdmin('users')}catch(ex){er.textContent=ex.message;er.hidden=false}};
  body.querySelector('.admin-users').onclick=async e=>{
    const b=e.target.closest('button[data-action]');if(!b)return;const id=Number(b.dataset.id),a=b.dataset.action,u=users.find(x=>x.id===id);if(!u)return;
    if(a==='state')return adminAction(()=>API.req('PATCH','/admin/users/'+id,{disabled:!u.disabled}),u.disabled?'Account enabled':'Account disabled and signed out','users');
    if(a==='unlock')return adminAction(()=>API.req('POST','/admin/users/'+id+'/unlock'),'Sign-in lockout cleared','users');
    if(a==='role'){const pw=await askPassword(u.role==='admin'?`Remove administrator access from ${u.username}?`:`Make ${u.username} an administrator?`,'Confirm with your password. They will be signed out and must sign in again.',u.role==='admin'?'Make user':'Make admin');if(pw==null)return showAdmin('users');return adminAction(()=>API.req('PATCH','/admin/users/'+id,{role:u.role==='admin'?'user':'admin',confirmPassword:pw}),'Role changed','users')}
    if(a==='mfa'){const pw=await askPassword(`Reset two-step verification for ${u.username}?`,'Use this when they lose their phone. They will be signed out and can set it up again.','Reset two-step',true);if(pw==null)return showAdmin('users');return adminAction(()=>API.req('POST','/admin/users/'+id+'/mfa-reset',{confirmPassword:pw}),'Two-step verification reset','users')}
    if(a==='delete'){const pw=await askPassword(`Delete ${u.username}?`,'This permanently deletes the account and all of its maps. It cannot be undone.','Delete account',true);if(pw==null)return showAdmin('users');return adminAction(()=>API.req('DELETE','/admin/users/'+id,{confirmPassword:pw}),'Account deleted','users')}
    if(a==='reset'){
      openModal(`<h2>Reset password for ${esc(u.username)}</h2><p>Set a temporary password and share it privately. They must change it at their next sign-in, and they are signed out everywhere now.</p><form id="rsF"><div class="field"><label for="rsNew">Temporary password (12+ characters)</label><input id="rsNew" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div><div class="field"><label for="rsMe">Your password</label><input id="rsMe" type="password" autocomplete="current-password" required></div><p class="err" id="rsErr" hidden></p><div class="row"><button class="btn" type="button" data-x>Cancel</button><button class="btn primary" type="submit">Reset password</button></div></form>`,c=>{
        c.querySelector('[data-x]').onclick=()=>showAdmin('users');
        c.querySelector('#rsF').onsubmit=async ev=>{ev.preventDefault();const er=c.querySelector('#rsErr');try{await API.req('POST','/admin/users/'+id+'/password',{password:c.querySelector('#rsNew').value,confirmPassword:c.querySelector('#rsMe').value});toast('Password reset');showAdmin('users')}catch(ex){er.textContent=ex.message;er.hidden=false}};
      });
    }
  };
}
async function adminInvitesTab(body){
  const {invites,registration}=await API.req('GET','/admin/invites');
  const mode={open:'Anyone can create an account.',invite:'People need an invite code to create an account.',closed:'Only administrators can create accounts. Invite codes are not accepted.'}[registration];
  const now=Date.now();
  body.innerHTML=`<p>${esc(mode)} Change this with the <code>REGISTRATION</code> setting on the server.</p><form id="invF" class="admin-form inline"><div class="field"><label for="invNote">Who is it for? (optional)</label><input id="invNote" maxlength="80" placeholder="e.g. Ravi from work"></div><div class="field"><label for="invHours">Valid for</label><select id="invHours"><option value="24">1 day</option><option value="48" selected>2 days</option><option value="168">7 days</option></select></div><button class="btn primary" type="submit">Create invite code</button></form><div id="invNew"></div>
  <div class="admin-users">${invites.length?invites.map(i=>`<div class="admin-user"><div class="admin-user-info"><b><code>${esc(i.hint)}</code>${i.note?' · '+esc(i.note):''}</b><small>${i.usedAt?'Used by '+esc(i.usedBy||'a deleted account')+' on '+esc(fmtTime(i.usedAt)):i.expiresAt<now?'Expired':'Valid until '+esc(fmtTime(i.expiresAt))}</small></div><div class="admin-user-actions">${i.usedAt?'':`<button class="btn danger-ghost" data-revoke="${esc(i.id)}">Revoke</button>`}</div></div>`).join(''):'<p>No invite codes yet.</p>'}</div>`;
  body.querySelector('#invF').onsubmit=async e=>{e.preventDefault();try{const r=await API.req('POST','/admin/invites',{note:body.querySelector('#invNote').value,hours:Number(body.querySelector('#invHours').value)});const box=body.querySelector('#invNew');box.innerHTML=`<div class="notice"><p>Share this code privately. It works once and is shown only now.</p><code class="code-box">${esc(r.code)}</code> <button class="btn" type="button" data-copy>Copy</button></div>`;box.querySelector('[data-copy]').onclick=()=>copyText(r.code,null)}catch(ex){toast(ex.message)}};
  body.onclick=e=>{const b=e.target.closest('[data-revoke]');if(b)adminAction(()=>API.req('DELETE','/admin/invites/'+b.dataset.revoke),'Invite revoked','invites')};
}
async function adminAuditTab(body,before){
  const {entries}=await API.req('GET','/admin/audit?limit=100'+(before?'&before='+before:''));
  const rows=entries.map(r=>`<tr><td>${esc(fmtTime(r.ts))}</td><td>${esc(r.actor||'—')}</td><td>${esc(AUDIT_LABELS[r.action]||r.action)}</td><td>${esc(r.target||'')}</td><td class="mono">${esc(r.ip||'')}</td></tr>`).join('');
  if(!before)body.innerHTML=`<div class="table-wrap"><table class="audit"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Target</th><th>IP</th></tr></thead><tbody></tbody></table></div><div class="row"><button class="btn" id="auditMore">Load older</button></div>`;
  body.querySelector('tbody').insertAdjacentHTML('beforeend',rows||(before?'':'<tr><td colspan="5">No activity yet.</td></tr>'));
  const more=body.querySelector('#auditMore');more.hidden=entries.length<100;
  more.onclick=()=>adminAuditTab(body,entries[entries.length-1].id).catch(ex=>toast(ex.message));
}
async function adminLegacyTab(body){
  const [{legacy},{users}]=await Promise.all([API.req('GET','/admin/legacy'),API.req('GET','/admin/users')]);
  const opts=users.map(u=>`<option value="${u.id}">${esc(u.username)}</option>`).join('');
  body.innerHTML=`<p>These maps came from the old demo version, where anyone could sign in with any name. They are not attached to any account until you decide who they belong to. Check with the person before assigning.</p>${legacy.length?`<div class="admin-users">${legacy.map(l=>`<div class="admin-user"><div class="admin-user-info"><b>${esc(l.username)}</b><small>${l.maps} map${l.maps===1?'':'s'} · ${(l.bytes/1024).toFixed(1)} KB${l.matchingUserId?' · an account with this name exists, but that does not prove ownership':''}</small></div><div class="admin-user-actions"><label class="sr" for="lg-${esc(l.username)}">Assign to</label><select id="lg-${esc(l.username)}">${opts}</select><button class="btn" data-assign="${esc(l.username)}">Assign</button><button class="btn danger-ghost" data-ldel="${esc(l.username)}">Delete</button></div></div>`).join('')}</div>`:'<p>Nothing left to review.</p>'}`;
  body.onclick=async e=>{
    const a=e.target.closest('[data-assign]'),d=e.target.closest('[data-ldel]');
    if(a){const name=a.dataset.assign;const sel_=body.querySelector(`select[id="lg-${CSS.escape(name)}"]`);const userId=Number(sel_.value);const to=users.find(u=>u.id===userId);const pw=await askPassword(`Give “${name}” maps to ${to.username}?`,'They will be added next to that account’s existing maps.','Assign maps');if(pw==null)return showAdmin('legacy');adminAction(()=>API.req('POST','/admin/legacy/'+encodeURIComponent(name)+'/assign',{userId,confirmPassword:pw}),'Maps assigned','legacy')}
    if(d){const name=d.dataset.ldel;const pw=await askPassword(`Delete old maps for “${name}”?`,'This cannot be undone.','Delete',true);if(pw==null)return showAdmin('legacy');adminAction(()=>API.req('DELETE','/admin/legacy/'+encodeURIComponent(name),{confirmPassword:pw}),'Old maps deleted','legacy')}
  };
}

/* ---------------- version history ---------------- */
const HISTORY_REASONS={autosave:'Automatic save','before-restore':'Before a restore','before-delete':'Before deleting all maps','legacy-assign':'Before old maps were added',conflict:'Replaced from another device'};
function showHistory(){
  openModal(`<h2>Version history</h2><p>The server keeps your last 20 saved versions (at most one every 5 minutes), plus a copy before any restore. Restoring replaces your current maps, and your current state is saved here first.</p><div id="histList">Loading…</div><div class="row"><button class="btn" data-x>Close</button></div>`,async c=>{
    c.querySelector('[data-x]').onclick=()=>closeModal();
    const L=c.querySelector('#histList');
    try{
      const {versions}=await API.req('GET','/data/history');
      if(!versions.length){L.innerHTML='<p>No earlier versions yet. They appear as you keep working.</p>';return}
      L.innerHTML=`<ul class="hist">${versions.map(v=>`<li><div><b>${esc(fmtTime(v.savedAt))}</b><small>${v.maps} map${v.maps===1?'':'s'} · ${esc(HISTORY_REASONS[v.reason]||v.reason)}</small></div><button class="btn" data-restore="${v.id}">Restore</button></li>`).join('')}</ul>`;
      L.onclick=async e=>{const b=e.target.closest('[data-restore]');if(!b)return;b.disabled=true;
        try{clearTimeout(saveT);if(isDirty)await saveNow();await API.req('POST','/data/history/'+b.dataset.restore+'/restore');const remote=await API.req('GET','/data');loadDoc(remote);isDirty=false;writeCache();closeModal();toast('Version restored')}
        catch(ex){if(ex.auth){forceLogout(ex.message);return}toast(ex.message);b.disabled=false}};
    }catch(ex){L.innerHTML=`<p class="err">${esc(ex.message)}</p>`}
  });
}


/* ---------------- map switching ---------------- */
function switchMap(id){data.currentId=id;sel=null;hist=[];fut=[];$('#search').value='';runSearch(true);closeSide();renderNodes();const m=cur();if(m.auto){tidy(m);positionNodes()}renderTop();renderSidebar();renderPanel();fit();queueSave()}
function openSide(){$('#app').classList.add('side-open');$('#scrim').hidden=false}
function closeSide(){$('#app').classList.remove('side-open');$('#scrim').hidden=true}

/* ---------------- theme ---------------- */
function isDark(){const t=document.documentElement.dataset.theme;if(t)return t==='dark';return window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches}
function applyTheme(){if(prefs.theme)document.documentElement.dataset.theme=prefs.theme;$('#tTheme')&&($('#tTheme').innerHTML=isDark()?ICON.sun:ICON.moon)}

/* ---------------- canvas interaction ---------------- */
function bindStage(){
  const stage=$('#stage');const pts=new Map();let pan=null,drag=null,pinch=null,lastTap={};
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  stage.addEventListener('pointerdown',e=>{
    if(e.target.closest('.zoombar,.hint,.tog'))return;if(e.target.isContentEditable)return;if(e.pointerType==='mouse'&&e.button!==0)return;
    if(document.activeElement&&document.activeElement.isContentEditable)document.activeElement.blur();
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pts.size===2){if(drag&&drag.moved){drag.orig.forEach(([i,x,y])=>{N(i).x=x;N(i).y=y});positionNodes()}drag=null;pan=null;const [a,b]=[...pts.values()];pinch={d:dist(a,b)};return}
    const nodeEl=e.target.closest('.node');
    if(nodeEl){drag={id:nodeEl.dataset.id,sx:e.clientX,sy:e.clientY,moved:false,ids:subtree(nodeEl.dataset.id),target:null}}
    else{pan={x:e.clientX,y:e.clientY,ox:e.clientX,oy:e.clientY,moved:false};stage.classList.add('panning')}
    try{stage.setPointerCapture(e.pointerId)}catch(_){}
  });
  stage.addEventListener('pointermove',e=>{
    if(!pts.has(e.pointerId))return;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pinch&&pts.size===2){const [a,b]=[...pts.values()];const d=dist(a,b);const r=stage.getBoundingClientRect();zoomAt(d/pinch.d,(a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top);pinch.d=d;return}
    if(drag){const dx=e.clientX-drag.sx,dy=e.clientY-drag.sy;if(!drag.moved&&Math.hypot(dx,dy)<5)return;
      if(!drag.moved){drag.moved=true;pushHist();drag.orig=drag.ids.map(i=>[i,N(i).x,N(i).y]);stage.classList.add('dragging')}
      drag.orig.forEach(([i,x,y])=>{const n=N(i);n.x=x+dx/view.s;n.y=y+dy/view.s});positionNodes();
      const hit=document.elementsFromPoint(e.clientX,e.clientY).find(x=>x.classList&&x.classList.contains('node')&&!drag.ids.includes(x.dataset.id));
      const tid=hit?hit.dataset.id:null;if(tid!==drag.target){$$('#nodes .node.drop').forEach(x=>x.classList.remove('drop'));drag.target=tid;if(hit)hit.classList.add('drop')}
      return}
    if(pan){view.tx+=e.clientX-pan.x;view.ty+=e.clientY-pan.y;pan.x=e.clientX;pan.y=e.clientY;if(Math.hypot(e.clientX-pan.ox,e.clientY-pan.oy)>4)pan.moved=true;applyView()}
  });
  const end=(e,cancel)=>{
    if(!pts.has(e.pointerId))return;pts.delete(e.pointerId);stage.classList.remove('panning');
    if(pinch){if(pts.size<2)pinch=null;pan=null;return}
    if(drag){const d=drag;drag=null;stage.classList.remove('dragging');$$('#nodes .node.drop').forEach(x=>x.classList.remove('drop'));
      if(cancel){if(d.moved){d.orig.forEach(([i,x,y])=>{N(i).x=x;N(i).y=y});positionNodes()}return}
      if(!d.moved){const now=Date.now();if(lastTap.id===d.id&&now-lastTap.t<400){lastTap={};select(d.id);startRename(d.id)}else{lastTap={id:d.id,t:now};select(d.id)}return}
      const m=cur();
      if(d.target&&reparent(d.id,d.target)){refresh();renderPanel()}
      else if(m.auto&&d.id!==m.rootId){m.auto=false;renderTop();toast('Auto-arrange is now off, so topics stay where you drag them.','Turn back on',()=>{m.auto=true;refresh();queueSave()})}
      drawEdges();queueSave();return}
    if(pan){if(!pan.moved&&!cancel)select(null);pan=null}
  };
  stage.addEventListener('pointerup',e=>end(e,false));
  stage.addEventListener('pointercancel',e=>end(e,true));
  stage.addEventListener('wheel',e=>{if(e.target.closest('.zoombar,.hint'))return;e.preventDefault();const r=stage.getBoundingClientRect();
    const mouse=e.deltaMode===1||(e.deltaX===0&&Math.abs(e.deltaY)>=50&&Number.isInteger(e.deltaY));
    if(e.ctrlKey||e.metaKey||mouse)zoomAt(Math.exp(-e.deltaY*(e.ctrlKey?0.012:0.0016)*(e.deltaMode===1?33:1)),e.clientX-r.left,e.clientY-r.top);
    else{view.tx-=e.deltaX;view.ty-=e.deltaY;applyView()}},{passive:false});
  $('#nodes').addEventListener('click',e=>{const t=e.target.closest('.tog');if(t){e.stopPropagation();toggleCollapse(t.dataset.tog)}});
}

/* ---------------- keyboard ---------------- */
function bindKeys(){
  document.addEventListener('keydown',e=>{
    if($('#app').hidden)return;
    if(!$('#modal').hidden){if(e.key==='Escape')closeModal();return}
    if(menuEl&&e.key==='Escape'){closeMenu();return}
    const t=e.target;const typing=t.matches&&(t.matches('input,textarea,select')||t.isContentEditable);const mod=e.ctrlKey||e.metaKey;const k=e.key.toLowerCase();
    if(mod&&k==='f'){e.preventDefault();$('#search').focus();$('#search').select();return}
    if(typing)return;
    if(mod&&k==='z'){e.preventDefault();e.shiftKey?redo():undo();return}
    if(mod&&k==='y'){e.preventDefault();redo();return}
    if(mod)return;
    const m=cur();
    switch(e.key){
      case 'Tab':e.preventDefault();addChild(sel||m.rootId);break;
      case 'Enter':e.preventDefault();sel?addSibling(sel):addChild(m.rootId);break;
      case 'Delete':case 'Backspace':if(sel){e.preventDefault();removeNode(sel)}break;
      case 'F2':e.preventDefault();if(sel)startRename(sel);break;
      case ' ':e.preventDefault();if(sel)toggleCollapse(sel);break;
      case 'Escape':if($('#app').classList.contains('side-open'))closeSide();else select(null);break;
      case '+':case '=':zoomCenter(1.2);break;
      case '-':case '_':zoomCenter(1/1.2);break;
      case '0':fit();break;
      case 'ArrowUp':case 'ArrowDown':e.preventDefault();if(e.altKey&&sel)moveSibling(sel,e.key==='ArrowUp'?-1:1);else navigate(e.key);break;
      case 'ArrowLeft':case 'ArrowRight':e.preventDefault();navigate(e.key);break;
      case '?':showKeys();break;
    }
  });
}

/* ---------------- boot ---------------- */
function setIcons(){
  const map={menuBtn:'menu',tUndo:'undo',tRedo:'redo',tChild:'child',tSib:'sib',tDel:'trash',tCollapse:'collapse',tExpand:'expand',tMore:'more',logout:'logout',tTidy:'tidy',zOut:'minus',zIn:'plus',zFit:'fit'};
  for(const [id,ic] of Object.entries(map))$('#'+id).innerHTML=ICON[ic];
  $('#newMap').innerHTML=ICON.plus+'New';
}
function bindApp(){
  setIcons();bindStage();bindKeys();
  $('#tUndo').onclick=undo;$('#tRedo').onclick=redo;
  $('#tChild').onclick=()=>addChild(sel||cur().rootId);$('#tSib').onclick=()=>addSibling(sel);$('#tDel').onclick=()=>removeNode(sel);
  $('#tCollapse').onclick=()=>setAllCollapsed(true);$('#tExpand').onclick=()=>setAllCollapsed(false);
  $('#tTheme').onclick=()=>{prefs.theme=isDark()?'light':'dark';store.set('atlas:prefs',prefs);applyTheme()};
  $('#tMore').onclick=e=>{e.stopPropagation();openMore(e.currentTarget)};
  document.addEventListener('pointerdown',e=>{if(menuEl&&!menuEl.contains(e.target)&&e.target.closest('#tMore')==null)closeMenu()});
  $('#tAuto').onclick=()=>{const m=cur();m.auto=!m.auto;if(m.auto){pushHist();refresh();fit()}renderTop();queueSave();toast(m.auto?'Auto-arrange on: the map tidies itself as you add topics.':'Auto-arrange off: drag topics wherever you like.')};
  $('#tTidy').onclick=()=>{pushHist();tidy(cur());positionNodes();fit();queueSave()};
  $('#zIn').onclick=()=>zoomCenter(1.2);$('#zOut').onclick=()=>zoomCenter(1/1.2);$('#zFit').onclick=fit;$('#zoomPct').onclick=fit;
  $('#hintKeys').onclick=showKeys;
  $('#menuBtn').onclick=openSide;$('#scrim').onclick=closeSide;
  $('#newMap').onclick=()=>{const m=newMap('New skill');data.maps.push(m);switchMap(m.id);setTimeout(()=>{const t=$('#mapTitle');t.focus();t.select()},50)};
  $('#mapList').addEventListener('click',e=>{const b=e.target.closest('[data-map]');if(b&&b.dataset.map!==data.currentId)switchMap(b.dataset.map);else closeSide()});
  $('#logout').onclick=async()=>{await saveNow();try{await API.req('POST','/logout')}catch(_){}forceLogout()};
  $('#changePassword').onclick=()=>showChangePassword(false);
  $('#mfaBtn').onclick=showMfa;
  $('#adminUsers').onclick=()=>showAdmin('users');
  const mt=$('#mapTitle');
  mt.addEventListener('input',()=>{editStart();const m=cur();m.nodes[m.rootId].topic=mt.value;const lb=$(`.node[data-id="${m.rootId}"] .label`);if(lb){lb.textContent=mt.value;const el=lb.parentNode;sizes[m.rootId]={w:el.offsetWidth,h:el.offsetHeight};drawEdges()}if(sel===m.rootId){const f=$('#fTopic');if(f)f.value=mt.value}queueSave()});
  mt.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key==='Escape')mt.blur()});
  mt.addEventListener('blur',()=>{editEnd();const m=cur();if(!m.nodes[m.rootId].topic.trim())m.nodes[m.rootId].topic='Untitled skill';refresh()});
  const s=$('#search');s.addEventListener('input',()=>runSearch());s.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();nextMatch(e.shiftKey)}if(e.key==='Escape'){s.value='';runSearch();s.blur()}});
  $('#filter').onchange=e=>{filter=e.target.value;renderNodes()};
  const pn=$('#panel');pn.addEventListener('click',panelClick);pn.addEventListener('change',panelChange);pn.addEventListener('input',panelInput);pn.addEventListener('focusout',panelFocusOut);pn.addEventListener('keydown',panelKey);pn.addEventListener('submit',panelSubmit);
  $('#modal').addEventListener('click',e=>{if(e.target.id==='modal')closeModal()});
  window.addEventListener('resize',()=>applyView());
  if(window.matchMedia)matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyTheme);
}
async function showApp(){
  $('#login').hidden=true;$('#app').hidden=false;$('#saveState').textContent='Loading…';
  renderAccount();filter='all';$('#filter').value='all';$('#search').value='';matchSet=new Set();applyTheme();
  let remote=null;
  try{remote=await API.req('GET','/data')}catch(e){
    if(e.auth){forceLogout(e.message);return}
    if(e.code==='password_change_required'){showForcedPassword();return}
  }
  const cache=store.get(cacheKey());
  const cached=cache&&cache.data&&Array.isArray(cache.data.maps)&&cache.data.maps.length?cache:null;
  if(!remote){ // offline: work from this device's copy
    loadDoc(cached?{doc:cache.data,revision:cache.baseRevision||0}:{doc:null,revision:0});isDirty=!!(cached&&cached.dirty);
    toast('Can’t reach the server. You can keep working; changes sync when it’s back.');return;
  }
  if(cached&&cached.dirty){
    // Unsynced edits from last time: push them, or ask if the server moved on meanwhile.
    loadDoc({doc:cache.data,revision:cache.baseRevision||0});isDirty=true;
    if((cache.baseRevision||0)===remote.revision){saveNow();toast('Synced changes made while you were offline')}
    else resolveConflict();
  }else{
    loadDoc(remote);isDirty=false;
    if(remote.revision===0)queueSave(); // first sign-in: save the example map
    else{writeCache();$('#saveState').textContent='Saved'}
  }
  requestAnimationFrame(()=>{$('#emptyHint').hidden=false;setTimeout(()=>{$('#emptyHint').hidden=true},6000)});
  if(session.user.role==='admin'&&adminMfaRequired&&!session.user.mfaEnabled)
    toast('Turn on two-step verification to use administrator tools.','Set up',showMfa);
}
function enterApp(){if(session.user.mustChangePassword)showForcedPassword();else showApp()}

let authMode='login',regMode='invite',mfaStep=false;
async function loadConfig(){try{const c=await API.req('GET','/config');regMode=c.registration}catch(_){}$('#authSwitch').hidden=regMode==='closed';setAuthMode(authMode)}
function setAuthMode(mode){
  authMode=mode;const registering=mode==='register';mfaStep=false;
  $('#loginForm h2').textContent=registering?'Create your account':'Sign in';
  $('#authSubtitle').textContent=registering?(regMode==='invite'?'You need an invite code from the administrator.':'Create a private workspace for your skill maps.'):'Pick up your maps where you left them.';
  $('#confirmField').hidden=!registering;$('#inviteField').hidden=!(registering&&regMode==='invite');$('#mfaField').hidden=true;$('#lgCode').value='';
  $('#lgUser').disabled=false;$('#lgPass').disabled=false;
  $('#lgPass').autocomplete=registering?'new-password':'current-password';
  $('#loginForm button[type=submit]').textContent=registering?'Create account':'Sign in';
  $('#authSwitchText').textContent=registering?'Already have an account?':'New to Skill Atlas?';
  $('#authModeBtn').textContent=registering?'Sign in':'Create an account';$('#lgErr').hidden=true;
}
function showLogin(){
  $('#login').hidden=false;$('#lgErr').hidden=true;$('#lgPass').value='';$('#lgConfirm').value='';$('#lgInvite').value='';setAuthMode('login');
  setTimeout(()=>$('#lgUser').focus(),0);
}
$('#authModeBtn').onclick=()=>setAuthMode(authMode==='login'?'register':'login');
$('#loginForm').addEventListener('submit',async e=>{
  e.preventDefault();const u=$('#lgUser').value.trim(),p=$('#lgPass').value;const err=$('#lgErr');const btn=$('#loginForm button[type=submit]');
  const fail=(m,f)=>{err.textContent=m;err.hidden=false;if(f)f.focus()};
  if(!u)return fail('Enter a username to continue.',$('#lgUser'));
  if(!p)return fail('Enter your password.',$('#lgPass'));
  if(!/^[\w.@-]{2,40}$/.test(u))return fail('Use 2–40 letters, numbers, dots, dashes or underscores for your username.');
  if(authMode==='register'&&p.length<12)return fail('Choose a password with at least 12 characters.',$('#lgPass'));
  if(authMode==='register'&&p!==$('#lgConfirm').value)return fail('The passwords do not match.',$('#lgConfirm'));
  if(mfaStep&&!/^\d{6}$/.test($('#lgCode').value.trim()))return fail('Enter the 6-digit code from your authenticator app.',$('#lgCode'));
  const label=btn.textContent;btn.setAttribute('aria-busy','true');btn.disabled=true;btn.textContent=authMode==='register'?'Creating account…':'Signing in…';
  try{
    const payload=authMode==='register'?{username:u,password:p,inviteCode:$('#lgInvite').value}:{username:u,password:p,totp:mfaStep?$('#lgCode').value.trim():undefined};
    const res=await API.req('POST',authMode==='register'?'/register':'/login',payload);
    const me=await API.req('GET','/me');session={user:me.user};adminMfaRequired=!!me.adminMfaRequired;
    err.hidden=true;$('#lgPass').value='';$('#lgConfirm').value='';mfaStep=false;$('#mfaField').hidden=true;
    enterApp();
  }catch(ex){
    if(ex.code==='mfa_required'){
      const already=mfaStep;mfaStep=true;$('#mfaField').hidden=false;$('#lgUser').disabled=true;$('#lgPass').disabled=true;$('#lgCode').value='';$('#lgCode').focus();
      if(already)fail(ex.message,$('#lgCode'));else err.hidden=true;
    }else fail(ex.offline?'Can’t reach the Skill Atlas server. Check that it’s running and try again.':ex.message);
  }finally{btn.removeAttribute('aria-busy');btn.disabled=false;btn.textContent=label}
});
window.addEventListener('pagehide',()=>{if(session&&data){try{writeCache()}catch(_){}}});

applyTheme();bindApp();purgeOldCaches();
store.del('atlas:session');store.del('atlas:session',true);
showLogin();loadConfig();
API.req('GET','/me').then(res=>{session={user:res.user};adminMfaRequired=!!res.adminMfaRequired;enterApp()}).catch(error=>{
  if(!error.auth&&!error.offline){showLogin();const e=$('#lgErr');e.textContent=error.message;e.hidden=false}
});
})();
