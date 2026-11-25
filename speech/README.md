# Local transcription (Omnilingual ASR)

Live transcription runs on **each participant's own computer**. The meeting page cuts
the microphone into speech windows (AudioWorklet, mono 16 kHz; see **Windows** below) and sends
them over loopback to a local speech service, `speech/service.py`. The service runs
Meta's [Omnilingual ASR](https://github.com/facebookresearch/omnilingual-asr) model
`omniASR_LLM_1B_v2` by default (an 8.5 GiB download). The page then sends **only the recognized text** to the meeting
server. The server checks consent, stamps the authenticated speaker name and shares the
text with the room. No audio reaches the meeting server, and the server needs no speech
setup.

Captions appear once your own computer has recognized a window, so about every 3 s during
continuous speech. The default LLM 1B model, like LLM 300M (same text decoder), writes the text
one character at a time (about 48 ms per character). On an Apple M4 MacBook Air a fully spoken
4-second window took about 3.6 s on its own (LLM 300M: 3.4 s, and 5–6 s during a live meeting in
Chrome). Each window brings 3 s of new speech, so that is slower than real time: during continuous
speech the captions fall further and further behind and catch up in pauses, and the transcript
pane says how much audio is still waiting. The MacBook Air has no fan and slows down after a few
minutes of this.

## Install (once per computer)

Requirements:
- macOS on Apple silicon, or Linux. Windows has no fairseq2 build, so run the service
  inside WSL2 (Ubuntu) with the Linux steps. WSL forwards `127.0.0.1:8765` to Windows
  (not tested here).
- Python 3.11 or 3.10. omnilingual-asr 0.2.0 declares `<=3.12`, and pip reads that as
  excluding 3.12.1 and later.
- About 11 GB of disk for the Python packages and the default model (see **Models** for the
  others).

```sh
npm run speech:install
```

This creates `.venv-omniasr/` (git-ignored) and installs `speech/requirements.txt`.
Use `PYTHON=/path/to/python3.11 npm run speech:install` if Python 3.11 is not on your PATH.

## Start

```sh
npm run speech
```

The service listens on `http://127.0.0.1:8765` (this computer only). The first start
downloads the model (8.5 GiB for the default) from `dl.fbaipublicfiles.com` into
`~/.cache/fairseq2/assets/`. Later starts only load it. `/health` reports `loading`, then
`ready`. Until it is ready the meeting page says so and does not let you start or agree
to transcription.

**Deployed meeting site:** pages on `localhost`/`127.0.0.1` are always allowed. Any other
site must be named, because the service refuses requests from other websites:

```sh
npm run speech -- --allow-origin https://your-meeting-site.example
```

The meeting page prints this exact command, with its own address, when the service
refuses it. Chrome may also ask once for permission to reach apps on this device; allow
it. Use Chrome, Edge or Firefox.

Options (flags or environment variables):

| Flag | Env | Default |
| --- | --- | --- |
| `--device` | `SPEECH_DEVICE` | `auto`: CUDA, else Apple GPU (`mps`), else CPU |
| `--dtype` | `SPEECH_DTYPE` | `auto`: bfloat16 on CUDA, float16 on `mps`, float32 on CPU |
| `--model` | `SPEECH_MODEL` | `omniASR_LLM_1B_v2` |
| `--port` | `SPEECH_PORT` | `8765` (pages look there unless the meeting server sets `LOCAL_SPEECH_URL`) |
| `--allow-origin` | `SPEECH_ALLOWED_ORIGINS` (comma-separated) | none |

## Models

| Model | Download | Language choice |
| --- | --- | --- |
| `omniASR_CTC_300M_v2` | 1.21 GiB | ignored: the model detects the language itself |
| `omniASR_CTC_1B_v2` | 3.63 GiB | ignored |
| `omniASR_LLM_300M_v2` | 6.08 GiB | used |
| `omniASR_LLM_1B_v2` (default) | 8.49 GiB | used |

Choose another one with `npm run speech -- --model omniASR_LLM_300M_v2`. LLM 300M is 2.4 GiB
smaller and about 3% faster, with the same text decoder; on an M4 MacBook Air neither LLM model
keeps up with continuous speech. CTC models are much faster but ignore the language choice. The first start with a new model downloads it. fairseq2's downloader can
stall on slow connections without timing out; if the progress bar stops moving, stop
the service and start it again (this restarts that download from zero).

## Languages

