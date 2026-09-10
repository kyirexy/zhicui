"""把作品目录唯一键限定到博主，保留旧行、外键、索引及删除记录。"""
from __future__ import annotations

import re

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine


TABLE = "creator_source_items"
OLD = "uq_creator_item_user_platform_external"
NEW = "uq_creator_item_user_source_platform_external"
OLD_COLUMNS = {"user_id", "platform", "external_id"}
NEW_COLUMNS = OLD_COLUMNS | {"source_id"}


def _legacy_constraints(constraints):
    return [row for row in constraints if set(row.get("column_names") or []) == OLD_COLUMNS]


def ensure_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    if not inspector.has_table(TABLE):
        return
    constraints = inspector.get_unique_constraints(TABLE)
    legacy = _legacy_constraints(constraints)
    if not legacy:
        return
    if engine.dialect.name == "postgresql":
        with engine.begin() as connection:
            # 多进程启动时，锁内重新读取约束，避免另一个进程已迁移后的旧快照。
            connection.execute(text(f"LOCK TABLE {TABLE} IN ACCESS EXCLUSIVE MODE"))
            constraints = inspect(connection).get_unique_constraints(TABLE)
            legacy = _legacy_constraints(constraints)
            if not legacy:
                return
            named_new = next((row for row in constraints if row["name"] == NEW), None)
            if named_new and set(named_new["column_names"]) != NEW_COLUMNS:
                raise RuntimeError("博主作品新约束同名但字段不匹配，已停止迁移")
            # 同一事务内先建立更窄范围的约束，再删除旧约束，不改数据和记录 ID。
            if not any(set(row.get("column_names") or []) == NEW_COLUMNS for row in constraints):
                connection.execute(text(
                    f"ALTER TABLE {TABLE} ADD CONSTRAINT {NEW} "
                    "UNIQUE (user_id, source_id, platform, external_id)"
                ))
            quote = connection.dialect.identifier_preparer.quote_identifier
            for constraint in legacy:
                name = constraint.get("name")
                if not name:
                    raise RuntimeError("旧博主作品约束缺少名称，已停止迁移")
                connection.execute(text(f"ALTER TABLE {TABLE} DROP CONSTRAINT {quote(name)}"))
        return
    if engine.dialect.name != "sqlite":
        raise RuntimeError("当前数据库不支持博主作品归属迁移")

    # SQLite 不能删除 UNIQUE 约束。暂时关闭本连接外键，事务内复制原 DDL，
    # 只替换此约束；保留所有列、外键、检查、显式索引和触发器。
    with engine.connect() as connection:
        enabled = connection.exec_driver_sql("PRAGMA foreign_keys").scalar()
        connection.commit()
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.commit()
        try:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            violations = set(connection.exec_driver_sql("PRAGMA foreign_key_check").all())
            original = connection.execute(text(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=:name"
            ), {"name": TABLE}).scalar_one()
            definition, replacements = re.subn(
                rf'CONSTRAINT\s+["`\[]?{OLD}["`\]]?\s+UNIQUE\s*'
                r'\(\s*user_id\s*,\s*platform\s*,\s*external_id\s*\)',
                f"CONSTRAINT {NEW} UNIQUE (user_id, source_id, platform, external_id)",
                original, flags=re.IGNORECASE,
            )
            if replacements != 1:
                raise RuntimeError("旧博主作品约束格式不匹配，已停止迁移")
            temporary = "creator_source_items_identity_new"
            definition, replacements = re.subn(
                rf'^(CREATE\s+TABLE\s+)["`\[]?{TABLE}["`\]]?',
                rf'\g<1>{temporary}', definition, count=1, flags=re.IGNORECASE,
            )
            if replacements != 1:
                raise RuntimeError("旧博主作品表格式不匹配，已停止迁移")
            objects = connection.execute(text(
                "SELECT sql FROM sqlite_master WHERE tbl_name=:name "
                "AND type IN ('index','trigger') AND sql IS NOT NULL"
            ), {"name": TABLE}).scalars().all()
            columns = [row[1] for row in connection.exec_driver_sql(f'PRAGMA table_info("{TABLE}")')]
            quoted = ", ".join('"' + name.replace('"', '""') + '"' for name in columns)
            count = connection.exec_driver_sql(f"SELECT COUNT(*) FROM {TABLE}").scalar_one()
            connection.exec_driver_sql(definition)
            connection.exec_driver_sql(
                f"INSERT INTO {temporary} ({quoted}) SELECT {quoted} FROM {TABLE}"
            )
            if connection.exec_driver_sql(f"SELECT COUNT(*) FROM {temporary}").scalar_one() != count:
                raise RuntimeError("博主作品行数校验失败，已停止迁移")
            connection.exec_driver_sql(f"DROP TABLE {TABLE}")
            connection.exec_driver_sql(f"ALTER TABLE {temporary} RENAME TO {TABLE}")
            for sql in objects:
                connection.exec_driver_sql(sql)
            if set(connection.exec_driver_sql("PRAGMA foreign_key_check").all()) - violations:
                raise RuntimeError("博主作品外键校验失败，已停止迁移")
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.exec_driver_sql(f"PRAGMA foreign_keys={'ON' if enabled else 'OFF'}")
            connection.commit()
