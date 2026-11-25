"""Scores call benchmark recordings: what arrived at the far end of a Zoom, Meet, Teams (or this app's) call when the
playlist from scripts/call-bench-make.mjs was played into the sender's microphone.

    .venv-bench/bin/python scripts/call_bench_score.py data/call-bench/<time> zoom=call-zoom-....wav meet=call-meet-....wav
    (npm run call:bench:score -- data/call-bench/<time> name=file.wav ...)

Each recording is either the stereo WAV saved by /call-bench (left: received, right: the playlist as it was played, on
the same clock) or a mono WAV of the received audio only (scripts/call-bench-ours.mjs or any other recorder); any sample
rate. Every clip is found in the recording (from the played channel, or by its speech pattern for mono files), lined up
with its clean speech, and scored on the part after the noise-only pre-roll, as in the noise benchmark:
  PESQ (wide-band)                    perceived quality against the clean speech; tolerates small delay changes
  STOI                                intelligibility; only on clips whose delay stayed steady (within 2 ms), because a
                                      call's jitter buffer can shift the audio mid-clip, which STOI counts as damage
  DNSMOS P.835 SIG / BAK / OVRL       no-reference quality: speech, background, overall
  noise reduction (dB)                how much quieter the background got relative to the voice (so an app's volume or
                                      gain control does not count); capped at 60 dB
  WER                                 word error rate of the local speech service (npm run speech) against the script,
                                      when it is running and the clips are the test script (skip with --no-wer)
  delay (ms)                          sender microphone to receiver speaker, stereo recordings only
Writes results.csv, summary.md, chart.png and aligned/<name>/*.wav into <playlist folder>/score-<time>/.
"""
import argparse
import csv
import io
import json
import re
import sys
import unicodedata
import wave
import warnings
from datetime import datetime, timezone
from math import gcd
from pathlib import Path

import numpy as np
import requests
from pesq import pesq
from pystoi import stoi
from scipy.io import wavfile
from scipy.signal import resample_poly
from speechmos import dnsmos

sys.path.insert(0, str(Path(__file__).parent))
from audio_bench_score import db, fmt, frames, mean, si_sdr  # noqa: E402

warnings.filterwarnings('ignore')
ROOT = Path(__file__).resolve().parent.parent
RATE = 48000
SPEECH = 'http://127.0.0.1:8765'
STEADY_MS = 2.0


