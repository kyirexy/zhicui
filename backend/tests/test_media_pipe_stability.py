from __future__ import annotations

import subprocess
import sys
import threading
import unittest
from collections import deque

from app.services.video_extractor import _drain_process_stderr


class MediaPipeStabilityTests(unittest.TestCase):
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
