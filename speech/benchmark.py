"""Speed benchmark for the local speech models: how long each model takes per speech segment.

Feeds segments (8 s by default, like the meeting page's longest) of a spoken WAV (looped so every segment is full of speech, the worst case for
live captions) straight to the Omnilingual pipeline, the way speech/service.py does, and prints the
time per segment, the real-time factor and, for LLM models, the time per decoder step (one step
writes one character).

    ../.venv-omniasr/bin/python benchmark.py --model omniASR_LLM_1B_v2
    ../.venv-omniasr/bin/python benchmark.py --model omniASR_CTC_300M_v2 --no-skip-reorder

Run it with nothing else busy on the GPU (stop npm run speech, close the meeting page), and expect
a fanless Mac to slow down as it warms up over several runs.
"""
import argparse
import statistics
import time
import wave

import numpy as np

from recognition import SAMPLE_RATE, skip_identity_reorder

parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument('--model', default='omniASR_LLM_1B_v2')
parser.add_argument('--wav', default='../data/transcription-test/english.wav', help='mono 16 kHz 16-bit WAV with speech')
parser.add_argument('--language', default='eng_Latn', help='hint for LLM models; auto sends none')
parser.add_argument('--device', default='auto', help='auto, cpu, mps or cuda')
parser.add_argument('--dtype', default='float16', help='float16, bfloat16 or float32')
parser.add_argument('--seconds', type=float, default=8, help='segment length (the meeting page sends at most 8 s)')
parser.add_argument('--overlap', type=float, default=0, help='seconds each segment repeats from the one before (the page uses 4 s with 1 s)')
parser.add_argument('--segments', type=int, default=3, help='how many consecutive segments')
parser.add_argument('--save', metavar='JSON', help='write each segment\'s text and overlap here (for scripts/merge-windows.mjs)')
parser.add_argument('--repeats', type=int, default=3, help='timed runs per segment (the median is reported)')
parser.add_argument('--skip-reorder', action=argparse.BooleanOptionalAction, default=True,
                    help="apply the service's identity-reorder skip (LLM models only)")
args = parser.parse_args()

import torch  # noqa: E402 - after argparse so --help is instant
from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline  # noqa: E402

device = args.device
if device == 'auto':
    device = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
dtype = getattr(torch, args.dtype)


def sync():
    if device == 'mps':
        torch.mps.synchronize()
    elif device == 'cuda':
        torch.cuda.synchronize()


with wave.open(args.wav) as w:
    if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (SAMPLE_RATE, 1, 2):
        raise SystemExit('Expected a mono 16 kHz 16-bit WAV')
    speech = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
seg_len = int(args.seconds * SAMPLE_RATE)
hop = seg_len - int(args.overlap * SAMPLE_RATE)
audio = np.tile(speech, -(-(hop * args.segments + seg_len) // len(speech)) + 1)
segments = [audio[i * hop:i * hop + seg_len] for i in range(args.segments)]

started = time.monotonic()
pipeline = ASRInferencePipeline(model_card=args.model, device=device, dtype=dtype)
model = pipeline.model
decoder = getattr(model, 'llama_decoder', None)
millions = lambda module: sum(p.numel() for p in module.parameters()) / 1e6  # noqa: E731
print(f'{args.model} on {device} ({args.dtype}), loaded in {time.monotonic() - started:.1f}s')
print(f'parameters: {millions(model):.0f}M in all' + (f', {millions(decoder):.0f}M in the text decoder' if decoder else ''))
if decoder is not None and args.skip_reorder:
    skip_identity_reorder()
    print('identity-reorder skip: on')

steps = {'n': 0}
if decoder is not None:
    forward = decoder.forward

    def counting_forward(*a, **k):
        steps['n'] += 1
        return forward(*a, **k)

    decoder.forward = counting_forward

hint = None if args.language == 'auto' else args.language


def transcribe(samples):
    [text] = pipeline.transcribe([{'waveform': samples, 'sample_rate': SAMPLE_RATE}], lang=[hint], batch_size=1)
    return ' '.join(text.split())


transcribe(segments[0])  # warm-up: kernel set-up is not part of the steady state
medians, texts = [], []
for i, samples in enumerate(segments):
    times = []
    for _ in range(args.repeats):
        steps['n'] = 0
        sync()
        t = time.monotonic()
        text = transcribe(samples)
        sync()
        times.append(time.monotonic() - t)
    median = statistics.median(times)
    medians.append(median)
    per_step = f', {steps["n"]} decoder steps, {1000 * median / steps["n"]:.0f} ms/step' if steps['n'] else ''
    print(f'segment {i + 1}: {median:.2f}s for {args.seconds:g} s of audio (x{median / args.seconds:.2f} real time){per_step}, {len(text)} characters')
    print(f'  {text}')
    texts.append(text)
mean = statistics.mean(medians)
print(f'mean: {mean:.2f}s per {args.seconds:g} s segment (x{mean / args.seconds:.2f} real time); live captions keep up only below x1.00')
print(f'all segments joined: {" | ".join(texts)}')
if args.save:
    import json
    overlap = seg_len - hop
    with open(args.save, 'w') as f:
        json.dump([{'seq': i, 'text': t, 'overlapSamples': overlap if i else 0, 'samples': seg_len, 'continues': bool(overlap)} for i, t in enumerate(texts)], f, ensure_ascii=False, indent=1)
