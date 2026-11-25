# Speech model experiments: Omnilingual ASR on a participant's laptop

Notes for the report, 23–25 November 2026. Live transcription runs on each participant's own
computer (`speech/service.py`): the meeting page sends 8-second speech segments to the local
service and forwards only the recognized text to the meeting server. This file records which
Omnilingual ASR models were tried, how fast each one is on a laptop, and what was done to speed up
the larger ones.

## Test setup

| | |
| --- | --- |
| Computer | MacBook Air 13" M4 (Mac16,12): 10-core CPU (4 performance + 6 efficiency), 24 GB unified memory, **no fan** |
| Compute | Apple GPU through PyTorch MPS, float16 weights |
| Software | Python 3.11, PyTorch 2.8.0, omnilingual-asr 0.2.0 (fairseq2) |
| Test audio | `data/transcription-test/english.wav`: 6.1 s of English speech, mono 16 kHz, looped to fill 8 s segments |
| Live test | `npm run test:transcription-real`: Chrome plays the WAV as its microphone into a real meeting page, which uses the local service |
| Benchmark | `speech/benchmark.py`: segments go straight to the model, 3 segments × 3 runs, median reported |

## The models

Omnilingual ASR (Meta) comes in two families. Both start with the same kind of audio encoder
(wav2vec 2.0); the "300M" or "1B" in the name is the size of that encoder.

- **CTC** models put a small output layer on the encoder that guesses one character per slice of
  audio, all in one pass. They are fast, but they ignore the language you pick and nothing checks
  that the letters form real words.
- **LLM** models add a language-model decoder (LLaMA-style) that writes the text one character at a
  time, guided by a language code (for example `apc_Arab` for Lebanese Arabic). They are expected to
  be more accurate, but each character costs a full pass through the decoder.

| Model | Download | Parameters | Language choice | Tested |
| --- | --- | --- | --- | --- |
| `omniASR_CTC_300M_v2` | 1.21 GiB | 326M | ignored | yes |
| `omniASR_CTC_1B_v2` | 3.63 GiB | – | ignored | no |
| `omniASR_LLM_300M_v2` | 6.08 GiB | 1,632M, of which 1,221M is the text decoder | used | yes |
| `omniASR_LLM_1B_v2` | 8.49 GiB | 2,280M, of which 1,221M is the text decoder | used | yes |

The model configurations in omnilingual-asr show that **LLM 300M and LLM 1B share the same text
decoder** (12 layers, width 4096, 8 attention heads); only the audio encoder differs. The decoder
is where an LLM model spends most of its time (see below), so LLM 300M was expected to be only a
little faster than LLM 1B. Measured: 3% faster (see **LLM 300M** below).

## Getting the LLM 1B model

- The default model was changed from CTC 300M to LLM 1B in `speech/service.py`, the READMEs and
  the page's "still loading" message (and later to LLM 300M, see **LLM 300M**).
- fairseq2's built-in downloader cannot resume. On a connection of 0.3–1.3 MiB/s that stalled
  several times, the 8.5 GiB download kept failing from the start. The weights were instead
  fetched with `curl -C -` (resume), restarting automatically whenever the speed stayed under
  50 kB/s for 60 s, and placed where fairseq2 looks for them:
  `~/.cache/fairseq2/assets/<first 24 hex digits of sha1(URL)>/<file name>`.
- The download resumed from a 1.97 GB partial file, took about 3 hours, and restarted itself 4
  times after stalls. The finished file passed its integrity check (CRC of all 923 entries in the
  PyTorch archive).
- LLM 300M (6.1 GiB) was fetched the same way on 25 November: 2 h 28 min, restarting itself 20
  times; all 539 entries passed the integrity check.

## Results

### Live test (whole system: Chrome, meeting page, local service)

