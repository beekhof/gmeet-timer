(() => {
  "use strict";

  // A meeting is considered "joined" while one of these leave/hang-up controls is on screen.
  const LEAVE_SELECTORS = [
    '[aria-label*="Leave call" i]',          // Google Meet
    '[aria-label*="Leave meeting" i]',
    '[aria-label^="Leave" i]',               // Zoom web / Teams
    '[aria-label*="Hang up" i]',             // Teams
    '[data-tid="hangup-main-btn"]',          // Teams
    '#hangup-button',                        // Teams
    ".footer__leave-btn",                    // Zoom web client
  ].join(",");

  const POLL_MS = 1000;
  const LEAVE_GRACE_MS = 5000; // tolerate the button briefly disappearing (UI re-renders)
  const START_KEY = "meetingTimer:start:" + location.pathname;
  const STATS_KEY = "meetingTimer:stats:" + location.pathname;
  const POS_KEY = "meetingTimerPos";
  const WARN_MS = 25 * 60 * 1000;   // turn orange
  const ALERT_MS = 50 * 60 * 1000;  // turn red

  // Speaker tracking (Google Meet only)
  const IS_MEET = location.hostname === "meet.google.com";
  const SAMPLE_MS = 250;            // how often we attribute speaking time
  const SPEAK_WINDOW_MS = 600;      // tile counts as "speaking" if its indicator changed this recently
  const SPEAK_MIN_MUTATIONS = 2;    // ...at least this many times within the window
  const MAX_ROWS = 8;
  const DEBUG = (() => { try { return localStorage.getItem("meetingTimerDebug") === "1"; } catch { return false; } })();

  let startTime = null;
  let lastSeenInCall = 0;
  let tickHandle = null;
  let sampleHandle = null;
  let panelOpen = false;

  // ---------- Overlay (Shadow DOM so page CSS can't interfere) ----------
  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 16px; right: 16px; display: none;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      .wrap {
        font: 600 14px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #fff;
        cursor: grab;
        user-select: none;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 4px;
      }
      .wrap.dragging { cursor: grabbing; opacity: 0.9; }
      .box, .panel {
        background: rgba(20, 20, 20, 0.75);
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.35);
        backdrop-filter: blur(4px);
      }
      .box {
        padding: 6px 10px;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: background-color 0.5s;
      }
      .box.warn { background: rgba(245, 124, 0, 0.9); }
      .box.alert { background: rgba(211, 47, 47, 0.92); }
      .box.warn .dot, .box.alert .dot { background: #fff; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #e53935; }
      .toggle {
        all: unset;
        cursor: pointer;
        font-size: 11px;
        padding: 0 2px;
        opacity: 0.8;
      }
      .toggle:hover { opacity: 1; }
      .panel {
        display: none;
        width: 230px;
        padding: 8px 10px;
        font-weight: 500;
        font-size: 12px;
      }
      .panel.open { display: block; }
      .row { display: grid; grid-template-columns: 1fr 38px; gap: 2px 6px; margin-bottom: 6px; }
      .row:last-child { margin-bottom: 0; }
      .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row.speaking .name::after { content: " \\25CF"; color: #4caf50; }
      .pct { text-align: right; }
      .bar { grid-column: 1 / -1; height: 5px; background: rgba(255,255,255,0.15); border-radius: 3px; overflow: hidden; }
      .fill { height: 100%; background: #8ab4f8; }
      .row.silence .fill { background: rgba(255,255,255,0.4); }
      .row.me .fill { background: #81c995; }
      .row.me { padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.15); }
      .note { opacity: 0.7; font-size: 11px; margin-bottom: 6px; }
      .empty { opacity: 0.7; }
    </style>
    <div class="wrap" title="Time since you joined. Drag to move, double-click to reset.">
      <div class="box">
        <span class="dot"></span><span class="time">0:00</span>
        <button class="toggle" title="Show who's been talking" hidden>&#9662;</button>
      </div>
      <div class="panel"></div>
    </div>`;
  const wrap = shadow.querySelector(".wrap");
  const box = shadow.querySelector(".box");
  const timeEl = shadow.querySelector(".time");
  const toggleEl = shadow.querySelector(".toggle");
  const panelEl = shadow.querySelector(".panel");
  if (IS_MEET) toggleEl.hidden = false;

  function format(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  function render() {
    if (startTime == null) return;
    const elapsed = Date.now() - startTime;
    timeEl.textContent = format(elapsed);
    box.classList.toggle("alert", elapsed >= ALERT_MS);
    box.classList.toggle("warn", elapsed >= WARN_MS && elapsed < ALERT_MS);
    if (panelOpen) renderPanel(elapsed);
  }

  // ---------- Positioning & dragging ----------
  function clampAndPlace(left, top) {
    const r = host.getBoundingClientRect();
    left = Math.max(0, Math.min(left, window.innerWidth - r.width));
    top = Math.max(0, Math.min(top, window.innerHeight - r.height));
    host.style.left = left + "px";
    host.style.top = top + "px";
    host.style.right = "auto";
    return { left, top };
  }

  let savedPos = null;
  chrome.storage.local.get(POS_KEY, (res) => {
    savedPos = res && res[POS_KEY];
    if (savedPos && host.style.display !== "none") clampAndPlace(savedPos.left, savedPos.top);
  });

  let drag = null;
  wrap.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target === toggleEl) return;
    const r = host.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    wrap.setPointerCapture(e.pointerId);
    wrap.classList.add("dragging");
    e.preventDefault();
    e.stopPropagation();
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!drag) return;
    clampAndPlace(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    wrap.classList.remove("dragging");
    try { wrap.releasePointerCapture(e.pointerId); } catch {}
    const r = host.getBoundingClientRect();
    savedPos = { left: r.left, top: r.top };
    chrome.storage.local.set({ [POS_KEY]: savedPos });
  };
  wrap.addEventListener("pointerup", endDrag);
  wrap.addEventListener("pointercancel", endDrag);

  wrap.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    if (startTime == null || e.target === toggleEl) return;
    startTime = Date.now();
    sessionStorage.setItem(START_KEY, String(startTime));
    resetStats();
    render();
  });

  toggleEl.addEventListener("click", (e) => {
    e.stopPropagation();
    panelOpen = !panelOpen;
    panelEl.classList.toggle("open", panelOpen);
    toggleEl.innerHTML = panelOpen ? "&#9652;" : "&#9662;";
    render();
    // Keep the (now taller/shorter) overlay on screen.
    const r = host.getBoundingClientRect();
    clampAndPlace(r.left, r.top);
  });

  window.addEventListener("resize", () => {
    if (host.style.display === "none") return;
    const r = host.getBoundingClientRect();
    clampAndPlace(r.left, r.top);
  });

  // ---------- Speaker tracking (Google Meet) ----------
  // Meet's class names are obfuscated and change often, so rather than looking for a
  // specific "speaking" class we rely on two fairly stable facts:
  //   1. every participant tile carries a [data-participant-id] attribute;
  //   2. while someone talks, Meet's audio-level indicator in their tile updates its
  //      class/style many times a second, whereas a silent tile is mostly static.
  // So: count attribute mutations per tile and treat a burst of them as "speaking".
  //
  // Your own talk time does NOT use this heuristic: page-hook.js measures the volume of
  // the microphone stream Meet captures and reports it here. Your own tile is excluded
  // from the tile heuristic so you aren't counted twice.
  const stats = { me: 0, talk: {}, names: {}, silence: 0 }; // ms; talk keyed by participant id
  const selfIds = new Set();
  const MIC_STALE_MS = 3000;
  let mic = { speaking: false, tracks: 0, lastHeard: 0 };

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__meetingTimer !== true || e.data.type !== "mic") return;
    mic = { speaking: !!e.data.speaking, tracks: e.data.tracks | 0, lastHeard: Date.now() };
  });

  function micAvailable() {
    return mic.tracks > 0 && Date.now() - mic.lastHeard < MIC_STALE_MS;
  }

  // Backstop in case Meet mutes without disabling the audio track.
  function meetSaysMuted() {
    const btn = document.querySelector('[data-is-muted][aria-label*="microphone" i]');
    if (btn) return btn.getAttribute("data-is-muted") === "true";
    return !!document.querySelector('[aria-label*="Turn on microphone" i]');
  }

  function meSpeaking() {
    return micAvailable() && mic.speaking && !meetSaysMuted();
  }
  const recentMutations = new Map();                  // participant id -> [timestamps]
  let speakingNow = new Set();
  let meNow = false;
  let observer = null;

  function resetStats() {
    stats.me = 0;
    stats.talk = {};
    stats.silence = 0;
    sessionStorage.removeItem(STATS_KEY);
  }

  function loadStats() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STATS_KEY) || "null");
      if (saved) Object.assign(stats, saved);
    } catch {}
  }

  function saveStats() {
    try { sessionStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch {}
  }

  const ICON_TEXT = /^[a-z0-9_]+$/; // Material icon ligatures like "mic_off", "more_vert"

  function tileName(tile) {
    const self = tile.querySelector("[data-self-name]");
    if (self) return self.getAttribute("data-self-name") + " (you)";
    const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.trim();
      if (!t || t.length > 60 || ICON_TEXT.test(t)) continue;
      if (n.parentElement && n.parentElement.closest("i, button, [role=button]")) continue;
      return t;
    }
    return null;
  }

  function onMutations(list) {
    const now = performance.now();
    for (const m of list) {
      const el = m.target;
      if (el.nodeName === "VIDEO" || el.nodeName === "CANVAS") continue;
      const tile = el.closest && el.closest("[data-participant-id]");
      if (!tile || el === tile) continue; // ignore changes to the tile itself (layout/hover)
      const id = tile.getAttribute("data-participant-id");
      let arr = recentMutations.get(id);
      if (!arr) recentMutations.set(id, (arr = []));
      arr.push(now);
    }
  }

  function sampleSpeakers() {
    if (startTime == null) return;
    const now = performance.now();
    const speaking = new Set();
    for (const [id, arr] of recentMutations) {
      while (arr.length && now - arr[0] > SPEAK_WINDOW_MS) arr.shift();
      if (arr.length >= SPEAK_MIN_MUTATIONS) speaking.add(id);
      if (!arr.length) recentMutations.delete(id);
    }

    // Identify your own tile(s) and refresh names (names can appear late).
    for (const tile of document.querySelectorAll("[data-participant-id]")) {
      const id = tile.getAttribute("data-participant-id");
      if (tile.querySelector("[data-self-name]")) selfIds.add(id);
      if (!stats.names[id]) {
        const name = tileName(tile);
        if (name) stats.names[id] = name;
      }
    }

    for (const id of selfIds) speaking.delete(id);
    const me = meSpeaking();

    if (me) stats.me += SAMPLE_MS;
    for (const id of speaking) stats.talk[id] = (stats.talk[id] || 0) + SAMPLE_MS;
    if (!me && speaking.size === 0) stats.silence += SAMPLE_MS;
    speakingNow = speaking;
    meNow = me;

    if (DEBUG && (me || speaking.size)) {
      console.debug("[meeting-timer] speaking:", [...(me ? ["you (mic)"] : []), ...[...speaking].map((id) => stats.names[id] || id)]);
    }
  }

  function renderPanel(elapsed) {
    const rows = Object.entries(stats.talk)
      .filter(([id]) => !selfIds.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ROWS);
    const pct = (ms) => (elapsed > 0 ? Math.min(100, (ms / elapsed) * 100) : 0);
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const row = (label, ms, cls) => {
      const p = pct(ms);
      return `<div class="row ${cls}">
        <span class="name" title="${esc(label)} — ${format(ms)}">${esc(label)}</span>
        <span class="pct">${Math.round(p)}%</span>
        <div class="bar"><div class="fill" style="width:${p.toFixed(1)}%"></div></div>
      </div>`;
    };
    const note = micAvailable() ? "" : `<div class="note">Mic not detected yet; your time isn't being counted.</div>`;
    panelEl.innerHTML =
      note +
      row("You", stats.me, "me" + (meNow ? " speaking" : "")) +
      (rows.length ? "" : `<div class="note">No one else detected speaking yet.</div>`) +
      rows.map(([id, ms]) => row(stats.names[id] || "Unknown", ms, speakingNow.has(id) ? "speaking" : "")).join("") +
      row("Silence", stats.silence, "silence");
  }

  function startSpeakerTracking() {
    if (!IS_MEET || observer) return;
    loadStats();
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    let ticks = 0;
    sampleHandle = setInterval(() => {
      sampleSpeakers();
      if (++ticks % 20 === 0) saveStats(); // every 5s, so a reload keeps the numbers
    }, SAMPLE_MS);
  }

  function stopSpeakerTracking() {
    if (observer) observer.disconnect();
    observer = null;
    clearInterval(sampleHandle);
    sampleHandle = null;
    recentMutations.clear();
    speakingNow = new Set();
    meNow = false;
    selfIds.clear();
    resetStats();
    stats.names = {};
  }

  // ---------- Meeting state ----------
  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function inCall() {
    for (const el of document.querySelectorAll(LEAVE_SELECTORS)) {
      if (isVisible(el)) return true;
    }
    return false;
  }

  function startTimer() {
    // Survive page reloads within the same meeting (same tab + same URL path).
    const stored = Number(sessionStorage.getItem(START_KEY));
    startTime = stored > 0 ? stored : Date.now();
    sessionStorage.setItem(START_KEY, String(startTime));

    if (!host.isConnected) document.documentElement.appendChild(host);
    host.style.display = "block";
    if (savedPos) clampAndPlace(savedPos.left, savedPos.top);
    startSpeakerTracking();
    render();
    tickHandle = setInterval(render, 1000);
  }

  function stopTimer() {
    clearInterval(tickHandle);
    tickHandle = null;
    startTime = null;
    sessionStorage.removeItem(START_KEY);
    stopSpeakerTracking();
    host.style.display = "none";
  }

  function poll() {
    const now = Date.now();
    if (inCall()) {
      lastSeenInCall = now;
      if (startTime == null) startTimer();
    } else if (startTime != null && now - lastSeenInCall > LEAVE_GRACE_MS) {
      stopTimer();
    }
    // Some apps rebuild <html>/<body>; make sure we stay attached.
    if (startTime != null && !host.isConnected) document.documentElement.appendChild(host);
  }

  setInterval(poll, POLL_MS);
  poll();
})();
