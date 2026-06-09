from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import db
from dependencies import get_current_user

router = APIRouter(prefix="/groups")


class GroupCreate(BaseModel):
    class_id: str
    name: str


class GroupUpdate(BaseModel):
    name: str | None = None
    members: list[str] | None = None


@router.get("")
async def list_groups(class_id: str, user=Depends(get_current_user)):
    groups = await db.groups.find({"class_id": class_id}).to_list(None)
    result = []
    for g in groups:
        members = []
        if g.get("members"):
            oids = [ObjectId(m) for m in g["members"]]
            users = await db.users.find({"_id": {"$in": oids}}).to_list(None)
            members = [{"id": str(u["_id"]), "name": u["name"], "email": u["email"]} for u in users]
        result.append({"id": str(g["_id"]), "name": g["name"], "class_id": g["class_id"], "members": members})
    return result


@router.post("")
async def create_group(body: GroupCreate, user=Depends(get_current_user)):
    result = await db.groups.insert_one({"class_id": body.class_id, "name": body.name, "members": []})
    return {"id": str(result.inserted_id), "name": body.name, "class_id": body.class_id, "members": []}


@router.patch("/{group_id}")
async def update_group(group_id: str, body: GroupUpdate, user=Depends(get_current_user)):
    try:
        oid = ObjectId(group_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid group ID")

    updates = {}
    if body.name is not None:
        updates["name"] = body.name
    if body.members is not None:
        updates["members"] = body.members

    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")

    result = await db.groups.update_one({"_id": oid}, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Group not found")
    return {"ok": True}


@router.delete("/{group_id}")
async def delete_group(group_id: str, user=Depends(get_current_user)):
    try:
        oid = ObjectId(group_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid group ID")
    await db.groups.delete_one({"_id": oid})
    return {"ok": True}
