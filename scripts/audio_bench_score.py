"""Scores a noise benchmark run made by scripts/audio-bench.mjs.

    .venv-bench/bin/python scripts/audio_bench_score.py data/audio-bench/<run>/

Each live capture is lined up with the clean speech, then the part after the noise-only pre-roll is scored at 16 kHz
against the clean speech. (Chrome restarts the fake microphone file when a capture opens, so a capture is the file
shifted by a small offset; the loop seam comes after the scored part.)
  PESQ (ITU-T P.862.2 wide-band, 1-4.5)    perceived quality against the clean speech
  STOI (0-1)                              intelligibility
  SDR (dB)                                speech against noise and artifacts, BSS-eval style: whatever a fixed 512-tap filter
                                          of the clean speech explains counts as speech, so a processor's phase response
                                          or equalisation is not counted as damage (Chrome's filter bank shifts phase by
                                          up to 1.5 rad, which made plain SI-SDR read about 14 dB too low for Browser)
  SI-SDR (dB)                             plain scale-invariant SDR, in results.csv only
  DNSMOS P.835 SIG / BAK / OVRL (1-5)     Microsoft's no-reference MOS predictor: speech, background, overall
  noise reduction (dB)                    noise level in the noise-only lead-in, before against after
  speech level (dB)                       output level where the clean speech is active, against the clean speech
Writes results.csv, summary.md, chart.png and aligned/<mode>/*.wav (for listening) into the run folder.
"""
import csv
import json
import sys
import warnings
from pathlib import Path

import numpy as np
from pesq import pesq
from pystoi import stoi
from scipy.io import wavfile
from scipy.linalg import solve_toeplitz
from scipy.signal import resample_poly
from speechmos import dnsmos

warnings.filterwarnings('ignore')
LABELS = {'input': 'Input (noisy file)', 'off': 'Off (raw)', 'browser': 'Browser (built-in)', 'browser-noagc': 'Browser, gain control off',
          'ours': 'Ours (DTLN-aec + DeepFilterNet3)'}
SHORT = {'input': 'Input', 'off': 'Off', 'browser': 'Browser', 'browser-noagc': 'Browser, AGC off', 'ours': 'Ours'}
METRICS = [('pesq', 'PESQ', '{:.2f}'), ('stoi', 'STOI', '{:.3f}'), ('sdr', 'SDR dB', '{:.1f}'), ('dnsmos_ovrl', 'DNSMOS OVRL', '{:.2f}'),
           ('dnsmos_sig', 'DNSMOS SIG', '{:.2f}'), ('dnsmos_bak', 'DNSMOS BAK', '{:.2f}'), ('noise_reduction_db', 'Noise reduction dB', '{:.1f}'),
           ('speech_level_db', 'Speech level dB', '{:+.1f}')]


def read(path):
    rate, data = wavfile.read(path)
    assert rate == 48000, f'{path}: {rate} Hz'
    return data.astype(np.float64) / 32768.0


