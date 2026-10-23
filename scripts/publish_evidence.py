"""Export compressed test telemetry without network endpoints or local paths."""
import gzip, json, re
from pathlib import Path

root=Path('artifacts')
output=root/'evidence'; output.mkdir(exist_ok=True)
blocked={'ip','address','ipAddress','localIp','remoteIp','localAddress','remoteAddress',
         'port','localPort','remotePort','url','username','credential','password',
         'iceLocalUsernameFragment','iceRemoteUsernameFragment','certificate',
         'base64Certificate','workingTree','userAgent','usernameFragment','relatedAddress','relatedPort'}
def scrub(value):
    if isinstance(value,dict):
        return {key:scrub(item) for key,item in value.items() if key not in blocked and not key.lower().endswith(('address','ip'))}
    if isinstance(value,list): return [scrub(item) for item in value]
    return value

summaries=[]
for path in sorted((root/'raw').glob('*/manifest.json')):
    manifest=json.loads(path.read_text())
    peers=[peer for peer in sorted(path.parent.glob('peer-[0-9]*.json')) if 'failure' not in peer.name]
    if not peers:
        # Debugging errors may contain local filesystem paths; retain locally.
        summaries.append({'runId':manifest['runId'],'passed':False,'note':'Development harness failure; no performance measurements. Details retained locally.'})
        continue
    public_manifest=scrub(manifest)
    public_manifest['errors']=[{'message':item['message'].split('\n')[0]} for item in manifest['errors']]
    export={'manifest':public_manifest,'peers':[]}
    for peer in peers:
        export['peers'].append(scrub(json.loads(peer.read_text())))
    text=json.dumps(export,separators=(',',':'))
    # Reject unexpected literal IPs except local loopback used in the app URL.
    addresses=set(re.findall(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])',text))
    addresses={a for a in addresses if all(int(n)<=255 for n in a.split('.'))}
    if addresses-{'127.0.0.1'}: raise ValueError(f'Unredacted addresses: {addresses}')
    with gzip.GzipFile(filename=str(output/f'{manifest["runId"]}.json.gz'),mode='wb',mtime=0) as f:
        f.write(text.encode())
    summaries.append(public_manifest)
(root/'run-manifests.json').write_text(json.dumps(summaries,indent=2),encoding='utf-8')
print(f'Exported {len(list(output.glob("*.json.gz")))} sanitized measured runs; failures retained.')
