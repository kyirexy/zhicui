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

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()
