from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import db
from dependencies import get_current_user
from routers.classes import _get_owned_class_or_404
from routers.assignments import _get_owned_assignment_or_404

router = APIRouter(prefix="/disclosure")

# F4.3 — template language the professor adopts or adapts (FRONTEND.md F3.1).
# Per HANDOVER.md C2: this is necessary but not sufficient authority — the
# professor still needs institutional sign-off before running on a real
# graded class (tracked as a non-code gate, see CLAUDE.md/ME.MD).
DISCLOSURE_TEMPLATE = (
    "For this assignment, I will use GroupSync, a browser extension that analyzes "
    "the edit history of your shared Google Doc to produce a character-level "
    "breakdown of who contributed what, as evidence to support my evaluation of "
    "individual contribution to group work. This analysis runs locally in my "
    "browser; your document's content and edit history are never uploaded to a "
    "server or third party. The analysis only reflects on-document editing — it "
    "cannot detect work done outside the document (planning, discussion, research "
    "done elsewhere) and does not by itself determine your grade."
)


class DisclosureCreate(BaseModel):
    class_id: str | None = None
    assignment_id: str | None = None
    disclosure_text: str


def _fmt(d: dict) -> dict:
    return {
        "id": str(d["_id"]),
        "class_id": d.get("class_id"),
        "assignment_id": d.get("assignment_id"),
        "professor_id": d["professor_id"],
        "disclosure_text": d["disclosure_text"],
        "enabled_at": d["enabled_at"],
    }


@router.get("/template")
def get_template():
    return {"disclosure_text": DISCLOSURE_TEMPLATE}


@router.post("")
async def create_disclosure(body: DisclosureCreate, user=Depends(get_current_user)):
    if not body.class_id and not body.assignment_id:
        raise HTTPException(status_code=400, detail="class_id or assignment_id is required")
    if body.class_id:
        await _get_owned_class_or_404(body.class_id, user)
    if body.assignment_id:
        await _get_owned_assignment_or_404(body.assignment_id, user)

    doc = {
        "class_id": body.class_id,
        "assignment_id": body.assignment_id,
        "professor_id": str(user["_id"]),
        "disclosure_text": body.disclosure_text,
        "enabled_at": datetime.utcnow().isoformat(),
    }
    result = await db.disclosure_records.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _fmt(doc)


@router.get("")
async def list_disclosures(
    class_id: str | None = None, assignment_id: str | None = None, user=Depends(get_current_user)
):
    """Audit trail (N4: immutable, append-only) — also how the frontend
    checks whether disclosure has already been recorded for a class/assignment."""
    if not class_id and not assignment_id:
        raise HTTPException(status_code=400, detail="class_id or assignment_id is required")
    if class_id:
        await _get_owned_class_or_404(class_id, user)
        query = {"class_id": class_id}
    else:
        await _get_owned_assignment_or_404(assignment_id, user)
        query = {"assignment_id": assignment_id}
    records = await db.disclosure_records.find(query).sort("enabled_at", -1).to_list(None)
    return [_fmt(d) for d in records]
