# FYP Streaming Lab

Research prototype for the streaming component of the conferencing FYP. It uses browser WebRTC, a mediasoup SFU and Opus, with H.264 single-stream, H.264 two-layer simulcast and VP9 SVC experiment modes. Implementation follows [mediasoup's signaling sequence](https://mediasoup.org/documentation/v3/communication-between-client-and-server/) and [client API](https://mediasoup.org/documentation/v3/mediasoup-client/api/).

Initial measured results: [concise results table](artifacts/SUMMARY.md), [Word report](artifacts/FYP_Streaming_Initial_Evaluation.docx), [per-peer CSV](artifacts/results.csv), and [actual browser screenshots](artifacts/screenshots). Six matched software-video scenarios passed local checks, including eight synthetic browser participants. These are short exploratory trials on one laptop; the [evaluation matrix](evaluation/test-matrix.csv) identifies unverified experiments and unavailable features.

Controlled Linux experiments, when executed, are documented separately in [network results](artifacts/NETWORK_RESULTS.md), with [kernel shaping evidence](artifacts/network) and a [numeric CSV](artifacts/network-results.csv). Check exit codes represent basic media progress, not acceptable delay or perceptual quality.

This is a research prototype. A separate entry page supports email/password accounts, optional Google sign-in, and explicit guest sessions. Meeting names come from the server-side session. Rooms require an invitation or ownership; owners can lock admission, replace invitations and end rooms. Translation and TURN remain separate work. Chat, mic/camera controls, local video pinning, screen sharing, reactions and raised hands are included. Screen annotation (draw and pause over a shared screen) is included; see [Screen drawing](#screen-drawing). Reconnection requires leaving and joining again.

## Run locally

After signing in, `/` opens your homepage with **New meeting**, **Join a meeting**
and private meeting history. The call interface is at `/meeting`; old invitation
URLs continue to work. Leaving or ending a meeting returns everyone affected to
the homepage. Leaving alone keeps the room available to its other participants.

History includes rooms you own and meetings you have joined since this feature
was installed; earlier participant attendance cannot be reconstructed. Account
history persists in the existing private SQLite database. Guest history belongs
to the current guest session. Ended and expired rooms remain listed and cannot
be rejoined. A participant still needs a current invitation link or meeting name
plus invitation code; history does not bypass locks or invitation revocation.

Collected caption downloads remain available on the homepage in the same tab
after leaving, until the next meeting replaces them, sign-out, or tab closure.
This uses temporary browser session storage, not a server transcript archive.
Existing local recording downloads finish before the redirect.

Live Arabic/English transcription runs on each participant's own computer, with
separate unanimous consent, speaker labels and TXT/SRT downloads. Each participant
runs a local Omnilingual ASR service (`omniASR_CTC_300M_v2` by default, `npm run speech`); the page
sends it their microphone's speech segments and sends only the recognized text to the
meeting server, which never receives audio and needs no speech setup. See
[local transcription setup and current limits](speech/README.md).

For different devices on the same Wi-Fi, see [the HTTPS LAN demo setup](LAN-DEMO.md). It includes certificate trust, scoped firewall rules and a launcher. A Windows laptop and MacBook call was confirmed working by the project owner on October 31, 2026; this is a functional check, not a measured multi-device performance trial.

Requires Node.js 22.13+ (built-in SQLite without an experimental CLI flag); installation may download a native mediasoup worker. A compiler/Python toolchain is needed if no prebuilt worker is available. See the [official installation requirements](https://mediasoup.org/documentation/v3/mediasoup/installation/).

```powershell
npm ci
npm run build
npm start
```

Open http://127.0.0.1:3000. Log in, create an account, or choose Guest and enter a name, then use the same room name on each endpoint. Use separate browser profiles or private windows for different identities; tabs in one profile share a session. Invitation links preserve their room and fragment token through the entry page. A bare room name no longer creates or admits someone to a room. For initial automated experiments, select synthetic media, which publishes an animated canvas and quiet tone. Camera/microphone access requires browser permission. The app saves statistics in memory; Export raw telemetry downloads JSON. Export before leaving or closing. Test runs should use fresh tabs so each export covers one session.

Alternatively, start Docker Desktop and run `docker compose up --build`. The supplied Docker configuration binds to localhost only. Access from additional laptops needs a separately configured reachable media address and HTTPS for browser capture; it is not enabled by this local configuration.

## Accounts, Google and guest entry

`/auth` is a separate, replaceable page; the existing meeting page remains the research interface. Email signup asks for a name, email and 12–128 character password. Google sign-in creates an account on first use. Guests choose a name without creating an account. Guests are marked in the participant list. All three paths use an HttpOnly, SameSite=Lax cookie and server-side SQLite session; no session token is stored in browser JavaScript storage. Accounts last seven days per login, guests twelve hours. Sign-out revokes that session and closes its open meeting connections, including other tabs. WebSocket upgrades require a valid session and the same origin; client-supplied names cannot override the session identity.

Passwords use salted scrypt (N=32768, r=8, p=3), and only session-token hashes are stored. Auth requests require same-origin JSON, have payload limits and rate limiting, and password derivation concurrency is bounded. HTTPS uses Secure host-only cookies. Behind a TLS proxy set `APP_ORIGIN` to the exact public origin; forwarded headers alone are not trusted. The rate limiter uses the direct socket IP (a shared proxy is one bucket). These are single-instance controls; multi-instance hosting needs shared rate limiting and a suitable shared database.

Data lives in `data/auth.sqlite` by default (or `AUTH_DB_PATH`). Keep that directory private and persistent. Docker Compose mounts a named `auth-data` volume; do not remove it unless intentionally deleting accounts. Back up a stopped database, or use a consistent SQLite backup including its WAL rather than copying an actively written main file alone. Database files and `.env` are ignored by Git and excluded from the Docker build context.

Email ownership verification, password reset and account linking are not included. Email signup does not prove ownership of an email address. Google accounts are keyed by Google's verified subject ID. An email/password account is never silently linked to Google by matching an email: use the original method if that address is already registered. Google access/refresh tokens are not retained. Room ownership uses the internal user ID, not a display name or unverified email.

### Enable Google on the Dubai server

1. In Google Cloud, create/configure the OAuth consent screen (app name/support contact and audience). While the app is in Testing, add the team as test users as required by Google.
2. Create an OAuth client of type **Web application**. Register the exact redirect URI `https://84-12-183-78.sslip.io/api/auth/google/callback`. For this server-side redirect flow, the callback URI is required; no browser JavaScript client secret or Google API access is needed. If Google will not accept the shared sslip.io domain for your consent configuration, use a domain you control and update both the callback and `APP_ORIGIN`.
3. Copy `.env.example` to `.env` on the server only. Set `APP_ORIGIN`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; restrict the file with `chmod 600 .env`. Do not paste credentials into Git or browser code. `npm start` loads `.env`; services generated by the updated setup script load it via `EnvironmentFile`.
4. For an **existing** systemd service, add `EnvironmentFile=/absolute/path/to/fyp-streaming/.env` under `[Service]` using `sudo systemctl edit fyp-streaming`, then run `sudo systemctl daemon-reload` and `sudo systemctl restart fyp-streaming`. Keep the existing TLS/media variables.
5. For a local Google test, use an allowed localhost callback such as `http://localhost:3000/api/auth/google/callback`, set `APP_ORIGIN=http://localhost:3000`, and open that exact origin. Do not use the deployed APP_ORIGIN during a local HTTP run.

Without Google credentials the page shows Google as unavailable, while email/password and guest entry work. The OAuth flow uses authorization code + PKCE, a browser-bound one-use state, a nonce, and Google's official ID-token verifier (signature, issuer, audience and expiry). See [Google's OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect).

### Validate the entry feature

```sh
npm run test:auth
# With the server running on port 3100:
BASE_URL=http://127.0.0.1:3100 BROWSER_CHANNEL=chrome npm run test:entry
BASE_URL=http://127.0.0.1:3100 BROWSER_CHANNEL=chrome node scripts/meeting-features.mjs
```

`test:auth` uses temporary databases and a mocked Google provider to check credential validation, persistence, expiry, rotation/revocation, CSRF/origin checks, secure cookies, limits, redirects, state/nonce/PKCE and account collisions. `test:entry` uses a real local SFU and browser to check the page, account/guest media and chat, preserved room links, rejected anonymous/cross-origin signaling, identity spoofing, logout across tabs and mobile layout. It creates synthetic test accounts on the target server: use a local/disposable test database. Live Google consent/sign-in is still a manual test requiring your configured OAuth client. The existing smoke and meeting checks now establish guest sessions before joining.

## Protected rooms

Log in to an account, enter a room name and choose **Create room**. Guests join through an invitation; they cannot create or manage rooms. Owners can return through **Your rooms** without an invitation. Duplicate display names never grant ownership.

Use **Copy invitation** to share a link. Its random bearer token is in the URL fragment (after `#invite=`), so it is not sent in normal HTTP request URLs or referrers. The browser sends it over authenticated, same-origin signaling/API requests. Anyone holding a current invitation can join an unlocked room, including as a guest. Keep invitations private. Only token hashes are stored in SQLite, so reopening an owner page requires **New invitation** if the old full link was not saved. That action invalidates previous links for future joins; it leaves existing participants connected.

**Lock room** prevents new non-owner joins while existing calls continue. **End room** closes all participants and permanently disables that room. Rooms and invitations expire seven days after creation. The server checks these rules during admission, independently of UI controls. Ownership and invitation hashes persist in the same private database as accounts; active media/drawings remain in memory.

`npm run test:rooms` checks API permissions, admission, rotation, lock, ending and expiry. With the local SFU running, `BROWSER_CHANNEL=chrome npm run test:room-ui` checks the owner UI, real guest media, rejected forged ownership/missing invitations, locks, replacement links, owner reload and room-end disconnection. Test tools create disposable owner accounts and invitation-protected rooms on the target server.

## Recording with consent

The room owner can choose **Request recording & agree**. This explicitly grants the owner's consent and asks every other connected participant to Allow or Decline. No recorder starts until all current participants approve. A decline or a two-minute consent timeout cancels the request. Everyone sees a recording indicator. Participants can withdraw consent to stop the clip; owners can stop or cancel it.

The owner’s browser records a 1280×720, 15 fps grid of cameras and shared screens, including visible screen annotations/frozen frames, plus a separate mix of microphone and screen audio tracks. The saved grid is independent of local pinning. The call continues through its existing SFU tracks; recording never replaces or stops an original track. Output downloads to the owner's computer (WebM where supported, otherwise a supported MP4 format), with a fallback download link on the page. No recording file is uploaded to or stored on the server. Keep the host page open until the download finishes; download fallback links before closing it.

A new arrival stops the current recording before their media is admitted. The recorder also filters its video/audio sources to the explicitly approved peer IDs, so a newly arrived participant cannot enter that clip. Start a new consent request to include them. Host departure, session loss or room ending stops the recorder; an encoding/capture failure resets the recording indicator and leaves the call connected. A clip has a 30-minute server limit and a 200 MB local buffer limit. Longer meetings require another consented clip. Keep the host tab active: background throttling, host CPU load, browser support and tab closure affect browser recording. This is local browser recording, not a persistent server-side recorder.

`npm run test:recording-policy` checks consent quorum, stale requests, role restrictions, withdrawal, joining/leaving, failure and timers. With the local SFU running, `BROWSER_CHANNEL=chrome npm run test:recording` exercises consent UI, forged control rejection, playable video/audio output, screen sharing, withdrawal, new arrivals, host departure and recorder fault injection. Its media files stay under ignored `artifacts/private/`. These are functional synthetic tests, not a real-device quality or latency claim.

## Screen audio

Screen sound is a separate Opus producer associated with its screen video; microphone and screen audio have independent lifecycles. The server rejects screen audio without a screen and removes that sound when its screen closes. Audio-level speaker highlighting observes microphones only. `BROWSER_CHANNEL=chrome npm run test:screen-audio` uses generated display video/audio to verify receiver sound, microphone independence, the off option, source end and cleanup. Native screen/tab selection and real system audio still require checks on the demo devices.

## Audio processing

The meeting page has an **Audio processing** panel with a mode selector and two switches, **Echo cancellation** and **Noise suppression**. It applies to your microphone only; screen-share sound is always sent unchanged. **Audio info** opens a short explainer with a link to the test page.

| Mode | `echoCancellation` | `noiseSuppression` | `autoGainControl` | Processing |
| --- | --- | --- | --- | --- |
| Off (raw) | false | false | false | none: the baseline |
| Browser (built-in) | echo switch | noise switch | true | the browser's own (in Chrome/Edge: WebRTC AEC3, NS, AGC); both switches on = the previous app behaviour and the default |
| Ours | false | false | false | DTLN-aec 128 (if echo is on), then DeepFilterNet3 (if noise is on), on this device |

**Switching.** Every change captures a new microphone track for the requested mode (Ours also builds a new pipeline). It swaps that track into the existing mediasoup producer with `producer.replaceTrack`, then stops the old track and pipeline. The producer, consumers and call stay up; mute state carries over. The microphone producer uses `stopTracks: false` because the panel owns these tracks. After every change the panel shows what `track.getSettings()` actually reports for the three properties. For Ours it shows the raw capture feeding the pipeline. If the browser ignored a request, the panel says so. Chrome can give a new capture the processing of a capture of the same microphone that is still open. When the read-back shows that, the panel releases its old capture and captures once more, which causes a short gap in your sent audio but not in the call. If a mode cannot start (missing model file, no AudioWorklet or WebAssembly, a model that fails to load), the panel shows the reason and the previous mode stays active. If it had to release the old capture, it reopens it in the previous mode. Joining is the one exception, because there is no previous mode yet: if a saved Ours choice cannot start at join, the panel says so and uses Browser until you choose again. The choice is saved in `localStorage` (`audio-processing`). Mode changes are also recorded in the exported telemetry (`audioProcessing` events and `metadata.audioProcessing`). Live transcription and local recording follow the swapped track. With **Synthetic test media**, browser constraints do not apply to the generated tone (the panel says so). Ours still processes it.

**Ours pipeline.** `client/audio/` holds the code: `controller.js` (panel), `pipeline.js` (Web Audio graph), `worklet.js` (AudioWorklet), `worker.js` (models), `engine.js` (the chain), `dtln-aec.js`, `deepfilter.js`, `playout.js`, `dsp.js`, `modes.js`.

```
raw mic (all browser processing off) ─► AudioWorklet ⇄ Worker [48k→16k ─► DTLN-aec 128 ─► 16k→48k ─► DeepFilterNet3 48k] ─► MediaStreamAudioDestinationNode ─► producer
remote participants' audio ─► Web Audio ─┬─► speakers
                                         └─► far-end reference bus ─► 48k→16k ─► delay line ─► DTLN-aec (second input)
your shared tab's sound (played by that tab) ─► far-end reference bus only
```

- **Far-end reference.** With Ours and echo cancellation on, remote audio is played through Web Audio instead of the `<audio>` elements. The elements stay attached but muted, because Chrome only feeds remote WebRTC audio to Web Audio while it is attached to an element. The same samples go to the speakers and to the echo canceller. The sound of a tab you share is added to the reference only, because that tab already plays it locally. Other modes play remote audio exactly as before.
- **Playout latency compensation.** The reference is tapped before playout, so its echo reaches the microphone later. The reference is first delayed by the browser-reported `baseLatency + outputLatency` plus the capture latency. Once far-end audio is playing, the worker measures the real echo path (GCC-PHAT between reference and microphone, once a second). After three consistent estimates it delays the reference so that it leads its echo by 4 ms (maximum 400 ms). The panel shows the delay in use and where it came from.
- **Sample rates.** The AudioContext, the sent track and Opus stay at 48 kHz. DTLN-aec exists only at 16 kHz, so the echo stage resamples explicitly by a factor of 3 with a 96-tap Kaiser-windowed sinc low-pass (cut-off 7.2 kHz, 47.5-sample group delay at 48 kHz in each direction). With echo cancellation on, your voice is therefore limited to below 8 kHz. DeepFilterNet3 runs natively at 48 kHz.
- **Latency.** The panel reports the added latency as two measured parts. *Model + resampling* is the delay between the chain's input and output streams, found by cross-correlation on live audio, so it needs speech. *Buffering* comes from counting samples in and out of the worklet (framing, worker round trip, output buffer). DTLN-aec's 24 ms (its 512-sample window minus the 128-sample hop) is part of the first figure. The Web Audio hops into and out of the graph are not visible from inside; the test page measures the full track-to-track delay. If the device cannot keep up, the worklet drops the oldest audio, counts it and the panel reports it.

### Setting up the models

```sh
npm ci
npm run build          # bundles client/audio and copies the LiteRT.js runtime to public/audio/vendor/litert/
npm run audio:models   # model files into public/audio/models/, each checked against a pinned SHA-256
```

Generated files under `public/audio/` are ignored by Git. The Docker image runs both steps.

The model weights come from the official repositories. DeepFilterNet also needs a WebAssembly build of libDF, its Rust runtime. The project publishes the source for one (libDF's `wasm` feature) but no prebuilt binary. `npm run audio:models` therefore installs the libDF build shipped in `@workadventure/noise-suppression` 0.2.0 (MIT package; libDF MIT OR Apache-2.0).

- **Checks:** the script verifies the npm integrity value and the binary's SHA-256 (`8ebf2b21…7fe708`). It only accepts a file that exports libDF's `df_create`, `df_get_frame_length` and `df_process_frame`.
- **Provenance:** according to that package, the binary is DeepFilterNet commit `d375b2d` patched to tract 0.23.8 for WebAssembly SIMD. It is a third-party build that this project has not rebuilt from source. The DeepFilterNet3 model shipped with it is byte-identical to the official one, and the binary can only call the four functions our glue hands it.
- **Building your own instead** (needs Rust, the `wasm32-unknown-unknown` target and `wasm-pack`): in a DeepFilterNet checkout run `wasm-pack build libDF --target web --features wasm`, then `node scripts/audio-models.mjs --deepfilter-wasm=/path/to/DeepFilterNet/libDF/pkg/df_bg.wasm`. Untested here: WorkAdventure reports that upstream tract 0.21.x has no WebAssembly SIMD kernels, and that 0.21.5/0.21.6 fail to load DeepFilterNet3.
- **Without libDF** (`node scripts/audio-models.mjs` alone), Ours with noise suppression on reports that the build is missing; echo cancellation still works.

DeepFilterNet3 runs with libDF's default attenuation limit (none). `client/audio/deepfilter.js` is a minimal replacement for wasm-bindgen's JS glue.

### Test page

Open `/audio-test` (signed in, like the meeting) or follow the link in **Audio info**. Use Chrome or Edge, the same microphone and position for every mode, and keep the speaker volume fixed. All audio stays in the browser. The only upload is the recognition check, which says what it sends before you press it.

1. **A/B recording:** one take per mode of the on-screen script, with a 3-second silent lead-in. Clips play back side by side with level meters and a level graph, and download as WAV. Tick *Play a noise clip* for the noise test (generated pink noise played through the speakers but kept out of the echo reference), or record in your own noisy room. The speech-to-noise estimate compares speech frames with the lead-in noise.
2. **Echo test (speakers, not headphones):** a generated speech-like clip goes through a local WebRTC loopback and plays like a remote participant (routed into the echo canceller for Ours, exactly as in a meeting) while you stay silent. It reports the residual echo level, the reduction below the Off run, and the in-run ERLE where an unprocessed copy was captured at the same time (always for Ours; for Browser only if the browser allows a parallel raw capture). Results are marked invalid unless the Off recording actually correlates with the played clip and is at least 10 dB above the room noise.
3. **Recognition check:** each take is cut into speech segments exactly as live transcription does (16 kHz averaging plus `public/speech-buffer.js`). The segments go to the speech service on the tester's own computer (`npm run speech`), the recognizer live transcription uses, with the English hint `eng_Latn`; nothing is uploaded to the meeting server. The page shows the word error rate against the script. If the local service is not running or not ready, the page says why and that the result was not measured.
4. **Results table:** settings read back, speech level, speech-to-noise, residual echo/ERLE, WER, processing time per frame, CPU (worker busy share of real time; Compute Pressure state where the browser offers it) and added latency (track to track against the raw microphone). Anything not measurable says why; published model figures are never used to fill gaps. *Download results* saves the table as JSON.

### Validation

`npm test` (52 tests) includes `tests/audio-dsp.test.mjs` and `tests/audio-modes.test.mjs`. They cover the FFT, resampling (pass band, alias rejection, chunk-size independence), delay estimation, DTLN-aec framing and its 384-sample delay, measured chain delay and reference alignment, speech-to-noise, WER, mode constraints, saved preferences, settings read-back and the test page's local speech service settings. `npm run test:audio-ui` (`scripts/audio-processing.mjs`, Chrome by default, `BROWSER_CHANNEL=msedge` for Edge) runs against a local server on port 3100. It uses Chrome's fake devices with output muted. Set `SPEECH_TEST_WAV` to a spoken 48 kHz WAV for the speech checks; add `NOISE_DB=10` to feed the fake microphone that speech plus pink noise. Its three parts:

- An offline check through the real worker: the official DTLN-aec sample recordings, and (with `SPEECH_TEST_WAV`) DeepFilterNet3 on that speech plus pink noise at 5 dB SNR.
- Live switching in a two-participant call, with the read-back checked after every switch and the other participant's received audio checked to keep flowing from the same consumer.
- The test page.

Results so far (November 16, 2026, this Mac, Chrome 157 headless, fake devices; speech is a macOS `say` reading of the test script):

- **DTLN-aec 128 offline** on the repository's samples: far-end single talk reduced by 31.5 dB; near-end single talk kept (0.4 dB level change, correlation 0.974 with the input); double talk changed by 0.7 dB. Measured chain delay 26 ms (24 ms model plus two resampling filters); 0.30 ms per 8 ms block offline.
- **DeepFilterNet3 offline**, that speech plus pink noise at 5 dB SNR: noise between words −21.2 → −53.5 dBFS (32 dB removed); SI-SNR against the clean speech 5.6 → 15.0 dB; measured delay 30 ms; 0.28 ms per 10 ms frame. Both stages on the far-end sample: output −96.5 dBFS (echo and residual removed).
- **Live call:** every switch (Browser → Off → Ours echo only → Ours echo + noise → Ours with both stages off → Browser without echo/noise → muted switch → Browser; in an earlier run without libDF, a failed switch to Ours with noise suppression kept Off and showed why) kept the same producer and consumer, and the other participant kept receiving non-silent audio. The read-back matched the request after each switch. Twice Chrome first returned the previous capture's settings for a new Browser capture, and the automatic re-capture fixed it (`audioProcessingRecapture` events). With echo only, Ours added 42–55 ms in the call (26 ms model + resampling, 16–29 ms buffering) at about 1 ms per 8 ms block and 15–20 % worker busy time. With both stages it ran at 0.8 ms per AEC block and 0.9 ms per DeepFilterNet3 frame, 20–22 % worker busy time.
- **Test page, clean speech, Ours echo only:** track-to-track added latency 2.7 ms for Browser and 58–68 ms for Ours. WER through the local faster-whisper `base` worker was 0 % for all three modes in the last run. An earlier run gave 2.6 % for Browser and Ours ("clear" heard as "clean"), so single takes are noisy.
- **Test page, speech + pink noise at 10 dB SNR, Ours echo + noise:**

  | | Off | Browser | Ours |
  | --- | --- | --- | --- |
  | Speech-to-noise estimate | 11.7 dB | 21 dB | lead-in noise (−24.7 dBFS raw) removed to below −100 dBFS |
  | WER | 2.6 % | 0 % | 5.3 % ("voice" → "goals", "clear" → "clean") |
  | Added latency (track to track) | reference | 4.3 ms in one run, not alignable in another | 113–123 ms (56 ms models + resampling, 27–37 ms buffering, the rest Web Audio hops) |

  Two runs on identical input gave the same WER. This is one synthetic voice and one recognizer, so it is not evidence about DeepFilterNet3 in general, but it is the recognition risk the info tab warns about.
- **Echo test:** with a file as the microphone, no played sound can reach it, and the test correctly reported no valid result.

These are functional checks with synthetic audio, not quality results. Not yet verified: a real microphone and speakers (acoustic echo, real room noise, the echo-path estimate), listening quality, Edge, Firefox/Safari, mobile, slow machines, and multi-device calls.

### Licences

| Component | Pinned to | Licence | How it is used |
| --- | --- | --- | --- |
| DTLN-aec 128 model (`breizhn/DTLN-aec`, Westhausen & Meyer) | commit `9d24e12`, SHA-256 checked | MIT (`public/audio/models/LICENSES/`) | downloaded by `npm run audio:models` |
| DeepFilterNet3 model (`Rikorose/DeepFilterNet`, `DeepFilterNet3_onnx.tar.gz`) | commit `7b14b89`, SHA-256 `c94d91f7…` | MIT OR Apache-2.0 | downloaded by `npm run audio:models` |
| libDF WebAssembly build (DeepFilterNet) | `@workadventure/noise-suppression` 0.2.0, npm integrity + SHA-256 `8ebf2b21…` | MIT OR Apache-2.0 (WorkAdventure package: MIT) | installed by `npm run audio:models`; third-party build, see above |
| LiteRT.js (`@litertjs/core`, `@litertjs/wasm-utils`) | 2.6.0 | Apache-2.0 | npm dependency; runs the DTLN-aec TF-lite files in a Worker |
| DTLN-aec sample recordings (from the AEC Challenge) | commit `9d24e12` | not stated in the DTLN-aec repository | downloaded only by `scripts/audio-processing.mjs` into ignored `data/audio-test/`; not redistributed; check the AEC Challenge data terms before publishing results based on them |

The far-end and noise clips on the test page are generated in code (`client/audio-test/signals.js`) and carry no third-party licence. The model figures quoted in **Audio info** are reported results from the literature, not measurements by this project.

### Known limits

- With both stages on, Ours added 113–123 ms track to track on this Mac, a large share of the guide's sub-200 ms original-audio target. Most of it is the models (24 ms DTLN-aec + 30 ms DeepFilterNet3 + 2 ms resampling); the rest is worklet/worker buffering and Web Audio hops. Running the models inside the AudioWorklet, as WorkAdventure does, would remove most of the worker buffering. This has not been tried.
- DeepFilterNet3 uses libDF's default (unlimited) attenuation, so noise between words goes to digital silence. WorkAdventure reports that listeners hear this as dropouts and a metallic background; a limit (for example 25 dB) is not configured here.
- The DeepFilterNet3 runtime is a third-party libDF build (above).
- Echo cancellation in Ours narrows your voice to below 8 kHz; Ours has no automatic gain control, so levels differ from Browser mode.
- The far-end reference only contains audio this page plays. Sound from other apps or tabs (other than a shared tab) is not cancelled by Ours.
- Echo-path measurement needs far-end speech; until then the reference uses the browser-reported latency. Very long echo paths (over 400 ms) are not compensated.
- Worker round trips and the output buffer add about 15–37 ms of buffering on top of the models.
- The test page uses one English script; Arabic recognition is not covered. One take per mode gives noisy WER and speech-to-noise figures; repeat takes before drawing conclusions.
- Browser mode's own processing cost is not measurable from a web page. The worker's busy share excludes the AudioWorklet and Web Audio graph.

## Active speaker

Microphone RTP audio levels drive a green camera-tile outline and a Speaking label in the participant list. No speech recognition or AI is used. Muting, silence and departure clear the indicator; pinning stays local and is not changed by speaker events. Only microphone producers are observed, so screen sound does not count as a person speaking. `BROWSER_CHANNEL=chrome npm run test:speaker` exercises switching, silence, camera-off speaking and cleanup using synthetic microphone audio over the real SFU.

## Shared whiteboard

After joining a meeting, choose **Whiteboard** to open a shared blank canvas.
The microphone, camera and call remain connected. **Show to everyone** opens
this board for all current participants and subsequent arrivals. Participants
can close their own panel without clearing the board or leaving the call.

Everyone can use pencil, marker, translucent highlighter, line, arrow, rectangle
and ellipse tools, a custom color and four thicknesses. Pencil and marker use
solid ink. Finished strokes stay visible locally while awaiting server
confirmation; rejected submissions display an error. Hold Shift while drawing
a rectangle or ellipse for a square or circle. Mouse, pen and touch are supported.
Drawings and erasures are shared when the pointer is released. Escape cancels
an unfinished gesture.

**Eraser** removes only the portions you drag over, including portions of shapes
and other participants' drawings. The size selector controls its width. Erasures
are stored in the shared history, so **Undo my last drawing / erasure** restores
your latest erasure or removes your latest drawing from this connection. New ink
can be drawn over previously erased areas. Only the owner can **Clear board**,
after confirmation. Late arrivals get the current drawing and erasure history.
**Download PNG** saves the visible board with a white background.

The board is held in memory until the last participant leaves or the server
restarts. It is separate from screen annotations and is not included in the
camera/screen recording grid. Boards are limited to 600 drawing/erasing gestures
and 50,000 points.

Validation: `npm run build` and all 36 unit tests (`npm test`) passed. Run
`npm run test:whiteboard-ui` for the isolated four-browser WebSocket integration
check (installed Chrome by default; override `BROWSER_CHANNEL` if needed). It
checks shared ink, partial erasing, undo, late arrivals, presentation, room
isolation, hidden-panel updates, PNG download and owner-only clearing. The
single-user preview also passed pen visibility with a simulated 600 ms delay.
The isolated check runs the actual whiteboard client and policy, but does not
start the meeting server or mediasoup. Full audio/video meeting verification
remains pending because the native worker could not build on the local Mac.

Before merging/deploying, use a machine with a working meeting-server setup:
create a room, join from separate owner/guest browser profiles with audio/video,
choose **Show to everyone**, draw and partially erase from both profiles, undo,
and join a third participant to check the restored board. Verify camera, audio,
chat and screen sharing continue, then test closing the board and leaving.
Rebuild the frontend and restart the server together when deploying this change.

## Screen drawing

Marks are drawn on a layer over the **video** of a shared screen and relayed through the server as coordinates (0..1 of the picture), so every viewer sees them in the same place whatever their window size.

- **Toolbar.** While you share, a toolbar appears at the right edge: draw (pen), pop out, pause/resume, pen color and size, undo, clear. Esc stops drawing. Only the sharer draws; marks are removed when the share stops. Late joiners receive the current marks and pause state.
- **Draw over your whole screen and any app (screen pen).** On a Mac or Windows PC, `npm start` starts it with the server (first run installs it; `SCREEN_PEN=0` turns it off). If you use a deployed server instead, run `npm run overlay` on the computer you present from. Then share your **Entire screen**: the pen button now draws directly on your screen, over any window, and a small toolbar appears at the right edge of your screen (pen, pause, colors, undo, clear). Cmd/Ctrl+Shift+D toggles the pen, Esc stops. It opens and closes with your share. What you draw goes through the page like any other mark, so pause, undo, clear and late joiners behave the same. The screen pen asks to be left out of screen capture, so viewers get the marks only through the page layer.
- **Without the screen pen (pop-out, Chrome/Edge 116+).** The pop-out button opens an always-on-top window with a live preview of your shared screen plus the toolbar; draw on that preview while you are on other pages or apps. If you share your entire screen, the pop-out shows up inside the share as a small mirrored preview.
- **Pause.** Viewers see a still of your screen: the exact frame you paused on, sent with the pause, so late joiners see the same picture. Your own screen stays live. The drawing layer is separate from the picture, so marks keep reaching viewers live while paused, and undo/clear do not resume the share. Resume shows your live screen again and keeps the marks.

Status: verified with scripted end-to-end runs (real server, Chrome 156, a fake "Entire screen" capture, the real screen-pen app with synthetic pen input) covering drawing, pause, drawing while paused, undo, clear, late joiners, pop-out and resume. Not yet verified: drawing with a real mouse on the screen pen, whether Chrome's real screen capture honours the pen's capture exclusion (if not, viewers see each mark twice in the same place), multi-device use. Limits: the screen pen covers the primary display only and needs an Entire-screen share; no eraser; "only the sharer can draw or clear" is enforced by the page, not the server (pause is server-enforced).

## Automated local measurements

```powershell
npx playwright install chromium
npm run test:smoke
python scripts/report.py
```

The server must already be running. Environment variables `PARTICIPANTS` (2/4/6/8), `MODE` (h264/simulcast/vp9) and `DURATION` (seconds) select a scenario. Tests check remote track counts, received audio bytes, decoded video, mute/camera state, chat delivery and leave cleanup. They do not establish intelligibility, camera quality or microphone-to-speaker latency.

For Edge, set `$env:BROWSER_CHANNEL='msedge'` before testing. The matched local load trials use `$env:SOFTWARE_VIDEO='1'` and `$env:PROFILE='windows-software-video'`: this disables accelerated video encode/decode and GPU rendering for the synthetic benchmark. Larger accelerated headless runs stalled on this laptop and are retained as diagnostic results. Browser arguments and synthetic source type are recorded per run. These settings apply to automated tests, not to normal visitors using their cameras.

One-second browser statistics and SFU worker/process/transport counters are saved under `artifacts/raw/<run-id>`, with a manifest identifying mode, browser, commit, duration, checks and limitations. Screenshots go under `artifacts/screenshots`; the report script creates a CSV and Markdown table from saved measurements. Missing metrics stay empty. The reported bitrate uses RTP payload counters, not full network-interface egress. ICE RTT is not mouth-to-ear latency.

Counter definitions follow the [W3C WebRTC Statistics API](https://www.w3.org/TR/webrtc-stats/). Jitter-buffer delay and concealment metrics describe receiver behavior; they do not replace calibrated microphone-to-speaker measurements.

Raw files are ignored by Git because they may contain IP addresses and other connection metadata. Publish only reviewed synthetic-test artifacts and summaries. Use repeated trials and fixed reference media for research comparisons. A short smoke run is not evidence for the under-200-ms original-audio target or final eight-device capacity.

Published `artifacts/evidence/*.json.gz` files contain sanitized telemetry. Run `python scripts/restore_evidence.py` and then `python scripts/report.py` to recalculate the tables from a fresh clone. To regenerate charts and the Word document, install `requirements-report.txt` and run `python scripts/plot.py` followed by `python scripts/document.py`.

## Isolated Linux network experiments

After stopping the native local server, use `docker compose -f compose.yaml -f compose.impairment.yaml up --build -d` to give only the lab container permission to shape its network. Then run `node scripts/netem.mjs` from the Windows host with the browser settings above. This is an experiment runner, not an assertion that all profiles have already passed; consult saved manifests.

The runner applies caps, random loss, delay and jitter only to outgoing media on the dedicated container interface. The cap is shared SFU egress, not a per-publisher uplink cap. Delay is one-directional; compare actual measured RTT rather than assuming symmetric delay. It saves shaping configuration and kernel queue/drop counters under `artifacts/network`, and resets the container queue at the end. Windows network settings are not modified. Signaling is excluded from the impairment filter. Network emulation follows the [Linux netem interface](https://man7.org/linux/man-pages/man8/tc-netem.8.html); queueing effects and actual browser statistics must be reported together.

The filter matches TCP/UDP source port 40000, so RTP, RTCP feedback, ICE and DTLS on that media transport share the impairment. HTTP/WebSocket signaling and telemetry use port 3000 and are excluded. The jitter cases use 100 ms base delay with 10/30/60 ms normal-distribution variation settings; these are not hard bounded ranges.

## Evaluation coverage

See `evaluation/test-matrix.csv` for the scenarios derived from the supplied research guide. Impairment tests require Linux network shaping of the actual media route; browser HTTP throttling is insufficient. TURN, real device/browser comparisons, calibrated audio latency, reference-aligned VMAF/SSIM/PSNR, human MOS and optional recorder/AI isolation remain separate experiments.

## Meeting controls

Choose your name at signup or guest entry. The meeting uses that session's name (up to 40 characters) on camera/shared-screen tiles and in chat; it cannot be changed by editing the meeting-page input. Guest sessions are explicitly labelled in the participant list. Display names are not unique and do not confer host permissions.

Click **Pin** on a video to enlarge it in the centered stage above the other videos. Click **Unpin** to return to the grid. Pinning affects only your own view, and a departing or stopped pinned track returns your view to the grid.

Click **Share screen** and choose a tab, window or display in the browser picker. Your camera and microphone remain available, and other participants receive the screen as a separate named video tile. Multiple people may share at once. Click **Stop sharing**, use the browser's stop control, or leave the meeting to end a share. The Include screen sound option requests audio too. Choose a browser tab and enable Share tab audio in the picker when available. Browser/OS/source support varies; if no audio track is returned, video sharing continues with a clear video-only message. Microphone mute does not mute shared sound. Stopping screen sharing removes both tracks, while an audio-only end leaves screen video running. Display capture requires HTTPS (or localhost), a supporting desktop browser and any OS screen-recording permission.

Run `node scripts/meeting-features.mjs` against the updated server (default `http://127.0.0.1:3100`, override with `BASE_URL`) for the three-participant feature check using Edge. It substitutes a generated display stream to verify media publication, reception and lifecycle; manually check the browser picker and real screen contents on the demo devices. The existing smoke script also accepts `BASE_URL`.

Muted microphones show a muted icon and text beside the participant name on camera/screen tiles and in the participant list. **Raise hand** keeps a hand indicator visible to the room until you click **Lower hand** or leave. Late joiners receive the current mute and hand states. Thumbs up, heart and laugh buttons display a named reaction to everyone for four seconds; reactions do not persist or replay to late joiners.
