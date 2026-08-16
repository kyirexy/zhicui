"""Curated knowledge pages and read-only video-summary candidates."""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import and_, exists, or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Query, Session

from app.models.knowledge_entry import KnowledgeEntry
from app.models.note import Note


KnowledgeView = Literal["pages", "inbox"]

_CANONICAL_STATUS = "canonical"
_MANUAL_ORIGIN = "manual"
_VIDEO_ORIGIN = "video"
_INELIGIBLE_GENERATION_STATUSES = {
    "error",
    "failed",
    "fallback",
    "pending",
    "processing",
}
_LEGACY_FAILURE_MARKERS = (
    "AI 暂时无法生成结构化卡片",
    "AI 处理暂时不可用",
)


def _clean(value: Any, *, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _candidate_text(value: Any, *, limit: int) -> str:
    """Accept only human-readable JSON strings for candidate prose."""
    return value.strip(" \t\r\n\v\f")[:limit] if isinstance(value, str) else ""


def _parse_ai_summary(raw: str | None) -> dict[str, Any]:
    try:
        parsed = json.loads(raw or "{}")
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _source_meta(parsed: dict[str, Any]) -> dict[str, Any]:
    value = parsed.get("source_meta")
    return value if isinstance(value, dict) else {}


def _normalized_sections(parsed: dict[str, Any]) -> list[dict[str, str]]:
    raw_sections = parsed.get("sections")
    if not isinstance(raw_sections, list):
        return []

    sections: list[dict[str, str]] = []
    for index, raw_section in enumerate(raw_sections[:24], start=1):
        if not isinstance(raw_section, dict):
            continue
        title = _candidate_text(raw_section.get("title"), limit=256)
        content = _candidate_text(raw_section.get("content"), limit=12_000)
        if not content and isinstance(raw_section.get("items"), list):
            content = "\n".join(
                f"- {_candidate_text(item, limit=1_000)}"
                for item in raw_section["items"][:50]
                if _candidate_text(item, limit=1_000)
            )
        # A heading without readable content is not a meaningful summary.
        if not content:
            continue
        sections.append({
            "title": title or f"要点 {index}",
            "content": content,
        })
    return sections


def _candidate_parts(note: Note) -> dict[str, Any] | None:
    """Return normalized AI content only when a Note is a real candidate."""
    if not bool(note.ai_initialized):
        return None
    parsed = _parse_ai_summary(note.ai_summary)
    if not parsed:
        return None
    generation_status = _clean(parsed.get("generation_status"), limit=32).lower()
    if generation_status in _INELIGIBLE_GENERATION_STATUSES:
        return None

    key_insight = _candidate_text(parsed.get("key_insight"), limit=4_000)
    conclusion = _candidate_text(parsed.get("conclusion"), limit=12_000)
    if any(
        marker in key_insight or marker in conclusion
        for marker in _LEGACY_FAILURE_MARKERS
    ):
        return None
    sections = _normalized_sections(parsed)
    if not key_insight and not conclusion and not sections:
        return None

    summary = key_insight or conclusion or sections[0]["content"]
    body_parts: list[str] = []
    for section in sections:
        body_parts.append(f"## {section['title']}\n\n{section['content']}")
    if conclusion and all(conclusion != section["content"] for section in sections):
        body_parts.append(f"## 总结\n\n{conclusion}")
    if not body_parts:
        body_parts.append(conclusion or key_insight)

    return {
        "parsed": parsed,
        "key_insight": key_insight,
        "conclusion": conclusion,
        "sections": sections,
        "summary": _clean(summary, limit=4_000),
        "content": _clean("\n\n".join(body_parts), limit=100_000),
    }


def normalize_candidate_to_page(note: Note) -> dict[str, str] | None:
    """Normalize a meaningful Note summary into editable canonical page fields."""
    parts = _candidate_parts(note)
    if parts is None:
        return None
    meta = _source_meta(parts["parsed"])
    author = _clean(meta.get("author_name"), limit=256)
    platform = _clean(meta.get("platform"), limit=80)
    return {
        "title": _clean(note.video_title, limit=256) or "未命名视频",
        "summary": parts["summary"],
        "content": parts["content"],
        "source_label": author or platform or "视频资料",
    }


def _note_source_fields(note: Note | None) -> dict[str, Any]:
    if note is None:
        return {
            "video_id": "",
            "video_url": "",
            "source_url": "",
            "cover_url": "",
            "author_name": "",
            "platform": "",
            "section_count": 0,
            "sections": [],
            "conclusion": "",
            "key_insight": "",
            "transcript_ready": False,
        }
    parsed = _parse_ai_summary(note.ai_summary)
    meta = _source_meta(parsed)
    sections = _normalized_sections(parsed)
    return {
        "video_id": note.video_id,
        "video_url": note.video_url,
        "source_url": _clean(meta.get("source_url"), limit=1_024) or note.video_url,
        "cover_url": _clean(meta.get("cover_url"), limit=2_048),
        "author_name": _clean(meta.get("author_name"), limit=256),
        "platform": _clean(meta.get("platform"), limit=80),
        "section_count": len(sections),
        "sections": sections,
        "conclusion": _clean(parsed.get("conclusion"), limit=12_000),
        "key_insight": _clean(parsed.get("key_insight"), limit=4_000),
        "transcript_ready": bool(note.transcript_raw),
    }


def serialize_entry(entry: KnowledgeEntry, source_note: Note | None = None) -> dict[str, Any]:
    """Serialize a canonical page without exposing another user's source Note."""
    item = entry.to_dict()
    linked = source_note is not None and source_note.user_id == entry.user_id
    item["source_note_id"] = source_note.id if linked else None
    item["source_count"] = 1 if linked else 0
    item.update(_note_source_fields(source_note if linked else None))
    return item


def serialize_candidate(note: Note) -> dict[str, Any] | None:
    """Project an eligible Note as a read-only inbox candidate."""
    parts = _candidate_parts(note)
    if parts is None:
        return None
    source = _note_source_fields(note)
    meta = _source_meta(parts["parsed"])
    source_label = (
        _clean(meta.get("author_name"), limit=256)
        or _clean(meta.get("platform"), limit=80)
        or "视频资料"
    )
    created_at = note.created_at.isoformat() if note.created_at else None
    updated_at = note.updated_at.isoformat() if note.updated_at else None
    return {
        "id": note.id,
        "kind": "candidate",
        "title": _clean(note.video_title, limit=512) or "未命名视频",
        "summary": parts["summary"],
        "content": parts["content"],
        "excerpt": parts["summary"][:180],
        "status": "inbox",
        "origin": _VIDEO_ORIGIN,
        "source_note_id": note.id,
        "source_count": 1,
        "source_label": source_label,
        "content_chars": len(parts["content"]),
        "created_at": created_at,
        "updated_at": updated_at,
        **source,
    }


def serialize_source_reference(note: Note) -> dict[str, Any]:
    """Serialize an owned legacy Note that is not eligible for the inbox."""
    source = _note_source_fields(note)
    source.update({
        "section_count": 0,
        "sections": [],
        "conclusion": "",
        "key_insight": "",
    })
    parsed = _parse_ai_summary(note.ai_summary)
    meta = _source_meta(parsed)
    source_label = (
        _clean(meta.get("author_name"), limit=256)
        or _clean(meta.get("platform"), limit=80)
        or "视频资料"
    )
    created_at = note.created_at.isoformat() if note.created_at else None
    updated_at = note.updated_at.isoformat() if note.updated_at else None
    return {
        "id": note.id,
        "kind": "candidate",
        "title": _clean(note.video_title, limit=512) or "未命名视频",
        "summary": "",
        "content": "",
        "excerpt": "",
        "status": "source-only",
        "origin": _VIDEO_ORIGIN,
        "source_note_id": note.id,
        "source_count": 1,
        "source_label": source_label,
        "content_chars": 0,
        "created_at": created_at,
        "updated_at": updated_at,
        **source,
    }


def get_candidate_item(
    db: Session,
    user_id: str,
    note_id: str,
) -> dict[str, Any] | None:
    """Return the server-authoritative candidate or legacy source projection."""
    note = db.query(Note).filter(Note.id == note_id, Note.user_id == user_id).first()
    if note is None:
        return None
    return serialize_candidate(note) or serialize_source_reference(note)


def create_entry(
    db: Session,
    user_id: str,
    *,
    title: str,
    content: str,
    summary: str = "",
    source_label: str = "",
) -> KnowledgeEntry:
    clean_title = _clean(title, limit=256)
    clean_content = _clean(content, limit=100_000)
    if not clean_title:
        raise ValueError("标题不能为空")
    if not clean_content:
        raise ValueError("正文不能为空")
    entry = KnowledgeEntry(
        user_id=user_id,
        title=clean_title,
        summary=_clean(summary, limit=4_000),
        content=clean_content,
        status=_CANONICAL_STATUS,
        origin=_MANUAL_ORIGIN,
        source_label=_clean(source_label, limit=256),
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def get_entry(db: Session, user_id: str, entry_id: str) -> KnowledgeEntry | None:
    return db.query(KnowledgeEntry).filter(
        KnowledgeEntry.id == entry_id,
        KnowledgeEntry.user_id == user_id,
    ).first()


def get_entry_item(db: Session, user_id: str, entry_id: str) -> dict[str, Any] | None:
    row = (
        db.query(KnowledgeEntry, Note)
        .outerjoin(
            Note,
            and_(
                KnowledgeEntry.source_note_id == Note.id,
                Note.user_id == user_id,
            ),
        )
        .filter(
            KnowledgeEntry.id == entry_id,
            KnowledgeEntry.user_id == user_id,
        )
        .first()
    )
    return serialize_entry(row[0], row[1]) if row else None


def update_entry(
    db: Session,
    entry: KnowledgeEntry,
    *,
    title: str | None = None,
    summary: str | None = None,
    content: str | None = None,
    source_label: str | None = None,
) -> KnowledgeEntry:
    if title is not None:
        clean_title = _clean(title, limit=256)
        if not clean_title:
            raise ValueError("标题不能为空")
        entry.title = clean_title
    if summary is not None:
        entry.summary = _clean(summary, limit=4_000)
    if content is not None:
        clean_content = _clean(content, limit=100_000)
        if not clean_content:
            raise ValueError("正文不能为空")
        entry.content = clean_content
    if source_label is not None:
        entry.source_label = _clean(source_label, limit=256)
    entry.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(entry)
    return entry


def delete_entry(db: Session, entry: KnowledgeEntry) -> None:
    db.delete(entry)
    db.commit()


def _candidate_eligibility_sql(db: Session):
    """Return a dialect-safe DB predicate for meaningful AI summary content."""
    dialect = db.get_bind().dialect.name
    if dialect == "sqlite":
        return text(
            "CASE WHEN json_valid(notes.ai_summary) = 1 THEN ("
            "LOWER(COALESCE(json_extract(notes.ai_summary, '$.generation_status'), '')) "
            "NOT IN ('error','failed','fallback','pending','processing') AND "
            "INSTR(COALESCE(json_extract(notes.ai_summary, '$.key_insight'), ''), "
            "'AI 暂时无法生成结构化卡片') = 0 AND "
            "INSTR(COALESCE(json_extract(notes.ai_summary, '$.conclusion'), ''), "
            "'AI 处理暂时不可用') = 0 AND ("
            "(json_type(notes.ai_summary, '$.key_insight') = 'text' AND "
            "NULLIF(TRIM(COALESCE(json_extract(notes.ai_summary, '$.key_insight'), ''), "
            "' ' || CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13)), '') "
            "IS NOT NULL) OR "
            "(json_type(notes.ai_summary, '$.conclusion') = 'text' AND "
            "NULLIF(TRIM(COALESCE(json_extract(notes.ai_summary, '$.conclusion'), ''), "
            "' ' || CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13)), '') "
            "IS NOT NULL) OR EXISTS ("
            "SELECT 1 FROM json_each(CASE "
            "WHEN json_type(notes.ai_summary, '$.sections') = 'array' "
            "THEN json_extract(notes.ai_summary, '$.sections') ELSE '[]' END) AS ks "
            "WHERE CAST(ks.key AS INTEGER) < 24 AND ks.type = 'object' AND "
            "((json_type(CASE WHEN ks.type = 'object' "
            "THEN ks.value ELSE '{}' END, '$.content') = 'text' AND "
            "NULLIF(TRIM(COALESCE(json_extract(CASE WHEN ks.type = 'object' "
            "THEN ks.value ELSE '{}' END, '$.content'), ''), "
            "' ' || CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13)), '') "
            "IS NOT NULL) OR EXISTS (SELECT 1 FROM json_each(CASE "
            "WHEN json_type(CASE WHEN ks.type = 'object' THEN ks.value ELSE '{}' END, "
            "'$.items') = 'array' THEN json_extract(CASE WHEN ks.type = 'object' "
            "THEN ks.value ELSE '{}' END, '$.items') ELSE '[]' END) AS ki "
            "WHERE CAST(ki.key AS INTEGER) < 50 AND ki.type = 'text' AND "
            "NULLIF(TRIM(COALESCE(CAST(ki.value AS TEXT), ''), "
            "' ' || CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13)), '') "
            "IS NOT NULL)"
            ")))) ELSE 0 END"
        )
    if dialect == "postgresql":
        # Production runs PostgreSQL 16, whose IS JSON predicate lets legacy
        # malformed Text rows be rejected before a safe jsonb cast.
        return text(
            "CASE WHEN notes.ai_summary IS JSON THEN ("
            "LOWER(COALESCE((notes.ai_summary::jsonb)->>'generation_status', '')) "
            "NOT IN ('error','failed','fallback','pending','processing') AND "
            "POSITION('AI 暂时无法生成结构化卡片' IN "
            "COALESCE((notes.ai_summary::jsonb)->>'key_insight', '')) = 0 AND "
            "POSITION('AI 处理暂时不可用' IN "
            "COALESCE((notes.ai_summary::jsonb)->>'conclusion', '')) = 0 AND ("
            "(jsonb_typeof((notes.ai_summary::jsonb)->'key_insight') = 'string' AND "
            "NULLIF(BTRIM(COALESCE((notes.ai_summary::jsonb)->>'key_insight', ''), "
            "E' \\t\\n\\v\\f\\r'), '') "
            "IS NOT NULL) OR "
            "(jsonb_typeof((notes.ai_summary::jsonb)->'conclusion') = 'string' AND "
            "NULLIF(BTRIM(COALESCE((notes.ai_summary::jsonb)->>'conclusion', ''), "
            "E' \\t\\n\\v\\f\\r'), '') "
            "IS NOT NULL) OR EXISTS ("
            "SELECT 1 FROM jsonb_array_elements(CASE "
            "WHEN jsonb_typeof((notes.ai_summary::jsonb)->'sections') = 'array' "
            "THEN (notes.ai_summary::jsonb)->'sections' ELSE '[]'::jsonb END) "
            "WITH ORDINALITY AS ks(value, ord) "
            "WHERE ks.ord <= 24 AND ((jsonb_typeof(ks.value->'content') = 'string' AND "
            "NULLIF(BTRIM(COALESCE(ks.value->>'content', ''), E' \\t\\n\\v\\f\\r'), '') "
            "IS NOT NULL) "
            "OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE "
            "WHEN jsonb_typeof(ks.value->'items') = 'array' THEN ks.value->'items' "
            "ELSE '[]'::jsonb END) WITH ORDINALITY AS ki(value, ord) "
            "WHERE ki.ord <= 50 AND jsonb_typeof(ki.value) = 'string' AND "
            "NULLIF(BTRIM(COALESCE(ki.value #>> '{}', ''), E' \\t\\n\\v\\f\\r'), '') "
            "IS NOT NULL)"
            "))) ELSE FALSE END"
        )
    # The supported deployments are SQLite and PostgreSQL. Keep an explicit
    # conservative fallback for test/dialect adapters rather than exposing all
    # non-empty bookkeeping JSON as candidates.
    return or_(
        Note.ai_summary.ilike('%"key_insight"%'),
        Note.ai_summary.ilike('%"conclusion"%'),
        Note.ai_summary.ilike('%"sections"%'),
    )


def _pages_query(db: Session, user_id: str, term: str) -> Query:
    query = db.query(KnowledgeEntry).filter(
        KnowledgeEntry.user_id == user_id,
        KnowledgeEntry.status == _CANONICAL_STATUS,
    )
    if term:
        like = f"%{term}%"
        query = query.filter(or_(
            KnowledgeEntry.title.ilike(like),
            KnowledgeEntry.summary.ilike(like),
            KnowledgeEntry.content.ilike(like),
            KnowledgeEntry.source_label.ilike(like),
            KnowledgeEntry.origin.ilike(like),
        ))
    return query


def _inbox_query(db: Session, user_id: str, term: str) -> Query:
    saved = exists().where(and_(
        KnowledgeEntry.user_id == user_id,
        KnowledgeEntry.source_note_id == Note.id,
    ))
    query = db.query(Note).filter(
        Note.user_id == user_id,
        Note.ai_initialized.is_(True),
        Note.ai_summary.is_not(None),
        ~saved,
        _candidate_eligibility_sql(db),
    )
    if term:
        like = f"%{term}%"
        query = query.filter(or_(
            Note.video_title.ilike(like),
            Note.ai_summary.ilike(like),
        ))
    return query


def list_knowledge(
    db: Session,
    user_id: str,
    *,
    view: KnowledgeView = "pages",
    page: int = 1,
    per_page: int = 20,
    search: str = "",
) -> dict[str, Any]:
    """List one knowledge view with DB-side filtering, count and pagination."""
    if view not in {"pages", "inbox"}:
        raise ValueError("知识视图无效")
    safe_page = max(1, page)
    safe_per_page = max(1, min(per_page, 50))
    term = _clean(search, limit=120)

    pages_query = _pages_query(db, user_id, term)
    inbox_query = _inbox_query(db, user_id, term)
    page_count = pages_query.count()
    inbox_count = inbox_query.count()
    offset = (safe_page - 1) * safe_per_page

    if view == "pages":
        entries = (
            pages_query.order_by(
                KnowledgeEntry.updated_at.desc(), KnowledgeEntry.id.desc()
            )
            .offset(offset)
            .limit(safe_per_page)
            .all()
        )
        source_ids = {entry.source_note_id for entry in entries if entry.source_note_id}
        source_notes = {
            note.id: note
            for note in db.query(Note).filter(
                Note.user_id == user_id,
                Note.id.in_(source_ids),
            ).all()
        } if source_ids else {}
        items = [serialize_entry(entry, source_notes.get(entry.source_note_id)) for entry in entries]
        total = page_count
    else:
        notes = (
            inbox_query.order_by(Note.updated_at.desc(), Note.id.desc())
            .offset(offset)
            .limit(safe_per_page)
            .all()
        )
        # The DB predicate mirrors this defensive serializer; malformed legacy
        # JSON is still never exposed if a driver behaves unexpectedly.
        items = [item for note in notes if (item := serialize_candidate(note)) is not None]
        total = inbox_count

    return {
        "view": view,
        "items": items,
        "page": safe_page,
        "per_page": safe_per_page,
        "total": total,
        "total_pages": max(1, math.ceil(total / safe_per_page)),
        "counts": {"pages": page_count, "inbox": inbox_count},
    }


def save_candidate(db: Session, user_id: str, note_id: str) -> KnowledgeEntry:
    """Idempotently save one owned, meaningful video candidate as a page."""
    note = db.query(Note).filter(Note.id == note_id, Note.user_id == user_id).first()
    if note is None:
        raise LookupError("待整理内容不存在")

    existing = db.query(KnowledgeEntry).filter(
        KnowledgeEntry.user_id == user_id,
        KnowledgeEntry.source_note_id == note.id,
    ).first()
    if existing is not None:
        return existing

    normalized = normalize_candidate_to_page(note)
    if normalized is None:
        raise ValueError("该视频没有可整理的 AI 摘要")

    entry = KnowledgeEntry(
        user_id=user_id,
        title=normalized["title"],
        summary=normalized["summary"],
        content=normalized["content"],
        status=_CANONICAL_STATUS,
        origin=_VIDEO_ORIGIN,
        source_note_id=note.id,
        source_label=normalized["source_label"],
    )
    db.add(entry)
    try:
        db.commit()
    except IntegrityError:
        # The unique (user_id, source_note_id) index closes the rapid-click or
        # concurrent-request race while keeping the endpoint idempotent.
        db.rollback()
        existing = db.query(KnowledgeEntry).filter(
            KnowledgeEntry.user_id == user_id,
            KnowledgeEntry.source_note_id == note.id,
        ).first()
        if existing is None:
            raise
        return existing
    db.refresh(entry)
    return entry
