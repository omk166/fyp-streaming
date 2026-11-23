"""Recognition policy, kept apart from HTTP and model loading so it can be tested without the model."""
from urllib.parse import urlsplit

# Language hints the meeting page offers, as Omnilingual ASR codes. 'auto' sends no hint, so the model picks
# the language itself, which suits mixed Arabic/English speech. CTC models ignore the hint altogether.
LANGUAGES = {
    'auto': None,
    'apc_Arab': 'apc_Arab',  # North Levantine Arabic (Lebanese)
    'arb_Arab': 'arb_Arab',  # Modern Standard Arabic
    'eng_Latn': 'eng_Latn',
}
SAMPLE_RATE = 16000
MAX_SECONDS = 40  # Omnilingual ASR's pipeline rejects longer inputs.
LOOPBACK_HOSTS = ('localhost', '127.0.0.1', '::1')


def language_hint(requested):
    if requested not in LANGUAGES:
        raise ValueError('Unsupported language')
    return LANGUAGES[requested]


def recognize(pipeline, samples, requested='auto', has_speech=lambda samples: True):
    """Text for one mono 16 kHz float32 clip, or '' when the clip holds no speech."""
    hint = language_hint(requested)
    if len(samples) > MAX_SECONDS * SAMPLE_RATE:
        raise ValueError(f'Audio longer than {MAX_SECONDS} seconds')
    # Skip clips with no speech: they cost a full inference, and an LLM decoder given only noise can invent a sentence.
    if not has_speech(samples):
        return ''
    [text] = pipeline.transcribe([{'waveform': samples, 'sample_rate': SAMPLE_RATE}], lang=[hint], batch_size=1)
    return ' '.join(text.split())


def origin_allowed(origin, extra=()):
    """Pages on this computer are always allowed; a deployed meeting site must be listed explicitly."""
    if origin in extra:
        return True
    try:
        parts = urlsplit(origin)
        return parts.scheme in ('http', 'https') and parts.hostname in LOOPBACK_HOSTS
    except ValueError:
        return False


def host_allowed(host, port):
    """Rejects DNS-rebinding requests that reach 127.0.0.1 under another name."""
    return host in (f'127.0.0.1:{port}', f'localhost:{port}', f'[::1]:{port}')
