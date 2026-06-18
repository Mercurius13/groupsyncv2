from bson import ObjectId
from fastapi import APIRouter, Depends

from database import db
from dependencies import get_current_user

router = APIRouter(prefix="/student")


@router.get("/assignments")
async def my_assignments(user=Depends(get_current_user)):
    uid = str(user["_id"])
    classes = await db.classes.find({"students": uid}).to_list(None)
    if not classes:
        return []
    class_names = {str(c["_id"]): c["name"] for c in classes}

    groups = await db.groups.find({"members": uid}).to_list(None)
    group_by_class = {g["class_id"]: g for g in groups}

    assignments = await db.assignments.find(
        {"class_id": {"$in": list(class_names)}}
    ).to_list(None)

    result = []
    for a in assignments:
        submission = None
        group = group_by_class.get(a["class_id"])
        if group:
            sub = await db.submissions.find_one({
                "assignment_id": str(a["_id"]),
                "group_id": str(group["_id"]),
            })
            if sub:
                submission = {
                    "id": str(sub["_id"]),
                    "doc_url": sub["doc_url"],
                    "submitted_at": sub["submitted_at"],
                }
        result.append({
            "id": str(a["_id"]),
            "class_id": a["class_id"],
            "class_name": class_names[a["class_id"]],
            "title": a["title"],
            "instructions": a["instructions"],
            "deadline": a["deadline"],
            "submission": submission,
        })
    return result


@router.get("/group")
async def my_groups(user=Depends(get_current_user)):
    uid = str(user["_id"])
    groups = await db.groups.find({"members": uid}).to_list(None)
    result = []
    for g in groups:
        cls = await db.classes.find_one({"_id": ObjectId(g["class_id"])})
        member_oids = [ObjectId(m) for m in g.get("members", [])]
        members = await db.users.find({"_id": {"$in": member_oids}}).to_list(None)
        result.append({
            "id": str(g["_id"]),
            "name": g["name"],
            "class_id": g["class_id"],
            "class_name": cls["name"] if cls else "Unknown class",
            "members": [
                {"id": str(m["_id"]), "name": m["name"], "email": m["email"]}
                for m in members
            ],
        })
    return result