Each participant picks their language in the lobby (**My language**) or the transcript
pane (**My speech language**); the two stay in sync. The choice only matters with an
LLM model, such as the default. CTC models ignore it, and the transcript pane says so. With an LLM
model, the choice is passed to the recognizer as an Omnilingual language code:

- **Arabic + English (mixed)** (no hint): the model chooses the language. Use it for mixed
  Arabic/English speech. Omnilingual recommends a hint when one applies, so check the
  quality on your own speech.
- **Lebanese / Levantine Arabic** `apc_Arab`, **Modern Standard Arabic** `arb_Arab`,
  **English** `eng_Latn`.

On a 22-second recording of formal Arabic made with the macOS Arabic voice, LLM 1B got 31 of 32
words right with any of the three Arabic choices, and so did LLM 300M. Arabic script leaves out
short vowels, so a window of Arabic takes about half as long to write as English (2.4–2.7 s per
4-second window here). Lebanese dialect, real voices and mixed speech have not been measured yet.
See `speech/MODEL-EXPERIMENTS.md`.

## Windows

The page cuts speech into windows of at most 4 s. A pause (0.64 s of quiet after at least 1 s
of speech) closes a window early. Speech that runs on is cut at 4 s, and the next window
starts 1 s before the cut: 0–4 s, 3–7 s, 6–10 s, and so on. A word split by a cut is then heard
whole in one of the two windows. The page holds back each such window's last word, lines up the
next window's text with the end of the previous one and drops the words they share
(`client/transcript-merge.js`), so each word is shown once. Words are compared with Arabic spelling
variants treated as equal; when they still differ, the letters are compared. If nothing lines up,
the page keeps all of the new window's words, because the previous window has most likely left out
the speech at its cut: a word shown twice is better than a word lost.

On the test recording, plain 4-second cuts produced 1.5–4.5% word errors at the cuts
("transcris nsystem"); with the 1-second overlap the joined text had none, the same as
8-second segments. Each window brings 3 s of new speech, so a model must recognize a 4-second
window in under 3 s to keep up: on an M4 MacBook Air LLM 1B takes about 3.6 s and LLM 300M about 3.4 s.
`speech/MODEL-EXPERIMENTS.md` has the measurements.

## What the service does with audio

- It accepts mono 16 kHz 16-bit PCM WAV up to 40 s (the model's limit). The page sends
  at most 4 s per window.
- Silero VAD checks every segment first. A segment with no speech never reaches the
  model, because an LLM decoder given only noise can invent a sentence.
- It recognizes one segment at a time, in memory, and stores nothing. The log records
  durations and processing time only, never audio or text.
- It answers only on loopback, checks the `Host` header (against DNS rebinding) and the
  `Origin` header (allowed sites only), and handles CORS and Private Network Access
  preflights.

## Meeting behaviour and limits

- The owner requests transcription and everyone must agree, as before. Agreeing (or
  starting) first checks that your local service is ready. Decline or withdrawal stops at
  once and discards your computer's waiting segments. A new arrival stops the session and
  needs fresh consent. Requests expire after two minutes, and sessions end after 30
  minutes.
- Windows are recognized in order. Up to 120 windows (about six minutes of continuous
  speech) can wait. Beyond that the page skips speech and warns you.
- **Stop** flushes each computer's partial window. The session ends when every
  participant's computer has transcribed and sent its remaining speech, or after two
  minutes with a warning that the last sentences may be missing.
- Muting clears the partial window, and speech captured while muted is never
  recognized. Screen-share audio is not transcribed.
- The text is produced on participants' computers. The server attributes each line to
  the authenticated sender, but cannot check that the text matches what they said (as
  with chat).
- Omnilingual ASR returns text without word timings. Each caption spans the new part of its
  window's capture time, so TXT/SRT timestamps are approximate to within about 3 s.
- The latest 2,000 lines are kept in room and browser memory. Download TXT/SRT before
  leaving.

## Checks

```sh
npm run test:transcription      # server consent/relay rules, local client, segmentation
npm run test:transcription-ui   # two browsers against a fake local service (no model needed)
npm run test:speech             # recognition policy, origin/host checks (needs .venv-omniasr)
SPEECH_TEST_WAV=path/to/spoken.wav npm run test:transcription-real   # real model, needs npm run speech
```

`test:transcription-real` feeds a spoken WAV through Chrome's microphone, the app and the
running local service. It asserts that no audio reached the meeting server and writes
`data/transcription-test/result.json`. Its default expected words are English. Set
`SPEECH_EXPECT_WORDS` and `SPEECH_LANGUAGE` for other samples. It does not measure
accuracy.