def align(out, clean, pre):
    """Capture sample s holds source sample s + offset (offset from -0.5 s up to the pre-roll). Find the offset with
    GCC-PHAT on 16 kHz copies, refine it to the 48 kHz sample, and return the capture for source samples [pre, end)."""
    n = len(clean)
    a, b = resample_poly(clean, 1, 3), resample_poly(out[:n], 1, 3)
    size = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    spectrum = np.conj(np.fft.rfft(b, size)) * np.fft.rfft(a, size)
    corr = np.fft.irfft(spectrum / np.maximum(np.abs(spectrum), 1e-12), size)
    lags = np.r_[np.arange(-8000, 0), np.arange(0, pre // 3)]
    values = corr[lags % size]
    coarse = int(lags[np.argmax(values)])
    confidence = float(values.max() / (np.mean(np.abs(values)) + 1e-12))
    best, offset = -np.inf, coarse * 3
    for d in range(coarse * 3 - 3, coarse * 3 + 4):
        v = float(np.dot(out[pre - d:n - d], clean[pre:n]))
        if v > best:
            best, offset = v, d
    if pre - offset < 0 or n - offset > len(out):
        raise ValueError(f'offset {offset} leaves the capture ({len(out)} samples)')
    return out[pre - offset:n - offset], offset, confidence


def frames(x, size=320):
    usable = len(x) // size * size
    return (x[:usable].reshape(-1, size) ** 2).mean(axis=1)


def db(power):
    return 10 * np.log10(max(power, 1e-12))


def si_sdr(ref, est):
    ref, est = ref - ref.mean(), est - est.mean()
    target = np.dot(est, ref) / np.dot(ref, ref) * ref
    return 10 * np.log10(np.sum(target ** 2) / max(np.sum((est - target) ** 2), 1e-20))


def sdr(ref, est, taps=512):
    """Project est onto ref filtered by any filter with taps-1 .. 0 .. delays (-taps/2 to taps/2 samples); the rest is error."""
    half, n = taps // 2, len(ref)
    size = 1 << int(np.ceil(np.log2(2 * n + taps)))
    rf, ef = np.fft.rfft(ref, size), np.fft.rfft(est, size)
    acf = np.fft.irfft(np.abs(rf) ** 2, size)[:taps]
    xc = np.fft.irfft(ef * np.conj(rf), size)  # xc[l] = sum_t est[t] ref[t - l]
    b = xc[np.arange(-half, taps - half) % size]
    h = solve_toeplitz(acf + np.r_[acf[0] * 1e-9, np.zeros(taps - 1)], b)
    projection = np.convolve(ref, h)[half:half + n]
    return 10 * np.log10(np.sum(projection ** 2) / max(np.sum((est - projection) ** 2), 1e-20))


def score(clean16, noisy16, deg16, lead):
    row = {}
    try:
        row['pesq'] = pesq(16000, clean16, deg16, 'wb')
    except Exception:  # no utterance found in the output
        row['pesq'] = None
    row['stoi'] = stoi(clean16, deg16, 16000, extended=False)
    row['sdr'], row['si_sdr'] = sdr(clean16, deg16), si_sdr(clean16, deg16)
    mos = dnsmos.run(np.clip(deg16, -1, 1).astype(np.float32), 16000)
    row['dnsmos_ovrl'], row['dnsmos_sig'], row['dnsmos_bak'] = float(mos['ovrl_mos']), float(mos['sig_mos']), float(mos['bak_mos'])
    # Noise-only lead-in (after the pre-roll the processing has settled).
    s, e = int(0.1 * 16000), int((lead - 0.1) * 16000)
    # Capped at 60 dB: beyond that the output is (close to) digital silence and the exact figure means nothing.
    row['noise_reduction_db'] = min(db(np.mean(noisy16[s:e] ** 2)) - db(np.mean(deg16[s:e] ** 2)), 60.0)
    fc, fd = frames(clean16), frames(deg16)
    active = fc > fc.max() * 1e-4
    row['speech_level_db'] = db(fd[active].mean()) - db(fc[active].mean())
    return row


def mean(values):
    values = [v for v in values if v is not None]
    return float(np.mean(values)) if values else None


def fmt(value, pattern):
    return '–' if value is None else pattern.format(value)


def table(rows, group_keys, modes, metrics):
    groups = sorted({tuple(r[k] for k in group_keys) for r in rows}, key=lambda g: tuple((isinstance(v, str), v) for v in g))
    lines = ['| ' + ' | '.join([*group_keys, 'mode', *[label for _, label, _ in metrics]]) + ' |',
             '|' + '---|' * (len(group_keys) + 1 + len(metrics))]
    for g in groups:
        for mode in modes:
            sel = [r for r in rows if r['mode'] == mode and tuple(r[k] for k in group_keys) == g]
            if not sel:
                continue
            cells = [str(v) for v in g] + [LABELS[mode]] + [fmt(mean([r[key] for r in sel]), p) for key, _, p in metrics]
            lines.append('| ' + ' | '.join(cells) + ' |')
    return '\n'.join(lines)


def chart(rows, modes, path):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    colors = {'input': '#8a8985', 'off': '#8a8985', 'browser': '#2a78d6', 'browser-noagc': '#1baf7a', 'ours': '#eb6834'}
    ink, muted, surface = '#0b0b0b', '#52514e', '#fcfcfb'
    shown = [m for m in modes if m != 'input']
    snrs = sorted({r['snr'] for r in rows})
    panels = [('pesq', 'PESQ wide-band (1–4.5)'), ('stoi', 'STOI (0–1)'), ('dnsmos_ovrl', 'DNSMOS overall (1–5)'), ('sdr', 'SDR, filter-compensated (dB)')]
    fig, axes = plt.subplots(2, 2, figsize=(11, 7.5), dpi=150, facecolor=surface)
    for ax, (key, title) in zip(axes.flat, panels):
        ax.set_facecolor(surface)
        ends = []
        for mode in shown:
            ys = [mean([r[key] for r in rows if r['mode'] == mode and r['snr'] == s]) for s in snrs]
            ax.plot(snrs, ys, color=colors[mode], linewidth=2, marker='o', markersize=6, markeredgecolor=surface, markeredgewidth=1.5,
                    linestyle='--' if mode == 'off' else '-', label=LABELS[mode], zorder=3)
            if ys[-1] is not None:
                ends.append([ys[-1], SHORT[mode]])
        # Direct labels at the line ends, spread apart so they never overlap: labels that would collide form a group,
        # spaced one gap apart and centred on the mean of their points, so each stays next to its own line.
        low, high = ax.get_ylim()
        gap = (high - low) * 0.07
        groups = [[y, [text]] for y, text in sorted(ends)]  # [centre, labels bottom to top]
        merged = True
        while merged:
            merged = False
            for i in range(len(groups) - 1):
                (c1, t1), (c2, t2) = groups[i], groups[i + 1]
                if c1 + (len(t1) - 1) * gap / 2 + gap > c2 - (len(t2) - 1) * gap / 2:
                    groups[i:i + 2] = [[(c1 * len(t1) + c2 * len(t2)) / (len(t1) + len(t2)), t1 + t2]]
                    merged = True
                    break
        ends = [(centre + (k - (len(texts) - 1) / 2) * gap, text) for centre, texts in groups for k, text in enumerate(texts)]
        for y, text in ends:
            ax.annotate(text, (snrs[-1], y), xytext=(8, 0), textcoords='offset points', va='center', fontsize=9, color=ink, annotation_clip=False)
        ax.set_title(title, loc='left', fontsize=11, color=ink)
        ax.set_xticks(snrs)
        ax.set_xlabel('Input speech-to-noise ratio (dB)', fontsize=9, color=muted)
        ax.grid(axis='y', color='#e4e3df', linewidth=0.8)
        ax.set_xlim(snrs[0] - 1, snrs[-1] + (snrs[-1] - snrs[0]) * 0.3)
        for side in ('top', 'right'):
            ax.spines[side].set_visible(False)
        for side in ('left', 'bottom'):
            ax.spines[side].set_color('#c9c8c3')
        ax.tick_params(colors=muted, labelsize=9)
    handles, labels = axes.flat[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc='upper center', ncol=len(shown), frameon=False, fontsize=9, bbox_to_anchor=(0.5, 0.955))
    noises = sorted({r['noise'] for r in rows})
    fig.suptitle(f'Noise suppression: mean over {", ".join(noises)} noise and {len({r["speech"] for r in rows})} speaker(s)', x=0.06, ha='left', fontsize=13, color=ink)
    fig.tight_layout(rect=(0, 0, 1, 0.92))
    fig.savefig(path, facecolor=surface)


def main(run):
    run = Path(run)
    manifest = json.loads((run / 'manifest.json').read_text())
    rate, lead, pre = manifest['rate'], manifest['lead'], int(manifest['preroll'] * manifest['rate'])
    modes = manifest['modes']
    rows, problems = [], []
    for c in manifest['conditions']:
        clean, noisy = read(c['clean']), read(c['noisy'])
        clean16, noisy16 = resample_poly(clean[pre:], 1, 3), resample_poly(noisy[pre:], 1, 3)
        base = {'condition': c['id'], 'speech': c['speech'], 'noise': c['noise'], 'snr': c['snr']}
        rows.append({**base, 'mode': 'input', **score(clean16, noisy16, noisy16, lead), 'sdr_gain': 0.0})
        input_sdr = rows[-1]['sdr']
        for mode in modes:
            if mode not in c['outputs']:
                continue
            aligned, offset, confidence = align(read(c['outputs'][mode]), clean, pre)
            out_dir = run / 'aligned' / mode
            out_dir.mkdir(parents=True, exist_ok=True)
            wavfile.write(out_dir / f"{c['id']}.wav", rate, (np.clip(aligned, -1, 1) * 32767).astype(np.int16))
            deg16 = resample_poly(aligned, 1, 3)
            row = {**base, 'mode': mode, **score(clean16, noisy16, deg16, lead)}
            row['sdr_gain'] = row['sdr'] - input_sdr
            row['align_confidence'], row['offset_ms'] = round(confidence, 1), round(offset / rate * 1000, 2)
            capture = c['capture'].get(mode, {})
            row['dropped_ms'], row['underruns'] = capture.get('droppedMs'), capture.get('underruns')
            row['slip_ms'], row['retries'] = capture.get('slipMs'), capture.get('retries')
            if (capture.get('slipMs') or 0) > 1:
                problems.append(f"{c['id']} {mode}: its delay moved by {capture['slipMs']:.1f} ms partway through, even after recapturing "
                                "(Chrome skipped audio or Ours's playout underran), so its STOI and SDR read low")
            if confidence < 8:
                problems.append(f"{c['id']} {mode}: weak alignment (confidence {confidence:.1f}); its scores may be wrong")
            if mode == 'browser-noagc' and capture.get('settings', {}).get('autoGainControl') is not False:
                problems.append(f"{c['id']}: Chrome reported autoGainControl {capture.get('settings', {}).get('autoGainControl')} for 'gain control off'")
            if mode == 'off':
                # The capture path itself should be transparent: Off against the noisy file it was fed.
                row['path_check_db'] = si_sdr(noisy16, deg16)
                if row['path_check_db'] < 20:
                    problems.append(f"{c['id']}: Off differs from its input file (SI-SDR {row['path_check_db']:.1f} dB); the capture path is not transparent")
            rows.append(row)
        print(f"scored {c['id']}: " + ', '.join(f"{r['mode']} PESQ {fmt(r['pesq'], '{:.2f}')}" for r in rows[-1 - len(c['outputs']):]))

    keys = ['condition', 'speech', 'noise', 'snr', 'mode', 'pesq', 'stoi', 'sdr', 'sdr_gain', 'si_sdr', 'dnsmos_ovrl', 'dnsmos_sig', 'dnsmos_bak',
            'noise_reduction_db', 'speech_level_db', 'align_confidence', 'offset_ms', 'path_check_db', 'dropped_ms', 'underruns', 'slip_ms', 'retries']
    with open(run / 'results.csv', 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=keys, extrasaction='ignore')
        writer.writeheader()
        for r in rows:
            writer.writerow({k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()})

    all_modes = ['input', *modes]
    clean_mos = {}
    for c in manifest['conditions']:
        if c['speech'] not in clean_mos:
            m = dnsmos.run(np.clip(resample_poly(read(c['clean'])[pre:], 1, 3), -1, 1).astype(np.float32), 16000)
            clean_mos[c['speech']] = float(m['ovrl_mos'])
    # Head-to-head: in how many conditions does one mode beat another on each metric?
    def head_to_head(first, second):
        lines = []
        for key, label, _ in METRICS[:5]:
            pairs = [(r, next((b for b in rows if b['condition'] == r['condition'] and b['mode'] == second), None)) for r in rows if r['mode'] == first]
            pairs = [(o[key], b[key]) for o, b in pairs if b and o[key] is not None and b[key] is not None]
            if pairs:
                lines.append(f"| {label} | {sum(o > b for o, b in pairs)} of {len(pairs)} | {np.mean([o - b for o, b in pairs]):+.3f} |")
        if not lines:
            return []
        return [f'## {SHORT[first]} against {SHORT[second]}, condition by condition', '',
                f'| Metric | {SHORT[first]} higher | Mean difference ({SHORT[first]} − {SHORT[second]}) |', '|---|---|---|', *lines, '']
    agc = ('Browser runs with automatic gain control on (its default). Its gain changes during a clip (it lifts quiet input by up to about 14 dB and '
           'then settles), which SDR counts as error and which can make the noise between words louder than in the input (negative noise reduction). '
           'PESQ and DNSMOS are not affected by slow level changes in the same way.')
    if 'browser-noagc' in modes:
        agc += (' "Browser, gain control off" is the same Chrome processing with automatic gain control off, so it shows Chrome\'s echo '
                'cancellation and noise suppression on their own; the difference between the two Browser rows is what the gain control does.')
    summary = [
        f"# Noise suppression benchmark ({manifest['startedAt'][:10]})", '',
        f"Browser: {manifest.get('browser')}. Switches for Browser and Ours: echo cancellation {'on' if manifest['switches']['echo'] else 'off'}, "
        f"noise suppression {'on' if manifest['switches']['noise'] else 'off'} (Browser also keeps automatic gain control on, as in a meeting"
        f"{'; Browser, gain control off turns it off' if 'browser-noagc' in modes else ''}). "
        f"Speech at {manifest['speechDb']} dBFS active level, {manifest['preroll']} s unscored noise pre-roll, then {lead} s scored noise-only lead-in. Each mode was captured live through Chrome's fake microphone "
        "from the same file; scores are against the clean speech at 16 kHz. Higher is better for every metric except speech level, where 0 dB means unchanged.", '',
        '## Overall (mean over all conditions)', '', table(rows, [], all_modes, METRICS), '',
        agc, '',
        *head_to_head('ours', 'browser'), *head_to_head('ours', 'browser-noagc'), *head_to_head('browser-noagc', 'browser'),
        '## By noise type', '', table(rows, ['noise'], all_modes, METRICS[:4] + METRICS[6:7]), '',
        '## By input SNR', '', table(rows, ['snr'], all_modes, METRICS[:4] + METRICS[6:7]), '',
        f"DNSMOS OVRL of the clean speech itself (the ceiling for this material): {', '.join(f'{k} {v:.2f}' for k, v in clean_mos.items())}.", '',
        '## Checks', '',
        *(f'- {p}' for p in problems or ['Every capture lined up with its source, kept one fixed delay throughout, and every Off capture matched the file it was fed (capture path transparent).']),
        *([f"- {sum(r.get('retries') or 0 for r in rows)} capture(s) were taken again after a timing slip (see retries in results.csv)."]
          if any(r.get('retries') for r in rows) else []),
        *([f"- Ours dropped audio in {sum(1 for r in rows if r['mode'] == 'ours' and r.get('dropped_ms'))} capture(s): see dropped_ms in results.csv."]
          if any(r['mode'] == 'ours' and r.get('dropped_ms') for r in rows) else []),
        '', 'Files: results.csv (every score), chart.png, aligned/<mode>/*.wav (outputs lined up with clean/ and noisy/ for listening).',
    ]
    (run / 'summary.md').write_text('\n'.join(summary) + '\n')
    chart(rows, modes, run / 'chart.png')
    print('\n'.join(summary))
    print(f'\nWrote {run / "results.csv"}, {run / "summary.md"}, {run / "chart.png"}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
