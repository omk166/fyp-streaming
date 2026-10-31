param(
    [Parameter(Mandatory = $true)][string]$LanAddress,
    [string]$InterfaceAlias = 'Wi-Fi'
)
$ErrorActionPreference = 'Stop'
$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($LanAddress, [ref]$parsedAddress) -or
    $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
    [System.Net.IPAddress]::IsLoopback($parsedAddress) -or $LanAddress -eq '0.0.0.0') {
    throw 'Supply the Wi-Fi IPv4 address of this laptop.'
}
$logDirectory = Join-Path $PSScriptRoot '../artifacts/private'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$rules = @(
    @{ Name = 'FYP LAN HTTPS WiFi'; Protocol = 'TCP'; Port = 3443 },
    @{ Name = 'FYP LAN media UDP WiFi'; Protocol = 'UDP'; Port = 40001 },
    @{ Name = 'FYP LAN media TCP WiFi'; Protocol = 'TCP'; Port = 40001 }
)
try {
    foreach ($rule in $rules) {
        if (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue) {
            Get-NetFirewallRule -DisplayName $rule.Name | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Protocol $rule.Protocol -LocalPort $rule.Port -LocalAddress $LanAddress -InterfaceAlias $InterfaceAlias -Profile Any -RemoteAddress LocalSubnet
        } else {
            New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow -Protocol $rule.Protocol -LocalPort $rule.Port -LocalAddress $LanAddress -InterfaceAlias $InterfaceAlias -Profile Any -RemoteAddress LocalSubnet | Out-Null
        }
    }
    'Demo firewall rules enabled.' | Set-Content (Join-Path $PSScriptRoot '../artifacts/private/firewall-setup.txt')
} catch {
    $_ | Out-String | Set-Content (Join-Path $PSScriptRoot '../artifacts/private/firewall-setup.txt')
    exit 1
}
