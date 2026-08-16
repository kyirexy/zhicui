"""Persistent catalog, billing, job, and result models for video analysis.

The feature deliberately keeps technical providers, published user offerings,
money-like analysis credits, execution state, and cached results separate.  All
JSON fields contain bounded metadata only; media URLs, frames, cookies, prompts,
and provider secrets must never be written to run or result rows.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


POINTS_PER_CNY = 1000

PROVIDER_HEALTH_STATUSES = {
    "untested",
    "healthy",
    "unhealthy",
    "circuit_open",
}
RUN_STATUSES = {
    "prepared",
    "queued",
    "running",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "reauthorization_required",
}
ITEM_STATUSES = {
    "prepared",
    "queued",
    "running",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "cached",
    "unsupported",
    "reauthorization_required",
}
BILLING_STATUSES = {
    "quoted",
    "reserved",
    "captured",
    "released",
    "refunded",
    "not_billable",
    "reconciliation_pending",
}
ITEM_STAGES = {
    "prepared",
    "downloading",
    "detecting_scenes",
    "sampling_frames",
    "analyzing_visuals",
    "persisting",
    "completed",
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


def _json_dict(raw: str | None) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


class VisionProvider(Base):
    """One administrator-managed technical provider and credential."""

    __tablename__ = "vision_providers"
    __table_args__ = (
        UniqueConstraint("code", name="uq_vision_provider_code"),
        Index("ix_vision_provider_enabled_health", "enabled", "health_status"),
        CheckConstraint("max_concurrency >= 1", name="ck_vision_provider_concurrency"),
        CheckConstraint("daily_budget_micros >= 0", name="ck_vision_provider_budget"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    driver: Mapped[str] = mapped_column(String(48), nullable=False)
    default_model: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    api_base: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    encrypted_api_key: Mapped[str] = mapped_column(Text, default="", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    capabilities_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    metering_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    limits_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    cost_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    max_concurrency: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    daily_budget_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    health_status: Mapped[str] = mapped_column(
        String(24), default="untested", nullable=False
    )
    health_message: Mapped[str] = mapped_column(String(256), default="", nullable=False)
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_tested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_test_succeeded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    circuit_open_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    @property
    def capabilities(self) -> dict[str, Any]:
        return _json_dict(self.capabilities_json)

    @property
    def metering(self) -> dict[str, Any]:
        return _json_dict(self.metering_json)

    @property
    def limits(self) -> dict[str, Any]:
        return _json_dict(self.limits_json)

    @property
    def cost(self) -> dict[str, Any]:
        return _json_dict(self.cost_json)


class VideoAnalysisOffering(Base):
    """Mutable draft and publication pointer for a user-facing analysis SKU."""

    __tablename__ = "video_analysis_offerings"
    __table_args__ = (
        UniqueConstraint("code", name="uq_video_analysis_offering_code"),
        Index("ix_video_analysis_offering_status_order", "status", "sort_order"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    method: Mapped[str] = mapped_column(String(32), default="local_scene", nullable=False)
    provider_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("vision_providers.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    model: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    recommended: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    byok_allowed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="draft", nullable=False)
    current_version_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    next_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    triggers_json: Mapped[str] = mapped_column(
        Text, default='["manual","batch","agent"]', nullable=False
    )
    limits_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    pricing_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    free_quota_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    fallback_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class VideoAnalysisOfferingVersion(Base):
    """Immutable snapshot used by quotes, tasks, caches, and audit reports."""

    __tablename__ = "video_analysis_offering_versions"
    __table_args__ = (
        UniqueConstraint(
            "offering_id",
            "version_number",
            name="uq_video_analysis_offering_version",
        ),
        Index("ix_video_analysis_version_published", "offering_id", "published_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    offering_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("video_analysis_offerings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    method: Mapped[str] = mapped_column(String(32), nullable=False)
    provider_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("vision_providers.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    model: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    recommended: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    byok_allowed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    triggers_json: Mapped[str] = mapped_column(Text, nullable=False)
    limits_json: Mapped[str] = mapped_column(Text, nullable=False)
    pricing_json: Mapped[str] = mapped_column(Text, nullable=False)
    free_quota_json: Mapped[str] = mapped_column(Text, nullable=False)
    fallback_json: Mapped[str] = mapped_column(Text, nullable=False)
    provider_snapshot_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    published_by_admin_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    published_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    @property
    def limits(self) -> dict[str, Any]:
        return _json_dict(self.limits_json)

    @property
    def pricing(self) -> dict[str, Any]:
        return _json_dict(self.pricing_json)

    @property
    def free_quota(self) -> dict[str, Any]:
        return _json_dict(self.free_quota_json)


class UserAnalysisAccount(Base):
    """Fast balance snapshot; every mutation also appends a ledger row."""

    __tablename__ = "user_analysis_accounts"
    __table_args__ = (
        CheckConstraint("available_points >= 0", name="ck_analysis_account_available"),
        CheckConstraint("reserved_points >= 0", name="ck_analysis_account_reserved"),
    )

    user_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    available_points: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    reserved_points: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    agent_auto_paid_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    agent_per_run_limit_points: Mapped[int] = mapped_column(
        BigInteger, default=0, nullable=False
    )
    agent_daily_limit_points: Mapped[int] = mapped_column(
        BigInteger, default=0, nullable=False
    )
    agent_byok_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class VideoAnalysisRun(Base):
    """A persisted single or batch request and its immutable quote snapshot."""

    __tablename__ = "video_analysis_runs"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "confirm_idempotency_key",
            name="uq_video_analysis_run_confirm_key",
        ),
        Index("ix_video_analysis_run_user_status", "user_id", "status", "created_at"),
        Index("ix_video_analysis_run_status_updated", "status", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    trigger: Mapped[str] = mapped_column(String(24), default="manual", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="prepared", nullable=False)
    billing_status: Mapped[str] = mapped_column(
        String(24), default="quoted", nullable=False
    )
    offering_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("video_analysis_offerings.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    offering_version_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("video_analysis_offering_versions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    provider_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("vision_providers.id", ondelete="SET NULL"),
        nullable=True,
    )
    use_byok: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    credential_owner: Mapped[str] = mapped_column(
        String(16), default="platform", nullable=False
    )
    funding_source: Mapped[str] = mapped_column(
        String(32), default="unresolved", nullable=False
    )
    confirm_idempotency_key: Mapped[str | None] = mapped_column(
        String(160), nullable=True
    )
    agent_thread_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("agent_threads.id", ondelete="SET NULL"), nullable=True
    )
    agent_turn_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    agent_context_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cached_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    unsupported_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completed_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    quoted_points: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    max_reserved_points: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    reserved_points: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    captured_points: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    free_units_reserved: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    free_units_captured: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    platform_cost_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    quote_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    quote_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    error_code: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    error_detail: Mapped[str] = mapped_column(String(256), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class VideoAnalysis(Base):
    """Structured analysis cache; raw media and sampled frames never live here."""

    __tablename__ = "video_analyses"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "note_id",
            "offering_version_id",
            "source_fingerprint",
            "revision",
            name="uq_video_analysis_cache_revision",
        ),
        Index(
            "ix_video_analysis_cache_lookup",
            "user_id",
            "note_id",
            "offering_version_id",
            "source_fingerprint",
            "is_current",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    note_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("notes.id", ondelete="CASCADE"), nullable=False
    )
    offering_version_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("video_analysis_offering_versions.id", ondelete="RESTRICT"),
        nullable=False,
    )
    provider_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("vision_providers.id", ondelete="SET NULL"), nullable=True
    )
    source_fingerprint: Mapped[str] = mapped_column(String(128), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    analysis_version: Mapped[str] = mapped_column(
        String(64), default="video-analysis-v1", nullable=False
    )
    result_json: Mapped[str] = mapped_column(Text, nullable=False)
    scene_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    frame_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    duration_ms: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    degraded_reason: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    @property
    def result(self) -> dict[str, Any]:
        return _json_dict(self.result_json)


class VideoAnalysisItem(Base):
    """One independently executable and billable Note in a run."""

    __tablename__ = "video_analysis_items"
    __table_args__ = (
        UniqueConstraint("run_id", "note_id", name="uq_video_analysis_item_note"),
        Index("ix_video_analysis_item_claim", "status", "claimed_at", "created_at"),
        Index("ix_video_analysis_item_user_status", "user_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("video_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    note_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("notes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    offering_version_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("video_analysis_offering_versions.id", ondelete="RESTRICT"),
        nullable=False,
    )
    provider_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("vision_providers.id", ondelete="SET NULL"), nullable=True
    )
    use_byok: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="prepared", nullable=False)
    stage: Mapped[str] = mapped_column(String(32), default="prepared", nullable=False)
    billing_status: Mapped[str] = mapped_column(
        String(24), default="quoted", nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    progress_percent: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    cancel_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    source_duration_ms: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    source_fingerprint: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    billing_quantity: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    quoted_points: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    reserved_points: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    captured_points: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    free_units_reserved: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    free_units_captured: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    platform_cost_reserved_micros: Mapped[int] = mapped_column(
        BigInteger, default=0, nullable=False
    )
    platform_cost_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    failure_cost_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    pricing_snapshot_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    quota_snapshot_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    analysis_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("video_analyses.id", ondelete="SET NULL"), nullable=True
    )
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    worker_id: Mapped[str] = mapped_column(String(96), default="", nullable=False)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_code: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    error_detail: Mapped[str] = mapped_column(String(256), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class AnalysisCreditLedger(Base):
    """Immutable analysis-credit journal.  Rows are never updated or deleted."""

    __tablename__ = "analysis_credit_ledger"
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uq_analysis_credit_ledger_key"),
        Index("ix_analysis_credit_ledger_user_created", "user_id", "created_at"),
        Index("ix_analysis_credit_ledger_run", "run_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    run_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("video_analysis_runs.id", ondelete="SET NULL"), nullable=True
    )
    item_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("video_analysis_items.id", ondelete="SET NULL"), nullable=True
    )
    entry_type: Mapped[str] = mapped_column(String(24), nullable=False)
    available_delta: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    reserved_delta: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    available_after: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    reserved_after: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(180), nullable=False)
    reason: Mapped[str] = mapped_column(String(256), default="", nullable=False)
    admin_user_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    metadata_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )


class UserVisionProviderConfig(Base):
    """User-scoped visual BYOK configuration, independent of text LLM routing."""

    __tablename__ = "user_vision_provider_configs"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_user_vision_provider_user"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider_name: Mapped[str] = mapped_column(String(80), nullable=False)
    driver: Mapped[str] = mapped_column(String(48), nullable=False)
    model: Mapped[str] = mapped_column(String(160), nullable=False)
    api_base: Mapped[str] = mapped_column(String(512), nullable=False)
    encrypted_api_key: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    health_status: Mapped[str] = mapped_column(
        String(24), default="untested", nullable=False
    )
    health_message: Mapped[str] = mapped_column(String(256), default="", nullable=False)
    capabilities_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_test_succeeded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class VideoAnalysisFreeUsage(Base):
    """Concurrency-safe free allowance reservation and consumption bucket."""

    __tablename__ = "video_analysis_free_usage"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "quota_scope",
            "period_key",
            name="uq_video_analysis_free_usage_period",
        ),
        CheckConstraint("reserved_units >= 0", name="ck_analysis_free_reserved"),
        CheckConstraint("used_units >= 0", name="ck_analysis_free_used"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    quota_scope: Mapped[str] = mapped_column(String(64), nullable=False)
    period_key: Mapped[str] = mapped_column(String(32), nullable=False)
    unit_type: Mapped[str] = mapped_column(String(16), nullable=False)
    reserved_units: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    used_units: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )
