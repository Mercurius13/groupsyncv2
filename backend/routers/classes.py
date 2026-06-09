import csv
import io
from datetime import datetime

from bson import ObjectId
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from database import db
from dependencies import get_current_user

router = APIRouter(prefix="/classes")


def _instructor_or_admin(user):
    if user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403, detail="Instructor access required")


class ClassCreate(BaseModel):
    name: str


@router.get("")
async def list_classes(user=Depends(get_current_user)):
    _instructor_or_admin(user)
    query = {} if user["role"] == "admin" else {"instructor_id": str(user["_id"])}
    classes = await db.classes.find(query).to_list(None)
    return [
        {
            "id": str(c["_id"]),
            "name": c["name"],
            "student_count": len(c.get("students", [])),
            "created_at": c.get("created_at"),
        }
        for c in classes
    ]


@router.post("")
async def create_class(body: ClassCreate, user=Depends(get_current_user)):
    _instructor_or_admin(user)
    result = await db.classes.insert_one({
        "name": body.name,
        "instructor_id": str(user["_id"]),
        "students": [],
        "created_at": datetime.utcnow().isoformat(),
    })
    return {"id": str(result.inserted_id), "name": body.name, "student_count": 0}


@router.get("/{class_id}")
async def get_class(class_id: str, user=Depends(get_current_user)):
    _instructor_or_admin(user)
    cls = await _get_class_or_404(class_id)
    return {
        "id": str(cls["_id"]),
        "name": cls["name"],
        "instructor_id": cls["instructor_id"],
        "students": cls.get("students", []),
    }


@router.get("/{class_id}/students")
async def list_students(class_id: str, user=Depends(get_current_user)):
    _instructor_or_admin(user)
    cls = await _get_class_or_404(class_id)
    student_ids = [ObjectId(sid) for sid in cls.get("students", [])]
    if not student_ids:
        return []
    students = await db.users.find({"_id": {"$in": student_ids}}).to_list(None)
    return [{"id": str(s["_id"]), "email": s["email"], "name": s["name"], "role": s["role"]} for s in students]


@router.post("/{class_id}/roster")
async def upload_roster(class_id: str, file: UploadFile = File(...), user=Depends(get_current_user)):
    _instructor_or_admin(user)
    cls = await _get_class_or_404(class_id)

    content = (await file.read()).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(content))
    headers = [h.strip().lower() for h in (reader.fieldnames or [])]

    # Find email and name columns (supports Canvas export and plain CSV)
    email_col = _find_col(reader.fieldnames or [], ["sis login id", "email", "e-mail"])
    name_col = _find_col(reader.fieldnames or [], ["student", "name", "full name"])
    if not email_col or not name_col:
        raise HTTPException(status_code=400, detail="CSV must have name and email columns")

    existing_students = set(cls.get("students", []))
    added = 0

    for row in reader:
        email = row[email_col].strip().lower()
        name = row[name_col].strip()
        if not email or not name or name.lower() in ("student, test", "points possible"):
            continue

        existing = await db.users.find_one({"email": email})
        if existing:
            uid = str(existing["_id"])
        else:
            result = await db.users.insert_one({"email": email, "name": name, "role": "student"})
            uid = str(result.inserted_id)

        if uid not in existing_students:
            existing_students.add(uid)
            added += 1

    await db.classes.update_one(
        {"_id": ObjectId(class_id)},
        {"$set": {"students": list(existing_students)}},
    )
    return {"added": added, "total": len(existing_students)}


def _find_col(headers: list, candidates: list) -> str | None:
    lower = [h.lower().strip() for h in headers]
    for c in candidates:
        if c in lower:
            return headers[lower.index(c)]
    return None


async def _get_class_or_404(class_id: str):
    try:
        oid = ObjectId(class_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid class ID")
    cls = await db.classes.find_one({"_id": oid})
    if not cls:
        raise HTTPException(status_code=404, detail="Class not found")
    return cls
