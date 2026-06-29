import csv
import io

from bson import ObjectId
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from database import db
from dependencies import get_current_user
from routers.groups import _get_owned_group_or_404

router = APIRouter()


class RosterMemberCreate(BaseModel):
    student_name: str
    student_email: str
    google_user_id: str | None = None


def _fmt(m: dict) -> dict:
    return {
        "id": str(m["_id"]),
        "group_id": m["group_id"],
        "student_name": m["student_name"],
        "student_email": m["student_email"],
        "google_user_id": m.get("google_user_id"),
    }


@router.get("/groups/{group_id}/roster")
async def list_roster(group_id: str, user=Depends(get_current_user)):
    await _get_owned_group_or_404(group_id, user)
    members = await db.roster_members.find({"group_id": group_id}).to_list(None)
    return [_fmt(m) for m in members]


@router.post("/groups/{group_id}/roster")
async def add_roster_member(group_id: str, body: RosterMemberCreate, user=Depends(get_current_user)):
    await _get_owned_group_or_404(group_id, user)
    email = body.student_email.strip().lower()
    if not email or not body.student_name.strip():
        raise HTTPException(status_code=400, detail="Name and email are required")
    doc = {
        "group_id": group_id,
        "student_name": body.student_name.strip(),
        "student_email": email,
        "google_user_id": body.google_user_id,
    }
    result = await db.roster_members.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _fmt(doc)


@router.post("/groups/{group_id}/roster/import")
async def import_roster_csv(group_id: str, file: UploadFile = File(...), user=Depends(get_current_user)):
    """F3.1/F3.2 bulk import — same CSV-header detection as the pre-pivot
    classes.py roster upload, but writes RosterMember docs scoped to this
    group, never `users` documents (F1.4)."""
    await _get_owned_group_or_404(group_id, user)
    content = (await file.read()).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(content))

    email_col = _find_col(reader.fieldnames or [], ["sis login id", "email", "e-mail"])
    name_col = _find_col(reader.fieldnames or [], ["student", "name", "full name"])
    if not email_col or not name_col:
        raise HTTPException(status_code=400, detail="CSV must have name and email columns")

    existing_emails = {
        m["student_email"] for m in await db.roster_members.find({"group_id": group_id}).to_list(None)
    }
    added = 0
    for row in reader:
        email = row[email_col].strip().lower()
        name = row[name_col].strip()
        if not email or not name or name.lower() in ("student, test", "points possible"):
            continue
        if email in existing_emails:
            continue
        await db.roster_members.insert_one({
            "group_id": group_id,
            "student_name": name,
            "student_email": email,
            "google_user_id": None,
        })
        existing_emails.add(email)
        added += 1

    return {"added": added}


@router.delete("/roster/{member_id}")
async def delete_roster_member(member_id: str, user=Depends(get_current_user)):
    try:
        oid = ObjectId(member_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid roster member ID")
    member = await db.roster_members.find_one({"_id": oid})
    if not member:
        raise HTTPException(status_code=404, detail="Roster member not found")
    await _get_owned_group_or_404(member["group_id"], user)
    await db.roster_members.delete_one({"_id": oid})
    return {"ok": True}


def _find_col(headers: list, candidates: list) -> str | None:
    lower = [h.lower().strip() for h in headers]
    for c in candidates:
        if c in lower:
            return headers[lower.index(c)]
    return None
