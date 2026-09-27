"""Web 与 CLI 共用的临时媒体响应。"""

from contextlib import ExitStack
from fastapi.responses import FileResponse


class TemporaryVideoResponse(FileResponse):
    """正常、断连、Range 错误均释放临时文件及并发槽。"""

    def __init__(self, *args, cleanup: ExitStack, **kwargs):
        super().__init__(*args, **kwargs)
        self._cleanup = cleanup

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._cleanup.close()
