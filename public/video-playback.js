// Muted autoplay, visible-only playback, and an explicit sound control.
export function enableVideoPlayback(video) {
  if (!video) return () => {};
  video.muted = true; video.defaultMuted = true; video.playsInline = true;
  let visible = false, userPaused = false, systemPause = false, disposed = false;
  const abort = new AbortController(), opts = { signal: abort.signal };
  const button = document.createElement('button'); button.type = 'button';
  button.style.cssText = 'display:block;margin:8px 12px;padding:8px 12px;border:0;border-radius:7px;background:#153d70;color:white;font:600 13px system-ui;cursor:pointer;pointer-events:auto';
  const label = () => { button.textContent = video.muted ? 'Sound on · Activer le son' : 'Mute sound · Couper le son'; button.setAttribute('aria-label', video.muted ? 'Enable video sound' : 'Mute video sound'); };
  video.insertAdjacentElement('afterend', button); label();
  const play = () => { if (!disposed && !video.ended && !userPaused) video.play().catch(() => { button.textContent = 'Play video · Lire la vidéo'; }); };
  const sync = () => {
    if (disposed) return;
    const rect=video.getBoundingClientRect();
    if (visible && document.visibilityState === 'visible' && getComputedStyle(video).visibility !== 'hidden' && rect.width && rect.height) play();
    else if (!video.paused) { systemPause = true; video.pause(); }
  };
  button.addEventListener('click', () => { userPaused = false; video.muted = !video.muted; label(); video.play().catch(() => { button.textContent = 'Play video · Lire la vidéo'; }); }, opts);
  video.addEventListener('volumechange', label, opts);
  video.addEventListener('pause', () => { if (!systemPause && !video.ended) userPaused = true; systemPause = false; }, opts);
  video.addEventListener('play', () => { userPaused = false; }, opts);
  document.addEventListener('visibilitychange', sync, opts);
  const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting && entries[0].intersectionRatio >= .5; sync(); }, { threshold: [0, .5] }); observer.observe(video);
  const cleanup = () => { if (disposed) return; disposed = true; observer.disconnect(); removed.disconnect(); abort.abort(); video.pause(); button.remove(); };
  const removed = new MutationObserver(() => { if (!video.isConnected) cleanup(); else sync(); }); removed.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style','class','hidden'] });
  return cleanup;
}
