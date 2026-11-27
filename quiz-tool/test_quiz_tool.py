"""Offline tests for quiz_tool.py — no API key or network required.

Run:  python -m pytest test_quiz_tool.py   (or: python test_quiz_tool.py)
"""

from __future__ import annotations

import base64
import json
import sys
import unittest
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import quiz_tool  # noqa: E402


def make_image(path: Path, w: int = 2400, h: int = 1500) -> None:
    im = Image.new("RGB", (w, h), (240, 240, 250))
    im.save(path, format="PNG")


class Schemas(unittest.TestCase):
    def test_extract_schema_validates(self):
        q = quiz_tool.ExtractedQuestion.model_validate({
            "question_number": "3 of 10",
            "question_type": "single_choice",
            "question": "What is 2+2?",
            "options": [{"label": "", "text": "3"}, {"label": "B", "text": "4"}],
        })
        self.assertEqual(q.options[0].label, "A")          # auto-assigned letter
        self.assertEqual(q.question_type, "single_choice")

    def test_bad_question_type_rejected(self):
        with self.assertRaises(Exception):
            quiz_tool.ExtractedQuestion.model_validate({
                "question_type": "essay", "question": "x", "options": []})

    def test_answer_schema_case_insensitive_labels(self):
        a = quiz_tool.AnsweredQuestion(correct_labels=["a"], explanation="ok", confidence="high")
        self.assertEqual(a.correct_labels, ["a"])
        with self.assertRaises(Exception):
            quiz_tool.AnsweredQuestion(correct_labels=["a"], explanation="", confidence="very-high")


class Preprocessing(unittest.TestCase):
    def test_downscale_long_edge(self):
        with TemporaryDirectory() as d:
            p = Path(d) / "big.png"
            make_image(p, 3000, 900)
            data, media = quiz_tool.prepare_image(p)
            with Image.open(BytesIO(data)) as out:
                self.assertLessEqual(max(out.size), 1568)
                self.assertEqual(out.mode, "RGB")
            self.assertEqual(media, "image/png")
            base64.standard_b64encode(data)  # must be encodable

    def test_crop_flag(self):
        with TemporaryDirectory() as d:
            p = Path(d) / "q.png"
            make_image(p, 1000, 800)
            data, _ = quiz_tool.prepare_image(p, crop=(0, 100, 0, 150))
            with Image.open(BytesIO(data)) as out:
                self.assertEqual(out.height, 550)

    def test_sha256_stable(self):
        with TemporaryDirectory() as d:
            p = Path(d) / "a.png"
            make_image(p, 10, 10)
            self.assertEqual(quiz_tool.sha256_file(p), quiz_tool.sha256_file(p))


class CostAndRetry(unittest.TestCase):
    def test_price_lookup(self):
        self.assertEqual(quiz_tool.price_for("claude-haiku-5-5")["in"], 0.10)
        self.assertEqual(quiz_tool.price_for("claude-opus-5-5")["out"], 20.00)

    def test_retry_on_429_then_success(self):
        err = quiz_tool.anthropic.APIStatusError.__new__(quiz_tool.anthropic.APIStatusError)
        err.status_code = 429
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] < 3:
                raise err
            return "ok"

        with mock.patch.object(quiz_tool.time, "sleep"):
            self.assertEqual(quiz_tool.call_with_retry(flaky, what="t"), "ok")
        self.assertEqual(calls["n"], 3)

    def test_non_retryable_raises_immediately(self):
        err = quiz_tool.anthropic.APIStatusError.__new__(quiz_tool.anthropic.APIStatusError)
        err.status_code = 400
        n = {"c": 0}

        def bad():
            n["c"] += 1
            raise err
        with self.assertRaises(quiz_tool.anthropic.APIStatusError):
            quiz_tool.call_with_retry(bad, what="t")
        self.assertEqual(n["c"], 1)


class Outputs(unittest.TestCase):
    def test_json_and_csv_written(self):
        results = [{
            "file": "s1.png",
            "extraction": {"question": "Capital of France?", "options": [
                {"label": "A", "text": "Paris"}, {"label": "B", "text": "Lyon"}]},
            "answer": {"correct_labels": ["A"], "confidence": "high"},
        }, {"file": "bad.png", "error": "RuntimeError: refusal"}]
        with TemporaryDirectory() as d:
            out = Path(d) / "results.json"
            quiz_tool.write_outputs(results, out)
            self.assertEqual(json.loads(out.read_text(encoding="utf-8"))[0]["answer"]["correct_labels"], ["A"])
            rows = (out.with_suffix(".csv")).read_text(encoding="utf-8").splitlines()
            self.assertEqual(rows[0], "file,question,A,B,C,D,answer,confidence")
            self.assertIn("Paris", rows[1])
            self.assertTrue(rows[1].endswith("A,high"))


class CliWiring(unittest.TestCase):
    def test_missing_key_exits_2(self):
        with mock.patch.dict(sys.modules):  # ensure env without key
            env = {k: v for k, v in __import__("os").environ.items() if k != "ANTHROPIC_API_KEY"}
            with mock.patch.object(sys, "argv", ["quiz_tool.py", "."]), \
                 mock.patch.dict(__import__("os").environ, env, clear=True), \
                 mock.patch.object(quiz_tool, "load_dotenv", lambda *a, **k: None):
                self.assertEqual(quiz_tool.main(), 2)

    def test_collect_images_sorted_by_name(self):
        with TemporaryDirectory() as d:
            p = Path(d)
            for name in ("b.png", "a.jpg", "notes.txt", "c.webp"):
                (p / name).write_bytes(b"x")
            got = [f.name for f in quiz_tool.collect_images(p)]
            self.assertEqual(got, ["a.jpg", "b.png", "c.webp"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
