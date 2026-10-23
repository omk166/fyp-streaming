"""Concise matched-baseline table; never pool incompatible source/settings."""
import csv,json
from pathlib import Path
from statistics import mean
root=Path('artifacts')
rows=list(csv.DictReader((root/'results.csv').open(encoding='utf-8')))
groups={}
for r in rows:
    if r['profile']=='windows-software-video' and r['source_clock']=='video-frame-timer': groups.setdefault(r['run_id'],[]).append(r)
lines=['# Preliminary matched local baseline','',
'One exploratory run per scenario, synthetic video/tone, Edge, all participants and SFU on one laptop. Hardware video encode/decode and GPU rendering disabled for these automated runs. These are functional and local-load observations, not final capacity or codec-quality results.','',
'| Mode | Participants | Outcome | Mean sender payload kb/s | Mean received video FPS | SFU CPU % of one core | Node RSS MiB |',
'|---|---:|---|---:|---:|---:|---:|']
confirmed=[]
for run_id,peers in groups.items():
    r=peers[0]
    avg=lambda key: mean(float(p[key]) for p in peers if p[key])
    lines.append(f"| {r['mode']} | {r['participants']} | {'PASS' if r['passed']=='True' else 'FAIL'} | {avg('send_rtp_payload_kbps_mean'):.1f} | {avg('inbound_video_fps_mean'):.1f} | {float(r['sfu_worker_cpu_one_core_pct_mean']):.1f} | {float(r['node_rss_mib_mean']):.1f} |")
    folder=root/'raw'/run_id
    for path in sorted(folder.glob('peer-[0-9].json')):
        data=json.loads(path.read_text())
        video=next(p for p in data['metadata']['negotiatedProducers'] if p['kind']=='video')['rtpParameters']
        codecs=[c['mimeType'] for c in video['codecs'] if not c['mimeType'].lower().endswith('/rtx')]
        encodings=video['encodings']
        expected='video/vp9' if r['mode']=='vp9' else 'video/h264'
        valid=any(c.lower()==expected for c in codecs) and len(encodings)==(2 if r['mode']=='simulcast' else 1)
        if r['mode']=='vp9': valid=valid and encodings[0].get('scalabilityMode','').startswith('L2T3')
        confirmed.append({'run_id':run_id,'peer':path.stem,'mode':r['mode'],'codecs':';'.join(codecs),'encodings':len(encodings),'scalability_modes':';'.join(e.get('scalabilityMode','unspecified') for e in encodings),'requested_format_confirmed':valid})
lines += ['', 'Sender bitrate is the average of per-peer means from RTP payload byte counters and excludes network overhead. Received FPS averages available per-peer inbound video reports. Server CPU/RSS are taken from peer 0 telemetry to avoid counting the same server once per participant; CPU is one-core utilization, not whole-laptop utilization. These columns do not include total endpoint or GPU CPU/RAM. Startup samples are included. Each run has a 30-second observation period after setup; earlier-joining peers accumulate more samples.','',
'Earlier accelerated six/eight-browser trials stalled. They are retained as diagnostics in the full CSV and evidence archive. A software-video pass does not establish the root cause of those stalls or predict behavior on separate devices.','',
'Still unverified: original-audio mouth-to-ear latency below 200 ms, multiple real devices/browsers, NAT/TURN, subjective MOS, reference-video quality scores, recorder/AI isolation and meeting features not implemented in this prototype.','',
'See RESULTS.md and results.csv for per-peer data, run-manifests.json for outcomes/settings, confirmed-formats.csv for negotiated producer parameters, and screenshots/ for browser captures.']
(root/'SUMMARY.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
if confirmed:
    with (root/'confirmed-formats.csv').open('w',newline='',encoding='utf-8') as f:
        w=csv.DictWriter(f,fieldnames=confirmed[0].keys());w.writeheader();w.writerows(confirmed)
    assert all(r['requested_format_confirmed'] for r in confirmed),'A requested codec/layer format was not negotiated'
print(f'Summarized {len(groups)} matched scenarios; verified {len(confirmed)} producer formats')
