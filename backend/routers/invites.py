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
    # Email sending disabled — enable when Resend is configured
    return {"sent": 0, "note": "Email sending is currently disabled"}
