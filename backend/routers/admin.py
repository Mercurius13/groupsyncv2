from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Literal

from database import db
from dependencies import require_admin

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])

VALID_ROLES = {"admin", "instructor", "student"}


class RoleUpdate(BaseModel):
    role: Literal["admin", "instructor", "student"]


@router.get("/users")
async def list_users():
    users = await db.users.find().to_list(length=None)
    return [
        {"id": str(u["_id"]), "email": u["email"], "name": u["name"], "role": u["role"]}
        for u in users
    ]


@router.patch("/users/{user_id}/role")
async def update_role(user_id: str, body: RoleUpdate):
    try:
        oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID")

    result = await db.users.update_one({"_id": oid}, {"$set": {"role": body.role}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")

    return {"ok": True}
