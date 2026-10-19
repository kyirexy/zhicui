"""仅扩展目录任务类型约束，保留已有任务、外键、索引和触发器。"""
from __future__ import annotations

import re

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine


TABLE = "creator_sync_runs"
CONSTRAINT = "ck_creator_run_operation"
EXPRESSION = "operation IN ('recent_transcript','catalog_recent','catalog_all','selected_transcript')"


def _needs_migration(connection) -> bool:
    constraint = next((row for row in inspect(connection).get_check_constraints(TABLE)
                       if row.get("name") == CONSTRAINT), None)
    # PostgreSQL 历史 ADD COLUMN 版本可能缺少 CHECK；本次补齐并验证已有值。
    # SQLite 没有旧约束时无需重建，已有模型新建的表仍包含完整 CHECK。
    if constraint is None:
        return connection.dialect.name == "postgresql"
    return "catalog_recent" not in constraint.get("sqltext", "")


def ensure_schema(engine: Engine) -> None:
    if not inspect(engine).has_table(TABLE) or not _needs_migration(engine):
        return
    if engine.dialect.name == "postgresql":
        with engine.begin() as connection:
            connection.execute(text(f"LOCK TABLE {TABLE} IN ACCESS EXCLUSIVE MODE"))
            if not _needs_migration(connection):
                return
            connection.execute(text(f"ALTER TABLE {TABLE} DROP CONSTRAINT IF EXISTS {CONSTRAINT}"))
            connection.execute(text(f"ALTER TABLE {TABLE} ADD CONSTRAINT {CONSTRAINT} CHECK ({EXPRESSION})"))
        return
    if engine.dialect.name != "sqlite":
        raise RuntimeError("当前数据库不支持近期目录任务约束迁移")
    with engine.connect() as connection:
        enabled = connection.exec_driver_sql("PRAGMA foreign_keys").scalar()
        connection.commit()
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.commit()
        try:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            if not _needs_migration(connection):
                connection.commit()
                return
            violations = set(connection.exec_driver_sql("PRAGMA foreign_key_check").all())
            original = connection.execute(text(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=:name"
            ), {"name": TABLE}).scalar_one()
            definition, replaced = re.subn(
                rf'CONSTRAINT\s+["`\[]?{CONSTRAINT}["`\]]?\s+CHECK\s*'
                r'\(\s*operation\s+IN\s*\([^)]*\)\s*\)',
                f"CONSTRAINT {CONSTRAINT} CHECK ({EXPRESSION})",
                original, flags=re.IGNORECASE,
            )
            if replaced != 1:
                raise RuntimeError("旧目录任务类型约束格式不匹配，已停止迁移")
            temporary = "creator_sync_runs_recent_new"
            definition, replaced = re.subn(
                rf'^(CREATE\s+TABLE\s+)["`\[]?{TABLE}["`\]]?',
                rf'\g<1>{temporary}', definition, count=1, flags=re.IGNORECASE,
            )
            if replaced != 1:
                raise RuntimeError("旧目录任务表格式不匹配，已停止迁移")
            objects = connection.execute(text(
                "SELECT sql FROM sqlite_master WHERE tbl_name=:name "
                "AND type IN ('index','trigger') AND sql IS NOT NULL"
            ), {"name": TABLE}).scalars().all()
            columns = [row[1] for row in connection.exec_driver_sql(f'PRAGMA table_info("{TABLE}")')]
            quoted = ", ".join('"' + name.replace('"', '""') + '"' for name in columns)
            count = connection.exec_driver_sql(f"SELECT COUNT(*) FROM {TABLE}").scalar_one()
            connection.exec_driver_sql(definition)
            connection.exec_driver_sql(f"INSERT INTO {temporary} ({quoted}) SELECT {quoted} FROM {TABLE}")
            if connection.exec_driver_sql(f"SELECT COUNT(*) FROM {temporary}").scalar_one() != count:
                raise RuntimeError("目录任务行数校验失败，已停止迁移")
            connection.exec_driver_sql(f"DROP TABLE {TABLE}")
            connection.exec_driver_sql(f"ALTER TABLE {temporary} RENAME TO {TABLE}")
            for sql in objects:
                connection.exec_driver_sql(sql)
            if set(connection.exec_driver_sql("PRAGMA foreign_key_check").all()) - violations:
                raise RuntimeError("目录任务外键校验失败，已停止迁移")
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.exec_driver_sql(f"PRAGMA foreign_keys={'ON' if enabled else 'OFF'}")
            connection.commit()
