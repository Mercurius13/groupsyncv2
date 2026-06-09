from datetime import datetime

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import db
from dependencies import get_current_user

router = APIRouter(prefix="/assignments")


class AssignmentCreate(BaseModel):
    class_id: str
    title: str
    instructions: str
    deadline: str  # ISO date string


@router.get("")
async def list_assignments(class_id: str, user=Depends(get_current_user)):
    assignments = await db.assignments.find({"class_id": class_id}).to_list(None)
    return [
        {
            "id": str(a["_id"]),
            "class_id": a["class_id"],
            "title": a["title"],
            "instructions": a["instructions"],
            "deadline": a["deadline"],
            "created_at": a.get("created_at"),
        }
        for a in assignments
    ]


@router.post("")
async def create_assignment(body: AssignmentCreate, user=Depends(get_current_user)):
    if user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403, detail="Instructor access required")
    result = await db.assignments.insert_one({
        "class_id": body.class_id,
        "title": body.title,
        "instructions": body.instructions,
        "deadline": body.deadline,
        "created_at": datetime.utcnow().isoformat(),
    })
    return {
        "id": str(result.inserted_id),
        "class_id": body.class_id,
        "title": body.title,
        "instructions": body.instructions,
        "deadline": body.deadline,
    }


@router.delete("/{assignment_id}")
async def delete_assignment(assignment_id: str, user=Depends(get_current_user)):
    if user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403, detail="Instructor access required")
    try:
        oid = ObjectId(assignment_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid assignment ID")
    await db.assignments.delete_one({"_id": oid})
    return {"ok": True}
