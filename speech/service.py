"""Local speech service: runs Omnilingual ASR on this computer for the meeting page.

The meeting page in this computer's browser sends each speech segment here over loopback and
forwards only the recognized text to the meeting server. Audio stays in memory and is never stored.
"""
import argparse
import io
import json
import logging
import os
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from recognition import LANGUAGES, MAX_SECONDS, SAMPLE_RATE, host_allowed, origin_allowed, recognize

parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument('--allow-origin', action='append', default=[], metavar='URL',
                    help='meeting site allowed to use this service, e.g. https://meet.example.com '
                         '(pages on localhost are always allowed; repeat for several sites)')
parser.add_argument('--port', type=int, default=int(os.getenv('SPEECH_PORT', '8765')))
# CTC 300M (1.2 GiB) is the default; an LLM model such as omniASR_LLM_1B_v2 (8.5 GiB) also uses the language hint.
parser.add_argument('--model', default=os.getenv('SPEECH_MODEL', 'omniASR_CTC_300M_v2'))
parser.add_argument('--device', default=os.getenv('SPEECH_DEVICE', 'auto'), help='auto, cpu, mps or cuda')
parser.add_argument('--dtype', default=os.getenv('SPEECH_DTYPE', 'auto'), help='auto, float32, float16 or bfloat16')
args = parser.parse_args()
origins = {o.rstrip('/') for o in args.allow_origin + os.getenv('SPEECH_ALLOWED_ORIGINS', '').split(',') if o.strip()}

# Omnilingual's CTC models ignore the language hint; only its LLM models are conditioned on it.
state = {'status': 'loading', 'model': args.model, 'device': None, 'error': None, 'languageHints': '_LLM_' in args.model}
pipeline = vad = None
lock = threading.Lock()


def pick_device(torch):
    if args.device != 'auto':
        return args.device
    if torch.cuda.is_available():
        return 'cuda'
    if torch.backends.mps.is_available():
        return 'mps'
    return 'cpu'


def pick_dtype(torch, device):
    if args.dtype != 'auto':
        return getattr(torch, args.dtype)
    # bfloat16 is the pipeline's default and suits CUDA; Apple GPUs run float16 well and CPUs float32.
    return {'cuda': torch.bfloat16, 'mps': torch.float16}.get(device, torch.float32)


def load():
    global pipeline, vad
    try:
        import torch
        from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline
        from silero_vad import load_silero_vad
        device = pick_device(torch)
        dtype = pick_dtype(torch, device)
        state['device'] = f'{device} ({str(dtype).removeprefix("torch.")})'
        started = time.monotonic()
        print(f'Loading {args.model} on {state["device"]}. The first start downloads its weights (1.2 GiB for omniASR_CTC_300M_v2, 8.5 GiB for omniASR_LLM_1B_v2).', flush=True)
        pipeline = ASRInferencePipeline(model_card=args.model, device=device, dtype=dtype)
        vad = load_silero_vad()
        # One warm-up pass so the first real sentence does not pay for kernel set-up.
        pipeline.transcribe([{'waveform': np.zeros(SAMPLE_RATE, dtype=np.float32), 'sample_rate': SAMPLE_RATE}], lang=[None], batch_size=1)
        state['status'] = 'ready'
        print(f'Speech model ready after {time.monotonic() - started:.0f}s; listening on http://127.0.0.1:{args.port}', flush=True)
    except Exception as error:  # noqa: BLE001 - reported to the page as well as the log
        logging.exception('Speech model failed to load')
        state.update(status='failed', error=f'{type(error).__name__}: {error}')


def has_speech(samples):
    import torch
    from silero_vad import get_speech_timestamps
    return bool(get_speech_timestamps(torch.from_numpy(samples), vad, sampling_rate=SAMPLE_RATE,
                                      threshold=0.35, min_speech_duration_ms=150))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # The per-request summary below is enough; never log audio or text.

    def cors(self):
        origin = self.headers.get('Origin')
        if origin and origin_allowed(origin, origins):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')

    def respond(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def refused(self):
        """Requests from other sites, or under another host name, get nothing from this service."""
        origin = self.headers.get('Origin')
        if not host_allowed(self.headers.get('Host', ''), args.port):
            self.respond(403, {'error': 'Unexpected host'})
            return True
        if origin and not origin_allowed(origin, origins):
            self.respond(403, {'error': f'{origin} is not allowed; restart the service with --allow-origin {origin}'})
            return True
        return False

    def do_OPTIONS(self):
        if self.refused():
            return
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Speech-Language')
        if self.headers.get('Access-Control-Request-Private-Network') == 'true':
            self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.refused():
            return
        if self.path != '/health':
            return self.respond(404, {'error': 'Not found'})
        self.respond(200, {**state, 'ready': state['status'] == 'ready', 'languages': list(LANGUAGES)})

    def do_POST(self):
        if self.refused():
            return
        if self.path != '/transcribe':
            return self.respond(404, {'error': 'Not found'})
        if state['status'] != 'ready':
            return self.respond(503, {'error': 'The speech model is still loading' if state['status'] == 'loading' else f'The speech model failed to load: {state["error"]}'})
        if self.headers.get_content_type() != 'audio/wav':
            return self.respond(415, {'error': 'Expected audio/wav'})
        language = self.headers.get('X-Speech-Language', 'auto')
        if language not in LANGUAGES:
            return self.respond(400, {'error': f'Language must be one of {", ".join(LANGUAGES)}'})
        try:
            self.connection.settimeout(10)
            length = int(self.headers.get('Content-Length', '0'))
            if not 44 + 3200 <= length <= 44 + MAX_SECONDS * SAMPLE_RATE * 2:
                return self.respond(400, {'error': 'Invalid audio size'})
            with wave.open(io.BytesIO(self.rfile.read(length))) as wav:
                if wav.getnchannels() != 1 or wav.getframerate() != SAMPLE_RATE or wav.getsampwidth() != 2:
                    return self.respond(400, {'error': 'Expected mono 16 kHz 16-bit PCM WAV'})
                pcm = wav.readframes(wav.getnframes())
            if len(pcm) != wav.getnframes() * 2:
                return self.respond(400, {'error': 'Truncated PCM audio'})
            samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
            # One recognition at a time; the page already sends its segments one by one.
            with lock:
                started = time.monotonic()
                text = recognize(pipeline, samples, language, has_speech)
                spent = time.monotonic() - started
            seconds = len(samples) / SAMPLE_RATE
            print(f'Audio {seconds:.2f}s, processing {spent:.2f}s (x{spent / seconds:.2f} real time), hint {language}, '
                  f'{"speech" if text else "no speech"}', flush=True)
            self.respond(200, {'text': text, 'seconds': seconds, 'processingSeconds': round(spent, 3)})
        except (ValueError, EOFError, wave.Error):
            self.respond(400, {'error': 'Invalid WAV'})
        except (BrokenPipeError, ConnectionError):
            pass  # The page went away; nothing to answer.
        except Exception:  # noqa: BLE001
            logging.exception('Speech processing failed')
            self.respond(500, {'error': 'Speech processing failed; see the speech service log'})


if __name__ == '__main__':
    # Listen first so the page can show "loading" during the long first download.
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    threading.Thread(target=load, daemon=True).start()
    allowed = ', '.join(sorted(origins)) or 'none besides localhost pages'
    print(f'Local speech service on http://127.0.0.1:{args.port} (model loading). Allowed meeting sites: {allowed}', flush=True)
    server.serve_forever()
