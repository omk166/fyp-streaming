"""Create standalone figures from measured aggregate data only."""
import csv
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root=Path('artifacts')
with (root/'results.csv').open(encoding='utf-8') as f: rows=list(csv.DictReader(f))
if not rows: raise SystemExit('No measurements available')
fig, axes=plt.subplots(1,2,figsize=(12,4),layout='constrained')
for mode in sorted({r['mode'] for r in rows}):
    selected=[r for r in rows if r['mode']==mode and r['passed']=='True' and r['source_clock']=='video-frame-timer' and r['sfu_platform']=='windows-native']
    for ax,field,label in zip(axes,['send_rtp_payload_kbps_mean','inbound_video_fps_mean'],['Mean send RTP payload (kb/s)','Mean inbound video FPS']):
        points=[r for r in selected if r[field]]
        ax.scatter([int(r['participants']) for r in points],[float(r[field]) for r in points],label=mode,alpha=.7)
        ax.set(xlabel='Browser participants on one laptop',ylabel=label,xticks=[2,4,6,8]); ax.grid(alpha=.2)
for ax in axes: ax.legend()
fig.suptitle('Generated-frame local runs; each point is one peer, not an independent trial')
fig.savefig(root/'local-measurements.png',dpi=180)
fig.savefig(root/'local-measurements.pdf')
print('Saved PNG and PDF measurement figures')
