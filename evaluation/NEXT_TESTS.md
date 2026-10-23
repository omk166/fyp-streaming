# Remaining research experiments

The current artifacts are exploratory measurements of a small streaming prototype. They do not close every item in the research guide. The next experiments need these inputs and controls.

| Experiment | Needed input or implementation | Evidence required |
|---|---|---|
| Original-audio mouth-to-ear | Two real endpoints, microphone/speaker path, distinctive timed audio reference and calibrated recording setup | Per-event delays, mean/p50/p95/p99/max, calibration and timing uncertainty; no RTT substitution |
| Separate-device capacity | 2/4/6/8 real endpoints, reachable SFU and HTTPS, identified hardware/browser versions | Actual endpoint and SFU CPU/RAM, media continuity, FPS, network counters and device screenshots |
| Per-sender constrained uplink | A Linux endpoint or controlled gateway for each sender path | Confirmed shaping direction/scope, measured total publisher bitrate, audio concealment and downgrade/recovery behavior |
| NAT and TURN | Reachable TURN service, credentials supplied privately, TLS certificate for TLS trials, independent networks | Forced relay UDP/TCP/TLS candidate evidence, join success/timing, reconnects and measured media delay |
| Objective video quality | Fixed reference clips with checksums, aligned decoded receiver frames, VMAF/SSIM/PSNR tools | Per-condition quality scores together with bitrate, freezes/drops, latency and CPU; alignment method documented |
| Subjective quality | Consenting listeners, randomized/blind fixed samples and a defined rating scale | Individual ratings, listener count, MOS and uncertainty; no inferred MOS from statistics |
| RTX/FEC efficacy | Supported controls and repeated matched loss/delay trials | Overhead and repaired packets that arrive before playback deadlines; NACK counts alone are insufficient |
| Application adaptation | Implemented fast-down/slow-up policy and unchanged GCC baseline | Same hardware/media/profile, repeated trials, layer/target logs, downgrade/recovery and oscillation definition |
| Recorder/AI isolation | Actual optional branches and their failure controls | Original-media continuity when each branch is enabled, disabled or crashed |
| Remaining meeting features | Screen share, roles/host permissions, reactions, raised hands, whiteboard and other required UI | Functional and server-permission checks for implemented behavior, with screenshots |

For audio timing, capture the reference and receiver output on a shared clock where possible. Independent recording clocks need calibrated offset and drift. A practical bench setup can use distinctive chirps and a shared recording system, but acoustic distances, cross-talk and device processing must be calibrated and reported. A constant tone by itself does not provide an unambiguous absolute-delay reference.

The local browser trials disable video acceleration to avoid stalls when many synthetic endpoints share this laptop. Real-device trials must also exercise normal browser settings. Do not generalize the software-video result to eight separate devices or interpret a synthetic-content bitrate difference as a codec-quality ranking.

Before final comparisons, use fixed media and an explicit warm-up/measurement window, repeat each condition, predefine acceptance/recovery/oscillation criteria, and record missing or unsupported metrics. Current short runs include startup/control checks and are clearly labelled preliminary.
