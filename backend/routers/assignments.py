import os
import uuid
from datetime import datetime

from bson import ObjectId
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from database import db
from dependencies import get_current_user

UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)

router = APIRouter(prefix="/assignments")


def _fmt(a: dict) -> dict:
    aid = str(a["_id"])
    return {
        "id": aid,
        "class_id": a["class_id"],
        "title": a["title"],
        "instructions": a["instructions"],
        "deadline": a["deadline"],
        "created_at": a.get("created_at"),
        "attachment_name": a.get("attachment_name"),
        "attachment_url": f"http://localhost:8000/assignments/{aid}/attachment" if a.get("attachment_name") else None,
    }


@router.get("")
async def list_assignments(class_id: str, user=Depends(get_current_user)):
    assignments = await db.assignments.find({"class_id": class_id}).to_list(None)
    return [_fmt(a) for a in assignments]


@router.post("")
async def create_assignment(
    class_id: str = Form(...),
    title: str = Form(...),
    instructions: str = Form(...),
    deadline: str = Form(...),
    file: UploadFile | None = File(None),
    user=Depends(get_current_user),
):
    if user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403, detail="Instructor access required")

    attachment_name = None
    attachment_path = None
    if file and file.filename:
        ext = os.path.splitext(file.filename)[1]
        stored = f"{uuid.uuid4()}{ext}"
        attachment_path = os.path.join(UPLOADS_DIR, stored)
        with open(attachment_path, "wb") as f:
            f.write(await file.read())
        attachment_name = file.filename

    doc = {
        "class_id": class_id,
        "title": title,
        "instructions": instructions,
        "deadline": deadline,
        "created_at": datetime.utcnow().isoformat(),
        "attachment_name": attachment_name,
        "attachment_path": attachment_path,
    }
    result = await db.assignments.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _fmt(doc)


@router.put("/{assignment_id}")
async def update_assignment(
    assignment_id: str,
    title: str = Form(...),
    instructions: str = Form(...),
    deadline: str = Form(...),
    file: UploadFile | None = File(None),
    remove_attachment: str = Form("false"),
    user=Depends(get_current_user),
):
    if user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403, detail="Instructor access required")
    try:
        oid = ObjectId(assignment_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid ID")
    a = await db.assignments.find_one({"_id": oid})
    if not a:
        raise HTTPException(status_code=404, detail="Assignment not found")

    updates: dict = {"title": title, "instructions": instructions, "deadline": deadline}

    if remove_attachment == "true":
        if a.get("attachment_path") and os.path.exists(a["attachment_path"]):
            os.remove(a["attachment_path"])
        updates["attachment_name"] = None
        updates["attachment_path"] = None

    if file and file.filename:
        if a.get("attachment_path") and os.path.exists(a["attachment_path"]):
            os.remove(a["attachment_path"])
        ext = os.path.splitext(file.filename)[1]
        stored = f"{uuid.uuid4()}{ext}"
        path = os.path.join(UPLOADS_DIR, stored)
        with open(path, "wb") as f:
            f.write(await file.read())
        updates["attachment_name"] = file.filename
        updates["attachment_path"] = path

    await db.assignments.update_one({"_id": oid}, {"$set": updates})
    updated = await db.assignments.find_one({"_id": oid})
    return _fmt(updated)


@router.get("/{assignment_id}/attachment")
async def get_attachment(assignment_id: str):
    try:
        oid = ObjectId(assignment_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid ID")
    a = await db.assignments.find_one({"_id": oid})
    if not a or not a.get("attachment_path"):
        raise HTTPException(status_code=404, detail="No attachment")
    return FileResponse(a["attachment_path"], filename=a["attachment_name"])


@router.delete("/{assignment_id}")
async def delete_assignment(assignment_id: str, user=Depends(get_current_user)):
    if user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403, detail="Instructor access required")
    try:
        oid = ObjectId(assignment_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid assignment ID")
    a = await db.assignments.find_one({"_id": oid})
    if a and a.get("attachment_path") and os.path.exists(a["attachment_path"]):
        os.remove(a["attachment_path"])
    await db.assignments.delete_one({"_id": oid})
    return {"ok": True}
