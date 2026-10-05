// One controller per publisher page; session state survives reloads in this tab.
let controller;
export function mountFloating(options){if(!controller)controller=new FloatingAds(options);return controller;}
const escapeHtml=x=>String(x||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
class FloatingAds{
  constructor(options){
    Object.assign(this,options);this.started=Date.now();this.engaged=false;this.scrolled=false;this.busy=false;this.current=null;
    try{this.state=JSON.parse(sessionStorage.getItem('adpulse-popup-state')||'null')}catch{}
    this.state=this.state||{shown:0,campaigns:{},cooldownUntil:0,pages:0};this.state.pages++;this.save();
    this.interact=()=>{this.engaged=true};this.scroll=()=>{const range=document.documentElement.scrollHeight-innerHeight;this.scrolled=this.scrolled||(range>0&&(scrollY/range*100>=(this.settings?.scrollThreshold||20)||(this.settings?.scrollTriggerPixels>0&&scrollY>=this.settings.scrollTriggerPixels)))};
    addEventListener('pointerdown',this.interact,{passive:true});addEventListener('keydown',this.interact);addEventListener('scroll',this.scroll,{passive:true});
    this.key=e=>{if(e.key==='Escape'&&this.current){e.preventDefault();this.close('dismiss')}};addEventListener('keydown',this.key);
    document.addEventListener('visibilitychange',()=>{if(document.hidden&&this.current){this.visibleSince=0;this.host.style.visibility='hidden'}else if(this.host)this.host.style.visibility='visible'});
    this.tickTimer=setInterval(()=>this.tick(),500);this.tick();
  }
  save(){try{sessionStorage.setItem('adpulse-popup-state',JSON.stringify(this.state))}catch{}}
  async config(){const r=await fetch(this.base+'/zone-config?zone='+encodeURIComponent(this.zone),{credentials:'omit',cache:'no-store'});if(!r.ok)throw Error('Configuration unavailable');return r.json()}
  clearance(){
    let lift=16;
    for(const el of document.querySelectorAll('[id],[style],nav,footer,[class*="chat"],[class*="widget"]')){
      if(el===this.host)continue;const r=el.getBoundingClientRect();
      if(r.width>0&&r.height>0&&r.height<150&&r.left<innerWidth&&r.right>0&&r.bottom>=innerHeight-20&&getComputedStyle(el).position==='fixed')lift=Math.max(lift,innerHeight-r.top+12);
    }
    return lift;
  }
  placementClear(){
    if(this.settings?.popupStyle==='center')return true;
    const mobile=innerWidth<=600,width=mobile?innerWidth*.92:Math.min(380,innerWidth-32),position=this.settings?.position;
    const left=mobile?innerWidth*.04:position==='bottom-left'?16:position==='bottom-center'?(innerWidth-width)/2:innerWidth-width-16;
    const bottom=innerHeight-this.clearance(),top=bottom-Math.min(310,innerHeight*.38);
    for(const el of document.querySelectorAll('button,.btn,[role="button"],input[type="submit"],a[class*="cta"]')){
      const r=el.getBoundingClientRect();if(r.width&&r.height&&r.left<left+width&&r.right>left&&r.top<bottom&&r.bottom>top&&getComputedStyle(el).visibility!=='hidden')return false;
    }
    return true;
  }
  safe(existing=false){
    if(document.hidden||document.fullscreenElement)return false;
    if(/(?:^|\/)(?:login|register|signup|sign-in|checkout|payment|pay|auth)(?:[/.?]|$)/i.test(location.pathname+location.search))return false;
    const el=document.activeElement;if(!existing&&el&&(el.matches('input,textarea,select,[contenteditable="true"]')||el.isContentEditable))return false;
    for(const modal of document.querySelectorAll('dialog[open],[aria-modal="true"],.modal.show,.modal.active'))if(modal.getBoundingClientRect().width&&modal.getBoundingClientRect().height)return false;
    return this.placementClear();
  }
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      if(!this.settings||Date.now()-(this.configAt||0)>5000){const c=await this.config();this.settings=c.settings;this.enabled=c.enabled;this.configAt=Date.now();this.scroll()}
      const s=this.settings;if(!s)return;
      if(!this.enabled||s.pauseAds||!s.allowFloating||!s.randomPopupEnabled){if(this.current)this.close('pause');return}
      const mobile=innerWidth<=600;if((mobile&&!s.showMobile)||(!mobile&&!s.showDesktop)){if(this.current)this.close('pause');return}
      if(this.current){
        if(!this.safe(true)){this.host.style.visibility='hidden';this.visibleSince=0;this.lastTick=Date.now();return}
        this.host.style.visibility='visible';const now=Date.now();this.elapsed+=Math.min(1000,now-(this.lastTick||now));this.lastTick=now;
        const rect=this.card.getBoundingClientRect();const visibleWidth=Math.max(0,Math.min(rect.right,innerWidth)-Math.max(0,rect.left));const visibleHeight=Math.max(0,Math.min(rect.bottom,innerHeight)-Math.max(0,rect.top));const ratio=rect.width*rect.height?visibleWidth*visibleHeight/(rect.width*rect.height):0;
        if(ratio>=.5){this.visibleSince=this.visibleSince||now;if(!this.viewed&&now-this.visibleSince>=1000){this.viewed=true;if(this.state.openAd){this.state.openAd.viewed=true;this.save()}this.sendEvent(this.current.token,'view',{visibilityPercent:Math.round(ratio*100),visibleMs:now-this.visibleSince,pageUrl:location.href})}}else this.visibleSince=0;
        if(s.autoClose!==false&&this.elapsed>=s.displayDurationSeconds*1000)this.close('timeout_close');return;
      }
      if(s.autoClose===false&&this.state.openAd&&this.state.openAd.zone===this.zone&&Date.now()-this.state.openAd.savedAt<23*3600000){if(this.safe())this.show(this.state.openAd.ad,true);return}
      if(this.state.openAd){delete this.state.openAd;this.save()}
      if(s.repeatCycle&&this.state.cycleInterval!==s.rotationIntervalSeconds){this.state.cyclePolicy=true;this.state.cycleInterval=s.rotationIntervalSeconds;if(!s.dismissCooldownSession)this.state.sessionDismissed=false;this.state.cooldownUntil=Math.min(this.state.cooldownUntil||0,Date.now()+s.rotationIntervalSeconds*1000);this.state.nextAt=Math.min(this.state.nextAt||0,Date.now()+s.rotationIntervalSeconds*1000);this.save()}
      if(this.state.awaitingNext&&!this.deadline){this.earliest=this.deadline=this.state.nextAt||Date.now()}
      if(this.state.sessionDismissed||Date.now()<this.state.cooldownUntil||Date.now()<(this.state.nextAt||0)||(s.maxAdsPerSession>0&&this.state.shown>=s.maxAdsPerSession))return;
      if(!this.deadline){const min=Math.max(s.initialDelaySeconds,s.minPopupDelaySeconds)*1000;this.earliest=Date.now()+min;this.deadline=Date.now()+min+Math.random()*Math.max(0,s.maxPopupDelaySeconds*1000-min)}
      if(Date.now()<this.earliest||!this.safe())return;
      const due=this.state.awaitingNext||{time:Date.now()>=this.deadline,scroll:this.scrolled,engagement:this.engaged,pageview:this.state.pages>=s.minPageViews,hybrid:this.engaged||this.scrolled||Date.now()>=this.deadline}[s.trigger];if(!due)return;
      const excluded=Object.keys(this.state.campaigns).filter(id=>s.maxImpressionsPerCampaignPerSession>0&&this.state.campaigns[id]>=s.maxImpressionsPerCampaignPerSession);
      if(s.repeatCycle&&this.state.lastCampaign&&!excluded.includes(this.state.lastCampaign))excluded.push(this.state.lastCampaign);
      const ad=await this.request(this.state.lastCampaign||'',excluded);
      // Configuration is checked again after the request; a pause never races a show.
      const fresh=await this.config();if(!fresh.enabled||fresh.settings.pauseAds||!this.safe())return;this.settings=fresh.settings;
      if(ad.noFill){this.state.nextAt=Date.now()+s.rotationIntervalSeconds*1000;this.save();return}
      this.show(ad);
    }catch{/* Network failure leaves the host page intact. */}finally{this.busy=false}
  }
  show(ad,restored=false){
    if(this.current)return;const s=this.settings,c=ad.creative;this.current=ad;this.elapsed=0;this.lastTick=Date.now();this.visibleSince=0;this.viewed=restored&&!!this.state.openAd?.viewed;this.previousFocus=document.activeElement;
    if(!restored){this.state.shown++;this.state.campaigns[ad.campaign.id]=(this.state.campaigns[ad.campaign.id]||0)+1;this.state.lastCampaign=ad.campaign.id;this.state.awaitingNext=false;if(s.autoClose===false)this.state.openAd={ad,zone:this.zone,viewed:false,savedAt:Date.now()};this.save()}
    const host=document.createElement('div');host.setAttribute('data-adpulse-floating','');this.host=host;
    // Inline host styles survive hostile publisher rules; all internal styles are isolated.
    host.style.cssText='position:fixed!important;inset:0!important;z-index:10000!important;pointer-events:none!important;display:block!important;margin:0!important;padding:0!important;border:0!important;';
    const root=host.attachShadow({mode:'open'});let style=s.popupStyle==='mixed'?(this.state.shown%2?'floating':'center'):s.popupStyle;
    const lift=this.clearance();
    const url=this.clickUrl(ad.token);const media=c.creativeType==='video'&&c.videoUrl?'<video controls playsinline preload="metadata" src="'+escapeHtml(c.videoUrl)+'"></video>':c.imageUrl?'<a href="'+escapeHtml(url)+'" target="_blank" rel="noopener sponsored" aria-label="'+escapeHtml(c.headline)+'"><img src="'+escapeHtml(c.imageUrl)+'" alt="'+escapeHtml(c.headline)+'"></a>':'';
    root.innerHTML=`<style>:host{all:initial}*{box-sizing:border-box}.overlay{position:absolute;inset:0;background:rgba(15,23,42,.10);pointer-events:none}.card{position:absolute;bottom:${lift}px;right:16px;width:min(380px,calc(100vw - 32px));max-height:38dvh;overflow:auto;border:1px solid #dfe4eb;border-radius:14px;background:white;color:#172033;font:14px/1.4 system-ui,sans-serif;box-shadow:0 10px 35px #0002;pointer-events:auto;animation:enter .2s ease}.left{right:auto;left:16px}.bottom-center{right:auto;left:50%;transform:translateX(-50%)}.center{width:min(520px,calc(100vw - 32px));left:50%;top:50%;bottom:auto;right:auto;transform:translate(-50%,-50%);max-height:60dvh}.bar{position:sticky;top:0;z-index:2;background:white;display:flex;align-items:center;justify-content:space-between;padding:5px 10px;font-size:11px;color:#536174}.close{min-width:36px;min-height:36px;font-size:24px;line-height:1;background:none;border:0;border-radius:8px;cursor:pointer;color:#172033}.close:focus-visible,a:focus-visible{outline:3px solid #2563eb;outline-offset:-3px}img,video{width:100%;display:block;max-height:min(23dvh,calc(38dvh - 112px));object-fit:contain;background:#f7f9fc}.body{padding:10px 14px}.body p{margin:5px 0;color:#56606f;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.cta{display:inline-block;padding:8px 12px;color:white;background:#153d70;text-decoration:none;border-radius:7px;margin:8px 14px 12px}.center img,.center video{max-height:35dvh}@keyframes enter{from{opacity:0}to{opacity:1}}@media(max-width:600px){.card{width:92vw;left:4vw;right:auto;max-height:38dvh}.center{left:50%;width:92vw;max-height:60dvh}.bottom-center{left:50%}}@media(prefers-reduced-motion:reduce){.card{animation:none}}</style>${style==='center'?'<div class="overlay"></div>':''}<aside class="card ${style==='center'?'center':s.position==='bottom-left'?'left':s.position==='bottom-center'?'bottom-center':''}" aria-label="Advertisement"><div class="bar"><span>Sponsored · ADPulse</span><button class="close" aria-label="Close advertisement" type="button">×</button></div>${media}${s.creativeOnly&&media?'':`<div class="body"><strong>${escapeHtml(c.headline)}</strong><p>${escapeHtml(c.description)}</p></div>`}${s.creativeOnly&&media&&c.creativeType!=="video"?"":`<a class="cta" href="${escapeHtml(url)}" target="_blank" rel="noopener sponsored">Learn more</a>`}</aside>`;
    this.card=root.querySelector('.card');root.querySelector('.close').onclick=()=>this.close('dismiss');document.body.appendChild(host);
    if(!restored)this.sendEvent(ad.token,'render',{pageUrl:location.href,popup:true,sessionCount:this.state.shown});if(!restored&&this.state.shown>1)this.sendEvent(ad.token,'rotation',{pageUrl:location.href});
  }
  close(reason){
    if(!this.current)return;const ad=this.current,s=this.settings;const focused=this.host.shadowRoot.activeElement;this.host.remove();this.host=null;this.current=null;this.visibleSince=0;delete this.state.openAd;
    if(reason==='dismiss'){this.state.cooldownUntil=Date.now()+s.dismissCooldownMinutes*60000;this.state.sessionDismissed=s.dismissCooldownSession}
    if(['dismiss','timeout_close'].includes(reason))this.sendEvent(ad.token,reason,{pageUrl:location.href});
    this.state.nextAt=Date.now()+s.rotationIntervalSeconds*1000;this.state.awaitingNext=reason==='dismiss'&&s.repeatCycle;this.earliest=this.state.nextAt;this.deadline=this.state.nextAt;this.save();if(focused&&this.previousFocus?.isConnected)this.previousFocus.focus({preventScroll:true});
  }
}
