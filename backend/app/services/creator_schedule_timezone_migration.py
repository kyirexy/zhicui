"""修复旧版补列的调度时间类型，按原连接时区保留真实触发时刻。"""
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine


# 只处理任务调度，不修改视频发布日期或用户历史媒体数据。
SCHEDULE_COLUMNS = {
    'creator_sync_runs': ('next_retry_at', 'lease_until'),
    'creator_sync_run_items': ('next_retry_at',),
    'creator_catalog_quality_runs': ('next_batch_at', 'lease_expires_at'),
}


def ensure_schema(engine: Engine) -> None:
    if engine.dialect.name != 'postgresql':
        return
    with engine.begin() as connection:
        for table, names in SCHEDULE_COLUMNS.items():
            inspector = inspect(connection)
            if not inspector.has_table(table):
                continue
            columns = {row['name']: row for row in inspector.get_columns(table)}
            pending = [name for name in names if name in columns
                       and getattr(columns[name]['type'], 'timezone', None) is False]
            if not pending:
                continue
            connection.execute(text(f'LOCK TABLE {table} IN ACCESS EXCLUSIVE MODE'))
            # 并发启动可能在等待锁时已经完成迁移，锁内重新读类型。
            columns = {row['name']: row for row in inspect(connection).get_columns(table)}
            for name in pending:
                if getattr(columns[name]['type'], 'timezone', None) is not False:
                    continue
                # 旧 timestamptz 参数写入无时区列时，PG 使用会话时区转为墙上时间。
                # 按同一时区转换回去，避免误把上海18点解释为UTC18点。
                connection.execute(text(
                    f'ALTER TABLE {table} ALTER COLUMN {name} TYPE TIMESTAMPTZ '
                    f"USING {name} AT TIME ZONE current_setting('TimeZone')"
                ))
