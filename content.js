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
  const POS_KEY = "meetingTimerPos";
  const WARN_MS = 25 * 60 * 1000;   // turn orange
  const ALERT_MS = 50 * 60 * 1000;  // turn red

  let startTime = null;
  let lastSeenInCall = 0;
  let tickHandle = null;

  // ---------- Overlay (Shadow DOM so page CSS can't interfere) ----------
  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 16px; right: 16px; display: none;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      .box {
        font: 600 14px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #fff;
        background: rgba(20, 20, 20, 0.75);
        padding: 6px 10px;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.35);
        cursor: grab;
        user-select: none;
        display: flex;
        align-items: center;
        gap: 6px;
        backdrop-filter: blur(4px);
        transition: background-color 0.5s;
      }
      .box.warn { background: rgba(245, 124, 0, 0.9); }
      .box.alert { background: rgba(211, 47, 47, 0.92); }
      .box.warn .dot, .box.alert .dot { background: #fff; }
      .box.dragging { cursor: grabbing; opacity: 0.9; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #e53935; }
    </style>
    <div class="box" title="Time since you joined. Drag to move, double-click to reset.">
      <span class="dot"></span><span class="time">0:00</span>
    </div>`;
  const box = shadow.querySelector(".box");
  const timeEl = shadow.querySelector(".time");

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
  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = host.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    box.setPointerCapture(e.pointerId);
    box.classList.add("dragging");
    e.preventDefault();
    e.stopPropagation();
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag) return;
    clampAndPlace(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    box.classList.remove("dragging");
    try { box.releasePointerCapture(e.pointerId); } catch {}
    const r = host.getBoundingClientRect();
    savedPos = { left: r.left, top: r.top };
    chrome.storage.local.set({ [POS_KEY]: savedPos });
  };
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);

  box.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    if (startTime == null) return;
    startTime = Date.now();
    sessionStorage.setItem(START_KEY, String(startTime));
    render();
  });

  window.addEventListener("resize", () => {
    if (host.style.display === "none") return;
    const r = host.getBoundingClientRect();
    clampAndPlace(r.left, r.top);
  });

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
    render();
    tickHandle = setInterval(render, 1000);
  }

  function stopTimer() {
    clearInterval(tickHandle);
    tickHandle = null;
    startTime = null;
    sessionStorage.removeItem(START_KEY);
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
