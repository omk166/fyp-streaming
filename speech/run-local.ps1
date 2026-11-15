param([string]$Model = 'base', [int]$CpuThreads = 4)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$python = Join-Path $project '.venv-speech\Scripts\python.exe'
$node = Join-Path (Split-Path $project -Parent) '.tools\node-v22.23.4-win-x64\node.exe'
if (!(Test-Path -LiteralPath $node)) { $node = (Get-Command node.exe).Source }
if (!(Test-Path -LiteralPath $python)) { throw 'Install speech/requirements.txt in .venv-speech first; see speech/README.md.' }
$logs = Join-Path $project 'data\transcription-local'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
foreach ($port in @(3198, 8765)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port is already in use. Check the existing local test before starting another."
    }
}
$env:WHISPER_MODEL = $Model
$downloadedModel = Join-Path $project ".venv-speech\models\$Model"
if (Test-Path -LiteralPath (Join-Path $downloadedModel 'model.bin')) {
    $env:WHISPER_MODEL = $downloadedModel
}
$env:WHISPER_DEVICE = 'cpu'
$env:WHISPER_COMPUTE_TYPE = 'int8'
$env:WHISPER_CPU_THREADS = [string]$CpuThreads
$env:WHISPER_PORT = '8765'
$env:WHISPER_DOWNLOAD_ROOT = Join-Path $project '.venv-speech\models'
$env:HF_HOME = Join-Path $project '.venv-speech\huggingface'
$speech = Start-Process -FilePath $python -ArgumentList @('-u', 'speech/service.py') -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'speech.log') -RedirectStandardError (Join-Path $logs 'speech-error.log')
Write-Output "Speech worker PID: $($speech.Id). Model: $Model (CPU). First launch downloads model weights."
$env:HOST = '127.0.0.1'
$env:PORT = '3198'
$env:MEDIA_IP = '127.0.0.1'
$env:ANNOUNCED_ADDRESS = '127.0.0.1'
$env:MEDIA_PORT = '41998'
$env:APP_ORIGIN = 'http://127.0.0.1:3198'
$env:AUTH_DB_PATH = Join-Path $logs 'auth.sqlite'
$env:TRANSCRIPTION_URL = 'http://127.0.0.1:8765/transcribe'
$env:SCREEN_PEN = '0'
# Local test is plain HTTP on loopback, regardless of inherited deployment TLS.
Remove-Item Env:TLS_CERT -ErrorAction SilentlyContinue
Remove-Item Env:TLS_KEY -ErrorAction SilentlyContinue
& $node (Join-Path $project 'node_modules\esbuild\bin\esbuild') (Join-Path $project 'client\main.js') --bundle --format=esm "--outfile=$project\public\bundle.js"
if ($LASTEXITCODE -ne 0) { Stop-Process -Id $speech.Id; throw 'Client build failed.' }
$meeting = Start-Process -FilePath $node -ArgumentList @('server.js') -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'meeting.log') -RedirectStandardError (Join-Path $logs 'meeting-error.log')
Write-Output "Meeting server PID: $($meeting.Id). Open http://127.0.0.1:3198 after the speech worker is ready."
Write-Output "Health: http://127.0.0.1:8765/health ; Logs: $logs"
Write-Output "To stop the meeting: Stop-Process -Id $($meeting.Id)"
Write-Output "To stop the speech worker and its Python child: taskkill /PID $($speech.Id) /T /F"