| Model | Time per 8 s segment | Real-time factor |
| --- | --- | --- |
| CTC 300M | 0.1–0.5 s | 0.01–0.06 |
| LLM 1B, as shipped by Omnilingual (23 Nov) | 13.1–15.4 s | 1.64–1.93 |
| LLM 1B with the reorder skip below (25 Nov) | 10.7–11.7 s | 1.34–1.46 |
| LLM 300M with the reorder skip, 4 s windows with 1 s overlap (25 Nov) | 5.1–6.1 s per 4 s window | 1.27–1.53 per window; 1.7–2.0 per second of new speech |

A real-time factor above 1 means the model takes longer than the speech lasts, so during
continuous speech the captions fall further and further behind.

### Benchmark (model only, `speech/benchmark.py`)

| Model | Time per 8 s segment | Real-time factor | Time per decoder step |
| --- | --- | --- | --- |
| CTC 300M | 0.15 s | 0.02 | – |
| LLM 1B, as shipped | 7.53 s | 0.94 | 51 ms |
| LLM 1B with the reorder skip | 7.06 s | 0.88 | 48 ms |
| LLM 300M with the reorder skip | 7.02 s | 0.88 | 48 ms |
| LLM 1B with the reorder skip, run right after LLM 300M | 7.25 s | 0.91 | 49 ms |

The live test is about 1.5 times slower than the benchmark because Chrome is using the same GPU
for the meeting page, and because the laptop is under load longer and heats up.

### Where the LLM model's time goes

- The decoder runs once per character: 152 steps for the 150 characters of one test segment.
- Each step takes about 40 ms inside the 12 decoder layers plus about 1 ms for the output layer.
  Within one layer, attention took 2.8 ms and the feed-forward part 1.1 ms.
- Each segment also has a fixed cost of about 0.8 s (audio encoder and reading the audio into the
  decoder), estimated from two segments of different length: 45 characters took 2.88 s and 136
  characters took 7.10 s.
- Each step reads the whole 1.22B-parameter decoder: 2.4 GB in float16. At the M4's memory
  bandwidth (about 120 GB/s) that alone needs about 20 ms, so a step costs about twice what the
  weight reads require. The rest is overhead: many small GPU operations dispatched one after
  another, plus a GPU-to-CPU wait at every step to check whether the text has ended.
- The test clip is fast speech (about 19 characters per second). At 48 ms per character, the
  decoder can write about 20 characters per second at best, before the fixed cost per segment.

### Speed-up attempts on LLM 1B

| Attempt | Result | Kept |
| --- | --- | --- |
| float16 (default on the Apple GPU) | 46–51 ms per step | yes |
| bfloat16 | about the same as float16 | no |
| float32 | 82–93 ms per step, about twice as slow | no |
| Fewer beam-search candidates | the pipeline already uses 1 (`nbest=1`), not 5 as first assumed | – |
| **Skip the identity key/value-cache reorder** | 6% faster back to back (51 → 48 ms per step); identical text | **yes** |
| 8-bit weights (`torch._weight_int8pack_mm`, per output channel, 84 decoder layers) | 8% faster together with the reorder skip, so little extra; identical English text, Arabic untested | no |
| Recognize 2–3 queued segments in one batch | 13% less time per segment; identical text | no |

**The reorder skip.** At each decoder step, beam search reorders every layer's key/value cache to
follow the best candidates. With one segment and one candidate the new order is always the same
as the old one, yet the cache is still copied, 24 times per step. `skip_identity_reorder()` in
`speech/recognition.py` skips the copy when there is only one entry to reorder, and
`speech/service.py` turns it on for LLM models. Batches and several candidates are reordered as
before.

**Why 8-bit weights did not help more.** On a single 4096 × 11008 weight matrix, the 8-bit matrix
product took 0.45 ms against 0.87 ms in float16 (relative error 0.9% with random weights). The
whole model gained much less, which agrees with the overhead finding above: reading weights is
not the main cost.

### Heat

The MacBook Air has no fan. The same segment took 7.75 s at the start of a benchmark run and
9.53 s a few minutes later. A meeting is sustained load, so the live figures are the realistic ones.

