from __future__ import annotations

import copy
import importlib.util
import re
import unittest
from pathlib import Path

from sqlalchemy import ForeignKeyConstraint, UniqueConstraint

from app.models.agent_interface import (
    AgentCredential,
    AgentDeviceAuthorization,
    ProductActionAudit,
    ProductActionConfirmation,
    ProductActionEvent,
    ProductActionIdempotency,
    ProductActionRateWindow,
    ProductActionRun,
)


ROOT = Path(__file__).resolve().parents[2]
VERIFY_SCRIPT = ROOT / "deploy" / "verify-agent-schema.py"


def _load_verify_module():
    spec = importlib.util.spec_from_file_location("verify_agent_schema", VERIFY_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 Agent schema verifier")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AgentSchemaReleaseGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.verifier = _load_verify_module()

    def test_versioned_contract_matches_the_eight_reviewed_models(self) -> None:
        models = (
            AgentCredential,
            AgentDeviceAuthorization,
            ProductActionRun,
            ProductActionEvent,
            ProductActionIdempotency,
            ProductActionConfirmation,
            ProductActionAudit,
            ProductActionRateWindow,
        )
        metadata_tables = {model.__table__.name: model.__table__ for model in models}
        self.assertEqual(set(self.verifier.EXPECTED_SCHEMA), set(metadata_tables))
        self.assertEqual(self.verifier.CONTRACT_VERSION, 1)

        for table_name, table in metadata_tables.items():
            expected = self.verifier.EXPECTED_SCHEMA[table_name]
            actual_columns = {
                column.name: {
                    "type": self.verifier.type_signature(column.type),
                    "nullable": bool(column.nullable),
                }
                for column in table.columns
            }
            self.assertEqual(expected["columns"], actual_columns, table_name)
            self.assertEqual(tuple(table.primary_key.columns.keys()), expected["primary_key"])

            actual_unique = {
                tuple(constraint.columns.keys())
                for constraint in table.constraints
                if isinstance(constraint, UniqueConstraint)
            }
            self.assertEqual(set(expected["unique"]), actual_unique, table_name)

            actual_indexes = {
                index.name: tuple(index.columns.keys()) for index in table.indexes
            }
            self.assertEqual(expected["indexes"], actual_indexes, table_name)

            actual_foreign_keys = set()
            for constraint in table.constraints:
                if not isinstance(constraint, ForeignKeyConstraint):
                    continue
                self.assertEqual(len(constraint.elements), 1, table_name)
                element = constraint.elements[0]
                target_table, target_column = element.target_fullname.rsplit(".", 1)
                actual_foreign_keys.add(
                    (
                        element.parent.name,
                        target_table,
                        target_column,
                        str(element.ondelete or "").upper(),
                    )
                )
            self.assertEqual(set(expected["foreign_keys"]), actual_foreign_keys, table_name)

    def test_fingerprint_is_versioned_deterministic_and_structure_sensitive(self) -> None:
        observed = {
            "agent_credentials": {
                "columns": [
                    {"name": "id", "type": "string:32", "nullable": False}
                ],
                "primary_key": ("id",),
                "unique": [],
                "indexes": [],
                "foreign_keys": [],
            }
        }
        first = self.verifier.schema_fingerprint(observed)
        second = self.verifier.schema_fingerprint(copy.deepcopy(observed))
        changed = copy.deepcopy(observed)
        changed["agent_credentials"]["columns"][0]["nullable"] = True
        self.assertEqual(first, second)
        self.assertNotEqual(first, self.verifier.schema_fingerprint(changed))
        self.assertRegex(first, re.compile(r"^agent-schema-v1:[0-9a-f]{64}$"))

    def test_deploy_requires_same_dark_commit_and_database_fingerprint(self) -> None:
        deploy = (ROOT / "deploy" / "deploy.sh").read_text(encoding="utf-8")
        for marker in (
            '"$runtime/deploy/verify-agent-schema.py"',
            "--require-postgresql",
            "PREVIOUS_AGENT_SCHEMA_FINGERPRINT",
            "TARGET_AGENT_SCHEMA_FINGERPRINT",
            "verify_agent_schema_dark_baseline",
            '[[ "$PREVIOUS_RUNTIME_COMMIT" == "$TARGET_COMMIT" ]]',
            '[[ "$TARGET_AGENT_SCHEMA_FINGERPRINT" == "$PREVIOUS_AGENT_SCHEMA_FINGERPRINT" ]]',
            'sudo -n "$RELEASE_EVIDENCE_HELPER" verify-dark',
            "verify_agent_schema_rehearsal",
            'sudo -n "$RELEASE_EVIDENCE_HELPER" verify-rehearsal',
            "AGENT_SCHEMA_DARK_EVIDENCE_SHA256",
            "AGENT_SCHEMA_REHEARSAL_EVIDENCE_SHA256",
            "agent_schema_rehearsal",
        ):
            self.assertIn(marker, deploy)

    def test_release_evidence_records_mode_and_both_fingerprints(self) -> None:
        deploy = (ROOT / "deploy" / "deploy.sh").read_text(encoding="utf-8")
        self.assertIn('"agent_release_mode": agent_release_mode', deploy)
        self.assertIn(
            '"previous_agent_schema_fingerprint": previous_agent_schema_fingerprint or None',
            deploy,
        )
        self.assertIn(
            '"target_agent_schema_fingerprint": target_agent_schema_fingerprint or None',
            deploy,
        )
        self.assertIn(
            '"rehearsal_evidence": ({"name": rehearsal_evidence_name, "sha256": rehearsal_evidence_sha256}',
            deploy,
        )
        self.assertIn(
            '"dark_evidence": ({"name": dark_evidence_name, "sha256": dark_evidence_sha256}',
            deploy,
        )
        self.assertIn(
            '"backup": ({',
            deploy,
        )

    def test_snapshot_rehearsal_is_isolated_repeatable_and_secret_safe(self) -> None:
        rehearsal = (ROOT / "deploy" / "rehearse-agent-schema-upgrade.py").read_text(
            encoding="utf-8"
        )
        for marker in (
            'DATABASE_PREFIXES = ("zhicui_restore_verify_", "zhicui_agent_rehearsal_")',
            '"AGENT_INTERFACE_ENABLED": "false"',
            "for _ in range(2):",
            '"schema_startup_passes": 2',
            '"workers_started": False',
            '"snapshot_counts": snapshot_counts',
            '"agent_schema_fingerprint": fingerprint',
            '"--database-url-file"',
            '"--snapshot-file"',
            '"--dark-evidence-file"',
            '"predecessor": {',
            '"sha256": dark_sha256',
        ):
            self.assertIn(marker, rehearsal)
        self.assertNotIn('"database_url": database_url', rehearsal)
        self.assertNotIn("shell=True", rehearsal)


if __name__ == "__main__":
    unittest.main()
