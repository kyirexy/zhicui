"""
Application configuration using pydantic-settings.
Reads from environment variables with sensible defaults for local development.
"""

import os
from urllib.parse import urlparse

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Global application settings."""

    DATABASE_URL: str = "sqlite:///./zhicui.db"

    # API key for the speech-to-text provider (SiliconFlow / DashScope).
    API_KEY: str = ""

    # LLM configuration — supports Anthropic-compatible endpoints via LiteLLM.
    LLM_MODEL: str = "mimo-v2.5-pro"
    LLM_API_BASE: str = ""  # 留空走 DeepSeek 官方；或填入 Anthropic 兼容端点 URL
    LLM_API_KEY: str = ""

    # Optional server-managed OmniRoute gateway. The key is backend-only and
    # must never be returned to clients. Leave the base/key empty to disable.
    OMNIROUTE_API_BASE: str = ""
    OMNIROUTE_API_KEY: str = ""
    OMNIROUTE_MODEL: str = "auto"
    # Optional browser-facing URL for the separately authenticated OmniRoute
    # admin console. It is only returned to Zhicui administrators.
    OMNIROUTE_DASHBOARD_URL: str = ""

    # SiliconFlow ASR endpoint and model (used by the DouyinProcessor)
    ASR_API_BASE_URL: str = "https://api.siliconflow.cn/v1/audio/transcriptions"
    ASR_MODEL: str = "FunAudioLLM/SenseVoiceSmall"

    # Optional companion service used by the batch Douyin video library.
    # The main app stays fully functional when this service is offline.
    DOUYIN_DOWNLOADER_URL: str = "http://127.0.0.1:9000"

    # Optional GPL-3.0 XHS-Downloader sidecar. It runs as a separate process;
    # the application only consumes its JSON API and falls back to the legacy
    # metadata scraper when the sidecar is unavailable.
    XHS_DOWNLOADER_API_BASE: str = "http://127.0.0.1:5556"
    XHS_DOWNLOADER_TIMEOUT_SECONDS: int = 20
    XHS_COOKIE: str = ""

    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # JWT signing key — must be set in production.
    JWT_SECRET: str = ""

    # Local development convenience. Disabled unless an explicit local
    # launcher enables it; production uvicorn/systemd starts never opt in.
    DEV_AUTH_BYPASS: bool = False

    # Fernet key for encrypting secrets stored in the DB (admin-configured
    # LLM/ASR API keys). Generate with:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    ENCRYPTION_KEY: str = ""

    # Optional outbound email for daily video digests. Local development
    # safely falls back to preview-only runs when SMTP_HOST is empty.
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = ""
    SMTP_FROM_NAME: str = "知萃"
    SMTP_USE_TLS: bool = True
    SMTP_USE_SSL: bool = False
    SMTP_TIMEOUT_SECONDS: int = 15
    PUBLIC_APP_URL: str = "https://luxai.cn"
    # Optional operations notification endpoint. Only HTTPS is accepted by
    # the alert service and payloads never include secrets or user content.
    ALERT_WEBHOOK_URL: str = ""
    ALERT_WEBHOOK_COOLDOWN_SECONDS: int = 900
    OPS_MONITOR_ENABLED: bool = False
    OPS_MONITOR_POLL_SECONDS: int = 60
    READINESS_CACHE_SECONDS: int = 5
    # Written by the PostgreSQL backup timer. Readiness only checks the safe
    # summary; backup archives and encryption keys remain outside the app.
    BACKUP_STATUS_FILE: str = "/var/lib/zhicui-backups/latest.json"
    BACKUP_MAX_AGE_HOURS: int = 36
    # Production release readiness fails closed until an encrypted backup and
    # its separately encrypted recovery material are verified in another
    # failure domain. SQLite development remains not_applicable.
    BACKUP_OFFSITE_REQUIRED: bool = True
    # Early-stage exception: this must be explicitly accepted before a
    # PostgreSQL deployment may rely on an encrypted local-only backup.
    EARLY_STAGE_LOCAL_BACKUP_ACCEPTED: bool = False
    # Comma-separated reverse-proxy addresses that may supply X-Real-IP.
    TRUSTED_PROXY_IPS: str = "127.0.0.1,::1"
    RATE_LIMIT_ENABLED: bool = False
    # Keep outbound delivery opt-in until the deployment has an approved
    # sender domain and account-email verification policy.
    EMAIL_DELIVERY_ENABLED: bool = False

    # Persistent database-backed scheduler. It is safe to leave enabled in
    # local development; no email is sent without explicit SMTP config.
    AGENT_AUTOMATION_ENABLED: bool = True
    AGENT_AUTOMATION_POLL_SECONDS: int = 30

    # On-demand detailed video analysis. Keep the feature off until an
    # administrator has tested and published at least one Offering. The
    # first database-backed worker is intentionally single-concurrency.
    VIDEO_ANALYSIS_ENABLED: bool = False
    VIDEO_ANALYSIS_MAX_WORKERS: int = 1
    VIDEO_ANALYSIS_POLL_SECONDS: int = 5
    VIDEO_ANALYSIS_HEARTBEAT_SECONDS: int = 15
    VIDEO_ANALYSIS_RECOVERY_SECONDS: int = 60
    VIDEO_ANALYSIS_STALE_SECONDS: int = 900
    VIDEO_ANALYSIS_MAX_DOWNLOAD_BYTES: int = 800 * 1024 * 1024
    VIDEO_ANALYSIS_DOWNLOAD_CONNECT_TIMEOUT_SECONDS: int = 10
    VIDEO_ANALYSIS_DOWNLOAD_TIMEOUT_SECONDS: int = 300
    VIDEO_ANALYSIS_FRAME_MAX_WIDTH: int = 1024
    VIDEO_ANALYSIS_JPEG_QUALITY: int = 85

    model_config = {
        # Keep local OmniRoute credentials separate from the application's
        # existing environment file. The second file is optional and ignored
        # by Git, while later values intentionally override matching entries.
        "env_file": (".env", ".env.omniroute.local"),
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()


def _ensure_loopback_no_proxy(url: str) -> None:
    """让本机 AI 网关绕过 Windows/系统级 HTTP 代理。"""
    hostname = (urlparse(url).hostname or "").lower()
    if hostname not in {"127.0.0.1", "localhost", "::1"}:
        return
    required = {"127.0.0.1", "localhost", "::1"}
    for variable in ("NO_PROXY", "no_proxy"):
        existing = {item.strip() for item in os.environ.get(variable, "").split(",") if item.strip()}
        os.environ[variable] = ",".join(sorted(existing | required))


_ensure_loopback_no_proxy(settings.OMNIROUTE_API_BASE)
_ensure_loopback_no_proxy(settings.XHS_DOWNLOADER_API_BASE)
