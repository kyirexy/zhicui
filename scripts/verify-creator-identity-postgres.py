"""手动 PostgreSQL 验收：仅访问随机新建 schema，结束后清除该 schema。

python verify-creator-identity-postgres.py --env-file /opt/zhicui/backend/.env \
    --migration-path /tmp/creator_source_identity_migration.py

不导入应用、不启动后台任务、不读取或修改现有业务表，不输出数据库凭据。
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets

from dotenv import dotenv_values
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import NullPool


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--migration-path', default=str(
        Path(__file__).resolve().parents[1] / 'backend/app/services/creator_source_identity_migration.py'
    ))
    args = parser.parse_args()
    url = os.environ.get('DATABASE_URL') or dotenv_values(args.env_file).get('DATABASE_URL')
    if not url or not str(url).startswith(('postgresql://', 'postgresql+psycopg2://')):
        raise RuntimeError('验收必须使用 PostgreSQL 连接')
    spec = importlib.util.spec_from_file_location('candidate_creator_identity', args.migration_path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    admin = create_engine(url, poolclass=NullPool)
    results = []
    try:
        for mode in ('concurrent', 'renamed_legacy', 'existing_new', 'equivalent_new', 'collision'):
            schema = 'zhicui_creator_test_' + secrets.token_hex(12)
            if not re.fullmatch(r'zhicui_creator_test_[a-f0-9]{24}', schema):
                raise RuntimeError('临时 schema 名校验失败')
            with admin.begin() as connection:
                connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            test = create_engine(url, poolclass=NullPool, connect_args={
                'options': f'-csearch_path={schema} -clock_timeout=15000 -cstatement_timeout=30000',
            })
            cleaned = False
            try:
                with test.begin() as connection:
                    assert connection.execute(text('SELECT current_schema()')).scalar_one() == schema
                    assert connection.execute(text('SELECT current_schemas(false)')).scalar_one() == [schema]
                    quote = connection.dialect.identifier_preparer.quote_identifier
                    old_name = 'old " quoted name' if mode == 'renamed_legacy' else migration.OLD
                    connection.execute(text('CREATE TABLE creator_sources (id TEXT PRIMARY KEY)'))
                    connection.execute(text('CREATE TABLE notes (id TEXT PRIMARY KEY)'))
                    connection.execute(text(f'''CREATE TABLE creator_source_items (
                        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
                        source_id TEXT NOT NULL REFERENCES creator_sources(id),
                        platform TEXT NOT NULL, external_id TEXT NOT NULL,
                        note_id TEXT REFERENCES notes(id), state TEXT NOT NULL,
                        removed_at TIMESTAMPTZ, future_column TEXT,
                        CONSTRAINT {quote(old_name)} UNIQUE (user_id, platform, external_id),
                        CONSTRAINT valid_state CHECK (state IN ('ready','removed'))
                    )'''))
                    connection.execute(text('''CREATE TABLE creator_sync_run_items (
                        id TEXT PRIMARY KEY, source_item_id TEXT NOT NULL
                        REFERENCES creator_source_items(id) ON DELETE CASCADE)'''))
                    connection.execute(text('CREATE INDEX preserved_index ON creator_source_items(source_id)'))
                    connection.execute(text("INSERT INTO creator_sources VALUES ('a'),('b')"))
                    connection.execute(text("INSERT INTO notes VALUES ('note')"))
                    connection.execute(text("INSERT INTO creator_source_items VALUES ('item','user','a','douyin','12345','note','removed','2026-01-01','preserved')"))
                    connection.execute(text("INSERT INTO creator_sync_run_items VALUES ('child','item')"))
                    if mode in {'existing_new', 'equivalent_new', 'collision'}:
                        new_name = 'equivalent_source_key' if mode == 'equivalent_new' else migration.NEW
                        columns = 'id' if mode == 'collision' else 'user_id,source_id,platform,external_id'
                        connection.execute(text(f'ALTER TABLE creator_source_items ADD CONSTRAINT {quote(new_name)} UNIQUE ({columns})'))
                    before = connection.execute(text('SELECT * FROM creator_source_items')).all()
                if mode == 'collision':
                    try:
                        migration.ensure_schema(test)
                    except RuntimeError as error:
                        assert '字段不匹配' in str(error)
                    else:
                        raise AssertionError('错误的新约束名称必须阻止迁移')
                elif mode == 'concurrent':
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        futures = [pool.submit(migration.ensure_schema, test) for _ in range(2)]
                        for future in futures:
                            future.result(timeout=45)
                    migration.ensure_schema(test)
                else:
                    migration.ensure_schema(test)
                    migration.ensure_schema(test)
                with test.begin() as connection:
                    assert connection.execute(text('SELECT * FROM creator_source_items')).all() == before
                    assert connection.execute(text('SELECT * FROM creator_sync_run_items')).all() == [('child', 'item')]
                    keys = inspect(connection).get_unique_constraints('creator_source_items')
                    if mode == 'collision':
                        assert migration._legacy_constraints(keys)
                    else:
                        assert not migration._legacy_constraints(keys)
                        connection.execute(text("INSERT INTO creator_source_items (id,user_id,source_id,platform,external_id,state) VALUES ('partner','user','b','douyin','12345','ready')"))
                        assert 'preserved_index' in [row['name'] for row in inspect(connection).get_indexes('creator_source_items')]
                if mode != 'collision':
                    try:
                        with test.begin() as connection:
                            connection.execute(text("INSERT INTO creator_source_items (id,user_id,source_id,platform,external_id,state) VALUES ('duplicate','user','b','douyin','12345','ready')"))
                    except IntegrityError:
                        pass
                    else:
                        raise AssertionError('同一博主重复视频必须被拒绝')
                    with test.begin() as connection:
                        connection.execute(text("DELETE FROM creator_source_items WHERE id='item'"))
                        assert connection.execute(text('SELECT COUNT(*) FROM creator_sync_run_items')).scalar_one() == 0
                results.append({'case': mode, 'passed': True})
            finally:
                test.dispose()
                # 名称在本函数随机生成且校验，绝不从环境或参数接收清理目标。
                with admin.begin() as connection:
                    connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
                cleaned = True
            assert cleaned
        print(json.dumps({'passed': True, 'cases': results, 'temporary_schemas_removed': True}, ensure_ascii=False))
    finally:
        admin.dispose()


if __name__ == '__main__':
    main()