### Segment length: 1 s instead of 8 s

The meeting page ends a segment at a pause (0.64 s of quiet after at least 1 s of audio) or after
8 s at the latest. To see whether much shorter segments would give faster captions, and whether
their text could be translated, the same 8 s of speech was cut into eight 1-second segments
(`benchmark.py --seconds 1 --segments 8`):

| | Time per 1 s segment | Real-time factor (1 s / 8 s segments) |
| --- | --- | --- |
| CTC 300M | 0.04 s | 0.04 / 0.02 |
| LLM 1B | 0.97 s | 0.97 / 0.88 |

Text, with `|` between segments:

| Segments | Text |
| --- | --- |
| one 8 s segment (both models) | we are testing the meeting transcription system every participant runs the speech model on their own computer … |
| 1 s, CTC 300M | we are testing the me \| ing transcriptions \| system every \| participent runs \| the speech modl on \| thei'r own computer \| … |
| 1 s, LLM 1B | we are testing the meat \| transcriptions \| system every \| participant runs \| the speech model on \| their own computer \| … |

- Short segments cut words in half ("me | ing", "meat | transcriptions"). The models make mistakes
  they do not make on whole sentences ("participent", "modl", "thei'r", "meat").
- Each segment carries a fixed cost, so LLM 1B gets slower relative to the speech (0.97 instead
  of 0.88). CTC 300M stays very fast.
- **Not suitable for translation.** Each piece holds two to four words, often part of a word and
  never a whole clause. A translator given "we are testing the meat" and then "transcriptions" has
  no sentence to work with. Arabic and English also order words differently (verb first, adjective
  after noun), so translating fragments in sequence gives wrong word order even when every word is
  right. The models output no punctuation, so sentence ends can only come from pauses.
- Better design: keep pause-based segments as the unit to translate. If captions must appear
  sooner, show quick provisional text from short pieces and replace it with the full segment's
  text, translating only that final text.

### Overlapping 4-second windows (adopted)

To get captions sooner than 8-second segments allow, without the cut words of short pieces, the
page now cuts speech into 4-second windows that overlap by 1 second (`public/speech-buffer.js`):

- A pause (0.64 s of quiet after at least 1 s) still closes a window early, with no overlap.
- Speech that runs on is cut at 4 s, and the next window starts 1 s before the cut: 0–4 s,
  3–7 s, 6–10 s ... Each window brings 3 s of new speech.
- A word split by a cut is heard whole in one of the two windows. The page holds back the last
  word of a window that is cut, then lines up the next window's text with the end of the previous
  one and drops the shared words (`client/transcript-merge.js`). Words match when they are equal,
  when one is the cut-off start of the other ("me" / "meeting"), or when longer words are one
  letter apart. If nothing lines up, the held word is kept and about a quarter of the new
  window's words (the overlap's share) are dropped.

Accuracy and speed on the same 24 s of speech (the test sentence four times), joined the way the
page joins them (`scripts/merge-windows.mjs`), scored by word error rate against the script:

| Windows | CTC 300M word errors | LLM 1B word errors | CTC 300M per window | LLM 1B per window |
| --- | --- | --- | --- | --- |
| 8 s, no overlap | 0% | 0% | 0.14 s | 7.17 s |
| 4 s, no overlap | 4.5% ("transcris nsystem", "owne") | 1.5% ("transcript") | 0.08 s | 3.62 s |
| **4 s, 1 s overlap** | **0%** | **0%** | **0.08 s** | **3.57 s** |

LLM 300M, measured later the same way: 0% word errors with 8 s segments and with overlapping
4 s windows, 6.86 s per 8 s segment and 3.41 s per 4 s window.

- Plain 4-second cuts split words; the 1-second overlap removes those errors and matches the
  accuracy of 8-second segments on this recording.
- Delay: a caption appears when its window closes plus recognition time, about every 3 s during
  continuous speech. With CTC 300M a word is shown at most about 4 s after it is spoken (a word
  at the start of a window); the held word at a cut waits for the next window, about 3–3.5 s.
- Cost: every second of continuous speech is recognized 4/3 times. CTC 300M needs 0.08 s for each
  3 s of new speech and keeps up easily. LLM 1B needs 3.57 s for each 3 s (x1.19) even in the
  benchmark, so with LLM models captions fall behind faster than with 8-second segments (x0.90).
- Live test (CTC 300M, 20 s of the looped recording through Chrome): windows were cut at 4, 7,
  10, 13, 16 and 19 s; recognition took 0.14–0.16 s per window after the first (0.66 s). The
  joined transcript read correctly apart from "the" for "we" at the very start and
  "participate" for "participant runs the" in one window; recognizing the same windows directly
  showed these were the model mishearing that capture, not the joining.
- For translation, the joined text of a speaker's windows up to a pause is the unit to translate,
  not each window.

## Accuracy

The English test clip does not separate the models. Fed clean 8-second segments, CTC 300M and LLM
1B produce the same correct text. In live runs the segment boundaries fall in different places
and cut words in half, so transcripts differ between runs. One CTC 300M live run had
"participent", "smevery" and a stray Arabic letter. The LLM 1B live runs were clean apart from
"transition" for "transcription" at the cut end of a segment. Comparing accuracy properly needs
Arabic and Lebanese recordings with reference transcripts, scored by word and character error rate.

## Conclusions so far

1. On a fanless M4 laptop, the LLM models cannot caption continuous speech live: LLM 1B takes
   1.3–1.5 times as long as the speech in a real meeting, even after the speed-up, and
   overlapping 4-second windows add a third more work.
2. CTC 300M takes about 2% of the speech's length and keeps up easily.
3. LLM speed is limited by the text decoder writing one character at a time. The decoder is the
   same in LLM 300M and LLM 1B, so the smaller LLM model saves only part of the 0.8 s fixed cost
   per segment: measured, LLM 300M is 3% faster than LLM 1B, not enough to keep up.
4. Any accuracy advantage of the LLM models still has to be measured on Arabic speech.
5. 4-second windows overlapping by 1 second give captions about every 3 s with the accuracy of
   8-second segments; plain 4-second cuts do not.

## LLM 300M

Measured on 25 November, after the overlapping windows were in place.

- **Size:** 1,632M parameters against LLM 1B's 2,280M. The text decoder is identical (1,221M);
  only the audio encoder is smaller. It loads in about 4–5 s instead of 7–8 s, and the download
  is 6.1 GiB instead of 8.5 GiB.
- **Speed, benchmark:** 7.02 s per fully spoken 8 s segment against 7.25 s for LLM 1B run straight
  after it, so 3% faster (0.23 s less per segment). The time per character is the same, 48–49 ms.
  Before measuring, the estimate was 0.3–0.5 s less per segment (about 5%): the saving is a little
  smaller than expected.
- **Speed, 4 s windows with 1 s overlap:** 3.41 s per window in the benchmark. Each window brings
  3 s of new speech, so that is 1.14 times as long as the speech. In the live meeting test it was
  5.1–6.1 s per window, 1.7–2.0 times as long as the new speech; after 20 s of talking the captions
  were about 16 s behind.
- **Accuracy:** 0% word errors on the 24 s test (8 s segments and overlapping 4 s windows alike).
  The live transcript read correctly from start to end apart from the first word ("we"), which the
  first window missed: "are testing the meeting transcription system every participant runs |
  the speech model on their own computer we are testing the | meeting transcription system every
  participant | runs the speech model on their own computer we are testing | …"
- **Verdict:** on this laptop LLM 300M behaves like LLM 1B: accurate on the English test, but too
  slow for live captions of continuous speech. Its advantages are the smaller download, lower
  memory use and faster start, not speed while transcribing.
