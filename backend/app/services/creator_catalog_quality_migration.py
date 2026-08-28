"""Compatibility migration hook for catalog quality columns.

`main.py` owns startup sequencing.  Keeping the DDL here lets that sequence
call one focused, idempotent hook without duplicating connector-specific
schema knowledge in the app factory.
"""

from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine


QUALITY_COLUMNS = {
    "metadata_quality": "VARCHAR(24) NOT NULL DEFAULT 'unknown'",
    "quality_issues_json": "TEXT NOT NULL DEFAULT '[]'",
    "needs_enrichment": "BOOLEAN NOT NULL DEFAULT FALSE",
    "transcription_blocked": "BOOLEAN NOT NULL DEFAULT FALSE",
    "quality_checked_at": "TIMESTAMP NULL",
    "quarantined_at": "TIMESTAMP NULL",
}

QUALITY_RUN_COLUMNS = {
    "lease_token": "VARCHAR(64) NOT NULL DEFAULT ''",
    "lease_expires_at": "TIMESTAMP NULL",
}


def ensure_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    with engine.begin() as connection:
        if "creator_source_items" in table_names:
            existing = {
                str(column["name"])
                for column in inspector.get_columns("creator_source_items")
            }
            for name, definition in QUALITY_COLUMNS.items():
                if name not in existing:
                    connection.execute(text(
                        f"ALTER TABLE creator_source_items ADD COLUMN {name} {definition}"
                    ))
            connection.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_creator_items_quality "
                "ON creator_source_items "
                "(metadata_quality, transcription_blocked, source_id)"
            ))
        if "creator_catalog_quality_runs" in table_names:
            existing_runs = {
                str(column["name"])
                for column in inspector.get_columns("creator_catalog_quality_runs")
            }
            for name, definition in QUALITY_RUN_COLUMNS.items():
                if name not in existing_runs:
                    connection.execute(text(
                        "ALTER TABLE creator_catalog_quality_runs "
                        f"ADD COLUMN {name} {definition}"
                    ))
            connection.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_creator_quality_runs_lease "
                "ON creator_catalog_quality_runs (status, lease_expires_at)"
            ))
