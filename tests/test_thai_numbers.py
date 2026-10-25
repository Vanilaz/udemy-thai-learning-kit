"""Numbers are read out as Thai words; code-like tokens are left alone."""

from __future__ import annotations

import unittest

from udemy_th.thai_numbers import number_words, spell_numbers


class NumberWordsTests(unittest.TestCase):
    def test_thai_reading_rules(self):
        cases = {
            0: "ศูนย์", 1: "หนึ่ง", 10: "สิบ", 11: "สิบเอ็ด", 12: "สิบสอง", 20: "ยี่สิบ", 21: "ยี่สิบเอ็ด",
            100: "หนึ่งร้อย", 101: "หนึ่งร้อยเอ็ด", 110: "หนึ่งร้อยสิบ", 2025: "สองพันยี่สิบห้า",
            15000: "หนึ่งหมื่นห้าพัน", 1_000_000: "หนึ่งล้าน", 1_000_001: "หนึ่งล้านหนึ่ง",
            21_000_000: "ยี่สิบเอ็ดล้าน",
        }
        for n, words in cases.items():
            with self.subTest(n=n):
                self.assertEqual(number_words(n), words)


class SpellNumbersTests(unittest.TestCase):
    def test_standalone_numbers_in_a_lecture_sentence(self):
        self.assertEqual(
            spell_numbers("ตัวแปร count เริ่มต้นที่ 0 แล้วเพิ่มขึ้นทีละ 1 ทุกครั้งที่วนลูป"),
            "ตัวแปร count เริ่มต้นที่ ศูนย์ แล้วเพิ่มขึ้นทีละ หนึ่ง ทุกครั้งที่วนลูป",
        )
        self.assertEqual(spell_numbers("ในปี 2025 ใช้ JavaScript"), "ในปี สองพันยี่สิบห้า ใช้ JavaScript")
        self.assertEqual(spell_numbers("ในบทที่12เรา"), "ในบทที่สิบสองเรา")

    def test_decimals_separators_and_percent(self):
        self.assertEqual(spell_numbers("ราคา 1,500 บาท"), "ราคา หนึ่งพันห้าร้อย บาท")
        self.assertEqual(spell_numbers("ค่า 3.14"), "ค่า สามจุดหนึ่งสี่")
        self.assertEqual(spell_numbers("เพิ่ม 50% ทันที"), "เพิ่ม ห้าสิบเปอร์เซ็นต์ ทันที")

    def test_code_and_names_are_left_alone(self):
        for text in ["ใช้แท็ก h1 กับ h2", "รองรับ ES6 แล้ว", "เวอร์ชัน v2.0", "ไฟล์ index2.html",
                     "ไอพี 192.168.0.1", "พอร์ต localhost:8080", "#1 ในใจ"]:
            with self.subTest(text=text):
                self.assertEqual(spell_numbers(text), text)

    def test_a_number_after_a_name_is_still_read(self):
        self.assertEqual(spell_numbers("ใช้ Node.js 18 ขึ้นไป"), "ใช้ Node.js สิบแปด ขึ้นไป")


if __name__ == "__main__":
    unittest.main()