- **Decision (25 Nov):** LLM 300M became the default model. It keeps the language choice and the
  LLM decoder, matched LLM 1B on the test, and costs 2.4 GiB less to download. CTC 300M stays the
  option when captions must keep up (`npm run speech -- --model omniASR_CTC_300M_v2`).

## Back to LLM 1B, and a first Arabic test (25 Nov)

**Decision:** LLM 1B became the default again (`speech/service.py`), at the project's request.
LLM 300M stays available with `npm run speech -- --model omniASR_LLM_300M_v2`. Both are already
in the local cache, so the switch needed no download.

**Arabic test recording.** There was no Arabic recording with a reference transcript, so one
was made with the macOS Arabic voice (Majed, Modern Standard Arabic, `say -r 160`): 22 s, 32
words, a short meeting announcement (`data/transcription-test/arabic-msa.wav` and `.txt`,
git-ignored). It was cut into 4 s windows overlapping by 1 s exactly as the page does (7 windows),
recognized with `speech/benchmark.py --save`, joined with `scripts/merge-windows.mjs` and scored
against the reference. The scorer now ignores punctuation and diacritics and treats Arabic letter
variants as equal (أ إ آ → ا, ى → ي, ة → ه), so spelling conventions are not counted as errors.
It also reports the character error rate (CER).

**Joining bug found.** The first scoring gave 3–12% word errors, and most of them were not the
model's. When a window's opening words did not line up with the end of the previous window, the
page assumed about a quarter of its words were repeats and dropped them. In Arabic the previous
window often stops short of the overlap: the decoder left out the words cut at its end. So the
dropped words were real speech, heard only once ("أرجو من", "إلى"). The fix in
`client/transcript-merge.js`:

1. Arabic spelling variants (hamza forms, alef maqsura, taa marbuta, diacritics) count as the same
   word when lining windows up.
2. When the words do not line up, the letters are compared: if the next window's first 1–4 words
   (at least 8 letters) are within 45% edits of the end of the previous window, they are taken as
   the same speech heard differently and dropped (one window had "وإرسال ملاحقين", the next
   "و الرسالة ملاحظاتكم"). Measured on these runs: real repeats 33–42%; all 120 pairs of windows
   that share no audio 50% or more.
3. Otherwise nothing is dropped. Showing a word twice is better than losing it.

The 45% threshold was chosen on these same runs, so it needs checking on more recordings.

| Model and language hint | Word errors (old join) | Word errors | Character errors | Per 4 s window* | Decoder steps per window |
| --- | --- | --- | --- | --- | --- |
| LLM 1B, `arb_Arab` (Modern Standard Arabic) | 12.5% | 3.1% | 2.6% | 2.36 s | 21–42 |
| LLM 1B, `apc_Arab` (Lebanese) | 3.1% | 3.1% | 5.3% | 2.46 s | 33–42 |
| LLM 1B, no hint (mixed) | 9.4% | 3.1% | 5.3% | 2.65 s | 25–42 |
| LLM 300M, `arb_Arab` | 9.4% | 3.1% | 5.3% | 2.24 s | 32–42 |
| LLM 1B, English `eng_Latn` (24 s test clip) | 0% | 0% | 0% | — | 67–78 |

\* Another speech service (port 8766, from other work) was running on the same GPU during these
runs, so the times are higher than a quiet machine would give (61–76 ms per decoder step for
Arabic, 105–117 ms for English, against 48 ms measured before). The English run's times were
too disturbed to use.

- **The only remaining error in every Arabic run is one word:** "ملاحظاتكم" (your notes) was heard
  as "ملاحقين" or left out at a window cut.
- **Arabic is quicker to write than English.** Arabic script leaves out short vowels, so a 4 s
  window takes about 34 decoder steps, half of English's 70. Even with the GPU shared, LLM 1B took
  2.4–2.7 s per Arabic window, under the 3 s of new speech each window brings, so in this
  benchmark it kept up. Not yet measured in a live meeting, which added 1.7–2.7 s per window for
  English.
