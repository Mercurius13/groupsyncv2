from datetime import datetime
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import db
from dependencies import get_current_user
from routers.assignments import _get_owned_assignment_or_404
from routers.groups import _get_owned_group_or_404

router = APIRouter(prefix="/summaries")


class SummaryCreate(BaseModel):
    assignment_id: str
    group_id: str
    # F5.1: exactly the content-stripped payload extension/src/export/index.ts's
    # ContentStrippedSummary produces (disclaimer, generatedAt, sections[],
    # signalNotes[], authorCounts[]). The backend stores it opaquely — it has
    # no way to verify it's truly content-stripped, that guarantee is
    # enforced upstream by the extension's type (no `text` field exists to
    # leak through). N1 (content-free) is a property of what the extension
    # sends, not something this endpoint can re-check.
    content_stripped_payload: dict[str, Any]


def _fmt(s: dict) -> dict:
    return {
        "id": str(s["_id"]),
        "assignment_id": s["assignment_id"],
        "group_id": s["group_id"],
        "created_at": s["created_at"],
        "content_stripped_payload": s["content_stripped_payload"],
    }


@router.post("")
async def create_summary(body: SummaryCreate, user=Depends(get_current_user)):
    """F5.2: opt-in per summary — this endpoint only runs when the professor
    explicitly submits, never automatically."""
    await _get_owned_group_or_404(body.group_id, user)
    doc = {
        "assignment_id": body.assignment_id,
        "group_id": body.group_id,
        "created_at": datetime.utcnow().isoformat(),
        "content_stripped_payload": body.content_stripped_payload,
    }
    result = await db.summaries.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _fmt(doc)


@router.get("")
async def list_summaries(
    assignment_id: str | None = None, group_id: str | None = None, user=Depends(get_current_user)
):
    if not assignment_id and not group_id:
        raise HTTPException(status_code=400, detail="assignment_id or group_id is required")
    if group_id:
        await _get_owned_group_or_404(group_id, user)
        query = {"group_id": group_id}
    else:
        await _get_owned_assignment_or_404(assignment_id, user)
        query = {"assignment_id": assignment_id}
    summaries = await db.summaries.find(query).sort("created_at", -1).to_list(None)
    return [_fmt(s) for s in summaries]


@router.delete("/{summary_id}")
async def delete_summary(summary_id: str, user=Depends(get_current_user)):
    """F5.3: the professor can purge any saved summary."""
    try:
        oid = ObjectId(summary_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid summary ID")
    summary = await db.summaries.find_one({"_id": oid})
    if not summary:
        raise HTTPException(status_code=404, detail="Summary not found")
    await _get_owned_group_or_404(summary["group_id"], user)
    await db.summaries.delete_one({"_id": oid})
    return {"ok": True}
