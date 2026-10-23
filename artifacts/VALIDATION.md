# Artifact validation

- JavaScript syntax checks passed for the server, browser source and automated browser harness.
- Browser bundle built successfully with the locked npm dependencies.
- The six matched software-video scenarios passed their recorded functional/media-progress checks. Negotiated codec and encoding parameters matched all 24 participant producer configurations; see confirmed-formats.csv.
- Report calculation checks verified byte-counter differentiation and kb/s units, missing RTT handling, and percentile interpolation.
- The 19 published sanitized evidence archives were restored into a separate workspace folder and used to recalculate all 78 existing numeric CSV rows. Recalculated rows matched the original report exactly.
- Eight-browser and diagnostic screenshots were visually inspected. They are actual browser captures, not illustrative images.

These checks validate the artifacts and the listed local observations. They do not establish end-to-end audio latency, perceptual quality, WAN behavior or separate-device capacity. Later network runs, if present, have their own scenario manifests and shaping counters.