- **Hints:** all three gave the same words after the fix. `apc_Arab` and no hint wrote hamza
  forms (أرجو, إلى) where `arb_Arab` sometimes did not (ارجو, الى). The scorer counts these as equal.
- **LLM 300M against LLM 1B:** the same words on this recording.
- **Limits:** one synthetic voice reading formal Arabic slowly and clearly, through a file rather
  than a microphone. It says nothing yet about Lebanese dialect, real voices, room noise or mixed
  Arabic/English speech. Those need real recordings with reference transcripts.

## Files changed

| File | Change |
| --- | --- |
| `speech/service.py` | default model `omniASR_LLM_1B_v2` (23 Nov), then `omniASR_LLM_300M_v2` (25 Nov), then `omniASR_LLM_1B_v2` again (25 Nov); turns on the reorder skip for LLM models |
| `speech/recognition.py` | `skip_identity_reorder()` |
| `speech/benchmark.py` | new: speed benchmark used for the tables above (`--seconds`, `--overlap`, `--save`) |
| `speech/README.md`, `README.md` | default model, download sizes, disk space, measured speeds |
| `client/local-speech.js` | "still loading" message gives the new download size |
| `public/speech-buffer.js` | 4-second windows with 1-second overlap when speech runs on (was: up to 8 s, no overlap) |
| `client/transcript-merge.js` | new: joins overlapping windows' text without repeating words; later: Arabic spelling variants, letter comparison, keeps everything when nothing lines up |
| `client/transcription.js` | joins each window's text before sending it; caption time spans only the new part; queue of 120 windows |
| `scripts/merge-windows.mjs` | new: joins `benchmark.py --save` output like the page and scores it (word and character error rate, Arabic-aware normalization; reference text or a `.txt` file) |
| `tests/speech-buffer.test.mjs`, `tests/transcript-merge.test.mjs`, `scripts/transcription.mjs` | tests for the windows and the joining |

## Reproducing

```sh
cd speech
../.venv-omniasr/bin/python benchmark.py --model omniASR_CTC_300M_v2
../.venv-omniasr/bin/python benchmark.py --model omniASR_LLM_1B_v2 --no-skip-reorder
../.venv-omniasr/bin/python benchmark.py --model omniASR_LLM_1B_v2
../.venv-omniasr/bin/python benchmark.py --model omniASR_LLM_300M_v2
```

Overlapping windows, joined and scored (`$S` is the test sentence):

```sh
cd speech
../.venv-omniasr/bin/python benchmark.py --model omniASR_CTC_300M_v2 --seconds 4 --overlap 1 --segments 8 --repeats 1 --save windows.json
cd ..
S="we are testing the meeting transcription system every participant runs the speech model on their own computer"
node scripts/merge-windows.mjs speech/windows.json "$S $S $S we are testing the meeting transcription system every participant runs the speech model on their own"
```

Arabic test recording and scoring (from the repository root):

```sh
D=data/transcription-test
say -v Majed -r 160 -o $D/arabic-msa.aiff "$(cat $D/arabic-msa.txt)"
afconvert -f WAVE -d LEI16@16000 -c 1 $D/arabic-msa.aiff $D/arabic-msa.wav
cd speech
../.venv-omniasr/bin/python benchmark.py --model omniASR_LLM_1B_v2 --language arb_Arab --wav ../$D/arabic-msa.wav --seconds 4 --overlap 1 --segments 7 --repeats 1 --save ../$D/arabic-1B.json
cd ..
node scripts/merge-windows.mjs $D/arabic-1B.json $D/arabic-msa.txt
```

(The recording used here was made from the same sentences with punctuation, which only changes the
pauses.)

Live test, with the service started on port 8766 (`npm run speech -- --port 8766`):

```sh
LOCAL_SPEECH_URL=http://127.0.0.1:8766 SPEECH_EXPECT_WORDS=meeting,transcription,participant,computer npm run test:transcription-real
```
