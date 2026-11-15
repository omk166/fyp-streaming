"""Private loopback-only inference worker. Audio stays in memory."""
import io
import json
import logging
import os
import threading
import time
import wave
import numpy as np
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from faster_whisper import WhisperModel
from faster_whisper.vad import get_speech_timestamps, VadOptions
from recognition import recognize

model = WhisperModel(os.getenv('WHISPER_MODEL', 'small'),
                     device=os.getenv('WHISPER_DEVICE', 'cpu'),
                     compute_type=os.getenv('WHISPER_COMPUTE_TYPE', 'int8'),
                     download_root=os.getenv('WHISPER_DOWNLOAD_ROOT'),
                     cpu_threads=int(os.getenv('WHISPER_CPU_THREADS', '2')))
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.respond(200 if self.path == '/health' else 404, {'ready': self.path == '/health'})

    def do_POST(self):
        if self.path != '/transcribe':
            return self.respond(404, {'error': 'Not found'})
        if not lock.acquire(blocking=False):
            return self.respond(503, {'error': 'Busy'})
        try:
            self.connection.settimeout(10)
            length = int(self.headers.get('Content-Length', '0'))
            if not 3244 <= length <= 256044:
                return self.respond(400, {'error': 'Invalid audio size'})
            audio = self.rfile.read(length)
            with wave.open(io.BytesIO(audio)) as wav:
                if wav.getnchannels() != 1 or wav.getframerate() != 16000 or wav.getsampwidth() != 2 or not 1600 <= wav.getnframes() <= 128000:
                    return self.respond(400, {'error': 'Expected mono 16kHz PCM WAV'})
                pcm = wav.readframes(wav.getnframes())
                if len(pcm) != wav.getnframes() * 2:
                    return self.respond(400, {'error': 'Truncated PCM audio'})
            # Our browser already sends validated 16kHz PCM: no codec decoding needed.
            samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
            language = self.headers.get('X-Speech-Language', 'auto')
            if language not in ('auto', 'ar', 'en'):
                return self.respond(400, {'error': 'Choose Arabic and/or English'})
            started = time.monotonic()
            # Never ask language detection to guess a language from silence.
            speech = get_speech_timestamps(samples, VadOptions(threshold=0.35, min_speech_duration_ms=150))
            result = recognize(model, samples, language, int(os.getenv('WHISPER_BEAM_SIZE', '1'))) if speech else []
            print(f'Audio {len(samples)/16000:.2f}s, processing {time.monotonic()-started:.2f}s, mode {language}, segments {len(result)}', flush=True)
            self.respond(200, {'segments': result})
        except (ValueError, EOFError, wave.Error):
            self.respond(400, {'error': 'Invalid WAV'})
        except (BrokenPipeError, ConnectionError):
            pass  # Client disconnected; do not try to send another response.
        except Exception:
            logging.exception('Speech processing failed')
            self.respond(503, {'error': 'Speech processing failed'})
        finally:
            lock.release()


if __name__ == '__main__':
    print('Speech model ready; listening on http://127.0.0.1:' + os.getenv('WHISPER_PORT', '8765'), flush=True)
    ThreadingHTTPServer(('127.0.0.1', int(os.getenv('WHISPER_PORT', '8765'))), Handler).serve_forever()
