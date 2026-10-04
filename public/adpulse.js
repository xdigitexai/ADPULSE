(()=>{
  const script=document.currentScript;
  const base=new URL(script.src).origin;
  const sent=new WeakSet();
  const contextCache=new Map();

  const browserId=(()=>{
    try{
      let v=localStorage.getItem('adpulse_browser_id');
      if(!v){v=(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36));localStorage.setItem('adpulse_browser_id',v)}
      return v;
    }catch{return 'b_'+Math.random().toString(36).slice(2)}
  })();
  const sessionId=(()=>{
    try{
      let v=sessionStorage.getItem('adpulse_session_id');
      if(!v){v=(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36));sessionStorage.setItem('adpulse_session_id',v)}
      return v;
    }catch{return 's_'+Math.random().toString(36).slice(2)}
  })();

  const esc=x=>String(x||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const signals=()=>({webdriver:!!navigator.webdriver,screenWidth:screen.width,screenHeight:screen.height,language:navigator.language||'',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'',browserId,sessionId});

  async function contextToken(zone){
    const key=zone+'|'+location.href;
    if(contextCache.has(key)) return contextCache.get(key);
    const promise=fetch(base+'/context?zone='+encodeURIComponent(zone)+'&url='+encodeURIComponent(location.href),{credentials:'omit'})
      .then(r=>r.ok?r.json():null).then(x=>x?.token||'').catch(()=>'');
    contextCache.set(key,promise);
    return promise;
  }

  async function sendEvent(token,type,metadata={}){
    return fetch(base+'/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,type,metadata:{...signals(),...metadata}})}).catch(()=>{});
  }

  function clickUrl(token){
    return base+'/r/click?t='+encodeURIComponent(token)+'&bid='+encodeURIComponent(browserId)+'&sid='+encodeURIComponent(sessionId);
  }

  function renderCreative(c,ad){
    const box=document.createElement('div');
    box.style.cssText='font-family:Arial,sans-serif;border:1px solid #e6e8ec;border-radius:10px;overflow:hidden;background:#fff;color:#111;max-width:100%;position:relative;'+(c.width?'width:'+c.width+'px;':'')+(c.height?'min-height:'+c.height+'px;':'');
    let media='';

    if(c.creativeType==='video'&&c.videoUrl){
      media='<div class="adpulse-video-wrap" style="position:relative;background:#000"><video src="'+esc(c.videoUrl)+'" muted playsinline controls style="width:100%;display:block;background:#000"></video><a class="adpulse-video-click" href="'+clickUrl(ad.token)+'" target="_blank" rel="noopener sponsored" aria-label="'+esc(c.headline)+'" style="position:absolute;left:0;right:0;top:0;height:72%;display:block;cursor:pointer;background:transparent"></a></div>';
    }else if(c.imageUrl){
      media='<img alt="" src="'+esc(c.imageUrl)+'" style="width:100%;display:block;max-height:'+(c.height||260)+'px;object-fit:cover">';
    }

    const nativeStyle=c.creativeType==='native'?'padding:16px;background:#fff;border-left:3px solid #111':'padding:12px';
    box.innerHTML=media+'<div style="'+nativeStyle+'"><div style="font-size:11px;color:#687080;margin-bottom:6px">Sponsored · ADPulse</div><strong style="display:block;margin-bottom:5px">'+esc(c.headline)+'</strong><span style="font-size:13px;color:#56606f">'+esc(c.description||'')+'</span></div>';

    const a=document.createElement('a');
    a.href=clickUrl(ad.token);
    a.target='_blank';
    a.rel='noopener sponsored';
    a.setAttribute('aria-label',c.headline);

    if(c.creativeType==='video'){
      a.textContent='Learn more';
      a.style.cssText='display:inline-block;margin:0 12px 12px;padding:8px 12px;border-radius:7px;background:#111;color:#fff;text-decoration:none;font-size:12px;font-weight:700';
    }else{
      a.style.cssText='position:absolute;inset:0';
    }

    box.appendChild(a);
    return box;
  }

  async function mount(el){
    const zone=el.dataset.zone;
    if(!zone)return;

    try{
      const ctx=await contextToken(zone);
      const url=base+'/serve?zone='+encodeURIComponent(zone)+(ctx?'&ctx='+encodeURIComponent(ctx):'');
      const r=await fetch(url,{credentials:'omit'});
      const ad=await r.json();

      if(ad.noFill){el.dataset.adpulse='no-fill';return}

      const c=ad.creative;
      const box=renderCreative(c,ad);
      el.replaceChildren(box);

      sendEvent(ad.token,'render',{pageUrl:location.href});

      let visibleSince=0,timer=0;
      const io=new IntersectionObserver(entries=>{
        for(const e of entries){
          if(e.intersectionRatio>=.5){
            if(!visibleSince)visibleSince=performance.now();
            clearTimeout(timer);
            timer=setTimeout(()=>{
              if(visibleSince&&!sent.has(el)&&performance.now()-visibleSince>=1000){
                sent.add(el);
                sendEvent(ad.token,'view',{
                  visibilityPercent:Math.round(e.intersectionRatio*100),
                  visibleMs:Math.round(performance.now()-visibleSince),
                  pageUrl:location.href
                });
                io.disconnect();
              }
            },1050);
          }else{
            visibleSince=0;
            clearTimeout(timer);
          }
        }
      },{threshold:[0,.5,1]});
      io.observe(el);
    }catch{
      el.dataset.adpulse='error';
    }
  }

  function scan(){
    document.querySelectorAll('.adpulse-ad:not([data-adpulse-mounted])').forEach(el=>{
      el.dataset.adpulseMounted='1';
      mount(el);
    });
  }

  scan();
  new MutationObserver(scan).observe(document.documentElement,{childList:true,subtree:true});
})();