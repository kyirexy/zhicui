"""B站公开资料与风控停止边界。"""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.services import creator_connectors as connector, yutto_catalog_client as yutto


class BilibiliCreatorProfileTests(unittest.TestCase):
    def resolve(self, payload, status=200):
        response = Mock(status_code=status)
        response.json.return_value = payload
        session = Mock()
        session.get.return_value = response
        context = Mock()
        context.__enter__ = Mock(return_value=session)
        context.__exit__ = Mock(return_value=False)
        with patch.object(connector.requests, "Session", return_value=context), patch.object(connector, "_bilibili_playlist") as playlist:
            result = connector.resolve_creator("bilibili", "https://space.bilibili.com/123/video")
            playlist.assert_not_called()
        self.assertFalse(session.trust_env)
        session.get.assert_called_once()
        self.assertFalse(session.get.call_args.kwargs["allow_redirects"])
        return result

    def test_profile_does_not_enumerate_posts_and_returns_only_public_identity(self):
        result = self.resolve({"code": 0, "data": {"card": {"mid": "123", "name": "测试博主", "face": "https://i0.hdslb.com/bfs/face/a.jpg", "cookie": "private"}}})
        self.assertEqual(result["display_name"], "测试博主")
        self.assertEqual(result["creator_id"], "123")
        self.assertNotIn("private", str(result))

    def test_identity_mismatch_and_missing_name_are_rejected(self):
        for card in ({"mid": "456", "name": "错误账号"}, {"mid": "123", "name": ""}):
            with self.subTest(card=card), self.assertRaises(connector.CreatorConnectorError) as raised:
                self.resolve({"code": 0, "data": {"card": card}})
            self.assertEqual(raised.exception.code, "invalid_upstream_response")

    def test_risk_response_stops_without_playlist_fallback(self):
        for code, status in ((-352, 200), (-799, 200), (None, 412), (None, 429)):
            with self.subTest(code=code, status=status), self.assertRaises(connector.CreatorConnectorError) as raised:
                self.resolve({"code": code, "message": "private"}, status)
            self.assertEqual(raised.exception.code, "bilibili_risk_control")
            self.assertNotIn("private", str(raised.exception))

    def test_unsafe_avatar_and_redirect_are_not_followed(self):
        result = self.resolve({"code": 0, "data": {"card": {"mid": "123", "name": "博主", "face": "https://evil.example/private?token=x"}}})
        self.assertEqual(result["avatar_url"], "")
        with self.assertRaises(connector.CreatorConnectorError):
            self.resolve({}, 302)

    def test_upstream_rejection_does_not_start_second_connector(self):
        source = SimpleNamespace(platform="bilibili", profile_url="https://space.bilibili.com/123/video")
        for code in ("bilibili_risk_control", "bilibili_verification_required", "bilibili_login_required", "bilibili_catalog_failed", "empty_catalog_unverified"):
            with self.subTest(code=code), patch.object(yutto, "discover_bilibili_catalog", side_effect=yutto.YuttoCatalogError(code, "读取失败")), patch.object(connector, "_discover_bilibili_catalog_fallback") as fallback:
                with self.assertRaises(connector.CreatorConnectorError) as raised:
                    connector.discover_catalog(source)
                self.assertEqual(raised.exception.code, code)
                fallback.assert_not_called()

    def test_numeric_risk_codes_are_preserved(self):
        for code in (-352, -401, -412, -799):
            self.assertEqual(yutto._rpc_error_code({"message": f"失败（code: {code}）"}), "bilibili_risk_control")

    def test_playlist_ignores_machine_config_and_disables_implicit_retries(self):
        with patch.object(connector.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout='{"entries": []}')) as run:
            connector._bilibili_playlist("https://space.bilibili.com/123/video", 1)
        command = run.call_args.args[0]
        self.assertIn("--ignore-config", command)
        self.assertIn("--skip-download", command)
        for flag in ("--retries", "--extractor-retries"):
            self.assertEqual(command[command.index(flag) + 1], "0")


if __name__ == "__main__":
    unittest.main()
