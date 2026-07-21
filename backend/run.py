"""
Convenience script to start the VideoCapsule backend with uvicorn.
"""

import argparse
import os

# `run.py` is the documented local-development entry point. Keep the bypass
# opt-in here so direct uvicorn/systemd production starts retain normal auth.
os.environ.setdefault("DEV_AUTH_BYPASS", "true")

import uvicorn

from app.core.config import settings

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="启动知萃本地开发后端")
    parser.add_argument("--host", default=settings.HOST, help="监听地址")
    parser.add_argument("--port", type=int, default=settings.PORT, help="监听端口")
    args = parser.parse_args()

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=True,
    )
