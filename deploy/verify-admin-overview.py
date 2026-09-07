"""正式业务概览只读验收；不输出用户内容或凭证，不修改数据库。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path('/opt/zhicui-runtime/current').resolve(strict=True)
if root.parent != Path('/opt/zhicui-runtime/releases'):
    raise SystemExit('runtime 路径不在批准目录')
pid = subprocess.check_output(['systemctl', 'show', '-p', 'MainPID', '--value', 'videocapsule-backend'], text=True).strip()
if not pid.isdigit() or pid == '0':
    raise SystemExit('后端未运行')
for entry in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
    if b'=' in entry:
        key, value = entry.split(b'=', 1)
        os.environ[key.decode()] = value.decode()
sys.path.insert(0, str(root / 'backend'))
os.chdir(root / 'backend')
from sqlalchemy import text
from app.core.database import SessionLocal
from app.services.admin_overview_service import overview

with SessionLocal() as db:
    if db.bind.dialect.name != 'postgresql':
        raise SystemExit('此验收仅针对生产 PostgreSQL')
    db.execute(text('SET TRANSACTION READ ONLY'))
    results = []
    for days in (1, 7, 30):
        started = time.monotonic()
        result = overview(db, days=days)
        encoded = json.dumps(result, ensure_ascii=False).encode()
        assert len(result['recent_notes']) <= 10
        assert len(result['recent_tasks']) <= 5
        assert len(result['models']) <= 6
        results.append({'days': days, 'response_bytes': len(encoded),
                        'elapsed_ms': round((time.monotonic() - started) * 1000),
                        'note_rows': len(result['recent_notes']), 'task_rows': len(result['recent_tasks'])})
    db.rollback()
print(json.dumps({'read_only': True, 'results': results}))
