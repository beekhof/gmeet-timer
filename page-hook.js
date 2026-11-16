// Runs in Google Meet's own page context (MAIN world) at document_start, so it can see
// the microphone stream Meet requests. It measures the volume of that stream locally and
// tells the content script whether you're currently speaking. No audio is recorded,
// stored, or sent anywhere.
(() => {
  "use strict";
  if (window.__meetingTimerHooked) return;
  window.__meetingTimerHooked = true;

  const FRAME_MS = 50;
  const HANGOVER_MS = 400;   // keep "speaking" through short gaps between words
  const ONSET_FRAMES = 2;    // require this many loud frames in a row to start
  const HEARTBEAT_MS = 1000;
  const threshold = (() => {
    // RMS level (0..1) above which the mic counts as speech. Tunable for noisy setups:
    //   localStorage.meetingTimerMicThreshold = "0.03"
    try {
      const v = parseFloat(localStorage.getItem("meetingTimerMicThreshold"));
      return v > 0 ? v : 0.015;
    } catch { return 0.015; }
  })();
  const debug = (() => { try { return localStorage.getItem("meetingTimerDebug") === "1"; } catch { return false; } })();

  let ctx = null;
  const monitors = new Map(); // track -> { analyser, buf, source }
  let speaking = false;
  let loudFrames = 0;
  let lastLoud = 0;
  let timer = null;

  function post() {
    window.postMessage({ __meetingTimer: true, type: "mic", speaking, tracks: monitors.size }, location.origin);
  }

  function ensureContext() {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }
  // Autoplay rules can leave the context suspended until the next user gesture.
  window.addEventListener("pointerdown", () => { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); }, true);

  function monitor(track) {
    if (monitors.has(track) || track.readyState === "ended") return;
    const ac = ensureContext();
    // Use the original track (not a clone): when Meet disables it on mute, it goes silent here too.
    const source = ac.createMediaStreamSource(new MediaStream([track]));
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser); // not connected to the speakers, so nothing is played back
    monitors.set(track, { analyser, source, buf: new Float32Array(analyser.fftSize) });
    track.addEventListener("ended", () => unmonitor(track));
    if (debug) console.debug("[meeting-timer] monitoring mic track", track.label);
    if (!timer) timer = setInterval(frame, FRAME_MS);
    post();
  }

  function unmonitor(track) {
    const m = monitors.get(track);
    if (!m) return;
    try { m.source.disconnect(); } catch {}
    monitors.delete(track);
    if (!monitors.size) {
      clearInterval(timer);
      timer = null;
      speaking = false;
    }
    post();
  }

  function frame() {
    let level = 0;
    for (const [track, m] of monitors) {
      if (track.readyState === "ended") { unmonitor(track); continue; }
      if (!track.enabled || track.muted) continue;
      m.analyser.getFloatTimeDomainData(m.buf);
      let sum = 0;
      for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
      level = Math.max(level, Math.sqrt(sum / m.buf.length));
    }
    const now = performance.now();
    if (level > threshold) {
      loudFrames++;
      if (loudFrames >= ONSET_FRAMES) lastLoud = now;
    } else {
      loudFrames = 0;
    }
    const next = now - lastLoud < HANGOVER_MS;
    if (next !== speaking) {
      speaking = next;
      if (debug) console.debug("[meeting-timer] mic", speaking ? "speaking" : "quiet", "level", level.toFixed(4));
      post();
    }
  }

  setInterval(post, HEARTBEAT_MS);

  const md = window.MediaDevices && MediaDevices.prototype;
  if (!md || !md.getUserMedia) return;
  const orig = md.getUserMedia;
  md.getUserMedia = async function (...args) {
    const stream = await orig.apply(this, args);
    try { stream.getAudioTracks().forEach(monitor); } catch (e) { if (debug) console.debug("[meeting-timer]", e); }
    return stream;
  };
})();
