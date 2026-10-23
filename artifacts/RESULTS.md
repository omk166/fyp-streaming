# Measured local prototype results

Synthetic media; browsers and SFU share one physical laptop. RTP payload bitrate excludes transport overhead. RTT is not mouth-to-ear latency. No subjective or objective reference-video quality score was measured. Percentiles pool one-second reports per peer, not independent trials. Larger accelerated runs stalled under multiple source implementations; use matched software-video runs for preliminary comparisons. Failed runs retain available measurements, which do not indicate successful service.

| Source clock | Passed | Mode | Participants | Peer | Samples | Send payload kb/s (mean) | ICE RTT ms (p95) | Video FPS (mean) |
|---|---|---|---:|---|---:|---:|---:|---:|
| animation-frame | True | h264 | 2 | peer-0 | 17 | 133.55 | 1.00 | 30.25 |
| animation-frame | True | h264 | 2 | peer-1 | 16 | 140.35 | 1.00 | 28.13 |
| animation-frame | True | h264 | 4 | peer-0 | 34 | 163.95 | 3.00 | 16.63 |
| animation-frame | True | h264 | 4 | peer-1 | 34 | 169.15 | 2.00 | 17.84 |
| animation-frame | True | h264 | 4 | peer-2 | 34 | 172.71 | 3.00 | 18.02 |
| animation-frame | True | h264 | 4 | peer-3 | 34 | 163.87 | 2.00 | 17.27 |
| animation-frame | False | h264 | 6 | peer-0 | 37 | 43.72 | 3.00 | 20.38 |
| animation-frame | False | h264 | 6 | peer-1 | 37 | 42.73 | 4.00 | 21.75 |
| animation-frame | False | h264 | 6 | peer-2 | 37 | 39.53 | 2.35 | 21.93 |
| animation-frame | False | h264 | 6 | peer-3 | 36 | 37.68 | 3.00 | 20.50 |
| animation-frame | False | h264 | 6 | peer-4 | 36 | 33.59 | 3.00 | 22.67 |
| animation-frame | False | h264 | 6 | peer-5 | 35 | 32.34 | 4.00 | 6.00 |
| animation-frame | False | h264 | 8 | peer-0 | 40 | 41.75 | 5.00 | 25.71 |
| animation-frame | False | h264 | 8 | peer-1 | 44 | 40.82 | 9.00 | 21.60 |
| animation-frame | False | h264 | 8 | peer-2 | 44 | 37.87 | 6.00 | 28.22 |
| animation-frame | False | h264 | 8 | peer-3 | 45 | 36.25 | 5.00 | 20.36 |
| animation-frame | False | h264 | 8 | peer-4 | 46 | 33.74 | 7.00 | 25.00 |
| animation-frame | False | h264 | 8 | peer-5 | 47 | 32.40 | 5.00 | 4.00 |
| animation-frame | False | h264 | 8 | peer-6 | 45 | 32.42 | 5.55 |  |
| animation-frame | False | h264 | 8 | peer-7 | 45 | 32.40 | 6.65 |  |
| animation-frame | True | simulcast | 2 | peer-0 | 32 | 252.93 | 2.00 | 29.97 |
| animation-frame | True | simulcast | 2 | peer-1 | 31 | 258.99 | 2.00 | 29.13 |
| animation-frame | True | vp9 | 2 | peer-0 | 32 | 392.86 | 3.00 | 30.17 |
| animation-frame | True | vp9 | 2 | peer-1 | 31 | 399.48 | 3.00 | 28.87 |
| timer | True | h264 | 2 | peer-0 | 32 | 157.64 | 1.00 | 29.94 |
| timer | True | h264 | 2 | peer-1 | 31 | 172.47 | 2.00 | 28.97 |
| timer | True | h264 | 4 | peer-0 | 34 | 164.81 | 3.00 | 17.80 |
| timer | True | h264 | 4 | peer-1 | 34 | 170.28 | 5.00 | 18.71 |
| timer | True | h264 | 4 | peer-2 | 34 | 175.45 | 4.00 | 17.65 |
| timer | True | h264 | 4 | peer-3 | 34 | 170.79 | 4.65 | 17.39 |
| timer | False | h264 | 6 | peer-0 | 31 | 44.59 | 3.00 | 24.14 |
| timer | False | h264 | 6 | peer-1 | 32 | 43.42 | 5.00 | 26.92 |
| timer | False | h264 | 6 | peer-2 | 34 | 39.34 | 4.00 | 28.55 |
| timer | False | h264 | 6 | peer-3 | 34 | 36.91 | 5.00 | 23.27 |
| timer | False | h264 | 6 | peer-4 | 35 | 34.83 | 5.00 | 38.75 |
| timer | False | h264 | 6 | peer-5 | 34 | 32.35 | 4.30 |  |
| timer | False | h264 | 8 | peer-0 | 39 | 41.21 | 5.25 | 28.60 |
| timer | False | h264 | 8 | peer-1 | 42 | 40.91 | 6.90 | 25.93 |
| timer | False | h264 | 8 | peer-2 | 43 | 38.36 | 4.00 | 27.78 |
| timer | False | h264 | 8 | peer-3 | 43 | 36.45 | 5.00 | 27.57 |
| timer | False | h264 | 8 | peer-4 | 43 | 33.56 | 5.00 | 72.20 |
| timer | False | h264 | 8 | peer-5 | 44 | 32.41 | 4.65 |  |
| timer | False | h264 | 8 | peer-6 | 42 | 32.42 | 5.85 |  |
| timer | False | h264 | 8 | peer-7 | 42 | 32.40 | 4.00 |  |
| timer | True | simulcast | 2 | peer-0 | 32 | 234.43 | 2.00 | 30.03 |
| timer | True | simulcast | 2 | peer-1 | 31 | 235.69 | 2.00 | 28.90 |
| timer | True | vp9 | 2 | peer-0 | 32 | 399.63 | 2.00 | 30.17 |
| timer | True | vp9 | 2 | peer-1 | 31 | 437.97 | 2.00 | 28.77 |
| video-frame-timer | False | h264 | 6 | peer-0 | 36 | 42.71 | 3.00 | 19.67 |
| video-frame-timer | False | h264 | 6 | peer-1 | 37 | 40.13 | 2.40 | 19.07 |
| video-frame-timer | False | h264 | 6 | peer-2 | 37 | 38.29 | 2.00 | 16.75 |
| video-frame-timer | False | h264 | 6 | peer-3 | 37 | 36.46 | 3.00 | 15.42 |
| video-frame-timer | False | h264 | 6 | peer-4 | 37 | 33.91 | 4.00 | 11.11 |
| video-frame-timer | False | h264 | 6 | peer-5 | 36 | 32.42 | 2.00 |  |
| video-frame-timer | True | h264 | 6 | peer-0 | 36 | 170.13 | 17.00 | 29.38 |
| video-frame-timer | True | h264 | 6 | peer-1 | 38 | 171.29 | 7.00 | 29.33 |
| video-frame-timer | True | h264 | 6 | peer-2 | 40 | 167.56 | 39.00 | 29.17 |
| video-frame-timer | True | h264 | 6 | peer-3 | 41 | 172.23 | 9.00 | 29.07 |
| video-frame-timer | True | h264 | 6 | peer-4 | 44 | 168.62 | 8.00 | 28.95 |
| video-frame-timer | True | h264 | 6 | peer-5 | 46 | 183.89 | 9.00 | 28.96 |
| video-frame-timer | True | h264 | 8 | peer-0 | 39 | 165.09 | 34.00 | 27.81 |
| video-frame-timer | True | h264 | 8 | peer-1 | 40 | 166.09 | 8.00 | 27.99 |
| video-frame-timer | True | h264 | 8 | peer-2 | 41 | 161.14 | 9.00 | 27.70 |
| video-frame-timer | True | h264 | 8 | peer-3 | 43 | 162.02 | 15.00 | 27.74 |
| video-frame-timer | True | h264 | 8 | peer-4 | 44 | 163.34 | 11.65 | 27.60 |
| video-frame-timer | True | h264 | 8 | peer-5 | 46 | 163.01 | 66.70 | 27.78 |
| video-frame-timer | True | h264 | 8 | peer-6 | 47 | 163.43 | 13.20 | 27.79 |
| video-frame-timer | True | h264 | 8 | peer-7 | 47 | 163.73 | 13.40 | 27.69 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 166.79 | 2.00 | 30.26 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 172.08 | 1.00 | 29.27 |
| video-frame-timer | True | h264 | 4 | peer-0 | 33 | 167.24 | 4.00 | 30.32 |
| video-frame-timer | True | h264 | 4 | peer-1 | 33 | 172.73 | 5.00 | 30.15 |
| video-frame-timer | True | h264 | 4 | peer-2 | 33 | 172.55 | 3.00 | 30.09 |
| video-frame-timer | True | h264 | 4 | peer-3 | 33 | 172.20 | 3.00 | 29.95 |
| video-frame-timer | True | simulcast | 2 | peer-0 | 32 | 251.03 | 1.00 | 28.87 |
| video-frame-timer | True | simulcast | 2 | peer-1 | 31 | 276.91 | 2.00 | 29.20 |
| video-frame-timer | True | vp9 | 2 | peer-0 | 32 | 413.93 | 2.00 | 30.33 |
| video-frame-timer | True | vp9 | 2 | peer-1 | 31 | 411.43 | 1.00 | 29.17 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 171.30 | 7.00 | 30.10 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 171.54 | 7.00 | 29.07 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 93.95 | 6936.00 | 14.12 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 85.42 | 6842.00 | 12.52 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 191.80 | 680.00 | 29.57 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 172.16 | 695.55 | 29.53 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 188.66 | 18.00 | 30.81 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 192.29 | 19.00 | 29.93 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 171.38 | 8.95 | 30.13 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 171.77 | 6.00 | 29.13 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 171.79 | 6.00 | 30.68 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 172.36 | 5.00 | 28.97 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 171.26 | 5.00 | 30.39 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 172.47 | 5.00 | 29.20 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 171.02 | 5.95 | 30.20 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 172.12 | 7.40 | 29.03 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 166.51 | 5.00 | 30.26 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 172.33 | 4.00 | 29.13 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 187.75 | 122.00 | 30.30 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 189.30 | 120.00 | 30.28 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 190.86 | 171.00 | 30.48 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 190.27 | 158.00 | 30.38 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 187.76 | 182.00 | 30.27 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 189.51 | 218.70 | 30.24 |
| video-frame-timer | True | h264 | 2 | peer-0 | 31 | 187.99 | 105.00 | 29.93 |
| video-frame-timer | True | h264 | 2 | peer-1 | 32 | 188.75 | 105.00 | 30.19 |
| video-frame-timer | True | h264 | 2 | peer-0 | 31 | 186.42 | 216.00 | 30.34 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 187.20 | 205.00 | 30.37 |
| video-frame-timer | True | h264 | 2 | peer-0 | 32 | 182.98 | 405.00 | 30.31 |
| video-frame-timer | True | h264 | 2 | peer-1 | 31 | 183.44 | 404.00 | 30.14 |
| video-frame-timer | True | h264 | 2 | peer-0 | 182 | 188.18 | 1349.00 | 30.32 |
| video-frame-timer | True | h264 | 2 | peer-1 | 184 | 188.55 | 1354.40 | 29.96 |
