"""
Application configuration using pydantic-settings.
Reads from environment variables with sensible defaults for local development.
"""

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

    # SiliconFlow ASR endpoint and model (used by the DouyinProcessor)
    ASR_API_BASE_URL: str = "https://api.siliconflow.cn/v1/audio/transcriptions"
    ASR_MODEL: str = "FunAudioLLM/SenseVoiceSmall"

    # Optional companion service used by the batch Douyin video library.
    # The main app stays fully functional when this service is offline.
    DOUYIN_DOWNLOADER_URL: str = "http://127.0.0.1:9000"

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
    # Keep outbound delivery opt-in until the deployment has an approved
    # sender domain and account-email verification policy.
    EMAIL_DELIVERY_ENABLED: bool = False

    # Persistent database-backed scheduler. It is safe to leave enabled in
    # local development; no email is sent without explicit SMTP config.
    AGENT_AUTOMATION_ENABLED: bool = True
    AGENT_AUTOMATION_POLL_SECONDS: int = 30

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()
