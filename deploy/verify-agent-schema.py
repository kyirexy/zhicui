#!/usr/bin/env python3
"""校验生产 PostgreSQL 中公开 Agent 接口的持久化结构。

这个脚本只覆盖 ``open-agent-cli-interface`` 新增的 8 张表。它不执行迁移，
也不读取或输出任何凭据；成功时输出一个带版本前缀的确定性结构指纹，供 dark
发布记录、Stable 晋级和发布证据交叉校验。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import Boolean, DateTime, Integer, String, Text, create_engine, inspect


CONTRACT_VERSION = 1
FINGERPRINT_PREFIX = f"agent-schema-v{CONTRACT_VERSION}:"


def _columns(*items: tuple[str, str, bool]) -> dict[str, dict[str, Any]]:
    return {
        name: {"type": type_signature, "nullable": nullable}
        for name, type_signature, nullable in items
    }


# This is intentionally explicit instead of being generated from ORM metadata at deploy
# time. A model edit must update and review the release contract before Stable can pass.
EXPECTED_SCHEMA: dict[str, dict[str, Any]] = {
    "agent_credentials": {
        "columns": _columns(
            ("id", "string:32", False),
            ("user_id", "string:64", False),
            ("kind", "string:24", False),
            ("name", "string:120", False),
            ("client_type", "string:32", False),
            ("token_hash", "string:64", False),
            ("token_prefix", "string:24", False),
            ("refresh_hash", "string:64", True),
            ("previous_refresh_hash", "string:64", True),
            ("refresh_generation", "integer", False),
            ("scopes_json", "text", False),
            ("expires_at", "datetime:tz", False),
            ("refresh_expires_at", "datetime:tz", True),
            ("revoked_at", "datetime:tz", True),
            ("last_used_at", "datetime:tz", True),
            ("created_at", "datetime:tz", False),
            ("updated_at", "datetime:tz", False),
        ),
        "primary_key": ("id",),
        "unique": (("token_hash",), ("refresh_hash",)),
        "indexes": {
            "ix_agent_credentials_user_id": ("user_id",),
            "ix_agent_credentials_revoked_at": ("revoked_at",),
            "ix_agent_credentials_user_kind": ("user_id", "kind", "created_at"),
            "ix_agent_credentials_expiry": ("expires_at", "revoked_at"),
        },
        "foreign_keys": (("user_id", "users", "id", "CASCADE"),),
    },
    "agent_device_authorizations": {
        "columns": _columns(
            ("id", "string:32", False),
            ("device_code_hash", "string:64", False),
            ("user_code_hash", "string:64", False),
            ("user_code_hint", "string:16", False),
            ("requested_scopes_json", "text", False),
            ("client_name", "string:120", False),
            ("client_type", "string:32", False),
            ("status", "string:24", False),
            ("approved_user_id", "string:64", True),
            ("credential_id", "string:32", True),
            ("interval_seconds", "integer", False),
            ("expires_at", "datetime:tz", False),
            ("approved_at", "datetime:tz", True),
            ("consumed_at", "datetime:tz", True),
            ("last_polled_at", "datetime:tz", True),
            ("created_at", "datetime:tz", False),
        ),
        "primary_key": ("id",),
        "unique": (("device_code_hash",), ("user_code_hash",)),
        "indexes": {
            "ix_agent_device_authorizations_approved_user_id": ("approved_user_id",),
            "ix_agent_device_authorizations_credential_id": ("credential_id",),
            "ix_agent_device_authorizations_expiry": ("status", "expires_at"),
        },
        "foreign_keys": (
            ("approved_user_id", "users", "id", "CASCADE"),
            ("credential_id", "agent_credentials", "id", "SET NULL"),
        ),
    },
    "product_action_runs": {
        "columns": _columns(
            ("id", "string:32", False),
            ("request_id", "string:64", False),
            ("user_id", "string:64", False),
            ("credential_id", "string:32", True),
            ("action_id", "string:120", False),
            ("action_version", "string:24", False),
            ("run_type", "string:24", False),
            ("execution_location", "string:24", False),
            ("status", "string:24", False),
            ("input_json", "text", False),
            ("output_json", "text", True),
            ("error_json", "text", True),
            ("cancellation_requested", "boolean", False),
            ("next_sequence", "integer", False),
            ("idempotency_key", "string:160", True),
            ("input_hash", "string:64", False),
            ("external_type", "string:40", True),
            ("external_id", "string:64", True),
            ("external_event_cursor", "integer", False),
            ("lease_token", "string:32", True),
            ("lease_expires_at", "datetime:tz", True),
            ("created_at", "datetime:tz", False),
            ("started_at", "datetime:tz", True),
            ("completed_at", "datetime:tz", True),
            ("updated_at", "datetime:tz", False),
        ),
        "primary_key": ("id",),
        "unique": (),
        "indexes": {
            "ix_product_action_runs_request_id": ("request_id",),
            "ix_product_action_runs_user_id": ("user_id",),
            "ix_product_action_runs_credential_id": ("credential_id",),
            "ix_product_action_runs_idempotency_key": ("idempotency_key",),
            "ix_product_action_runs_external_type": ("external_type",),
            "ix_product_action_runs_external_id": ("external_id",),
            "ix_product_action_runs_lease_token": ("lease_token",),
            "ix_product_action_runs_updated_at": ("updated_at",),
            "ix_product_action_runs_user_updated": ("user_id", "updated_at"),
            "ix_product_action_runs_action_status": ("action_id", "status", "updated_at"),
        },
        "foreign_keys": (
            ("user_id", "users", "id", "CASCADE"),
            ("credential_id", "agent_credentials", "id", "SET NULL"),
        ),
    },
    "product_action_events": {
        "columns": _columns(
            ("id", "string:32", False),
            ("run_id", "string:32", False),
            ("user_id", "string:64", False),
            ("sequence", "integer", False),
            ("event_type", "string:80", False),
            ("status", "string:24", False),
            ("message", "string:500", False),
            ("data_json", "text", False),
            ("terminal", "boolean", False),
            ("terminal_key", "string:16", True),
            ("created_at", "datetime:tz", False),
        ),
        "primary_key": ("id",),
        "unique": (("run_id", "sequence"), ("run_id", "terminal_key")),
        "indexes": {
            "ix_product_action_events_run_id": ("run_id",),
            "ix_product_action_events_user_id": ("user_id",),
            "ix_product_action_events_user_run_seq": ("user_id", "run_id", "sequence"),
        },
        "foreign_keys": (
            ("run_id", "product_action_runs", "id", "CASCADE"),
            ("user_id", "users", "id", "CASCADE"),
        ),
    },
    "product_action_idempotency": {
        "columns": _columns(
            ("id", "string:32", False),
            ("user_id", "string:64", False),
            ("credential_key", "string:40", False),
            ("action_id", "string:120", False),
            ("idempotency_key", "string:160", False),
            ("input_hash", "string:64", False),
            ("run_id", "string:32", False),
            ("created_at", "datetime:tz", False),
        ),
        "primary_key": ("id",),
        "unique": (("user_id", "credential_key", "action_id", "idempotency_key"),),
        "indexes": {"ix_product_action_idempotency_run_id": ("run_id",)},
        "foreign_keys": (
            ("user_id", "users", "id", "CASCADE"),
            ("run_id", "product_action_runs", "id", "CASCADE"),
        ),
    },
    "product_action_confirmations": {
        "columns": _columns(
            ("id", "string:32", False),
            ("user_id", "string:64", False),
            ("credential_id", "string:32", True),
            ("action_id", "string:120", False),
            ("input_hash", "string:64", False),
            ("confirmation_summary_json", "text", False),
            ("status", "string:24", False),
            ("expires_at", "datetime:tz", False),
            ("approved_at", "datetime:tz", True),
            ("used_at", "datetime:tz", True),
            ("created_at", "datetime:tz", False),
        ),
        "primary_key": ("id",),
        "unique": (),
        "indexes": {
            "ix_product_action_confirmations_user_status": ("user_id", "status", "expires_at"),
        },
        "foreign_keys": (
            ("user_id", "users", "id", "CASCADE"),
            ("credential_id", "agent_credentials", "id", "CASCADE"),
        ),
    },
    "product_action_audits": {
        "columns": _columns(
            ("id", "string:32", False),
            ("user_id", "string:64", False),
            ("credential_id", "string:32", True),
            ("run_id", "string:32", True),
            ("action_id", "string:120", False),
            ("status", "string:24", False),
            ("error_code", "string:80", False),
            ("duration_ms", "integer", False),
            ("metadata_json", "text", False),
            ("created_at", "datetime:tz", False),
        ),
        "primary_key": ("id",),
        "unique": (),
        "indexes": {
            "ix_product_action_audits_user_created": ("user_id", "created_at"),
        },
        "foreign_keys": (
            ("user_id", "users", "id", "CASCADE"),
            ("credential_id", "agent_credentials", "id", "SET NULL"),
            ("run_id", "product_action_runs", "id", "SET NULL"),
        ),
    },
    "product_action_rate_windows": {
        "columns": _columns(
            ("id", "string:32", False),
            ("user_id", "string:64", False),
            ("credential_key", "string:40", False),
            ("action_id", "string:120", False),
            ("window_started_at", "datetime:tz", False),
            ("request_count", "integer", False),
            ("updated_at", "datetime:tz", False),
        ),
        "primary_key": ("id",),
        "unique": (("user_id", "credential_key", "action_id", "window_started_at"),),
        "indexes": {
            "ix_product_action_rate_window_expiry": ("window_started_at",),
        },
        "foreign_keys": (("user_id", "users", "id", "CASCADE"),),
    },
}


def type_signature(value: Any) -> str:
    if isinstance(value, Text):
        return "text"
    if isinstance(value, String):
        return f"string:{value.length or '*'}"
    if isinstance(value, Boolean):
        return "boolean"
    if isinstance(value, Integer):
        return "integer"
    if isinstance(value, DateTime):
        return "datetime:tz" if bool(value.timezone) else "datetime:naive"
    return value.__class__.__name__.lower()


def _column_tuple(value: Iterable[str] | None) -> tuple[str, ...]:
    return tuple(str(item) for item in (value or ()))


def inspect_schema(inspector: Any) -> dict[str, Any]:
    observed: dict[str, Any] = {}
    for table_name in sorted(EXPECTED_SCHEMA):
        columns = sorted(
            (
                {
                    "name": str(column["name"]),
                    "type": type_signature(column["type"]),
                    "nullable": bool(column["nullable"]),
                }
                for column in inspector.get_columns(table_name)
            ),
            key=lambda item: item["name"],
        )
        primary_key = _column_tuple(
            inspector.get_pk_constraint(table_name).get("constrained_columns")
        )
        unique_constraints = sorted(
            {
                _column_tuple(item.get("column_names"))
                for item in inspector.get_unique_constraints(table_name)
                if item.get("column_names")
            }
        )
        indexes = sorted(
            (
                {
                    "name": str(item.get("name") or ""),
                    "columns": _column_tuple(item.get("column_names")),
                    "unique": bool(item.get("unique")),
                }
                for item in inspector.get_indexes(table_name)
            ),
            key=lambda item: (item["name"], item["columns"]),
        )
        # Some dialects expose a unique constraint only as a unique index.
        unique_constraints = sorted(
            set(unique_constraints)
            | {item["columns"] for item in indexes if item["unique"]}
        )
        foreign_keys = sorted(
            (
                {
                    "columns": _column_tuple(item.get("constrained_columns")),
                    "referred_table": str(item.get("referred_table") or ""),
                    "referred_columns": _column_tuple(item.get("referred_columns")),
                    "ondelete": str((item.get("options") or {}).get("ondelete") or "").upper(),
                }
                for item in inspector.get_foreign_keys(table_name)
            ),
            key=lambda item: (
                item["columns"], item["referred_table"], item["referred_columns"]
            ),
        )
        observed[table_name] = {
            "columns": columns,
            "primary_key": primary_key,
            "unique": unique_constraints,
            "indexes": indexes,
            "foreign_keys": foreign_keys,
        }
    return observed


def validate_schema(observed: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for table_name, expected in EXPECTED_SCHEMA.items():
        actual = observed.get(table_name)
        if not isinstance(actual, dict):
            errors.append(f"缺少表 {table_name}")
            continue

        actual_columns = {item["name"]: item for item in actual["columns"]}
        for column_name, column_expected in expected["columns"].items():
            column_actual = actual_columns.get(column_name)
            if column_actual is None:
                errors.append(f"{table_name}.{column_name} 缺失")
                continue
            if column_actual["nullable"] != column_expected["nullable"]:
                errors.append(
                    f"{table_name}.{column_name} nullable={column_actual['nullable']}，"
                    f"期望 {column_expected['nullable']}"
                )
            if column_actual["type"] != column_expected["type"]:
                errors.append(
                    f"{table_name}.{column_name} 类型为 {column_actual['type']}，"
                    f"期望 {column_expected['type']}"
                )

        if tuple(actual["primary_key"]) != tuple(expected["primary_key"]):
            errors.append(
                f"{table_name} 主键为 {tuple(actual['primary_key'])}，"
                f"期望 {tuple(expected['primary_key'])}"
            )

        actual_unique = {tuple(item) for item in actual["unique"]}
        for required_unique in expected["unique"]:
            if tuple(required_unique) not in actual_unique:
                errors.append(f"{table_name} 缺少唯一约束 {tuple(required_unique)}")

        actual_indexes = {
            item["name"]: tuple(item["columns"]) for item in actual["indexes"]
        }
        for index_name, index_columns in expected["indexes"].items():
            if actual_indexes.get(index_name) != tuple(index_columns):
                errors.append(
                    f"{table_name} 缺少索引 {index_name}{tuple(index_columns)}"
                )

        actual_foreign_keys = {
            (
                tuple(item["columns"]),
                item["referred_table"],
                tuple(item["referred_columns"]),
                item["ondelete"],
            )
            for item in actual["foreign_keys"]
        }
        for column, target_table, target_column, ondelete in expected["foreign_keys"]:
            required = ((column,), target_table, (target_column,), ondelete)
            if required not in actual_foreign_keys:
                errors.append(
                    f"{table_name}.{column} 缺少外键 "
                    f"{target_table}.{target_column} ON DELETE {ondelete}"
                )
    return errors


def schema_fingerprint(observed: dict[str, Any]) -> str:
    payload = {
        "contract_version": CONTRACT_VERSION,
        "tables": observed,
    }
    canonical = json.dumps(
        payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return FINGERPRINT_PREFIX + hashlib.sha256(canonical).hexdigest()


def read_database_url(env_file: Path) -> str:
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, value = line.split("=", 1)
        if key.strip() == "DATABASE_URL":
            return value.strip().strip('"').strip("'")
    raise ValueError("环境文件缺少 DATABASE_URL")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="校验知萃 Agent PostgreSQL 结构")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--env-file", type=Path)
    source.add_argument(
        "--database-url-file",
        type=Path,
        help="只含隔离数据库 URL 的 0600 文件；用于恢复快照演练",
    )
    parser.add_argument(
        "--require-postgresql",
        action="store_true",
        help="拒绝非 PostgreSQL 数据库（生产发布必须启用）",
    )
    parser.add_argument("--output", choices=("fingerprint", "json"), default="json")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.database_url_file is not None:
            database_url = args.database_url_file.read_text(encoding="utf-8").strip()
        else:
            database_url = read_database_url(args.env_file)
        engine = create_engine(database_url, pool_pre_ping=True)
        try:
            if args.require_postgresql and engine.dialect.name != "postgresql":
                raise RuntimeError(
                    f"生产结构门禁只接受 PostgreSQL，当前为 {engine.dialect.name}"
                )
            inspector = inspect(engine)
            present = set(inspector.get_table_names())
            missing = sorted(set(EXPECTED_SCHEMA) - present)
            if missing:
                raise RuntimeError("缺少 Agent 持久化表：" + ", ".join(missing))
            observed = inspect_schema(inspector)
        finally:
            engine.dispose()
        errors = validate_schema(observed)
        if errors:
            raise RuntimeError("；".join(errors))
        fingerprint = schema_fingerprint(observed)
        if args.output == "fingerprint":
            print(fingerprint)
        else:
            print(
                json.dumps(
                    {
                        "contract_version": CONTRACT_VERSION,
                        "fingerprint": fingerprint,
                        "table_count": len(observed),
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
            )
        return 0
    except Exception as exc:  # deploy gate: one concise, secret-free failure line
        print(f"Agent 数据库结构校验失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
