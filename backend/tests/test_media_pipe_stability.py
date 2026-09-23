from __future__ import annotations

import subprocess
import sys
import threading
import unittest
import tempfile
from pathlib import Path
from collections import deque

from app.services.video_extractor import _audio_is_digital_silence, _drain_process_stderr, _get_ffmpeg_path


class MediaPipeStabilityTests(unittest.TestCase):
    def test_real_silent_audio_is_detected_but_even_quiet_sound_is_not_skipped(self) -> None:
        ffmpeg = _get_ffmpeg_path()
        with tempfile.TemporaryDirectory() as folder:
            for source, expected in (("anullsrc=r=16000:cl=mono", True),
                                     ("sine=frequency=440:sample_rate=16000,volume=0.0001", False)):
                with self.subTest(source=source):
                    audio = Path(folder) / "audio.mp3"
                    subprocess.run(
                        [ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", source,
                         "-t", "0.3", "-codec:a", "libmp3lame", "-b:a", "64k", str(audio)],
                        check=True, capture_output=True, timeout=10,
                    )
                    self.assertEqual(_audio_is_digital_silence(audio), expected)

    def test_error_stream_larger_than_pipe_capacity_cannot_stall_decoder(self) -> None:
        # 模拟先大量报错、随后才继续读取媒体输入的解码器；不调用网络或 ASR。
        command = (
            "import sys; "
            "sys.stderr.buffer.write(b'x' * (2 * 1024 * 1024)); "
            "sys.stderr.buffer.write(b'final decoder message'); "
            "sys.stderr.buffer.flush(); "
            "sys.stdin.buffer.read()"
        )
        process = subprocess.Popen(
            [sys.executable, "-c", command], stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        tail = deque(maxlen=4)
        reader = threading.Thread(target=_drain_process_stderr, args=(process.stderr, tail))
        reader.start()
        try:
            process.stdin.write(b"media input")
            process.stdin.close()
            self.assertEqual(process.wait(timeout=10), 0)
            reader.join(timeout=2)
            self.assertFalse(reader.is_alive())
            diagnostics = b"".join(tail)
            self.assertLessEqual(len(diagnostics), 16 * 1024)
            self.assertTrue(diagnostics.endswith(b"final decoder message"))
            self.assertTrue(process.stderr.closed)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            reader.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
