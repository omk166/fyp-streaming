"""Create a shareable DOCX from real run summaries and screenshots."""
import csv, json
from pathlib import Path
from statistics import mean
from datetime import datetime, timezone
from docx import Document
from docx.shared import Inches, Pt

root=Path('artifacts')
rows=list(csv.DictReader((root/'results.csv').open(encoding='utf-8')))
matched=[r for r in rows if r['profile']=='windows-software-video' and r['source_clock']=='video-frame-timer']
network=list(csv.DictReader((root/'network-results.csv').open(encoding='utf-8'))) if (root/'network-results.csv').exists() else []
doc=Document()
doc.core_properties.title='FYP Streaming Prototype: Initial Local Evaluation'
doc.core_properties.author='FYP Streaming Lab'
doc.core_properties.subject='Exploratory streaming measurements with documented limitations'
doc.core_properties.created=datetime.now(timezone.utc).replace(tzinfo=None)
doc.core_properties.modified=doc.core_properties.created
doc.add_heading('FYP Streaming Prototype: Initial Local Evaluation',0)
doc.add_paragraph('Measured synthetic-media experiments. This report evaluates the research prototype, not a completed conferencing application.')
doc.add_heading('Environment and method',1)
env=json.loads((root/'environment.json').read_text(encoding='utf-8-sig'))
for key,value in env.items(): doc.add_paragraph(f'{key}: {value}')
if (root/'linux-environment.json').exists():
    linux=json.loads((root/'linux-environment.json').read_text(encoding='utf-8-sig'))
    doc.add_paragraph(f"Linux SFU: Node {linux['node']}, mediasoup {linux['mediasoup']}, {linux['architecture']}, kernel {linux['kernel']}. Exact image ID and server-source checksum are in linux-environment.json.")
doc.add_paragraph('Browser participants and the mediasoup SFU share one physical Windows laptop. The SFU platform is recorded per run. Each participant publishes animated 640 x 360 synthetic video and a quiet 440 Hz tone. Browser sessions are isolated. Telemetry is sampled about once per second. Runs include join setup and functional checks before a timed observation period; the tables use all saved samples, including startup. These short trials provide functional evidence and preliminary telemetry, not statistically validated capacity or codec-quality conclusions.')
doc.add_heading('Results',1)
doc.add_paragraph('Source clocks distinguish animation-frame, timer and video-frame-timer implementations. Larger accelerated headless runs stalled under more than one source implementation. A separately labelled software-video configuration passed the six-browser check. Browser arguments in the manifests identify the actual settings. Failure outcomes must be read alongside the metrics; low bitrate from a frozen source is not an efficiency improvement. Use matched software-video runs for preliminary comparisons; the trials do not establish a GPU root cause or separate-device capacity.')
table=doc.add_table(rows=1, cols=7); table.style='Light Shading Accent 1'
headers=['Mode','Peers','Outcome','Upload kb/s','Video FPS','SFU CPU %','Node RSS MiB']
for cell,text in zip(table.rows[0].cells,headers): cell.text=text
def fmt(value): return f'{float(value):.2f}' if value else 'N/A'
groups={}
for row in matched:groups.setdefault(row['run_id'],[]).append(row)
for peers in sorted(groups.values(),key=lambda peers:({'h264':0,'simulcast':1,'vp9':2}.get(peers[0]['mode'],9),int(peers[0]['participants']))):
    row=peers[0]
    avg=lambda key:mean(float(p[key]) for p in peers if p[key])
    vals=[row['mode'],row['participants'],'PASS' if row['passed']=='True' else 'FAIL',f"{avg('send_rtp_payload_kbps_mean'):.2f}",f"{avg('inbound_video_fps_mean'):.2f}",fmt(row['sfu_worker_cpu_one_core_pct_mean']),fmt(row['node_rss_mib_mean'])]
    for cell,text in zip(table.add_row().cells,vals): cell.text=text
doc.add_paragraph('Upload is the average of per-peer means from outbound RTP payload counter differences; headers and network overhead are excluded. FPS averages per-peer inbound video means. SFU CPU is worker utilization as a percentage of one core. CPU/RSS use peer 0 server telemetry so the server is not counted once per endpoint; Node RSS excludes the separate worker process. Full per-peer values and setup timings are in the CSV. Per-peer results from a shared laptop are correlated. ICE RTT is not end-to-end audio delay.')
doc.add_heading('Functional checks and run outcomes',1)
selected=[]
for path in sorted((root/'raw').glob('*/manifest.json')):
    run=json.loads(path.read_text())
    if run.get('impairment')!='windows-software-video': continue
    selected.append(run)
    doc.add_paragraph(f"{run['runId']}: {'PASS' if run['passed'] else 'FAIL'}; {run['measurementSeconds']} s observation; {run['browserChannel']} {run['browser']}; source {run['gitCommit']}")
    if run['errors']: doc.add_paragraph('Errors are preserved in the local raw manifest.')
