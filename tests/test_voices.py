"""Voice engine regressions: OmniVoice instruct vocabulary, Seamless cache."""

from __future__ import annotations

import hashlib
import re
import tempfile
import unittest
from pathlib import Path

from udemy_th import omnivoice_tts, seamless_tts, tts

I18N = Path(__file__).resolve().parent.parent / "extension" / "core" / "i18n.js"
THAI = re.compile(r"[฀-๿]")


class OmniVoiceInstructTests(unittest.TestCase):
    def test_every_preset_passes_the_models_own_validator(self):
        try:
            from omnivoice.models.omnivoice import _resolve_instruct
        except Exception as exc:  # omnivoice is an optional GPU extra
            self.skipTest(f"omnivoice not installed: {exc}")
        for voice, instruct in omnivoice_tts._INSTRUCTIONS.items():
            with self.subTest(voice=voice):
                self.assertTrue(_resolve_instruct(instruct))

    def test_every_listed_voice_except_clone_has_an_instruct(self):
        presets = set(omnivoice_tts.VOICES) - {"omnivoice:clone"}
        self.assertEqual(presets, set(omnivoice_tts._INSTRUCTIONS))


class LabelTranslationTests(unittest.TestCase):
    """The extension shows engine and voice names in English too; its table
    (SERVER_LABELS_EN in extension/core/i18n.js) must list exactly the Thai
    names the server sends."""

    def test_every_thai_engine_or_voice_name_has_an_english_one_and_no_more(self):
        with tempfile.TemporaryDirectory() as cache:
            catalogue = tts.TtsRegistry(Path(cache)).catalogue()
        sent = {e["label"] for e in catalogue} | {v["label"] for e in catalogue for v in e["voices"]}
        table = re.search(r"const SERVER_LABELS_EN = \{(.*?)\n  \};", I18N.read_text(encoding="utf-8"), re.S)
        translated = set(re.findall(r'^\s*"([^"]*)":', table.group(1), re.M))
        self.assertEqual({label for label in sent if THAI.search(label)}, translated)


class SeamlessCacheTests(unittest.TestCase):
    def test_second_request_is_served_from_cache_without_the_model(self):
        cache = Path(tempfile.mkdtemp())
        engine = seamless_tts.SeamlessTts(cache)
        text = "ทดสอบแคช"
        key = hashlib.sha256(f"seamless:{seamless_tts.MODEL_ID}:{text}".encode("utf-8")).hexdigest()[:24]
        (cache / "audio").mkdir(parents=True)
        (cache / "audio" / f"{key}.wav").write_bytes(b"RIFF")

        def no_model():
            raise AssertionError("model must not load for a cached sentence")

        engine._ensure_loaded = no_model
        self.assertEqual(engine.synthesize(text), {"file": f"{key}.wav", "cached": True})


class SeamlessLanguageTests(unittest.TestCase):
    def test_site_language_codes_map_to_seamless(self):
        cases = {
            None: "tha", "": "tha", "th": "tha", "en": "eng", "EN": "eng", "en_US": "eng",
            "es-419": "spa", "pt-BR": "por", "hi": "hin", "ja": "jpn", "zh-Hans": "cmn",
            "zh-TW": "cmn_Hant", "iw": "heb", "fil": "tgl", "eng": "eng",
        }
        for code, expected in cases.items():
            with self.subTest(code=code):
                self.assertEqual(seamless_tts.seamless_lang(code), expected)

    def test_unknown_language_is_refused_not_guessed(self):
        from udemy_th.google_tts import TtsError

        with self.assertRaises(TtsError):
            seamless_tts.seamless_lang("qq")

    def test_every_mapped_code_is_a_language_the_model_reads(self):
        try:
            from transformers import AutoTokenizer

            tok = AutoTokenizer.from_pretrained(seamless_tts.MODEL_ID, local_files_only=True)
        except Exception as exc:
            self.skipTest(f"model tokenizer not available offline: {exc}")
        vocab = tok.get_vocab()
        for code in set(seamless_tts.LANG_CODES.values()) | {"cmn_Hant"}:
            with self.subTest(code=code):
                self.assertIn(f"__{code}__", vocab)

    def test_thai_keeps_its_old_cache_key(self):
        key = hashlib.sha256(f"seamless:{seamless_tts.MODEL_ID}:สวัสดี".encode("utf-8")).hexdigest()[:24]
        self.assertEqual(seamless_tts.SeamlessTts.cache_key("สวัสดี", "tha"), key)
        self.assertNotEqual(seamless_tts.SeamlessTts.cache_key("hello", "eng"), seamless_tts.SeamlessTts.cache_key("hello", "spa"))


class ThaiTextTests(unittest.TestCase):
    def test_split_sara_am_from_seamless_is_joined(self):
        self.assertEqual(seamless_tts.tidy_thai("กําหนด สําหรับ"), "กำหนด สำหรับ")


class RoutingTests(unittest.TestCase):
    def test_original_text_is_refused_by_engines_that_cannot_translate(self):
        from udemy_th.google_tts import TtsError
        from udemy_th.tts import TtsRegistry

        registry = TtsRegistry(Path(tempfile.mkdtemp()))
        with self.assertRaises(TtsError):
            registry.synthesize("Hello", "th-TH-NiwatNeural", "en")
        engines = {e["name"]: e["translates"] for e in registry.catalogue()}
        self.assertTrue(engines["seamless"])
        self.assertFalse(engines["edge"])


if __name__ == "__main__":
    unittest.main()
