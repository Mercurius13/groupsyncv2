import httpx
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from config import RESEND_API_KEY, FRONTEND_URL
from database import db
from dependencies import get_current_user

router = APIRouter(prefix="/invites")


class InviteRequest(BaseModel):
    group_id: str


@router.post("")
async def send_invites(body: InviteRequest, user=Depends(get_current_user)):
    if user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403, detail="Instructor access required")

    try:
        oid = ObjectId(body.group_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid group ID")

    group = await db.groups.find_one({"_id": oid})
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    cls = await db.classes.find_one({"_id": ObjectId(group["class_id"])})
    class_name = cls["name"] if cls else "your class"

    member_ids = [ObjectId(m) for m in group.get("members", [])]
    if not member_ids:
        return {"sent": 0}

    members = await db.users.find({"_id": {"$in": member_ids}}).to_list(None)

    if not RESEND_API_KEY:
        print(f"[invites] RESEND_API_KEY not set — would have sent to: {[m['email'] for m in members]}")
        return {"sent": len(members), "note": "RESEND_API_KEY not configured, emails not sent"}

    sent = 0
    async with httpx.AsyncClient() as client:
        for member in members:
            payload = {
                "from": "GroupSync <onboarding@resend.dev>",
                "to": [member["email"]],
                "subject": f"You've been added to {class_name} on GroupSync",
                "html": (
                    f"<p>Hi {member['name']},</p>"
                    f"<p>You've been added to <strong>{group['name']}</strong> in <strong>{class_name}</strong> on GroupSync.</p>"
                    f"<p><a href='{FRONTEND_URL}'>Sign in with Google</a> to view your assignments.</p>"
                ),
            }
            res = await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
                json=payload,
            )
            if res.status_code in (200, 201):
                sent += 1

    return {"sent": sent}
