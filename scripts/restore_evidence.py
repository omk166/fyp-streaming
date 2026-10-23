"""Restore published sanitized telemetry for recalculating tables locally."""
import gzip, json, re
from pathlib import Path
root=Path('artifacts')
count=0
for archive in sorted((root/'evidence').glob('*.json.gz')):
    with gzip.open(archive,'rt',encoding='utf-8') as f: data=json.load(f)
    run_id=data['manifest']['runId']
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,149}',run_id): raise ValueError('Invalid run ID')
    folder=root/'raw'/run_id
    if folder.exists(): continue
    folder.mkdir(parents=True)
    (folder/'manifest.json').write_text(json.dumps(data['manifest'],indent=2),encoding='utf-8')
    for i,peer in enumerate(data['peers']):
        match=re.search(r'-peer(\d+)$',peer['metadata']['runId'])
        index=int(match[1]) if match else i
        (folder/f'peer-{index}.json').write_text(json.dumps(peer,indent=2),encoding='utf-8')
    count+=1
print(f'Restored {count} sanitized runs without overwriting existing local evidence')
