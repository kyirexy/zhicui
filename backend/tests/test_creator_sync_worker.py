"""验证立即完成的任务不会在注册回调时锁死扫描线程。"""
from concurrent.futures import Future
import threading
from types import SimpleNamespace
import unittest

from app.services.creator_sync_worker import CreatorSyncRunner


class CreatorSyncRunnerTests(unittest.TestCase):
    def test_completed_future_callback_does_not_deadlock_submit(self):
        runner = CreatorSyncRunner()
        completed = Future()
        completed.set_result(None)
        runner._accepting = True
        runner._executor = SimpleNamespace(submit=lambda *_args: completed)
        # daemon + 有界等待让旧版本的真实死锁表现为测试失败，而非卡住测试进程。
        thread = threading.Thread(target=runner.submit, args=('already-complete',), daemon=True)
        thread.start()
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive(), '完成 Future 的同步回调不能重入已持有的 Lock')
        self.assertEqual(runner._futures, {})

    def test_old_callback_does_not_remove_a_newer_submission(self):
        runner = CreatorSyncRunner()
        old, current = Future(), Future()
        old.set_result(None)
        runner._futures['same-run'] = current
        runner._forget('same-run', old)
        self.assertIs(runner._futures['same-run'], current)
        runner._forget('same-run', current)
        self.assertEqual(runner._futures, {})
