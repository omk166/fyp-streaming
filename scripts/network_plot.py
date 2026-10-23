import csv,json,re
from pathlib import Path
from datetime import datetime
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
root=Path('artifacts')
rows=list(csv.DictReader((root/'network-results.csv').open(encoding='utf-8')))
fig,axes=plt.subplots(2,2,figsize=(11,7),layout='constrained')
scenarios=[(r'egress-(\d+)kbit','Configured shared egress (kb/s)','mean_inbound_video_fps','Received video FPS'),
 (r'egress-loss-(\d+)pct','Configured random loss (%)','mean_inbound_video_fps','Received video FPS'),
 (r'egress-delay-(\d+)ms','Configured one-way added delay (ms)','max_peer_ice_rtt_p95_ms','Max peer ICE RTT p95 (ms)'),
 (r'egress-jitter-(\d+)ms','Configured normal jitter parameter (ms)','audio_jitter_buffer_ms_mean','Mean audio jitter-buffer delay (ms)')]
for ax,(pattern,xlabel,metric,ylabel) in zip(axes.flat,scenarios):
    points=sorted((int(m[1]),float(r[metric]),r['exit_code']) for r in rows if (m:=re.fullmatch(pattern,r['profile'])) and r[metric])
    if points:
        ax.plot([p[0] for p in points],[p[1] for p in points],marker='o')
        for x,y,code in points:
            if code!='0':ax.annotate('check failed',(x,y))
    ax.set(xlabel=xlabel,ylabel=ylabel);ax.grid(alpha=.25)
    ax.set_ylim(bottom=0)
    if metric=='mean_inbound_video_fps':ax.set_ylim(0,35)
fig.suptitle('One exploratory run per setting; two synthetic endpoints and Linux SFU share one laptop')
fig.savefig(root/'network-measurements.png',dpi=180);fig.savefig(root/'network-measurements.pdf')
plt.close(fig)
step=next((p for p in sorted((root/'raw').glob('*/manifest.json'),reverse=True) if json.loads(p.read_text()).get('impairment')=='egress-step-2000-500-2000kbit'),None)
if step and (step.parent/'peer-0.json').exists():
    data=json.loads((step.parent/'peer-0.json').read_text()); samples=data['samples']
    x=[];rates=[];previous={}; origin=datetime.fromisoformat(samples[0]['timestamp'].replace('Z','+00:00'))
    for s in samples:
        rate=0;valid=False
        for t in s['reports']:
            codecs={r['id']:r.get('mimeType','').lower() for r in t['reports'] if r['type']=='codec'}
            for r in t['reports']:
                if r['type']!='inbound-rtp' or r.get('codecId') not in codecs or codecs[r['codecId']].endswith('/rtx'):continue
                old=previous.get(r['id']);previous[r['id']]=r
                if old and r['timestamp']>old['timestamp'] and r['bytesReceived']>=old['bytesReceived']:
                    rate+=8*(r['bytesReceived']-old['bytesReceived'])/(r['timestamp']-old['timestamp']);valid=True
        if valid:
            x.append((datetime.fromisoformat(s['timestamp'].replace('Z','+00:00'))-origin).total_seconds());rates.append(rate)
    fig,ax=plt.subplots(figsize=(10,4),layout='constrained');ax.plot(x,rates,label='Peer 0 received media payload')
    config=json.loads((root/'network/egress-step-2000-500-2000kbit.json').read_text())
    for transition in config['transitions']:
        at=(datetime.fromisoformat(transition['at'].replace('Z','+00:00'))-origin).total_seconds()
        ax.axvline(at,color='black',linestyle='--',alpha=.5);ax.text(at,ax.get_ylim()[1]*.9,transition['rate'],rotation=90,va='top')
    ax.set(xlabel='Seconds from first saved sample',ylabel='Received primary media payload (kb/s)',title='Shared SFU egress step: 2 -> 0.5 -> 2 Mb/s; one exploratory trial')
    ax.set_ylim(bottom=0)
    ax.legend();ax.grid(alpha=.25);fig.savefig(root/'step-response.png',dpi=180);fig.savefig(root/'step-response.pdf')
print('Saved figures derived from executed network runs')
