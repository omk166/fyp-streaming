"""Recognition policy isolated from HTTP/model startup for regression tests."""
ALLOWED_LANGUAGES = ('ar', 'en')


def select_language(model, samples, requested):
    if requested in ALLOWED_LANGUAGES:
        return requested
    if requested != 'auto':
        raise ValueError('Only Arabic and English are configured')
    _, _, probabilities = model.detect_language(audio=samples, vad_filter=False)
    candidates = [(language, probability) for language, probability in probabilities
                  if language in ALLOWED_LANGUAGES]
    if not candidates:
        raise ValueError('No Arabic/English language scores returned')
    return max(candidates, key=lambda item: item[1])[0]


def recognize(model, samples, requested='auto', beam_size=1):
    language = select_language(model, samples, requested)
    segments, _ = model.transcribe(
        samples, task='transcribe', language=language, multilingual=False,
        vad_filter=True,
        vad_parameters={'threshold': 0.35, 'min_speech_duration_ms': 150,
                        'min_silence_duration_ms': 400, 'speech_pad_ms': 200},
        condition_on_previous_text=False, temperature=0.0, beam_size=beam_size)
    return [{'start': s.start, 'end': s.end, 'text': s.text} for s in segments]
