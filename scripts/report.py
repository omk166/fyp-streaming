"""Summarize only saved runs; preserve missing metrics as empty values."""
import csv, json, math
from pathlib import Path
from statistics import mean

def percentile(values, p):
    if not values: return None
    values = sorted(values)
    at = (len(values)-1)*p
    lo = math.floor(at); hi = math.ceil(at)
    return values[lo] + (values[hi]-values[lo])*(at-lo)

def measurements(data):
    rates, rtt, jitter, fps, cpu, memory = [], [], [], [], [], []
    previous = {}
    previous_server = None
    for sample in data['samples']:
        server = sample.get('server')
        if server:
            usage = server['worker']
            memory.append(server['nodeMemory']['rss']/1048576)
            if previous_server:
                dt = sample['monotonicMs']-previous_server['monotonicMs']
                old = previous_server['server']['worker']
                delta = usage['ru_utime']+usage['ru_stime']-old['ru_utime']-old['ru_stime']
                if dt > 0 and delta >= 0: cpu.append(100*delta/dt)
            previous_server = sample
        sending = 0; valid = False
        for transport in sample['reports']:
            for r in transport['reports']:
                key = (transport['direction'], r['id'])
                old = previous.get(key)
                if r['type'] == 'outbound-rtp' and not r.get('isRemote') and old:
                    dt = r['timestamp'] - old['timestamp']
                    delta = r.get('bytesSent', 0) - old.get('bytesSent', 0)
                    if dt > 0 and delta >= 0:
                        sending += delta*8/dt  # bytes/ms -> kb/s, RTP payload counters
                        valid = True
                if r['type'] == 'candidate-pair' and r.get('state') == 'succeeded' and r.get('nominated') and 'currentRoundTripTime' in r:
                    rtt.append(r['currentRoundTripTime']*1000)
                if r['type'] == 'inbound-rtp':
                    if 'jitter' in r: jitter.append(r['jitter']*1000)
                    if r.get('kind') == 'video' and 'framesPerSecond' in r: fps.append(r['framesPerSecond'])
                previous[key] = r
        if valid: rates.append(sending)
    return {'send_rtp_payload_kbps_mean': mean(rates) if rates else None,
            'ice_rtt_ms_p95': percentile(rtt,.95), 'inbound_jitter_ms_p95': percentile(jitter,.95),
            'inbound_video_fps_mean': mean(fps) if fps else None,
            'sfu_worker_cpu_one_core_pct_mean': mean(cpu) if cpu else None,
            'node_rss_mib_mean': mean(memory) if memory else None}

root = Path('artifacts'); rows = []
for manifest in sorted((root/'raw').glob('*/manifest.json')):
    run = json.loads(manifest.read_text())
    for peer in sorted(manifest.parent.glob('peer-[0-9]*.json')):
        if 'failure' in peer.name: continue
        data = json.loads(peer.read_text())
        rows.append({'run_id': run['runId'], 'passed': run['passed'], 'mode': run['mode'],
            'participants': run['participants'], 'peer': peer.stem, 'sample_count': len(data['samples']),
            'join_setup_ms': data.get('joinMs'), **measurements(data)})
root.mkdir(exist_ok=True)
fields = ['run_id','passed','mode','participants','peer','sample_count','join_setup_ms',
          'send_rtp_payload_kbps_mean','ice_rtt_ms_p95','inbound_jitter_ms_p95','inbound_video_fps_mean',
          'sfu_worker_cpu_one_core_pct_mean','node_rss_mib_mean']
with (root/'results.csv').open('w',newline='',encoding='utf-8') as f:
    writer=csv.DictWriter(f,fieldnames=fields); writer.writeheader(); writer.writerows(rows)
lines=['# Measured local prototype results','',
'Synthetic media; browsers and SFU share one laptop. RTP payload bitrate excludes transport overhead. RTT is not mouth-to-ear latency. No subjective or objective reference-video quality score was measured. Percentiles pool one-second reports per peer, not independent trials.','',
'| Mode | Participants | Peer | Samples | Send payload kb/s (mean) | ICE RTT ms (p95) | Video FPS (mean) |',
'|---|---:|---|---:|---:|---:|---:|']
def fmt(v): return '' if v is None else f'{v:.2f}'
for row in rows:
    lines.append(f"| {row['mode']} | {row['participants']} | {row['peer']} | {row['sample_count']} | {fmt(row['send_rtp_payload_kbps_mean'])} | {fmt(row['ice_rtt_ms_p95'])} | {fmt(row['inbound_video_fps_mean'])} |")
if not rows: lines += ['', 'No completed telemetry runs found.']
(root/'RESULTS.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print(f'Summarized {len(rows)} peer records')