doc.add_paragraph('The automated checks cover expected remote track counts, microphone producer pause/resume, video producer pause/resume, delivery of a chat message to a second peer, continued decoded video/audio packet progress on every peer during observation, and remote-track cleanup after leaving. They do not establish perceptual audio quality or continuous frame delivery at a specified FPS.')
doc.add_paragraph('Earlier failed accelerated runs and all available per-peer measurements remain in the CSV and evidence archive. The report tables focus on the matched software-video configuration rather than pooling incompatible conditions.')
if network:
    doc.add_heading('Controlled Linux media-network experiments',1)
    doc.add_paragraph('The SFU runs in a dedicated Docker Linux container on the same physical laptop as two synthetic Edge endpoints. Network shaping applies only to outgoing SFU media, shared across receivers; signaling is excluded. It is not a per-sender uplink experiment. Delay is applied in one direction. Configurations, actual rate-change timestamps and kernel queue/drop counters are saved under artifacts/network. One exploratory run per profile, no fixed random seed and no confidence interval. A functional pass is not a conversational-quality acceptance result.')
    nt=doc.add_table(rows=1,cols=5);nt.style='Light Shading Accent 1'
    for cell,text in zip(nt.rows[0].cells,['Profile','Exit code','RTT p95 max ms','Mean video FPS','Kernel drops']):cell.text=text
    for r in network:
        values=[r['profile'],r['exit_code'],fmt(r['max_peer_ice_rtt_p95_ms']),fmt(r['mean_inbound_video_fps']),r['kernel_netem_dropped_packets'] or 'N/A']
        for cell,text in zip(nt.add_row().cells,values):cell.text=text
    doc.add_paragraph('RTT values are the maximum of per-peer p95 values, not pooled p95. Kernel drops include emulation/queue drops and do not equal unrepaired RTP loss. Concealment, NACK and freeze counters are retained in the CSV; no subjective quality score or proof of repair before playback deadlines is inferred.')
    constrained=next((r for r in network if r['profile']=='egress-250kbit'),None)
    if constrained:doc.add_paragraph(f"At the shared 250 kb/s cap, mean received video was {fmt(constrained['mean_inbound_video_fps'])} FPS and the maximum peer ICE RTT p95 was {fmt(constrained['max_peer_ice_rtt_p95_ms'])} ms. The media-progress check passed while queue delay and media diagnostics deteriorated. This is not evidence of acceptable conversational quality or a measured mouth-to-ear result.")
    for path in sorted((root/'raw').glob('*/manifest.json')):
        run=json.loads(path.read_text())
        if run.get('sfuPlatform')=='docker-linux' and run.get('impairment') in {'egress-250kbit','egress-loss-10pct','egress-delay-400ms','egress-step-2000-500-2000kbit'}:selected.append(run)
doc.add_heading('Measured figures and screenshots',1)
if (root/'local-measurements.png').exists(): doc.add_picture(str(root/'local-measurements.png'),width=Inches(6))
if (root/'network-measurements.png').exists():doc.add_picture(str(root/'network-measurements.png'),width=Inches(6))
if (root/'step-response.png').exists():doc.add_picture(str(root/'step-response.png'),width=Inches(6))
for run in selected:
    image=root/'screenshots'/f"{run['runId']}{'' if run['passed'] else '-failure'}.png"
    if not image.exists(): continue
    doc.add_paragraph(image.stem)
    doc.add_picture(str(image),width=Inches(6))
doc.add_heading('Limitations and pending experiments',1)
for text in [
    'No real microphone, speaker, camera, acoustic echo or mouth-to-ear test has been performed. The original-audio target below 200 ms remains unverified.',
    'Shared-SFU egress impairment trials are preliminary; per-sender uplink, real WAN, NAT and TURN behavior remain unverified.' if network else 'No bandwidth caps, packet loss, jitter, WAN delay, NAT or TURN path has been exercised in these local trials.',
    'Multiple browser sessions on one laptop do not establish eight-device meeting capacity or cross-browser compatibility.',
    'No aligned reference/received video recording, VMAF, PSNR, SSIM or human MOS was measured. Synthetic-canvas bitrate cannot establish codec superiority.',
    'Screen sharing, host permissions, whiteboard, recorder and AI branches are not implemented in this prototype and are not tested.',
    'The experiment matrix retains pending work. Further measurements require repeated trials, controlled media, actual network shaping and separate endpoint devices.'
]: doc.add_paragraph(text,style='List Bullet')
doc.add_heading('Evidence and reproduction',1)
doc.add_paragraph('See README.md for startup commands, scripts/smoke.mjs for the automated procedure, scripts/report.py for calculations, artifacts/results.csv for numeric data, and artifacts/screenshots for visual evidence. Raw telemetry and detailed manifests are retained locally under artifacts/raw and excluded from the public repository pending review of connection metadata.')
for section in doc.sections:
    section.header.paragraphs[0].text='FYP Streaming Lab | Preliminary evaluation'
doc.styles['Normal'].font.size=Pt(10)
doc.save(root/'FYP_Streaming_Initial_Evaluation.docx')
print('Saved DOCX report from measured artifacts')
