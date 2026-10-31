# Same-Wi-Fi demo

One Windows laptop runs the SFU; other laptops/phones use their browsers. The project owner confirmed a working call between a Windows laptop and MacBook on October 31, 2026. This confirms basic functionality for that setup, not measured latency, quality or device capacity. Start with two devices, H.264, and headphones to avoid feedback.

## 1. Find the server address

Run `ipconfig` and find the IPv4 address of the connected Wi-Fi adapter, for example `192.168.1.42`. All devices must be on a network that permits communication between clients; guest/campus Wi-Fi may isolate devices. Use a personal router or hotspot if needed.

## 2. Create and trust HTTPS certificates

Install mkcert using its official instructions: https://github.com/FiloSottile/mkcert#installation. In PowerShell, from `app`, substitute your actual Wi-Fi IP:

```powershell
mkcert -install
New-Item -ItemType Directory -Force certs
mkcert -cert-file certs/lan.pem -key-file certs/lan-key.pem 192.168.1.42 localhost 127.0.0.1
mkcert -CAROOT
```

Install and trust **only `rootCA.pem`** from that last directory on each participating device. On another Windows laptop, import it into the current user's Trusted Root Certification Authorities. For phones, follow the mkcert mobile-device instructions; iOS also requires enabling full trust in Certificate Trust Settings. Restart the browser. The demo URL must open without a certificate warning before testing camera/microphone access. Never distribute `rootCA-key.pem` or `lan-key.pem`. Do not commit certificates or keys. Remove the demo CA from devices when finished if no longer needed.

If the laptop's Wi-Fi address changes, regenerate the server certificate for the new IP and restart the server.

On a MacBook, import the public CA into the login keychain in Keychain Access, double-click it, expand Trust and set Secure Sockets Layer (SSL) to Always Trust. Authenticate in the macOS dialog, then restart Safari or Chrome. See [Apple's certificate trust instructions](https://support.apple.com/guide/keychain-access/change-the-trust-settings-of-a-certificate-kyca11871/mac). Only the Windows host needs Node and the server; other devices need a browser.

## 3. Allow the two ports

On a trusted Private Windows network, run the following once in an Administrator PowerShell. These rules accept only local-subnet traffic on the Private profile:

```powershell
New-NetFirewallRule -DisplayName 'FYP LAN HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3443 -Profile Private -RemoteAddress LocalSubnet
New-NetFirewallRule -DisplayName 'FYP LAN media UDP' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 40001 -Profile Private -RemoteAddress LocalSubnet
New-NetFirewallRule -DisplayName 'FYP LAN media TCP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 40001 -Profile Private -RemoteAddress LocalSubnet
```

## 4. Start and rehearse

If the Wi-Fi is classified Public, the optional `scripts/enable-demo-firewall.ps1` helper supports it without changing the network profile. From an Administrator PowerShell run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/enable-demo-firewall.ps1 -LanAddress 192.168.1.42`. It limits access to that address, the Wi-Fi interface and the local subnet on all profiles. Rerun with the new address after an IP change. Remove its rules with `Remove-NetFirewallRule -DisplayName 'FYP LAN HTTPS WiFi', 'FYP LAN media UDP WiFi', 'FYP LAN media TCP WiFi'` when finished.

From `app` in a normal PowerShell:

```powershell
.\scripts\start-lan.ps1 -LanAddress 192.168.1.42
```

If Windows blocks scripts, use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-lan.ps1 -LanAddress 192.168.1.42`. This applies only to that PowerShell process.

The launcher builds the client and uses HTTPS port 3443 and media port 40001, separate from the existing localhost demo. On every device, including the host, open `https://192.168.1.42:3443`, choose H.264, enter the same room name, and join. Allow camera/microphone permission. Keep the host terminal open.

Verify two-way audible speech and moving camera video, chat, mute/unmute, camera pause/resume, and leaving/rejoining. Then add the remaining devices and rehearse for the expected demo duration. Export telemetry before leaving. Synthetic media is useful for diagnosis but does not validate real cameras or audible speech.

If the page cannot load, check the IP, firewall profile, and Wi-Fi client isolation. If it loads but media fails, check media port rules and the announced IP. Camera permission failures usually need certificate trust or device permission checks. No router port forwarding is required for this LAN setup. The prototype has no authentication; run it only for the supervised local demo.

To remove the demo firewall rules afterward, in Administrator PowerShell:

```powershell
Remove-NetFirewallRule -DisplayName 'FYP LAN HTTPS', 'FYP LAN media UDP', 'FYP LAN media TCP'
```
