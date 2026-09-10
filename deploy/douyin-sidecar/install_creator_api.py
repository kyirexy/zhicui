"""把独立博主接口接入已固定版本的伴随服务；重复执行不重复插入。"""
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1]).resolve(strict=True)
source = Path(__file__).resolve().parent / 'creator_api.py'
app = root / 'server/app.py'
text = app.read_text(encoding='utf-8')
marker = '    return app\n'
hook = ('    from server.creator_api import install_creator_routes\n'
        '    install_creator_routes(app, deps, _session_scope, DouyinAPIClient, _cookie_state_is_valid)\n')
if 'install_creator_routes(app,' not in text:
    if text.count(marker) != 1:
        raise RuntimeError('伴随服务入口结构与固定版本不一致')
    text = text.replace(marker, hook + marker)
    app.write_text(text, encoding='utf-8')
shutil.copyfile(source, root / 'server/creator_api.py')
