# Server transcription prototype

The Node meeting server forwards each consenting browser's microphone as mono
16kHz PCM WAV to a private faster-whisper service on the **same Dubai server**.
No speech model runs in the browser. Screen audio is excluded. Authenticated
meeting identities supply speaker labels; these do not identify other people
speaking near the same microphone. Audio exists in memory only; no audio or
transcript database is created. Participants receive the text and can export it.

## Local Windows microphone test

From the `app` folder, first install once:

```powershell
python -m venv .venv-speech
.\.venv-speech\Scripts\python.exe -m pip install -r speech/requirements.txt
```

Start a separate local meeting server and the real CPU recognizer:

```powershell
powershell -ExecutionPolicy Bypass -File speech/run-local.ps1
```

This uses the multilingual `base` model for a lightweight local check. Its first
launch downloads model weights; check `http://127.0.0.1:8765/health` before testing.
Use `-Model small` to compare a larger model after stopping the first test.
Local tests use four CPU threads; override with `-CpuThreads 2` if needed.
The launcher prints the process IDs and exact stop command. Logs and separate
test accounts live under ignored `data/transcription-local/`; `.env` is unchanged.

1. Open `http://127.0.0.1:3198` in Chrome and create a test account. A guest
   cannot create a room or request transcription.
2. Create a room and join, allowing microphone and camera access. Leave
   **Synthetic test media** unchecked; it produces a tone, not speech.
3. Choose **Request transcription & agree**. With only you in the room, capture
   starts immediately. Speak English, Arabic, then switch within a sentence.
4. Choose your speech language: Arabic + English automatically compares only those
   two languages; Arabic or English pins the decoder for a single-language test.
5. Stop and wait for **Finishing the remaining speech** to complete, then download
   TXT and SRT. Withdraw consent cancels pending speech immediately instead.
6. For consent testing, open the invitation in an Incognito window, join as a
   guest, and approve the request there too. Use headphones and avoid playing
   the same microphone through speakers.

`scripts/transcription-real.mjs` can additionally feed a supplied spoken WAV
through Chrome's microphone and the actual worker. It requires the local servers
above; set `SPEECH_TEST_WAV` to the WAV path. Its English smoke assertions do not
measure Arabic recognition accuracy. Results are saved under ignored
`data/transcription-test/`.

Local smoke check on November 15, 2026: the multilingual `base` CPU/int8 model
recognized "We are testing the meeting transcription system." through Chrome's
file-backed microphone, the app's AudioWorklet and the actual Python service.
The first matching caption arrived about 7.9 seconds after requesting
transcription; SRT export passed with no browser errors. This is one English
synthetic-voice sample, not a latency benchmark or an Arabic accuracy result.
The real test uncovered a PyAV compatibility issue; the worker now reads the
validated WAV's PCM directly into a normalized float array for inference.

Continuous-speech regression on the same date: the updated queue and speech
segmentation captured all six sentences (82 reference words) of a longer English
sample across six uploads. The normalized transcript matched the complete
reference, with no queue warnings or browser errors, and SRT export passed.
This addresses lost audio while inference is busy; it does not establish Arabic
accuracy. Unit checks cover sample continuity, quiet speech, missing input
channels during silence, cancellation, normal-stop draining and language policy.
The final rerun retained all six sentences live before Stop, with one word
substitution ("planned" became "plan"). No segments or warnings were lost.
An additional reproduced bug discarded valid sentences when model timestamps
extended beyond their clips (8.08s reported for 5.66s of audio). The server now
clamps those timestamps while preserving the recognized text, with regression
coverage for that case.

## Deployment (friend with server access)

From the repository directory on the Linux server:

```sh
python3 -m venv .venv-speech
.venv-speech/bin/python -m pip install -r speech/requirements.txt
WHISPER_MODEL=small WHISPER_DEVICE=cpu WHISPER_COMPUTE_TYPE=int8 \
  WHISPER_CPU_THREADS=2 .venv-speech/bin/python speech/service.py
```

First launch downloads the selected model. The service becomes reachable only
after loading the model. In a second terminal:

```sh
curl http://127.0.0.1:8765/health
```

Set this in the meeting server's private `.env`, then rebuild and restart its
existing service:

```dotenv
TRANSCRIPTION_URL=http://127.0.0.1:8765/transcribe
```

