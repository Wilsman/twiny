export function connect(roomId) {
  let url;
  if (typeof window !== 'undefined' && window.WORKER_ORIGIN) {
    try {
      const u = new URL(`/ws/${roomId}`, window.WORKER_ORIGIN);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      url = u.href;
    } catch {
      // Fallback to same-origin if WORKER_ORIGIN is malformed
    }
  }
  if (!url) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    url = `${proto}://${location.host}/ws/${roomId}`;
  }
  return new WebSocket(url);
}

export function nameStorage() {
  return {
    get() { return localStorage.getItem("name") || ""; },
    set(n) { localStorage.setItem("name", n); }
  };
}

export function minimalCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h; c.className = "arena";
  let stage = document.querySelector('.stage');
  if (!stage) { stage = document.createElement('div'); stage.className = 'stage'; document.body.appendChild(stage); }
  stage.appendChild(c);
  const ctx = c.getContext("2d");
  // Capture keyboard focus so Space/Arrows don't trigger buttons/scroll
  c.tabIndex = 0;
  setTimeout(() => c.focus(), 0);
  c.addEventListener('pointerdown', () => c.focus());
  return { c, ctx };
}

export function inputController(opts={ mouse:true }) {
  const state = { up:false,down:false,left:false,right:false,shoot:false,melee:false,aimX:0,aimY:0 };
  addEventListener("keydown", e => { if (e.repeat) return; if (e.key==="w"||e.key==="ArrowUp") state.up=true;
    if (e.key==="s"||e.key==="ArrowDown") state.down=true; if (e.key==="a"||e.key==="ArrowLeft") state.left=true; if (e.key==="d"||e.key==="ArrowRight") state.right=true; if (e.key==="q"||e.key==="e") state.melee=true; });
  addEventListener("keyup", e => { if (e.key==="w"||e.key==="ArrowUp") state.up=false;
    if (e.key==="s"||e.key==="ArrowDown") state.down=false; if (e.key==="a"||e.key==="ArrowLeft") state.left=false; if (e.key==="d"||e.key==="ArrowRight") state.right=false; if (e.key==="q"||e.key==="e") state.melee=false; });
  if (opts.mouse) {
    addEventListener("mousemove", e => { const rect = document.querySelector("canvas.arena").getBoundingClientRect(); state.aimX = e.clientX - rect.left; state.aimY = e.clientY - rect.top; });
    // Pointer/mouse shooting handling
    addEventListener("mousedown", (e) => { if (e.button===0) state.shoot = true; if (e.button===2) { state.melee = true; e.preventDefault(); } });
    addEventListener("mouseup", (e) => { if (e.button===0) state.shoot = false; if (e.button===2) { state.melee = false; e.preventDefault(); } });
    // prevent context menu on canvas for right-click melee
    document.addEventListener('contextmenu', (e) => {
      const c = document.querySelector('canvas.arena');
      if (c && c.contains(e.target)) e.preventDefault();
    });
    // Touch support (basic)
    addEventListener("touchstart", (e) => { const t=e.touches[0]; const rect = document.querySelector("canvas.arena").getBoundingClientRect(); state.aimX=t.clientX-rect.left; state.aimY=t.clientY-rect.top; state.shoot=true; }, { passive:true });
    addEventListener("touchend", () => { state.shoot=false; }, { passive:true });
  }
  const resetAll = () => { state.up=false; state.down=false; state.left=false; state.right=false; state.shoot=false; state.melee=false; };
  addEventListener("blur", () => { resetAll(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) resetAll(); });
  return state;
}

// Prevent browser defaults (scrolling / button activation) for game keys
export function suppressPageHotkeys() {
  window.addEventListener('keydown', (e) => {
    const code = e.code;
    const isGameKey = code === 'Space' || code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight' || e.key === ' ';
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('contenteditable') === 'true');
    if (isGameKey && !typing) {
      e.preventDefault();
    }
  }, { capture: true });
}

// Minimal toast helper
export function toast(msg, ms=1200) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className='toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._hide);
  t._hide = setTimeout(()=>t.classList.remove('show'), ms);
}
