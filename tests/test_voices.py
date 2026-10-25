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


class FakeOmniVoice:
    """Stands in for the model: records what it is asked, makes no sound."""

    def __init__(self):
        self.generated, self.prompts, self.transcribed = [], [], 0
        self._asr_pipe = None

    def create_voice_clone_prompt(self, ref_audio, ref_text=None):
        self.prompts.append((ref_audio, ref_text))
        return f"prompt-{len(self.prompts)}"

    def load_asr_model(self):
        self._asr_pipe = object()

    def transcribe(self, audio):
        self.transcribed += 1
        return "สวัสดีครับ นี่คือเสียงของผม"

    def generate(self, **kwargs):
        self.generated.append(kwargs)
        return [[0.0]]


class OmniVoiceCloneTests(unittest.TestCase):
    """Cloning: one speaker for the whole lecture, from the reference clip."""

    def engine(self, cache: Path, reference: Path | None, text: str | None = None):
        engine = omnivoice_tts.OmniVoiceTts(cache)
        engine.reference = str(reference) if reference else None
        engine.reference_text = text
        model = FakeOmniVoice()
        engine._load = lambda: model
        engine._write_wav = lambda audio, output: output.write_bytes(b"RIFF")
        return engine, model

    def test_every_sentence_uses_the_same_voice_from_the_clip(self):
        with tempfile.TemporaryDirectory() as tmp:
            clip = Path(tmp) / "me.wav"
            clip.write_bytes(b"clip")
            engine, model = self.engine(Path(tmp), clip, text="สวัสดีครับ")
            engine.synthesize("ประโยคแรก", "omnivoice:clone")
            engine.synthesize("ประโยคที่สอง", "omnivoice:clone")
        self.assertEqual(model.prompts, [(str(clip), "สวัสดีครับ")], "the voice is built once")
        self.assertEqual([g["voice_clone_prompt"] for g in model.generated], ["prompt-1", "prompt-1"])

    def test_only_names_the_model_declares_are_passed(self):
        # generate() silently drops names it does not know; a misnamed
        # reference clip was dropped that way and every sentence got a random voice.
        try:
            import inspect

            from omnivoice.models.omnivoice import OmniVoice
        except Exception as exc:  # omnivoice is an optional GPU extra
            self.skipTest(f"omnivoice not installed: {exc}")
        declared = set(inspect.signature(OmniVoice.generate).parameters) - {"self", "kwargs"}
        with tempfile.TemporaryDirectory() as tmp:
            clip = Path(tmp) / "me.wav"
            clip.write_bytes(b"clip")
            engine, model = self.engine(Path(tmp), clip, text="สวัสดีครับ")
            for voice in omnivoice_tts.VOICES:
                with self.subTest(voice=voice):
                    self.assertLessEqual(set(engine._generate_args(model, "ทดสอบ", voice)), declared)

    def test_without_a_transcript_the_clip_is_transcribed_once_and_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            clip = Path(tmp) / "me.wav"
            clip.write_bytes(b"clip")
            first, model1 = self.engine(Path(tmp), clip)
            first.synthesize("ประโยคแรก", "omnivoice:clone")
            second, model2 = self.engine(Path(tmp), clip)  # a server restart
            second.synthesize("ประโยคที่สอง", "omnivoice:clone")
        self.assertEqual((model1.transcribed, model2.transcribed), (1, 0))
        self.assertEqual(model2.prompts[0][1], "สวัสดีครับ นี่คือเสียงของผม")

    def test_a_missing_clip_is_named_rather_than_voiced_at_random(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine, model = self.engine(Path(tmp), Path(tmp) / "gone.wav")
            with self.assertRaises(omnivoice_tts.TtsError) as caught:
                engine.synthesize("ประโยค", "omnivoice:clone")
        self.assertIn("gone.wav", str(caught.exception))
        self.assertEqual(model.generated, [])

    def test_a_new_clip_in_the_same_place_is_not_answered_from_the_cache(self):
        import os

        with tempfile.TemporaryDirectory() as tmp:
            clip = Path(tmp) / "me.wav"
            clip.write_bytes(b"clip")
            engine, model = self.engine(Path(tmp), clip, text="สวัสดีครับ")
            engine.synthesize("ประโยคเดิม", "omnivoice:clone")
            clip.write_bytes(b"a different speaker")
            os.utime(clip, (1, 1))
            result = engine.synthesize("ประโยคเดิม", "omnivoice:clone")
        self.assertFalse(result["cached"])
        self.assertEqual(len(model.prompts), 2, "the new clip is a new voice")


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
        # Both generations: v1 and v2 spell Malay differently, and a server
        # may run v1 locally while a Colab GPU runs v2.
        from transformers import AutoTokenizer

        checked = 0
        for model_id in ("facebook/hf-seamless-m4t-medium", "facebook/seamless-m4t-v2-large"):
            try:
                vocab = AutoTokenizer.from_pretrained(model_id, local_files_only=True).get_vocab()
            except Exception:
                continue  # not downloaded on this machine
            checked += 1
            for primary in set(seamless_tts.LANG_CODES) | {"zh-hant"}:
                code = seamless_tts.seamless_lang(primary, model_id)
                with self.subTest(model=model_id, lang=primary):
                    self.assertIn(f"__{code}__", vocab)
        if not checked:
            self.skipTest("no Seamless tokenizer available offline")

    def test_malay_is_spelled_for_the_model_generation(self):
        self.assertEqual(seamless_tts.seamless_lang("ms", "facebook/hf-seamless-m4t-medium"), "zsm")
        self.assertEqual(seamless_tts.seamless_lang("ms", "facebook/seamless-m4t-v2-large"), "zlm")
        self.assertEqual(seamless_tts.seamless_lang("zsm", "facebook/seamless-m4t-v2-large"), "zlm")

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
