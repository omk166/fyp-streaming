import unittest
from types import SimpleNamespace
from recognition import recognize, select_language


class Model:
    def __init__(self):
        self.options = None

    def detect_language(self, **kwargs):
        # Even if Chinese is ranked first, it cannot become the decoding language.
        return 'zh', 0.8, [('zh', 0.8), ('hi', 0.1), ('ar', 0.06), ('en', 0.04)]

    def transcribe(self, samples, **kwargs):
        self.options = kwargs
        return [SimpleNamespace(start=0, end=1, text='مرحبا hello')], None


class RecognitionTests(unittest.TestCase):
    def test_auto_selects_only_allowed_languages(self):
        model = Model()
        self.assertEqual(select_language(model, [], 'auto'), 'ar')
        self.assertEqual(select_language(model, [], 'en'), 'en')
        self.assertEqual(select_language(model, [], 'ar'), 'ar')
        with self.assertRaises(ValueError):
            select_language(model, [], 'zh')

    def test_decode_cannot_redetect_an_unrelated_language(self):
        model = Model()
        self.assertEqual(recognize(model, [], 'auto')[0]['text'], 'مرحبا hello')
        self.assertEqual(model.options['language'], 'ar')
        self.assertFalse(model.options['multilingual'])
        self.assertEqual(model.options['task'], 'transcribe')


if __name__ == '__main__':
    unittest.main()
