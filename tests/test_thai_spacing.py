from udemy_th.build import _format_thai_spacing, _parse_subtitles


def test_format_thai_spacing_inserts_space_between_thai_and_english():
    raw = "เราจะใช้AngularCLIเพื่อสร้างเว็บ"
    formatted = _format_thai_spacing(raw)
    assert formatted == "เราจะใช้ AngularCLI เพื่อสร้างเว็บ"


def test_format_thai_spacing_preserves_existing_spaces():
    raw = "เราจะใช้ Angular CLI เพื่อสร้างเว็บ"
    formatted = _format_thai_spacing(raw)
    assert formatted == "เราจะใช้ Angular CLI เพื่อสร้างเว็บ"


def test_format_thai_spacing_with_digits():
    raw = "Angular20และ.NET9"
    formatted = _format_thai_spacing(raw)
    assert "Angular 20" in formatted or "Angular20" in formatted
    # Thai to digit
    th_digit = "บทที่1ของคอร์ส"
    assert _format_thai_spacing(th_digit) == "บทที่ 1 ของคอร์ส"


def test_parse_subtitles_applies_formatting():
    block = """
[[1]] เราจะใช้AngularCLIเพื่อสร้างเว็บ
[[2]] แอปพลิเคชันAngularของเรา
"""
    result = _parse_subtitles(block)
    assert result[1] == "เราจะใช้ AngularCLI เพื่อสร้างเว็บ"
    assert result[2] == "แอปพลิเคชัน Angular ของเรา"
