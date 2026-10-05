import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sdk=fs.readFileSync(new URL('../public/adpulse.js',import.meta.url),'utf8');
async function fixture({type='display',visible=true,ratio=1}={}){
  let now=0;const timers=new Map(),calls=[],listeners={};let nextTimer=0;
  const element=()=>({style:{},dataset:{},children:[],querySelector(){return null},setAttribute(){},appendChild(n){this.children.push(n)},replaceChildren(n){this.children=[n]}});
  const slot=element();slot.dataset.zone='fixture-zone';slot.dataset.adpulseFormat='inline';
  const store=new Map();const storage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)};
  const document={currentScript:{src:'https://ads.example.test/adpulse.js'},documentElement:{},visibilityState:visible?'visible':'hidden',createElement:element,querySelectorAll:()=>slot.dataset.adpulseMounted?[]:[slot]};
  const sandbox={document,window:{},URL,crypto:{randomUUID:()=> 'fixture-browser'},localStorage:storage,sessionStorage:storage,location:{href:'https://publisher.example.test/article'},navigator:{webdriver:false,language:'en'},screen:{width:1280,height:900},Intl,Date:class extends Date{static now(){return now}},performance:{now:()=>now},addEventListener:(name,fn)=>listeners[name]=fn,setTimeout:(f,ms)=>{const id=++nextTimer;timers.set(id,{f,ms});return id},clearTimeout:id=>timers.delete(id),IntersectionObserver:class{constructor(fn){this.fn=fn}observe(){this.fn([{intersectionRatio:ratio}])}disconnect(){}},MutationObserver:class{observe(){}},fetch:async(url,options)=>{
    calls.push({url,options});
    return {ok:true,json:async()=>url.includes('/context?')?{}:{noFill:false,requestId:'request-'+calls.length,token:'fixture-token',creative:{headline:'Creative',creativeType:type,imageUrl:'https://publisher.example.test/image.png',videoUrl:type==='video'?'https://publisher.example.test/video.mp4':null,width:300,height:250},campaign:{id:'campaign-'+calls.filter(c=>c.url.includes('/serve?')).length},zone:{refreshEnabled:true,refreshIntervalSeconds:45,refreshMax:3}}};
  }};
  vm.runInNewContext(sdk,sandbox);
  const flush=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r))};await flush();
  return {slot,calls,sandbox,timers,flush,refresh:async(ms=45000,active=true)=>{now+=ms;if(active&&listeners.mousemove)listeners.mousemove();const row=[...timers].find(([,t])=>t.ms===45000);if(row){timers.delete(row[0]);row[1].f();await flush()}}};
}
for(const type of ['display','native','video'])test('SDK renders '+type+' with tracked click URLs',async()=>{
  const f=await fixture({type});assert.equal(f.slot.dataset.adpulse,'filled');
  assert.ok(f.slot.children[0].children[0].href.startsWith('https://ads.example.test/r/click?t='));
  if(type==='video'){assert.match(f.slot.children[0].innerHTML,/ controls /);assert.equal(f.slot.children[0].children[0].textContent,'Learn more');}
  if(type!=='display')assert.equal([...f.timers.values()].filter(t=>t.ms===45000).length,0);
});
test('SDK refresh passes previous campaign and stops after three refreshes',async()=>{
  const f=await fixture();for(let i=0;i<4;i++)await f.refresh();
  const serve=f.calls.filter(c=>c.url.includes('/serve?'));assert.equal(serve.length,4);assert.ok(serve[1].url.includes('&prev=campaign-1'));
});
test('SDK hidden and non-viewable slots never refresh; personalization defaults off',async()=>{
  for(const params of [{visible:false},{ratio:.4}]){const f=await fixture(params);await f.refresh();assert.equal(f.calls.filter(c=>c.url.includes('/serve?')).length,1);assert.ok(f.calls.find(c=>c.url.includes('/serve?')).url.includes('&pa=0'));}
});
test('SDK idle visitors stop refreshing',async()=>{const f=await fixture();await f.refresh(61000,false);assert.equal(f.calls.filter(c=>c.url.includes('/serve?')).length,1)});
