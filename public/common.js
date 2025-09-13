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

// Client-side prediction for movement
export function createPredictionSystem() {
  let predictedPos = { x: 0, y: 0 };
  let lastServerPos = { x: 0, y: 0 };
  let lastServerTime = 0;
  let inputHistory = [];
  
  return {
    // Predict movement locally
    predictMovement(input, dt) {
      const speed = 200; // pixels per second
      const dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      const dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
      
      // Normalize diagonal movement
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        predictedPos.x += (dx / len) * speed * dt;
        predictedPos.y += (dy / len) * speed * dt;
      }
      
      // Store input for reconciliation
      inputHistory.push({
        input: { ...input },
        timestamp: performance.now(),
        predictedPos: { ...predictedPos }
      });
      
      // Keep only recent history (1 second)
      const cutoff = performance.now() - 1000;
      inputHistory = inputHistory.filter(h => h.timestamp > cutoff);
      
      return { ...predictedPos };
    },
    
    // Reconcile with server state
    reconcile(serverPos, serverTime) {
      lastServerPos = { ...serverPos };
      lastServerTime = serverTime;
      
      // Find inputs that happened after server state
      const replayInputs = inputHistory.filter(h => h.timestamp > serverTime);
      
      // Reset to server position and replay inputs
      predictedPos = { ...serverPos };
      for (const h of replayInputs) {
        const dt = 0.05; // Assume 50ms intervals
        const speed = 200;
        const dx = (h.input.right ? 1 : 0) - (h.input.left ? 1 : 0);
        const dy = (h.input.down ? 1 : 0) - (h.input.up ? 1 : 0);
        
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          predictedPos.x += (dx / len) * speed * dt;
          predictedPos.y += (dy / len) * speed * dt;
        }
      }
      
      return { ...predictedPos };
    },
    
    getCurrentPos() {
      return { ...predictedPos };
    },
    
    setPos(pos) {
      predictedPos = { ...pos };
    }
  };
}

// Connection quality monitoring
export function createLatencyMonitor(ws) {
  let pingHistory = [];
  let lastPingTime = 0;
  
  return {
    sendPing() {
      const now = performance.now();
      lastPingTime = now;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', timestamp: now }));
      }
    },
    
    handlePong(serverTimestamp) {
      const now = performance.now();
      const rtt = now - serverTimestamp;
      pingHistory.push({ rtt, timestamp: now });
      
      // Keep only recent pings (30 seconds)
      const cutoff = now - 30000;
      pingHistory = pingHistory.filter(p => p.timestamp > cutoff);
      
      return rtt;
    },
    
    getAverageLatency() {
      if (pingHistory.length === 0) return 0;
      const sum = pingHistory.reduce((acc, p) => acc + p.rtt, 0);
      return sum / pingHistory.length;
    },
    
    getLatencyStats() {
      if (pingHistory.length === 0) return { avg: 0, min: 0, max: 0, jitter: 0 };
      
      const rtts = pingHistory.map(p => p.rtt);
      const avg = rtts.reduce((a, b) => a + b) / rtts.length;
      const min = Math.min(...rtts);
      const max = Math.max(...rtts);
      
      // Calculate jitter (standard deviation)
      const variance = rtts.reduce((acc, rtt) => acc + Math.pow(rtt - avg, 2), 0) / rtts.length;
      const jitter = Math.sqrt(variance);
      
      return { avg, min, max, jitter };
    }
  };
}

// Minimal toast helper
export function toast(msg, ms=1200) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className='toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._hide);
  t._hide = setTimeout(()=>t.classList.remove('show'), ms);
}
