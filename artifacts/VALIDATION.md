# Artifact validation

- JavaScript syntax checks passed for the server, browser source and automated browser harness.
- Browser bundle built successfully with the locked npm dependencies.
- The six matched software-video scenarios passed their recorded functional/media-progress checks. Negotiated codec and encoding parameters matched all 24 participant producer configurations; see confirmed-formats.csv.
- Report calculation checks verified byte-counter differentiation and kb/s units, missing RTT handling, and percentile interpolation.
- All 35 published sanitized evidence archives were restored into a separate workspace folder. Recalculated results matched all 110 per-peer CSV rows and all 16 network-summary rows exactly.
- All 16 Linux scenario exit codes were zero, the recorded step transitions were 500 and 2000 kb/s at the expected times, and kernel queue/drop counters were preserved. These checks do not impose a QoE threshold.
- The container's server-source SHA-256 matched the repository source. The Docker image ID, pinned base-image digest and Linux runtime versions are recorded.
- Network shaping was reset, the experiment-only capability was removed, and the normal localhost server health check passed.
- Eight-browser and diagnostic screenshots were visually inspected. They are actual browser captures, not illustrative images.

These checks validate the artifacts and the listed local observations. They do not establish end-to-end audio latency, perceptual quality, real WAN behavior or separate-device capacity. The Linux experiments shape shared SFU egress on one physical laptop, not per-publisher uplinks.
