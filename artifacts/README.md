# Evidence conventions

These are measurements of a local research prototype, not results from the final application. All participants use synthetic canvas/tone media in isolated Edge sessions on the same laptop as the SFU.

- `results.csv`: per-peer measurements, including available data from failed runs. Check the `passed` column before interpreting a row.
- Inbound jitter/FPS summaries use reports associated with a negotiated media codec, excluding RTX and unmapped/probing SSRC reports. All original reports remain in the telemetry archives.
- `run-manifests.json`: run outcomes, source commit, browser version and checks. Development failures without telemetry are listed separately.
- `evidence/*.json.gz`: compressed telemetry with endpoint addresses, ports, credentials and raw user-agent strings removed. These are sufficient to inspect browser/SFU counters; original unredacted runs remain local.
- `screenshots`: actual browser captures. A `-failure` suffix identifies a failed test, not a successful meeting.
- `FYP_Streaming_Initial_Evaluation.docx`: shareable report generated from measured files.

Larger headless runs stalled with video acceleration enabled, including after changing the synthetic frame source. A separately labelled software-video configuration passed the six-browser check. Source-clock and browser-argument fields identify these conditions; do not pool the diagnostics with the matched software-video baseline or interpret them as separate-device capacity. No end-to-end audio latency, human MOS or reference-video quality scores are implied by these measurements. Network scenarios count as executed only when their manifests and shaping-counter evidence are present.
