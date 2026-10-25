"""Tests for agy CLI runner retry mechanism and isolated execution."""

from unittest.mock import MagicMock, patch
import pytest
from udemy_th import translate_agy


def test_run_agy_succeeds_first_attempt():
    mock_res = MagicMock()
    mock_res.returncode = 0
    mock_res.stdout = "## SUBTITLES\n[[1]] สวัสดี"
    mock_res.stderr = ""

    with patch("subprocess.run", return_value=mock_res) as mock_run:
        out = translate_agy._run_agy("agy.exe", "test prompt", "high", None, "chunk 1")
        assert "## SUBTITLES" in out
        assert mock_run.call_count == 1


def test_run_agy_retries_on_exit_error_and_succeeds():
    mock_fail = MagicMock()
    mock_fail.returncode = 3
    mock_fail.stdout = ""
    mock_fail.stderr = "error: agent executor error: maxMessageTokens must be positive, got 0"

    mock_ok = MagicMock()
    mock_ok.returncode = 0
    mock_ok.stdout = "## SUBTITLES\n[[1]] แปลสำเร็จรอบสอง"
    mock_ok.stderr = ""

    with patch("subprocess.run", side_effect=[mock_fail, mock_ok]) as mock_run, patch("time.sleep") as mock_sleep:
        out = translate_agy._run_agy("agy.exe", "test prompt", "high", None, "chunk 1")
        assert "[[1]] แปลสำเร็จรอบสอง" in out
        assert mock_run.call_count == 2
        mock_sleep.assert_called_once()


def test_run_agy_retries_on_format_error_and_succeeds():
    mock_bad_fmt = MagicMock()
    mock_bad_fmt.returncode = 0
    mock_bad_fmt.stdout = "I cannot translate this right now."
    mock_bad_fmt.stderr = ""

    mock_ok = MagicMock()
    mock_ok.returncode = 0
    mock_ok.stdout = "## SUBTITLES\n[[1]] แปลสำเร็จรอบสอง"
    mock_ok.stderr = ""

    with patch("subprocess.run", side_effect=[mock_bad_fmt, mock_ok]) as mock_run, patch("time.sleep") as mock_sleep:
        out = translate_agy._run_agy("agy.exe", "test prompt", "high", None, "chunk 1")
        assert "## SUBTITLES" in out
        assert mock_run.call_count == 2
        mock_sleep.assert_called_once()


def test_run_agy_exhausts_retries():
    mock_fail = MagicMock()
    mock_fail.returncode = 3
    mock_fail.stdout = ""
    mock_fail.stderr = "persistent error"

    with patch("subprocess.run", return_value=mock_fail) as mock_run, patch("time.sleep"):
        with pytest.raises(RuntimeError, match="agy ล้มเหลว"):
            translate_agy._run_agy("agy.exe", "test prompt", "high", None, "chunk 1")
        assert mock_run.call_count == translate_agy.MAX_RETRIES
