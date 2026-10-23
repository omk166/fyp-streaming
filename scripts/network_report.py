"""Combine measured browser counters and saved kernel shaping evidence."""
import csv,json,re
from pathlib import Path
from statistics import mean
root=Path('artifacts')
rows=list(csv.DictReader((root/'results.csv').open(encoding='utf-8')))
output=[]
def queue(text):
    match=re.search(r'qdisc netem .*?\n\s*Sent (\d+) bytes (\d+) pkt \(dropped (\d+)',text,re.S)
    return tuple(map(int,match.groups())) if match else None
for path in sorted((root/'network').glob('*.json')):
    evidence=json.loads(path.read_text())
    if 'profile' not in evidence: continue
    peers=[r for r in rows if r['profile']==evidence['profile'] and r['sfu_platform']=='docker-linux']
    valid=[r for r in peers if r['ice_rtt_ms_p95']]
    q0,q1=queue(evidence['before']),queue(evidence['after'])
    sent_packets=(q1[1]-q0[1]) if q0 and q1 else None
    drops=(q1[2]-q0[2]) if q0 and q1 else None
    def avg(key):
        values=[float(r[key]) for r in peers if r[key]]
        return mean(values) if values else None
    freezes=concealed=audio_samples=nack=0
    available=set()
    for manifest in sorted((root/'raw').glob('*/manifest.json')):
        run=json.loads(manifest.read_text())
        if run.get('impairment')!=evidence['profile']: continue
        for p in sorted(manifest.parent.glob('peer-[0-9].json')):
            data=json.loads(p.read_text())
            if not data['samples']: continue
            first={r['id']:r for t in data['samples'][0]['reports'] for r in t['reports']}
            for t in data['samples'][-1]['reports']:
                for r in t['reports']:
                    if r['type']!='inbound-rtp': continue
                    available.update(r.keys())
                    old=first.get(r['id'],{})
                    delta=lambda key: max(0,r.get(key,0)-old.get(key,0))
                    if r.get('kind')=='video': freezes+=delta('freezeCount')
                    if r.get('kind')=='audio':
                        concealed+=delta('concealedSamples'); audio_samples+=delta('totalSamplesReceived')
                    nack+=delta('nackCount')
    output.append({'profile':evidence['profile'],'exit_code':evidence['exitCode'],
        'peer_rows':len(peers),'max_peer_ice_rtt_p95_ms':max(float(r['ice_rtt_ms_p95']) for r in valid) if valid else None,
        'mean_send_payload_kbps':avg('send_rtp_payload_kbps_mean'),'mean_inbound_video_fps':avg('inbound_video_fps_mean'),
        'kernel_netem_sent_packets':sent_packets,'kernel_netem_dropped_packets':drops,
        'kernel_drop_fraction':drops/(drops+sent_packets) if drops is not None and drops+sent_packets else None,
        'reported_video_freezes':freezes if 'freezeCount' in available else None,'audio_concealed_samples':concealed if 'concealedSamples' in available else None,'audio_total_samples':audio_samples if 'totalSamplesReceived' in available else None,
        'inbound_nack_count':nack if 'nackCount' in available else None,'recorded_rate_transitions':len(evidence.get('transitions',[])),
        'phase_errors':len(evidence.get('phaseErrors',[]))})
if not output: raise SystemExit('No executed network profiles with shaping evidence found')
with (root/'network-results.csv').open('w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f,fieldnames=output[0].keys());w.writeheader();w.writerows(output)
lines=['# Exploratory Linux media impairment runs','',
'Shared SFU egress shaping on a dedicated Docker container; two synthetic Edge participants on the same physical laptop. Caps are not per-sender uplinks. Delay is one-directional, and reported RTT is measured. One run per profile; no statistical confidence claim. Randomized loss/jitter runs have no fixed seed.','',
'| Profile | Check exit code | Max peer ICE RTT p95 ms | Mean received video FPS | Kernel netem drops |',
'|---|---:|---:|---:|---:|']
def fmt(v):return 'N/A' if v is None else f'{v:.2f}'
for r in output:lines.append(f"| {r['profile']} | {r['exit_code']} | {fmt(r['max_peer_ice_rtt_p95_ms'])} | {fmt(r['mean_inbound_video_fps'])} | {r['kernel_netem_dropped_packets'] if r['kernel_netem_dropped_packets'] is not None else 'N/A'} |")
lines+=['','Exit code 0 means the functional/media-progress checks passed; it is not a QoE acceptance threshold. Kernel packet drops include emulation and queue drops and do not equal unrepaired RTP loss. Freeze, NACK and concealed-sample counters are browser-reported diagnostics, not MOS or calibrated audio continuity. The CSV does not prove RTX/FEC usefulness before playback deadlines. Unavailable counters require inspection of raw telemetry rather than assuming zero.','',
'The 2 -> 0.5 -> 2 Mb/s profile applies each cap for about 60 seconds, timed from process launch; actual transition timestamps are saved in network/. Setup and screenshots affect the overall window. No adaptive application policy has been implemented or compared against default WebRTC.']
(root/'NETWORK_RESULTS.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print(f'Summarized {len(output)} executed impairment profiles')