```sh
npm ci
npm run build
sudo systemctl restart fyp-streaming
```

Run the Python command under your service supervisor for persistent use. A
template is provided in `speech/fyp-speech.service`; replace its user and paths,
install it into `/etc/systemd/system`, then enable/start `fyp-speech`.
Keep port 8765 private; do not publish it through your reverse proxy or firewall.
These instructions assume Node and Python run directly on the same host.
The current Docker Compose deployment does not include this worker; container
loopback will not reach the host worker.

`WHISPER_MODEL`, `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE`,
`WHISPER_CPU_THREADS`, and `WHISPER_PORT` configure Python. Start with the
multilingual `small` CPU/int8 configuration as a benchmark, not an accuracy or
latency guarantee. Do not use an English-only `.en` model. If an NVIDIA GPU is
available, evaluate `large-v3` with `cuda` / `float16` after installing compatible
CUDA libraries per [faster-whisper's documentation](https://github.com/SYSTRAN/faster-whisper).
Automatic mode compares Arabic and English language probabilities for each
utterance, then explicitly sets that decoding language with `multilingual=False`
to prevent unrestricted redetection. Within-sentence language switching remains
a model accuracy limitation; larger models need evaluation with real speech.
`WHISPER_BEAM_SIZE` can increase decoding search (default 1 for CPU speed).

## Behavior and current limits

- Owner requests transcription independently of video recording. Everyone must
  agree; decline/withdrawal stops processing and discards pending results. A new
  arrival stops active transcription and requires fresh consent. Requests expire
  after two minutes; sessions end after 30 minutes, matching recording policy.
- The AudioWorklet segments speech on roughly 640ms pauses, with a short lead-in
  and an eight-second cap for continuous speech. Quiet speech uses a lower energy
  threshold; Python VAD rejects silence before attempting language detection.
  There are no speculative word-by-word partial captions yet.
- Browser AudioWorklet requires HTTPS (or localhost). Muting clears the partial
  microphone buffer; capture never stops the call's original microphone track.
- One inference runs globally at a time. Up to 24 requests are buffered in memory
  rather than dropped while busy. Pending segment count and audio duration are
  visible. Slower-than-real-time processing increases caption delay; queue
  overflow and service failures produce persistent warnings. Each running request
  times out after 120 seconds. Sustained overload still needs faster hardware, a
  smaller model or more inference capacity.
- Normal Stop flushes the partial microphone audio from every participant and
  waits for accepted jobs before finishing. A missing upload acknowledgement
  times out after ten seconds with a warning. Consent withdrawal, owner departure,
  new arrivals and room shutdown cancel queued results immediately. A decoder
  already running cannot be interrupted; its result is suppressed after cancel.
- Export contains collected captions, without a second full-recording accuracy
  pass. Eight-second cuts can still split words; we do not promise verbatim
  recognition. Longer mixed Lebanese Arabic/English recordings need evaluation.
- The latest 2,000 segments are held in room/browser memory. TXT and SRT exports
  sort by capture time. New sessions replace the previous transcript. Download
  before closing; room destruction or server restart loses server history.
- Timestamps are approximate browser wall-clock offsets; sync device clocks for
  comparison. Arabic paragraphs use automatic direction. No translation occurs.
- No Dubai deployment has been performed. Local tests include a real CPU model
  with English speech and a fake backend for two-participant consent. Arabic
  accuracy has not been established.

## Acceptance check on Dubai

Local automated checks (the browser check starts its own disposable server and
fake inference endpoint; it does not download or run a model):

```sh
npm run build
npm run test:transcription
npm run test:transcription-ui
```

The browser check uses installed Google Chrome by default; set `BROWSER_CHANNEL`
to another installed Playwright browser channel if necessary.

Use two different signed-in identities and real microphones over HTTPS. Check
that nobody sends audio before both agree, Arabic and English appear with the
correct names, mute prevents transcription, and TXT/SRT preserve both scripts.
Try decline, withdrawal, owner departure, a new arrival, silence, overlapping
speech and an unavailable worker. Compare against a manually transcribed mixed
Lebanese Arabic/English sample; measure caption delay and CPU/RAM during a call.
Revisit model size, buffer boundaries and scheduling based on those measurements.
