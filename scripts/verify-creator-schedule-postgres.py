"""手动验收调度时区修复；只创建并清理随机临时 schema，不访问业务表。"""
import argparse
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets

from dotenv import dotenv_values
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import NullPool


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--migration-path', default=str(Path(__file__).resolve().parents[1]
        / 'backend/app/services/creator_schedule_timezone_migration.py'))
    args = parser.parse_args()
    url = os.environ.get('DATABASE_URL') or dotenv_values(args.env_file).get('DATABASE_URL')
    if not url or not str(url).startswith(('postgresql://', 'postgresql+psycopg2://')):
        raise RuntimeError('验收必须使用 PostgreSQL')
    spec = importlib.util.spec_from_file_location('candidate_creator_schedule', args.migration_path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    admin = create_engine(url, poolclass=NullPool)
    results = []
    try:
        for zone in ('Asia/Shanghai', 'UTC'):
            schema = 'zhicui_schedule_test_' + secrets.token_hex(12)
            assert re.fullmatch(r'zhicui_schedule_test_[a-f0-9]{24}', schema)
            with admin.begin() as connection:
                connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            test = create_engine(url, poolclass=NullPool, connect_args={
                'options': f'-csearch_path={schema} -cTimeZone={zone} -clock_timeout=15000 -cstatement_timeout=30000',
            })
            target = datetime(2026, 9, 10, 10, 0, 30, tzinfo=timezone.utc)
            try:
                with test.begin() as connection:
                    assert connection.execute(text('SELECT current_schemas(false)')).scalar_one() == [schema]
                    for table, columns in migration.SCHEDULE_COLUMNS.items():
                        fields = ', '.join(f'{name} TIMESTAMP' for name in columns)
                        connection.execute(text(f'CREATE TABLE {table} (id TEXT PRIMARY KEY, {fields}, preserved_at TIMESTAMPTZ)'))
                        connection.execute(text(f'CREATE INDEX {table}_test_schedule ON {table} ({columns[0]})'))
                        values = ', '.join(':target' for _ in columns)
                        connection.execute(text(f'INSERT INTO {table} (id,{",".join(columns)},preserved_at) VALUES (:id,{values},:target)'),
                                           {'id': 'test', 'target': target})
                    # 媒体日期特意保持旧类型，验证本迁移不触碰媒体表。
                    connection.execute(text('CREATE TABLE creator_source_items (published_at TIMESTAMP)'))
                    connection.execute(text('INSERT INTO creator_source_items VALUES (:target)'), {'target': target})
                    media_before = connection.execute(text('SELECT published_at FROM creator_source_items')).scalar_one()
                    before = connection.execute(text('SELECT next_retry_at FROM creator_sync_runs')).scalar_one()
                    assert before.tzinfo is None
                    if zone == 'Asia/Shanghai':
                        assert before.replace(tzinfo=timezone.utc) > target + timedelta(hours=7)
                migration.ensure_schema(test)
                migration.ensure_schema(test)
                with test.begin() as connection:
                    for table, columns in migration.SCHEDULE_COLUMNS.items():
                        row = connection.execute(text(f'SELECT * FROM {table}')).mappings().one()
                        assert row['preserved_at'] == target
                        types = {column['name']: column['type'] for column in inspect(connection).get_columns(table)}
                        for name in columns:
                            assert types[name].timezone is True
                            assert row[name].tzinfo is not None
                            assert row[name].astimezone(timezone.utc) == target
                            assert row[name] <= target + timedelta(seconds=1)
                        assert f'{table}_test_schedule' in [index['name'] for index in inspect(connection).get_indexes(table)]
                    connection.execute(text('INSERT INTO creator_sync_runs (id,next_retry_at) VALUES (:id,:target)'),
                                       {'id': 'after', 'target': target + timedelta(seconds=30)})
                    after = connection.execute(text("SELECT next_retry_at FROM creator_sync_runs WHERE id='after'")).scalar_one()
                    assert after == target + timedelta(seconds=30)
                    assert connection.execute(text('SELECT published_at FROM creator_source_items')).scalar_one() == media_before
                results.append({'timezone': zone, 'passed': True, 'retry_offset_seconds': 30})
            finally:
                test.dispose()
                with admin.begin() as connection:
                    connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        print(json.dumps({'passed': True, 'cases': results, 'temporary_schemas_removed': True}))
    finally:
        admin.dispose()


if __name__ == '__main__':
    main()
