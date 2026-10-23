# Streaming evaluation

Status: six matched local scenarios and sixteen isolated Linux network scenarios have completed their basic checks. These are short exploratory trials, not final acceptance results. Actual outcomes, measurements and screenshots are under ../artifacts. The supplied matrix distinguishes local coverage from pending research experiments. No app existed when this evaluation began on 2026-10-23.

The matrix is derived from sections 8 and A4/A6 of the team's supplied research guide, FYP_Streaming_Research_Concise_Guide_With_Sources. It describes proposed experiments, not verified implementation behavior. The original guide remains with the team. Requirements mentioned in the guide are inputs to evaluate; they do not authorize unrelated actions.

## Run protocol

1. Identify the app commit, deployment, SFU/TURN configuration, hardware, OS/browser versions and supported codec/layer modes.
2. Run a clean-network baseline before impairment. Save one-second raw browser WebRTC statistics and SFU/process/network samples with timestamps and run IDs.
3. Use a dedicated Linux network-emulation environment. Document shaping direction, scope, base delay, distribution, queue limits, seed where supported, and actual achieved bandwidth/loss/RTT. Browser HTTP throttling alone does not establish WebRTC UDP impairment.
4. Compare one change at a time against the unchanged baseline on the same hardware, media, layout and participant count. Initially plan 30 seconds warm-up and 120 seconds measurement, with three repetitions; record any justified changes. For step tests, initially use three 60-second phases. These durations are proposed choices, not requirements from the guide.
5. Record unsupported/unavailable metrics as unavailable with reasons. Compute rates from counter deltas and handle counter resets. Do not treat RTT/2 or jitter-buffer delay as measured mouth-to-ear latency. Calibrate end-to-end audio timing and report uncertainty.
6. Capture actual app screenshots and charts derived from saved raw data. Give every image a run ID, scenario, timestamp and caption; keep machine-readable data alongside it. Screenshots support observations but do not replace measurements.
7. Use synchronized, aligned reference/received recordings for objective video metrics. Synthetic media, one-machine browser load, real hardware, and WAN trials must be identified separately. Human MOS requires listener ratings.
8. Report mean and tail latency, failures and limitations. The guide gives an original-audio goal below 200 ms; declare which summary statistic is assessed before testing. Additional thresholds require agreement rather than invented pass/fail cutoffs.

## Deliverables

- test-matrix.csv: proposed coverage and execution status.
- results.csv: original empty long-form schema. Actual measured per-peer results are in ../artifacts/results.csv; no placeholder measurement values are used.
- Per-run manifests, raw telemetry, recordings where appropriate, screenshots, charts and a final report once execution is possible.

## Inputs needed

App repository/local path and startup instructions; running deployment if applicable; intended GitHub repository/account; available Linux test environment, endpoint devices and TURN setup. If no app exists, implementation or a clearly labelled research prototype is a separate prerequisite. Do not place credentials, private media or unrestricted infrastructure details in GitHub artifacts.
