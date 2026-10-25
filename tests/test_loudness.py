"""Every dubbed line is brought to the same speech level."""
import io
import math
import unittest
import wave
from array import array

from udemy_th import loudness

RATE = 24000


def tone(amplitude, seconds=1.0, pause=0.0):
    """A 220 Hz tone at `amplitude` (of full scale), then `pause` seconds of silence."""
    n = int(RATE * seconds)
    samples = array("h", (round(amplitude * 32767 * math.sin(2 * math.pi * 220 * i / RATE)) for i in range(n)))
    samples.extend([0] * int(RATE * pause))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(samples.tobytes())
    return buffer.getvalue()


def read(data):
    with wave.open(io.BytesIO(data)) as w:
        samples = array("h")
        samples.frombytes(w.readframes(w.getnframes()))
        return samples, w.getparams()


def level(data):
    samples, params = read(data)
    return loudness.speech_level(samples, params.framerate)


class LoudnessTests(unittest.TestCase):
    def test_quiet_and_loud_lines_come_out_at_the_same_level(self):
        quiet = loudness.normalize_wav(tone(0.02))
        loud = loudness.normalize_wav(tone(0.4))
        self.assertAlmostEqual(level(quiet), level(loud), delta=1.0)
        self.assertAlmostEqual(level(loud), loudness.TARGET_DBFS, delta=1.0)

    def test_pauses_do_not_make_a_line_count_as_quieter(self):
        steady = loudness.normalize_wav(tone(0.1))
        paused = loudness.normalize_wav(tone(0.1, pause=3.0))
        self.assertAlmostEqual(level(steady), level(paused), delta=0.5)

    def test_turning_a_line_up_never_clips(self):
        peaky = tone(0.95)
        out, _ = read(loudness.normalize_wav(peaky))
        self.assertLess(max(map(abs, out)), 32767)

    def test_the_format_and_length_are_kept(self):
        original = tone(0.02, seconds=0.7)
        out, params = read(loudness.normalize_wav(original))
        _, before = read(original)
        self.assertEqual((params.nchannels, params.sampwidth, params.framerate), (1, 2, RATE))
        self.assertEqual(len(out), before.nframes)

    def test_anything_it_cannot_level_comes_back_untouched(self):
        silence = tone(0.0)
        for data in (b"ID3\x04not a wav", silence, b""):
            self.assertEqual(loudness.normalize_wav(data), data)


if __name__ == "__main__":
    unittest.main()
