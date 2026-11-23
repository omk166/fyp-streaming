import unittest

import numpy as np

from recognition import host_allowed, language_hint, origin_allowed, recognize


class Pipeline:
    def __init__(self, text='  مرحبا   hello '):
        self.text, self.calls = text, []

    def transcribe(self, inputs, lang=None, batch_size=2):
        self.calls.append({'inputs': inputs, 'lang': lang, 'batch_size': batch_size})
        return [self.text]


class RecognitionTests(unittest.TestCase):
    def test_language_hints_are_omnilingual_codes_and_auto_sends_none(self):
        self.assertIsNone(language_hint('auto'))
        self.assertEqual(language_hint('apc_Arab'), 'apc_Arab')
        self.assertEqual(language_hint('arb_Arab'), 'arb_Arab')
        self.assertEqual(language_hint('eng_Latn'), 'eng_Latn')
        for unsupported in ('en', 'ar', 'fra_Latn', ''):
            with self.assertRaises(ValueError):
                language_hint(unsupported)

    def test_one_in_memory_clip_per_call_with_its_hint(self):
        pipeline, samples = Pipeline(), np.zeros(16000, dtype=np.float32)
        self.assertEqual(recognize(pipeline, samples, 'apc_Arab'), 'مرحبا hello')
        [call] = pipeline.calls
        self.assertEqual(call['lang'], ['apc_Arab'])
        self.assertEqual(call['batch_size'], 1)
        self.assertIs(call['inputs'][0]['waveform'], samples)
        self.assertEqual(call['inputs'][0]['sample_rate'], 16000)
        recognize(pipeline, samples, 'auto')
        self.assertEqual(pipeline.calls[-1]['lang'], [None])

    def test_no_speech_never_reaches_the_model(self):
        pipeline = Pipeline()
        self.assertEqual(recognize(pipeline, np.zeros(16000, dtype=np.float32), 'auto', has_speech=lambda _: False), '')
        self.assertEqual(pipeline.calls, [])

    def test_over_long_audio_is_refused_before_inference(self):
        pipeline = Pipeline()
        with self.assertRaises(ValueError):
            recognize(pipeline, np.zeros(41 * 16000, dtype=np.float32))
        self.assertEqual(pipeline.calls, [])

    def test_only_local_pages_and_listed_sites_may_use_the_service(self):
        self.assertTrue(origin_allowed('http://127.0.0.1:3000'))
        self.assertTrue(origin_allowed('https://localhost:8443'))
        self.assertTrue(origin_allowed('https://meet.example.com', {'https://meet.example.com'}))
        self.assertFalse(origin_allowed('https://evil.example'))
        self.assertFalse(origin_allowed('https://127.0.0.1.evil.example'))
        self.assertFalse(origin_allowed('null'))
        self.assertTrue(host_allowed('127.0.0.1:8765', 8765))
        self.assertTrue(host_allowed('localhost:8765', 8765))
        self.assertFalse(host_allowed('rebound.example:8765', 8765))


if __name__ == '__main__':
    unittest.main()
