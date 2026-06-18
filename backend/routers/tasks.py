from datetime import datetime

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import db
from dependencies import get_current_user

router = APIRouter(prefix="/tasks")


class TaskCreate(BaseModel):
    group_id: str
    title: str
    assigned_to: str  # user_id of a group member


@router.post("")
async def create_task(body: TaskCreate, user=Depends(get_current_user)):
    try:
        gid = ObjectId(body.group_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid group ID")
    group = await db.groups.find_one({"_id": gid})
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    uid = str(user["_id"])
    if uid not in group.get("members", []) and user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403, detail="You are not a member of this group")
    if body.assigned_to not in group.get("members", []):
        raise HTTPException(status_code=400, detail="Assignee is not a member of this group")

    task = {
        "group_id": body.group_id,
        "title": body.title,
        "assigned_to": body.assigned_to,
        "created_by": uid,
        "created_at": datetime.utcnow().isoformat(),
    }
    result = await db.tasks.insert_one(task)
    return await _shape(task | {"_id": result.inserted_id})


@router.get("/{group_id}")
async def list_tasks(group_id: str, user=Depends(get_current_user)):
    tasks = await db.tasks.find({"group_id": group_id}).to_list(None)
    return [await _shape(t) for t in tasks]


async def _shape(task: dict) -> dict:
    names = {}
    for uid in (task["assigned_to"], task["created_by"]):
        if uid not in names:
            u = await db.users.find_one({"_id": ObjectId(uid)})
            names[uid] = u["name"] if u else "Unknown"
    return {
        "id": str(task["_id"]),
        "group_id": task["group_id"],
        "title": task["title"],
        "assigned_to": task["assigned_to"],
        "assigned_to_name": names[task["assigned_to"]],
        "created_by_name": names[task["created_by"]],
        "created_at": task["created_at"],
    }
