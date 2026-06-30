from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import db
from dependencies import get_current_user
from routers.assignments import _get_owned_assignment_or_404

router = APIRouter(prefix="/groups")


class GroupCreate(BaseModel):
    assignment_id: str
    name: str
    expected_size: int | None = None


class GroupUpdate(BaseModel):
    name: str | None = None
    expected_size: int | None = None


def _fmt(g: dict) -> dict:
    return {
        "id": str(g["_id"]),
        "assignment_id": g["assignment_id"],
        "name": g["name"],
        # F3 (2026-06-29 decision): the backend tracks group SIZE for license
        # seat-counting purposes only — never an actual named roster. Name
        # resolution of who's on a doc happens in the extension (People
        # API/Drive permissions), which the backend never sees or needs.
        "expected_size": g.get("expected_size"),
    }


@router.get("")
async def list_groups(assignment_id: str, user=Depends(get_current_user)):
    await _get_owned_assignment_or_404(assignment_id, user)
    groups = await db.groups.find({"assignment_id": assignment_id}).to_list(None)
    return [_fmt(g) for g in groups]


@router.post("")
async def create_group(body: GroupCreate, user=Depends(get_current_user)):
    await _get_owned_assignment_or_404(body.assignment_id, user)
    doc = {"assignment_id": body.assignment_id, "name": body.name, "expected_size": body.expected_size}
    result = await db.groups.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _fmt(doc)


@router.patch("/{group_id}")
async def update_group(group_id: str, body: GroupUpdate, user=Depends(get_current_user)):
    g = await _get_owned_group_or_404(group_id, user)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    await db.groups.update_one({"_id": g["_id"]}, {"$set": updates})
    return {"ok": True}


@router.delete("/{group_id}")
async def delete_group(group_id: str, user=Depends(get_current_user)):
    g = await _get_owned_group_or_404(group_id, user)
    await db.summaries.delete_many({"group_id": group_id})
    await db.groups.delete_one({"_id": g["_id"]})
    return {"ok": True}


async def _get_owned_group_or_404(group_id: str, user: dict) -> dict:
    try:
        oid = ObjectId(group_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid group ID")
    g = await db.groups.find_one({"_id": oid})
    if not g:
        raise HTTPException(status_code=404, detail="Group not found")
    await _get_owned_assignment_or_404(g["assignment_id"], user)
    return g
