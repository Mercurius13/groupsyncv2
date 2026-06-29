from datetime import datetime

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import db
from dependencies import get_current_user
from routers.classes import _get_owned_class_or_404

router = APIRouter(prefix="/assignments")


class AssignmentCreate(BaseModel):
    class_id: str
    name: str
    doc_reference: str | None = None


class AssignmentUpdate(BaseModel):
    name: str | None = None
    doc_reference: str | None = None


def _fmt(a: dict) -> dict:
    return {
        "id": str(a["_id"]),
        "class_id": a["class_id"],
        "name": a["name"],
        "doc_reference": a.get("doc_reference"),
        "created_at": a.get("created_at"),
    }


@router.get("")
async def list_assignments(class_id: str, user=Depends(get_current_user)):
    await _get_owned_class_or_404(class_id, user)
    assignments = await db.assignments.find({"class_id": class_id}).to_list(None)
    return [_fmt(a) for a in assignments]


@router.post("")
async def create_assignment(body: AssignmentCreate, user=Depends(get_current_user)):
    await _get_owned_class_or_404(body.class_id, user)
    doc = {
        "class_id": body.class_id,
        "name": body.name,
        "doc_reference": body.doc_reference,
        "created_at": datetime.utcnow().isoformat(),
    }
    result = await db.assignments.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _fmt(doc)


@router.patch("/{assignment_id}")
async def update_assignment(assignment_id: str, body: AssignmentUpdate, user=Depends(get_current_user)):
    a = await _get_owned_assignment_or_404(assignment_id, user)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    await db.assignments.update_one({"_id": a["_id"]}, {"$set": updates})
    return {"ok": True}


@router.delete("/{assignment_id}")
async def delete_assignment(assignment_id: str, user=Depends(get_current_user)):
    a = await _get_owned_assignment_or_404(assignment_id, user)
    groups = await db.groups.find({"assignment_id": assignment_id}).to_list(None)
    group_ids = [str(g["_id"]) for g in groups]
    if group_ids:
        await db.roster_members.delete_many({"group_id": {"$in": group_ids}})
        await db.summaries.delete_many({"group_id": {"$in": group_ids}})
    await db.groups.delete_many({"assignment_id": assignment_id})
    await db.disclosure_records.delete_many({"assignment_id": assignment_id})
    await db.assignments.delete_one({"_id": a["_id"]})
    return {"ok": True}


async def _get_owned_assignment_or_404(assignment_id: str, user: dict) -> dict:
    try:
        oid = ObjectId(assignment_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid assignment ID")
    a = await db.assignments.find_one({"_id": oid})
    if not a:
        raise HTTPException(status_code=404, detail="Assignment not found")
    await _get_owned_class_or_404(a["class_id"], user)
    return a
