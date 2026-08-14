from __future__ import annotations

import os
import unittest
from unittest.mock import patch


# app.config validates the PIN while importing settings. Keep tests independent
# from a developer's local .env file.
os.environ.setdefault("APP_PIN", "749281")
os.environ.setdefault("QR_OPEN_BROWSER", "false")

from pydantic import ValidationError

from app import main, remote_input


class InputPayloadTests(unittest.TestCase):
    def test_large_text_is_accepted(self) -> None:
        text = "line with emoji 😀\n" * 10_000
        payload = main.InputRequest(action="text", text=text)
        self.assertEqual(payload.text, text)
        self.assertGreater(len(text), 2_000)

    def test_text_limit_is_still_bounded(self) -> None:
        with self.assertRaises(ValidationError):
            main.InputRequest(action="text", text="x" * (main.MAX_INPUT_TEXT_CHARS + 1))

    def test_live_capture_options_can_be_tuned_per_phone(self) -> None:
        options = main._capture_options("live", 2, quality=40, max_width=854)
        self.assertEqual(options[1:], (40, 854, 2))


@unittest.skipUnless(os.name == "nt", "Windows SendInput batching is Windows-only")
class WindowsTextBatchTests(unittest.TestCase):
    def test_unicode_text_is_batched_without_losing_surrogates(self) -> None:
        batches = []

        def remember(inputs):
            batches.append(inputs)

        # 129 ASCII units plus two UTF-16 surrogate units for the emoji.
        text = ("a" * 129) + "😀"
        with patch.object(remote_input, "_send_inputs", side_effect=remember), patch.object(
            remote_input.time, "sleep"
        ):
            remote_input._win_type_text(text)

        self.assertEqual([len(batch) for batch in batches], [256, 6])
        units = [
            event.union.ki.wScan
            for batch in batches
            for index, event in enumerate(batch)
            if index % 2 == 0
        ]
        expected = [
            int.from_bytes(text.encode("utf-16-le")[i : i + 2], "little")
            for i in range(0, len(text.encode("utf-16-le")), 2)
        ]
        self.assertEqual(units, expected)


if __name__ == "__main__":
    unittest.main()