def load(path):
    """A WAV as float64 at 48 kHz: (received, played or None)."""
    rate, data = wavfile.read(path)
    if data.dtype == np.int16:
        data = data.astype(np.float64) / 32768.0
    elif data.dtype == np.int32:
        data = data.astype(np.float64) / 2147483648.0
    else:
        data = data.astype(np.float64)
    if rate != RATE:
        g = gcd(RATE, rate)
        data = resample_poly(data, RATE // g, rate // g, axis=0)
    if data.ndim == 1 or data.shape[1] == 1:
        return data.reshape(len(data), -1)[:, 0], None
    left, right = data[:, 0], data[:, 1]
    # A stereo file from another recorder (both channels the received sound) has no played channel.
    n = min(len(left), 60 * RATE)
    if np.corrcoef(left[:n], right[:n])[0, 1] > 0.98:
        return left, None
    return left, right


def to16(x):
    return resample_poly(x, 1, 3)


def gcc(ref, sig, max_lag):
    """Lag l in [0, max_lag] with sig[t + l] ~ ref[t] (GCC-PHAT), and the peak's confidence (peak over mean)."""
    size = 1 << int(np.ceil(np.log2(len(ref) + len(sig))))
    spectrum = np.fft.rfft(sig, size) * np.conj(np.fft.rfft(ref, size))
    corr = np.fft.irfft(spectrum / np.maximum(np.abs(spectrum), 1e-12), size)[:max_lag + 1]
    lag = int(np.argmax(corr))
    return lag, float(corr[lag] / (np.mean(np.abs(corr)) + 1e-12))


def envelope(x, floor_db=50):
    """10 ms frame levels in dB, floored floor_db below the loudest frame and mean-removed (for coarse alignment)."""
    e = 10 * np.log10(frames(x, 480) + 1e-12)
    e = np.maximum(e, e.max() - floor_db)
    return e - e.mean()


def locate_playlist(received, played, playlist, clean_track):
    """Recording sample where the playlist's sample 0 was played, and how it was found."""
    if played is not None and np.max(np.abs(played)) > 1e-3:
        # The played channel is an exact copy on the recording's clock: first sound, refined by correlation.
        first_rec, first_pl = int(np.argmax(np.abs(played) > 1e-4)), int(np.argmax(np.abs(playlist) > 1e-4))
        n = min(10 * RATE, len(playlist) - first_pl)
        segment = playlist[first_pl:first_pl + n]

        def match(d):
            s = first_rec + d
            return float(np.dot(played[s:s + n], segment)) if 0 <= s and s + n <= len(played) else -np.inf
        return first_rec + max(range(-240, 241), key=match) - first_pl, 'played channel'
    # Mono: line the received level pattern up with the clean speech pattern of the whole playlist (10 ms steps).
    a, b = envelope(clean_track), envelope(received)
    size = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    corr = np.fft.irfft(np.fft.rfft(b, size) * np.conj(np.fft.rfft(a, size)), size)
    lags = np.r_[np.arange(0, len(b)), np.arange(-len(a) + 1, 0)]
    values = corr[lags % size]
    return int(lags[np.argmax(values)]) * 480, 'speech pattern'


def steadiness(aligned, noisy, pre):
    """How far the delay moved within the scored part (ms), measured per second against the input clip."""
    a, b = to16(noisy[pre:]), to16(aligned[pre:])
    seg, margin, devs = 16000, 4000, []
    for u in range(0, len(a) - seg, seg):
        start = u - margin
        if start < 0 or start + seg + 2 * margin > len(b):
            continue
        ref, cap = a[u:u + seg], b[start:start + seg + 2 * margin]
        if db(np.mean(ref ** 2)) < -60 or db(np.mean(b[u:u + seg] ** 2)) < -60:
            continue
        lag, confidence = gcc(ref, cap, 2 * margin)
        if confidence > 8:
            devs.append(lag - margin)
    return (max(devs) - min(devs)) / 16 if len(devs) >= 2 else None


def normalize_words(text):
    """Same normalisation as client/audio/dsp.js normalizeWords."""
    text = unicodedata.normalize('NFKC', str(text).lower()).replace('‘', "'").replace('’', "'")
    text = re.sub(r"[^\w' ]+", ' ', text).replace('_', ' ')
    text = re.sub(r"(^|\s)'+|'+(?=\s|$)", ' ', text)
    return text.split()


def wer(reference, hypothesis):
    r, h = normalize_words(reference), normalize_words(hypothesis)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
    return d[len(h)] / max(len(r), 1)


def transcribe(x16):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes((np.clip(x16, -1, 1) * 32767).astype('<i2').tobytes())
    response = requests.post(f'{SPEECH}/transcribe', data=buffer.getvalue(), timeout=300,
                             headers={'Content-Type': 'audio/wav', 'X-Speech-Language': 'eng_Latn'})
    response.raise_for_status()
    return response.json()['text']


def score(clean16, noisy16, deg16, lead, timing_ok):
    row = {}
    try:
        row['pesq'] = pesq(16000, clean16, deg16, 'wb')
    except Exception:  # no utterance found in the output
        row['pesq'] = None
    row['stoi'] = stoi(clean16, deg16, 16000, extended=False) if timing_ok else None
    # DNSMOS depends on the level, and the received level depends on the receiver's volume: bring the voice to the
    # input's level first (one gain for the whole clip).
    fc = frames(clean16)
    active = fc > fc.max() * 1e-4
    gain = np.sqrt(frames(noisy16)[active].mean() / max(frames(deg16)[active].mean(), 1e-12))
    mos = dnsmos.run(np.clip(deg16 * gain, -1, 1).astype(np.float32), 16000)
    row['dnsmos_ovrl'], row['dnsmos_sig'], row['dnsmos_bak'] = float(mos['ovrl_mos']), float(mos['sig_mos']), float(mos['bak_mos'])
    # Voice level (where the clean speech is active) against the noise-only lead-in level, output against input.
    s, e = int(0.1 * 16000) // 320, int((lead - 0.1) * 16000) // 320
    ratio = lambda x: db(frames(x)[active].mean()) - db(frames(x)[s:e].mean())  # noqa: E731
    row['noise_reduction_db'] = min(ratio(deg16) - ratio(noisy16), 60.0)
    return row


METRICS = [('pesq', 'PESQ', '{:.2f}'), ('stoi', 'STOI', '{:.3f}'), ('dnsmos_ovrl', 'DNSMOS OVRL', '{:.2f}'), ('dnsmos_sig', 'DNSMOS SIG', '{:.2f}'),
           ('dnsmos_bak', 'DNSMOS BAK', '{:.2f}'), ('noise_reduction_db', 'Noise reduction dB', '{:.1f}'), ('wer', 'WER', '{:.1%}')]


def table(rows, group_keys, names, metrics):
    groups = sorted({tuple(r[k] for k in group_keys) for r in rows}, key=lambda g: tuple((isinstance(v, str), v) for v in g))
    lines = ['| ' + ' | '.join([*group_keys, 'run', *[label for _, label, _ in metrics]]) + ' |', '|' + '---|' * (len(group_keys) + 1 + len(metrics))]
    for g in groups:
        for name in names:
            sel = [r for r in rows if r['run'] == name and tuple(r[k] for k in group_keys) == g]
            if sel:
                lines.append('| ' + ' | '.join([str(v) for v in g] + [name] + [fmt(mean([r.get(k) for r in sel]), p) for k, _, p in metrics]) + ' |')
    return '\n'.join(lines)


def chart(rows, names, path):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.ticker
    # Categorical slots in fixed order (validated palette); the input is the gray dashed baseline.
    palette = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
    colors = {'input': '#8a8985', **{n: palette[i % len(palette)] for i, n in enumerate(n for n in names if n != 'input')}}
    ink, muted, surface = '#0b0b0b', '#52514e', '#fcfcfb'
    snrs = sorted({r['snr'] for r in rows})
    panels = [('pesq', 'PESQ wide-band (1–4.5)'), ('dnsmos_ovrl', 'DNSMOS overall (1–5)'), ('noise_reduction_db', 'Noise reduction relative to the voice (dB)'),
              ('wer' if any(r.get('wer') is not None for r in rows) else 'stoi', 'Word error rate' if any(r.get('wer') is not None for r in rows) else 'STOI (steady clips)')]
    fig, axes = plt.subplots(2, 2, figsize=(11, 7.5), dpi=150, facecolor=surface)
    for ax, (key, title) in zip(axes.flat, panels):
        ax.set_facecolor(surface)
        ends = []
        for name in names:
            ys = [mean([r.get(key) for r in rows if r['run'] == name and r['snr'] == s]) for s in snrs]
            ax.plot(snrs, ys, color=colors[name], linewidth=2, marker='o', markersize=6, markeredgecolor=surface, markeredgewidth=1.5,
                    linestyle='--' if name == 'input' else '-', label=name, zorder=3)
            if ys and ys[-1] is not None:
                ends.append([ys[-1], name])
        low, high = ax.get_ylim()
        gap = (high - low) * 0.07
        groups = [[y, [t]] for y, t in sorted(ends)]
        merged = True
        while merged:
            merged = False
            for i in range(len(groups) - 1):
                (c1, t1), (c2, t2) = groups[i], groups[i + 1]
                if c1 + (len(t1) - 1) * gap / 2 + gap > c2 - (len(t2) - 1) * gap / 2:
                    groups[i:i + 2] = [[(c1 * len(t1) + c2 * len(t2)) / (len(t1) + len(t2)), t1 + t2]]
                    merged = True
                    break
        for centre, texts in groups:
            for k, text in enumerate(texts):
                ax.annotate(text, (snrs[-1], centre + (k - (len(texts) - 1) / 2) * gap), xytext=(8, 0), textcoords='offset points',
                            va='center', fontsize=9, color=ink, annotation_clip=False)
        if key == 'wer':
            ax.yaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1.0))
        ax.set_title(title, loc='left', fontsize=11, color=ink)
        ax.set_xticks(snrs)
        ax.set_xlabel('Input speech-to-noise ratio (dB)', fontsize=9, color=muted)
        ax.grid(axis='y', color='#e4e3df', linewidth=0.8)
        ax.set_xlim(snrs[0] - 1, snrs[-1] + max(snrs[-1] - snrs[0], 4) * 0.3)
        for side in ('top', 'right'):
            ax.spines[side].set_visible(False)
        for side in ('left', 'bottom'):
            ax.spines[side].set_color('#c9c8c3')
        ax.tick_params(colors=muted, labelsize=9)
    handles, labels = axes.flat[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc='upper center', ncol=min(len(names), 6), frameon=False, fontsize=9, bbox_to_anchor=(0.5, 0.955))
    fig.suptitle('Call benchmark: audio received at the far end of the call', x=0.06, ha='left', fontsize=13, color=ink)
    fig.tight_layout(rect=(0, 0, 1, 0.92))
    fig.savefig(path, facecolor=surface)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('playlist', help='data/call-bench/<time> (made by npm run call:bench:make)')
    parser.add_argument('runs', nargs='+', metavar='name=recording.wav')
    parser.add_argument('--no-wer', action='store_true', help='skip the word error rate even if the speech service is running')
    args = parser.parse_args()
    folder = Path(args.playlist).resolve()
    meta = json.loads((folder / 'playlist.json').read_text())
    pre, lead = int(meta['preroll'] * RATE), meta['lead']
    runs = []
    for item in args.runs:
        name, _, path = item.partition('=')
        if not path or not re.fullmatch(r'[\w.-]{1,40}', name) or name == 'input':
            sys.exit(f'Give each recording as name=path, with a short name (letters, digits, - and _; not "input"): {item}')
        runs.append((name, Path(path).expanduser().resolve()))

    use_wer, model = False, None
    if not args.no_wer and meta.get('speechText'):
        try:
            health = requests.get(f'{SPEECH}/health', timeout=3).json()
            use_wer, model = health.get('ready', False), f"{health.get('model')} on {health.get('device')}"
        except requests.RequestException:
            pass
        print('Word error rate: ' + ('on (local speech service)' if use_wer else 'off (start it with "npm run speech" to include it)'))

    playlist, _ = load(folder / 'playlist.wav')
    clips = meta['clips']
    clean = {c['id']: load(ROOT / c['clean'])[0] for c in clips}
    noisy = {c['id']: load(ROOT / c['noisy'])[0] for c in clips}
    clean_track = np.zeros_like(playlist)
    for c in clips:
        clean_track[c['start']:c['start'] + c['samples']] = clean[c['id']][:c['samples']]

    out = folder / f"score-{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S')}"
    rows, checks, transcripts = [], [], {}

    def recognise(key, x16):
        if not use_wer:
            return None, None
        if key not in transcripts:
            transcripts[key] = transcribe(x16)
        return wer(meta['speechText'], transcripts[key]), transcripts[key]

    # The input itself (the noisy clips as played) and the clean speech, as baselines.
    for c in clips:
        c16, n16 = to16(clean[c['id']][pre:]), to16(noisy[c['id']][pre:])
        row = {'run': 'input', 'clip': c['id'], 'speech': c['speech'], 'noise': c['noise'], 'snr': c['snr'], **score(c16, n16, n16, lead, True)}
        row['wer'], row['transcript'] = recognise(('input', c['id']), n16)
        rows.append(row)
    ceiling = {}
    for c in clips:
        if c['speech'] not in ceiling:
            c16 = to16(clean[c['id']][pre:])
            mos = dnsmos.run(np.clip(c16, -1, 1).astype(np.float32), 16000)
            ceiling[c['speech']] = {'dnsmos_ovrl': float(mos['ovrl_mos']), 'wer': recognise(('clean', c['speech']), c16)[0]}

    for name, path in runs:
        received, played = load(path)
        if np.max(np.abs(received)) < 1e-4:
            checks.append(f'{name}: the recording is silent; nothing arrived from the app.')
            continue
        origin, how = locate_playlist(received, played, playlist, clean_track)
        # Delay: the first clip is searched 0-3 s after it was played (or +-1 s after the speech-pattern estimate),
        # each later clip within 0.5 s of the previous clip's delay (it drifts with clocks and jitter buffers).
        delay, window = (RATE * 3 // 2, RATE * 3 // 2) if played is not None else (0, RATE)
        found, delays, steady, identical = [], [], 0, 0
        (out / 'aligned' / name).mkdir(parents=True, exist_ok=True)
        for c in clips:
            base = origin + c['start'] + pre
            c48, n = clean[c['id']][pre:], c['samples'] - pre
            lo = base + delay - window
            if lo < 0 or base + delay + window + n > len(received):
                checks.append(f"{name} {c['id']}: not in the recording (it may have been stopped early)")
                continue
            lag, confidence = gcc(to16(c48), to16(received[lo:lo + n + 2 * window]), 2 * window // 3)
            if confidence < 6:
                checks.append(f"{name} {c['id']}: not found (match {confidence:.1f}); scored as missing")
                continue
            d = delay - window + 3 * lag
            d = max(range(d - 3, d + 4), key=lambda k: float(np.dot(received[base + k:base + k + n], c48)))
            delay, window = d, RATE // 2
            start = origin + c['start'] + d
            aligned = received[start:start + c['samples']]
            wavfile.write(out / 'aligned' / name / f"{c['id']}.wav", RATE, (np.clip(aligned, -1, 1) * 32767).astype(np.int16))
            slip = steadiness(aligned, noisy[c['id']], pre)
            timing_ok = slip is not None and slip <= STEADY_MS
            steady += timing_ok
            c16, n16, d16 = to16(clean[c['id']][pre:]), to16(noisy[c['id']][pre:]), to16(aligned[pre:])
            row = {'run': name, 'clip': c['id'], 'speech': c['speech'], 'noise': c['noise'], 'snr': c['snr'], **score(c16, n16, d16, lead, timing_ok)}
            row['wer'], row['transcript'] = recognise((name, c['id']), d16)
            row['delay_ms'] = round(d / RATE * 1000, 1) if played is not None else None
            row['slip_ms'], row['match'] = slip, round(confidence, 1)
            # Through a real call the codec alone keeps the waveform well below 30 dB of the input.
            identical += si_sdr(n16, d16) > 30
            rows.append(row)
            found.append(c['id'])
            delays.append(d / RATE * 1000)
            print(f"scored {name} {c['id']}: PESQ {fmt(row['pesq'], '{:.2f}')}, DNSMOS {row['dnsmos_ovrl']:.2f}" + (f", WER {row['wer']:.0%}" if row['wer'] is not None else ''))
        text = f'{name}: {len(found)} of {len(clips)} clips found ({how}); {steady} kept a steady delay (STOI is scored on those)'
        if played is not None and delays:
            text += f'; delay from the sender\'s microphone to the receiver\'s speaker {np.median(delays):.0f} ms (range {min(delays):.0f}-{max(delays):.0f} ms)'
        checks.append(text + '.')
        if identical > len(found) / 2:
            checks.append(f'{name}: the received audio is the playlist itself, unchanged (SI-SDR above 30 dB in {identical} clips). The recording '
                          'device was probably the virtual device the playlist was played into, so this run did not go through the app.')

    names = ['input', *[n for n, _ in runs if any(r['run'] == n for r in rows)]]
    keys = ['run', 'clip', 'speech', 'noise', 'snr', 'pesq', 'stoi', 'dnsmos_ovrl', 'dnsmos_sig', 'dnsmos_bak', 'noise_reduction_db', 'wer',
            'delay_ms', 'slip_ms', 'match', 'transcript']
    out.mkdir(parents=True, exist_ok=True)
    with open(out / 'results.csv', 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=keys, extrasaction='ignore')
        writer.writeheader()
        for r in rows:
            writer.writerow({k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()})
    metrics = [m for m in METRICS if m[0] != 'wer' or use_wer]
    summary = [
        f"# Call benchmark ({datetime.now().strftime('%Y-%m-%d')})", '',
        f"Playlist {folder.name}: {len(clips)} clips from {meta['source']}. Each run is what arrived at the far end of a call while the playlist "
        "was played into the sender's microphone. Scores are against the clean speech at 16 kHz, on the part after the noise-only pre-roll. "
        '"input" is the noisy playlist itself.' + (f' Word error rate: local speech service, {model}, English.' if use_wer else ''), '',
        '## Overall (mean over all clips)', '', table(rows, [], names, metrics), '',
        f"STOI is only scored on clips whose delay stayed within {STEADY_MS:.0f} ms (see Checks). Noise reduction compares the background with the "
        "voice, before and after, so a different volume or gain control in an app does not change it.", '',
        '## By input SNR', '', table(rows, ['snr'], names, metrics), '',
        '## By noise type', '', table(rows, ['noise'], names, metrics), '',
        'Clean speech (the ceiling for this material): ' + ', '.join(
            f"{k} DNSMOS {v['dnsmos_ovrl']:.2f}" + (f", WER {v['wer']:.0%}" if v['wer'] is not None else '') for k, v in ceiling.items()) + '.', '',
        '## Checks', '', *(f'- {c}' for c in checks), '',
        'Files: results.csv (every score and transcript), chart.png, aligned/<run>/*.wav (each clip as received, lined up with the clean speech).',
    ]
    (out / 'summary.md').write_text('\n'.join(summary) + '\n')
    if len(names) > 1:
        chart(rows, names, out / 'chart.png')
    print('\n'.join(summary))
    print(f'\nWrote {out}')


if __name__ == '__main__':
    main()
