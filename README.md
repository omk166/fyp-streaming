# FYP Streaming Lab

Research prototype for the streaming component of the conferencing FYP. It uses browser WebRTC, a mediasoup SFU and Opus, with H.264 single-stream, H.264 two-layer simulcast and VP9 SVC experiment modes. Implementation follows [mediasoup's signaling sequence](https://mediasoup.org/documentation/v3/communication-between-client-and-server/) and [client API](https://mediasoup.org/documentation/v3/mediasoup-client/api/).

Initial measured results: [concise results table](artifacts/SUMMARY.md), [Word report](artifacts/FYP_Streaming_Initial_Evaluation.docx), [per-peer CSV](artifacts/results.csv), and [actual browser screenshots](artifacts/screenshots). Six matched software-video scenarios passed local checks, including eight synthetic browser participants. These are short exploratory trials on one laptop; the [evaluation matrix](evaluation/test-matrix.csv) identifies unverified experiments and unavailable features.

This is a local experiment environment. It has no authentication, host roles, recording, translation, TURN service or screen sharing yet. Do not expose this prototype as a public meeting service. Chat and mic/camera controls are included for basic functional tests. Reconnection requires leaving and joining again.

## Run locally

Requires Node.js 22+; installation may download a native mediasoup worker. A compiler/Python toolchain is needed if no prebuilt worker is available. See the [official installation requirements](https://mediasoup.org/documentation/v3/mediasoup/installation/).

```powershell
npm ci
npm run build
npm start
```

Open http://127.0.0.1:3000 in two browser tabs. Use the same room name. For initial automated experiments, select synthetic media, which publishes an animated canvas and quiet tone. Camera/microphone access requires browser permission. The app saves statistics in memory; Export raw telemetry downloads JSON. Export before leaving or closing. Test runs should use fresh tabs so each export covers one session.

Alternatively, start Docker Desktop and run `docker compose up --build`. The supplied Docker configuration binds to localhost only. Access from additional laptops needs a separately configured reachable media address and HTTPS for browser capture; it is not enabled by this local configuration.

## Automated local measurements

```powershell
npx playwright install chromium
npm run test:smoke
python scripts/report.py
```

The server must already be running. Environment variables `PARTICIPANTS` (2/4/6/8), `MODE` (h264/simulcast/vp9) and `DURATION` (seconds) select a scenario. Tests check remote track counts, received audio bytes, decoded video, mute/camera state, chat delivery and leave cleanup. They do not establish intelligibility, camera quality or microphone-to-speaker latency.

For Edge, set `$env:BROWSER_CHANNEL='msedge'` before testing. The matched local load trials use `$env:SOFTWARE_VIDEO='1'` and `$env:PROFILE='windows-software-video'`: this disables accelerated video encode/decode and GPU rendering for the synthetic benchmark. Larger accelerated headless runs stalled on this laptop and are retained as diagnostic results. Browser arguments and synthetic source type are recorded per run. These settings apply to automated tests, not to normal visitors using their cameras.

One-second browser statistics and SFU worker/process/transport counters are saved under `artifacts/raw/<run-id>`, with a manifest identifying mode, browser, commit, duration, checks and limitations. Screenshots go under `artifacts/screenshots`; the report script creates a CSV and Markdown table from saved measurements. Missing metrics stay empty. The reported bitrate uses RTP payload counters, not full network-interface egress. ICE RTT is not mouth-to-ear latency.

Raw files are ignored by Git because they may contain IP addresses and other connection metadata. Publish only reviewed synthetic-test artifacts and summaries. Use repeated trials and fixed reference media for research comparisons. A short smoke run is not evidence for the under-200-ms original-audio target or final eight-device capacity.

Published `artifacts/evidence/*.json.gz` files contain sanitized telemetry. Run `python scripts/restore_evidence.py` and then `python scripts/report.py` to recalculate the tables from a fresh clone. To regenerate charts and the Word document, install `requirements-report.txt` and run `python scripts/plot.py` followed by `python scripts/document.py`.

## Isolated Linux network experiments

After stopping the native local server, use `docker compose -f compose.yaml -f compose.impairment.yaml up --build -d` to give only the lab container permission to shape its network. Then run `node scripts/netem.mjs` from the Windows host with the browser settings above. This is an experiment runner, not an assertion that all profiles have already passed; consult saved manifests.

The runner applies caps, random loss, delay and jitter only to outgoing media on the dedicated container interface. The cap is shared SFU egress, not a per-publisher uplink cap. Delay is one-directional; compare actual measured RTT rather than assuming symmetric delay. It saves shaping configuration and kernel queue/drop counters under `artifacts/network`, and resets the container queue at the end. Windows network settings are not modified. Signaling is excluded from the impairment filter. Network emulation follows the [Linux netem interface](https://man7.org/linux/man-pages/man8/tc-netem.8.html); queueing effects and actual browser statistics must be reported together.

## Evaluation coverage

See `evaluation/test-matrix.csv` for the scenarios derived from the supplied research guide. Impairment tests require Linux network shaping of the actual media route; browser HTTP throttling is insufficient. TURN, real device/browser comparisons, calibrated audio latency, reference-aligned VMAF/SSIM/PSNR, human MOS and optional recorder/AI isolation remain separate experiments.
