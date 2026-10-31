param(
    [Parameter(Mandatory = $true)][string]$LanAddress,
    [int]$Port = 3443,
    [int]$MediaPort = 40001
)
$ErrorActionPreference = 'Stop'
$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($LanAddress, [ref]$parsedAddress) -or
    $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
    [System.Net.IPAddress]::IsLoopback($parsedAddress) -or $LanAddress -eq '0.0.0.0') {
    throw 'LanAddress must be the Wi-Fi IPv4 address of this laptop (see ipconfig).'
}
if ($Port -lt 1024 -or $Port -gt 65535 -or $MediaPort -lt 1024 -or $MediaPort -gt 65535 -or $Port -eq $MediaPort) {
    throw 'Choose different web/media ports between 1024 and 65535.'
}
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    if (-not (Test-Path 'certs/lan.pem') -or -not (Test-Path 'certs/lan-key.pem')) {
        throw 'Missing HTTPS certificate. Follow LAN-DEMO.md to create certs/lan.pem and certs/lan-key.pem for this IP.'
    }
    $nodePath = Join-Path (Get-Location) '../.tools/node-v22.23.4-win-x64/node.exe'
    if (-not (Test-Path $nodePath)) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
    & $nodePath node_modules/esbuild/bin/esbuild client/main.js --bundle --format=esm --outfile=public/bundle.js
    if ($LASTEXITCODE -ne 0) { throw 'Client build failed.' }
    $names = @('HOST', 'PORT', 'MEDIA_IP', 'ANNOUNCED_ADDRESS', 'MEDIA_PORT', 'TLS_CERT', 'TLS_KEY')
    $previous = @{}
    foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        $env:HOST = $LanAddress
        $env:PORT = "$Port"
        $env:MEDIA_IP = $LanAddress
        $env:ANNOUNCED_ADDRESS = $LanAddress
        $env:MEDIA_PORT = "$MediaPort"
        $env:TLS_CERT = 'certs/lan.pem'
        $env:TLS_KEY = 'certs/lan-key.pem'
        Write-Host "On each device, open https://${LanAddress}:$Port and join the same room."
        Write-Host 'Keep this terminal open. Press Ctrl+C to stop.'
        & $nodePath server.js
        if ($LASTEXITCODE -ne 0) { throw 'LAN server stopped with an error.' }
    } finally {
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    }
} finally { Pop-Location }
