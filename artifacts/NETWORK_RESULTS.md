# Exploratory Linux media impairment runs

Shared SFU egress shaping on a dedicated Docker container; two synthetic Edge participants on the same physical laptop. Caps are not per-sender uplinks. Delay is one-directional, and reported RTT is measured. One run per profile; no statistical confidence claim. Randomized loss/jitter runs have no fixed seed. Summaries include startup and the scripted mute/camera/chat checks; they are not isolated steady-state estimates.

| Profile | Check exit code | Max peer ICE RTT p95 ms | Mean received video FPS | Kernel netem drops |
|---|---:|---:|---:|---:|
| egress-1500kbit | 0 | 8.95 | 29.63 | 0 |
| egress-250kbit | 0 | 6936.00 | 13.32 | 232 |
| egress-500kbit | 0 | 695.55 | 29.55 | 0 |
| egress-750kbit | 0 | 19.00 | 30.37 | 0 |
| egress-delay-100ms | 0 | 105.00 | 30.06 | 0 |
| egress-delay-200ms | 0 | 216.00 | 30.36 | 0 |
| egress-delay-400ms | 0 | 405.00 | 30.22 | 0 |
| egress-jitter-10ms | 0 | 122.00 | 30.29 | 0 |
| egress-jitter-30ms | 0 | 171.00 | 30.43 | 0 |
| egress-jitter-60ms | 0 | 218.70 | 30.25 | 0 |
| egress-loss-10pct | 0 | 5.00 | 29.70 | 631 |
| egress-loss-1pct | 0 | 6.00 | 29.82 | 56 |
| egress-loss-3pct | 0 | 5.00 | 29.79 | 178 |
| egress-loss-5pct | 0 | 7.40 | 29.62 | 318 |
| egress-step-2000-500-2000kbit | 0 | 1354.40 | 30.14 | 0 |
| linux-clean | 0 | 7.00 | 29.58 | N/A |

Exit code 0 means the functional/media-progress checks passed; it is not a QoE acceptance threshold. Kernel packet drops include emulation and queue drops and do not equal unrepaired RTP loss. Freeze, NACK and concealed-sample counters are browser-reported diagnostics, not MOS or calibrated audio continuity. The CSV does not prove RTX/FEC usefulness before playback deadlines. Unavailable counters require inspection of raw telemetry rather than assuming zero.

The 2 -> 0.5 -> 2 Mb/s profile applies each cap for about 60 seconds, timed from process launch; actual transition timestamps are saved in network/. Setup and screenshots affect the overall window. No adaptive application policy has been implemented or compared against default WebRTC.

Audio jitter-buffer delay is derived from the change in jitterBufferDelay divided by the change in jitterBufferEmittedCount. Concealment is concealedSamples divided by totalSamplesReceived over available counter windows. These are receiver-buffer and synthesis diagnostics, not end-to-end audio delay or listener ratings. Field definitions: [W3C WebRTC Statistics API](https://www.w3.org/TR/webrtc-stats/).
