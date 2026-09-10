"""在已安装的伴随服务上发布博主接口：保留原发行、会话及元数据，可原子回退。"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
from datetime import datetime, timezone

root = Path('/opt/douyin-downloader')
current_link = root / 'current'
previous = current_link.resolve(strict=True)
if os.geteuid() != 0 or not previous.is_relative_to(root / 'releases') or previous.parent != root / 'releases':
    raise RuntimeError('运行权限或当前发行路径不符合要求')
source = Path(__file__).resolve().parent
target = root / 'releases' / ('creator-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
if target.exists() or target.parent != root / 'releases':
    raise RuntimeError('新发行目录已经存在或越界')
shutil.copytree(previous, target, symlinks=True, ignore=shutil.ignore_patterns('__pycache__'))
subprocess.run(['python3', str(source / 'install_creator_api.py'), str(target)], check=True)
subprocess.run(['chown', '-R', 'ubuntu:ubuntu', str(target)], check=True)
env = dict(os.environ)
env['PYTHONDONTWRITEBYTECODE'] = '1'
env['XDG_CACHE_HOME'] = str(root / '.cache')
probe = "from config import ConfigLoader; from server.app import build_app; a=build_app(ConfigLoader('/opt/douyin-downloader/config.yml')); p={r.path for r in a.routes}; assert {'/api/v1/creators/health','/api/v1/creators/resolve','/api/v1/creators/works','/api/v1/creators/catalog'} <= p; print('creator_routes_verified')"
subprocess.run(['sudo', '-u', 'ubuntu', str(root / '.venv/bin/python'), '-c', probe], cwd=target, env=env, check=True)

def switch(path):
    temporary = root / 'current.creator-next'
    if temporary.exists() or temporary.is_symlink():
        raise RuntimeError('已有发行切换正在进行')
    temporary.symlink_to(path, target_is_directory=True)
    os.replace(temporary, current_link)
    subprocess.run(['systemctl', 'restart', 'zhicui-douyin-sidecar'], check=True)

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    switch(target)
    import time
    healthy = False
    for _ in range(20):
        try:
            with opener.open('http://127.0.0.1:9000/api/v1/creators/health', timeout=2) as response:
                state = json.load(response)
                healthy = state.get('protocol_version') == 1 and state.get('identity_checked') is True
            if healthy:
                break
        except Exception:
            pass
        time.sleep(1)
    if not healthy:
        raise RuntimeError('新博主接口健康检查未通过')
except Exception:
    switch(previous)
    raise
print(json.dumps({'status': 'deployed', 'previous': str(previous), 'current': str(target),
                  'sessions_preserved': True, 'media_deleted': False}))
