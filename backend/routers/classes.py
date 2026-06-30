from datetime import datetime

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import db
from dependencies import get_current_user

router = APIRouter(prefix="/classes")


class ClassCreate(BaseModel):
    name: str
    term: str | None = None


class ClassUpdate(BaseModel):
    name: str | None = None
    term: str | None = None


def _fmt(c: dict) -> dict:
    return {
        "id": str(c["_id"]),
        "name": c["name"],
        "term": c.get("term"),
        "professor_id": c["professor_id"],
        "created_at": c.get("created_at"),
    }


@router.get("")
async def list_classes(user=Depends(get_current_user)):
    classes = await db.classes.find({"professor_id": str(user["_id"])}).to_list(None)
    return [_fmt(c) for c in classes]


@router.post("")
async def create_class(body: ClassCreate, user=Depends(get_current_user)):
    doc = {
        "name": body.name,
        "term": body.term,
        "professor_id": str(user["_id"]),
        "created_at": datetime.utcnow().isoformat(),
    }
    result = await db.classes.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _fmt(doc)


@router.get("/{class_id}")
async def get_class(class_id: str, user=Depends(get_current_user)):
    cls = await _get_owned_class_or_404(class_id, user)
    return _fmt(cls)


@router.patch("/{class_id}")
async def update_class(class_id: str, body: ClassUpdate, user=Depends(get_current_user)):
    await _get_owned_class_or_404(class_id, user)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    await db.classes.update_one({"_id": ObjectId(class_id)}, {"$set": updates})
    return {"ok": True}


@router.delete("/{class_id}")
async def delete_class(class_id: str, user=Depends(get_current_user)):
    cls = await _get_owned_class_or_404(class_id, user)
    oid = cls["_id"]

    assignments = await db.assignments.find({"class_id": class_id}).to_list(None)
    assignment_ids = [str(a["_id"]) for a in assignments]
    if assignment_ids:
        groups = await db.groups.find({"assignment_id": {"$in": assignment_ids}}).to_list(None)
        group_ids = [str(g["_id"]) for g in groups]
        if group_ids:
            await db.summaries.delete_many({"group_id": {"$in": group_ids}})
        await db.groups.delete_many({"assignment_id": {"$in": assignment_ids}})
        await db.assignments.delete_many({"class_id": class_id})

    await db.disclosure_records.delete_many({"class_id": class_id})
    await db.classes.delete_one({"_id": oid})
    return {"ok": True}


async def _get_owned_class_or_404(class_id: str, user: dict) -> dict:
    try:
        oid = ObjectId(class_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid class ID")
    cls = await db.classes.find_one({"_id": oid})
    if not cls or cls["professor_id"] != str(user["_id"]):
        raise HTTPException(status_code=404, detail="Class not found")
    return cls
