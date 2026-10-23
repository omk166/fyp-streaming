# Preliminary matched local baseline

One exploratory run per scenario, synthetic video/tone, Edge, all participants and SFU on one laptop. Hardware video encode/decode and GPU rendering disabled for these automated runs. These are functional and local-load observations, not final capacity or codec-quality results.

| Mode | Participants | Outcome | Mean sender payload kb/s | Mean received video FPS | SFU CPU % of one core | Node RSS MiB |
|---|---:|---|---:|---:|---:|---:|
| h264 | 6 | PASS | 172.3 | 29.1 | 12.5 | 30.1 |
| h264 | 8 | PASS | 163.5 | 27.8 | 18.5 | 32.4 |
| h264 | 2 | PASS | 169.4 | 29.8 | 0.7 | 33.3 |
| h264 | 4 | PASS | 171.2 | 30.1 | 2.0 | 33.4 |
| simulcast | 2 | PASS | 264.0 | 29.0 | 1.6 | 33.4 |
| vp9 | 2 | PASS | 412.7 | 29.8 | 1.0 | 32.3 |

Sender bitrate is the average of per-peer means from RTP payload byte counters and excludes network overhead. Received FPS averages available per-peer inbound video reports. Server CPU/RSS are taken from peer 0 telemetry to avoid counting the same server once per participant; CPU is one-core utilization, not whole-laptop utilization. These columns do not include total endpoint or GPU CPU/RAM. Startup samples are included. Each run has a 30-second observation period after setup; earlier-joining peers accumulate more samples.

Earlier accelerated six/eight-browser trials stalled. They are retained as diagnostics in the full CSV and evidence archive. A software-video pass does not establish the root cause of those stalls or predict behavior on separate devices.

Still unverified: original-audio mouth-to-ear latency below 200 ms, multiple real devices/browsers, NAT/TURN, subjective MOS, reference-video quality scores, recorder/AI isolation and meeting features not implemented in this prototype.

See RESULTS.md and results.csv for per-peer data, run-manifests.json for outcomes/settings, confirmed-formats.csv for negotiated producer parameters, and screenshots/ for browser captures.
