# FYP Streaming Lab

Research prototype for the streaming component of the conferencing FYP. It uses browser WebRTC, a mediasoup SFU and Opus, with H.264 single-stream, H.264 two-layer simulcast and VP9 SVC experiment modes. Implementation follows [mediasoup's signaling sequence](https://mediasoup.org/documentation/v3/communication-between-client-and-server/) and [client API](https://mediasoup.org/documentation/v3/mediasoup-client/api/).

Initial measured results: [concise results table](artifacts/SUMMARY.md), [Word report](artifacts/FYP_Streaming_Initial_Evaluation.docx), [per-peer CSV](artifacts/results.csv), and [actual browser screenshots](artifacts/screenshots). Six matched software-video scenarios passed local checks, including eight synthetic browser participants. These are short exploratory trials on one laptop; the [evaluation matrix](evaluation/test-matrix.csv) identifies unverified experiments and unavailable features.

Controlled Linux experiments, when executed, are documented separately in [network results](artifacts/NETWORK_RESULTS.md), with [kernel shaping evidence](artifacts/network) and a [numeric CSV](artifacts/network-results.csv). Check exit codes represent basic media progress, not acceptable delay or perceptual quality.

This is a local experiment environment. It has no authentication, host roles, recording, translation or TURN service yet. Do not expose this prototype as a public meeting service. Usernames, chat, mic/camera controls, local video pinning and screen sharing are included for basic functional tests. Screen annotation (draw and pause over a shared screen) is included; see [Screen drawing](#screen-drawing). Reconnection requires leaving and joining again.

## Run locally

For different devices on the same Wi-Fi, see [the HTTPS LAN demo setup](LAN-DEMO.md). It includes certificate trust, scoped firewall rules and a launcher. A Windows laptop and MacBook call was confirmed working by the project owner on October 31, 2026; this is a functional check, not a measured multi-device performance trial.

Requires Node.js 22+; installation may download a native mediasoup worker. A compiler/Python toolchain is needed if no prebuilt worker is available. See the [official installation requirements](https://mediasoup.org/documentation/v3/mediasoup/installation/).

```powershell
npm ci
npm run build
npm start
```

Open http://127.0.0.1:3000 in two browser tabs. Enter your name and use the same room name. For initial automated experiments, select synthetic media, which publishes an animated canvas and quiet tone. Camera/microphone access requires browser permission. The app saves statistics in memory; Export raw telemetry downloads JSON. Export before leaving or closing. Test runs should use fresh tabs so each export covers one session.

Alternatively, start Docker Desktop and run `docker compose up --build`. The supplied Docker configuration binds to localhost only. Access from additional laptops needs a separately configured reachable media address and HTTPS for browser capture; it is not enabled by this local configuration.

## Screen drawing

Marks are drawn on a layer over the **video** of a shared screen and relayed through the server as coordinates (0..1 of the picture), so every viewer sees them in the same place whatever their window size.

- **Toolbar.** While you share, a toolbar appears at the right edge: draw (pen), pop out, pause/resume, pen color and size, undo, clear. Esc stops drawing. Only the sharer draws; marks are removed when the share stops. Late joiners receive the current marks and pause state.
- **Draw over your whole screen and any app (screen pen).** On a Mac or Windows PC, `npm start` starts it with the server (first run installs it; `SCREEN_PEN=0` turns it off). If you use a deployed server instead, run `npm run overlay` on the computer you present from. Then share your **Entire screen**: the pen button now draws directly on your screen, over any window, and a small toolbar appears at the right edge of your screen (pen, pause, colors, undo, clear). Cmd/Ctrl+Shift+D toggles the pen, Esc stops. It opens and closes with your share. What you draw goes through the page like any other mark, so pause, undo, clear and late joiners behave the same. The screen pen asks to be left out of screen capture, so viewers get the marks only through the page layer.
- **Without the screen pen (pop-out, Chrome/Edge 116+).** The pop-out button opens an always-on-top window with a live preview of your shared screen plus the toolbar; draw on that preview while you are on other pages or apps. If you share your entire screen, the pop-out shows up inside the share as a small mirrored preview.
- **Pause.** Viewers see a still of your screen: the exact frame you paused on, sent with the pause, so late joiners see the same picture. Your own screen stays live. The drawing layer is separate from the picture, so marks keep reaching viewers live while paused, and undo/clear do not resume the share. Resume shows your live screen again and keeps the marks.

Status: verified with scripted end-to-end runs (real server, Chrome 156, a fake "Entire screen" capture, the real screen-pen app with synthetic pen input) covering drawing, pause, drawing while paused, undo, clear, late joiners, pop-out and resume. Not yet verified: drawing with a real mouse on the screen pen, whether Chrome's real screen capture honours the pen's capture exclusion (if not, viewers see each mark twice in the same place), multi-device use. Limits: the screen pen covers the primary display only and needs an Entire-screen share; no eraser; "only the sharer can draw or clear" is enforced by the page, not the server (pause is server-enforced).

## Automated local measurements

```powershell
npx playwright install chromium
npm run test:smoke
python scripts/report.py
```

The server must already be running. Environment variables `PARTICIPANTS` (2/4/6/8), `MODE` (h264/simulcast/vp9) and `DURATION` (seconds) select a scenario. Tests check remote track counts, received audio bytes, decoded video, mute/camera state, chat delivery and leave cleanup. They do not establish intelligibility, camera quality or microphone-to-speaker latency.

For Edge, set `$env:BROWSER_CHANNEL='msedge'` before testing. The matched local load trials use `$env:SOFTWARE_VIDEO='1'` and `$env:PROFILE='windows-software-video'`: this disables accelerated video encode/decode and GPU rendering for the synthetic benchmark. Larger accelerated headless runs stalled on this laptop and are retained as diagnostic results. Browser arguments and synthetic source type are recorded per run. These settings apply to automated tests, not to normal visitors using their cameras.

One-second browser statistics and SFU worker/process/transport counters are saved under `artifacts/raw/<run-id>`, with a manifest identifying mode, browser, commit, duration, checks and limitations. Screenshots go under `artifacts/screenshots`; the report script creates a CSV and Markdown table from saved measurements. Missing metrics stay empty. The reported bitrate uses RTP payload counters, not full network-interface egress. ICE RTT is not mouth-to-ear latency.

Counter definitions follow the [W3C WebRTC Statistics API](https://www.w3.org/TR/webrtc-stats/). Jitter-buffer delay and concealment metrics describe receiver behavior; they do not replace calibrated microphone-to-speaker measurements.

Raw files are ignored by Git because they may contain IP addresses and other connection metadata. Publish only reviewed synthetic-test artifacts and summaries. Use repeated trials and fixed reference media for research comparisons. A short smoke run is not evidence for the under-200-ms original-audio target or final eight-device capacity.

Published `artifacts/evidence/*.json.gz` files contain sanitized telemetry. Run `python scripts/restore_evidence.py` and then `python scripts/report.py` to recalculate the tables from a fresh clone. To regenerate charts and the Word document, install `requirements-report.txt` and run `python scripts/plot.py` followed by `python scripts/document.py`.

## Isolated Linux network experiments

After stopping the native local server, use `docker compose -f compose.yaml -f compose.impairment.yaml up --build -d` to give only the lab container permission to shape its network. Then run `node scripts/netem.mjs` from the Windows host with the browser settings above. This is an experiment runner, not an assertion that all profiles have already passed; consult saved manifests.

The runner applies caps, random loss, delay and jitter only to outgoing media on the dedicated container interface. The cap is shared SFU egress, not a per-publisher uplink cap. Delay is one-directional; compare actual measured RTT rather than assuming symmetric delay. It saves shaping configuration and kernel queue/drop counters under `artifacts/network`, and resets the container queue at the end. Windows network settings are not modified. Signaling is excluded from the impairment filter. Network emulation follows the [Linux netem interface](https://man7.org/linux/man-pages/man8/tc-netem.8.html); queueing effects and actual browser statistics must be reported together.

The filter matches TCP/UDP source port 40000, so RTP, RTCP feedback, ICE and DTLS on that media transport share the impairment. HTTP/WebSocket signaling and telemetry use port 3000 and are excluded. The jitter cases use 100 ms base delay with 10/30/60 ms normal-distribution variation settings; these are not hard bounded ranges.

## Evaluation coverage

See `evaluation/test-matrix.csv` for the scenarios derived from the supplied research guide. Impairment tests require Linux network shaping of the actual media route; browser HTTP throttling is insufficient. TURN, real device/browser comparisons, calibrated audio latency, reference-aligned VMAF/SSIM/PSNR, human MOS and optional recorder/AI isolation remain separate experiments.

## Meeting controls

Enter a display name (up to 40 characters) before joining. Names appear on camera and shared-screen tiles and in chat; these are display labels, not authenticated identities.

Click **Pin** on a video to enlarge it in the centered stage above the other videos. Click **Unpin** to return to the grid. Pinning affects only your own view, and a departing or stopped pinned track returns your view to the grid.

Click **Share screen** and choose a tab, window or display in the browser picker. Your camera and microphone remain available, and other participants receive the screen as a separate named video tile. Multiple people may share at once. Click **Stop sharing**, use the browser's stop control, or leave the meeting to end a share. Screen audio is not included. Display capture requires HTTPS (or localhost), a supporting desktop browser and any OS screen-recording permission.

Run `node scripts/meeting-features.mjs` against the updated server (default `http://127.0.0.1:3100`, override with `BASE_URL`) for the three-participant feature check using Edge. It substitutes a generated display stream to verify media publication, reception and lifecycle; manually check the browser picker and real screen contents on the demo devices. The existing smoke script also accepts `BASE_URL`.

Muted microphones show a muted icon and text beside the participant name on camera/screen tiles and in the participant list. **Raise hand** keeps a hand indicator visible to the room until you click **Lower hand** or leave. Late joiners receive the current mute and hand states. Thumbs up, heart and laugh buttons display a named reaction to everyone for four seconds; reactions do not persist or replay to late joiners.
