import re
from datetime import datetime

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import db
from dependencies import get_current_user

router = APIRouter(prefix="/submissions")

DOC_URL_RE = re.compile(
    r"^https://docs\.google\.com/(document|presentation)/d/([a-zA-Z0-9_-]+)"
)


def parse_doc_url(url: str) -> tuple[str, str]:
    """Returns (kind, file_id) where kind is 'document' or 'presentation'."""
    m = DOC_URL_RE.match(url.strip())
    if not m:
        raise HTTPException(
            status_code=400,
            detail="URL must be a Google Docs or Slides link (docs.google.com/document/... or /presentation/...)",
        )
    return m.group(1), m.group(2)


class SubmissionCreate(BaseModel):
    assignment_id: str
    doc_url: str


@router.post("")
async def submit(body: SubmissionCreate, user=Depends(get_current_user)):
    try:
        aid = ObjectId(body.assignment_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid assignment ID")
    assignment = await db.assignments.find_one({"_id": aid})
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    uid = str(user["_id"])
    group = await db.groups.find_one({"class_id": assignment["class_id"], "members": uid})
    if not group:
        raise HTTPException(status_code=400, detail="You are not in a group for this class")

    parse_doc_url(body.doc_url)

    group_id = str(group["_id"])
    submitted_at = datetime.utcnow().isoformat()
    existing = await db.submissions.find_one(
        {"assignment_id": body.assignment_id, "group_id": group_id}
    )
    if existing:
        await db.submissions.update_one(
            {"_id": existing["_id"]},
            {"$set": {"doc_url": body.doc_url, "submitted_at": submitted_at}},
        )
        # Doc changed — invalidate the cached contribution report
        await db.contribution_reports.delete_many({"submission_id": str(existing["_id"])})
        sub_id = str(existing["_id"])
    else:
        result = await db.submissions.insert_one({
            "assignment_id": body.assignment_id,
            "group_id": group_id,
            "doc_url": body.doc_url,
            "submitted_at": submitted_at,
        })
        sub_id = str(result.inserted_id)

    return {
        "id": sub_id,
        "assignment_id": body.assignment_id,
        "group_id": group_id,
        "doc_url": body.doc_url,
        "submitted_at": submitted_at,
    }


@router.get("")
async def list_submissions(assignment_id: str, user=Depends(get_current_user)):
    if user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403, detail="Instructor access required")

    submissions = await db.submissions.find({"assignment_id": assignment_id}).to_list(None)
    result = []
    for s in submissions:
        group = await db.groups.find_one({"_id": ObjectId(s["group_id"])})
        result.append({
            "id": str(s["_id"]),
            "assignment_id": s["assignment_id"],
            "group_id": s["group_id"],
            "group_name": group["name"] if group else "Unknown group",
            "doc_url": s["doc_url"],
            "submitted_at": s["submitted_at"],
        })
    return result
