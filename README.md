# Meeting Timer Overlay

A small, draggable overlay that shows how long you've been in the current
meeting — and, on Google Meet, roughly who has been doing the talking.

- Appears automatically once you're in a call, disappears when you leave.
- Turns **orange at 25 minutes** and **red at 50 minutes**.
- Drag it anywhere; the position is remembered. Double-click to reset the timer.
- Survives a page reload in the same tab and meeting.
- Works on Google Meet, Zoom web client, and Microsoft Teams web.
  The talk-time panel (the ▾ button) is Google Meet only.

## Install

There's no build step and no packaged release — it loads as an unpacked
extension straight from this directory.

### Chrome / Chromium / Edge / Brave (version 111+)

1. Clone or download this repository.
2. Open `chrome://extensions` (`edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick this folder (the one containing
   `manifest.json`).
5. Join a meeting — the overlay shows up on its own.

Notes:

- There's no toolbar popup; the only UI is the in-page overlay.
- After editing `content.js` or `page-hook.js`, click **Reload** on the
  extension's card, then refresh the meeting tab.
- Chrome may warn about developer-mode extensions each time it starts. That's
  expected for unpacked loads.
- Firefox isn't supported as-is: the extension relies on a `"world": "MAIN"`
  content script and other Chromium-specific behaviour.

## Talk-time panel (Google Meet)

Click the ▾ on the overlay to expand a breakdown of speaking time: you, up to
eight other participants, and total silence.

Two different mechanisms feed it:

- **Your own time** comes from `page-hook.js`, which runs in Meet's page
  context, taps the microphone stream Meet already captures, and measures its
  volume. Nothing is recorded, stored, or sent anywhere — only a
  speaking/not-speaking flag crosses into the overlay.
- **Everyone else's time** is a heuristic. Meet's class names are obfuscated, so
  instead of looking for a "speaking" class, the extension counts DOM attribute
  mutations inside each `[data-participant-id]` tile: a talking participant's
  audio-level indicator updates many times a second, a silent one barely
  changes. Treat these numbers as indicative, not exact.

Counts are kept in `sessionStorage`, so they survive a reload but not a new tab.

### Tuning

Run these in the DevTools console on the Meet tab, then reload:

```js
// Mic sensitivity (RMS 0..1). Raise it in a noisy room, lower it if you're quiet.
localStorage.meetingTimerMicThreshold = "0.03"; // default 0.015

// Log speaking detection to the console.
localStorage.meetingTimerDebug = "1";
```

If the panel says *"Mic not detected yet"*, the hook hasn't seen a
`getUserMedia` call — reload the tab while in the meeting.

## Permissions

`storage` only, used to remember where you dragged the overlay. The content
scripts run on `meet.google.com`, `*.zoom.us`, and the Teams web domains.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest; declares both content scripts and the icons. |
| `content.js` | Overlay UI, meeting detection, drag/position, talk-time panel. |
| `page-hook.js` | MAIN-world mic volume monitor (Meet), posts to `content.js`. |
| `tools/make-icons.py` | Regenerates `icons/*.png` (needs Pillow). |
