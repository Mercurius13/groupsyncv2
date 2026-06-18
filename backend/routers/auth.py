from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from jose import jwt

from config import (
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
    JWT_SECRET, JWT_ALGORITHM, ADMIN_EMAIL, FRONTEND_URL,
)
from database import db
from dependencies import get_current_user

router = APIRouter(prefix="/auth")

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"


@router.get("/google")
def login():
    params = urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "prompt": "select_account",
    })
    return RedirectResponse(f"{GOOGLE_AUTH_URL}?{params}")


@router.get("/callback")
async def callback(code: str):
    async with httpx.AsyncClient() as client:
        token_res = await client.post(GOOGLE_TOKEN_URL, data={
            "code": code,
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri": GOOGLE_REDIRECT_URI,
            "grant_type": "authorization_code",
        })
        tokens = token_res.json()

        if "access_token" not in tokens:
            raise HTTPException(
                status_code=400,
                detail=f"Google token exchange failed: {tokens.get('error')}: {tokens.get('error_description')}",
            )

        user_res = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        info = user_res.json()

    email: str = info["email"]
    google_id: str = info["id"]
    name: str = info["name"]

    # Drive tokens, used by the contribution engine to read revision history.
    # Google only returns refresh_token on consent, so keep the old one if absent.
    google_tokens = {
        "access_token": tokens["access_token"],
        "expires_at": (
            datetime.now(timezone.utc) + timedelta(seconds=tokens.get("expires_in", 3600))
        ).isoformat(),
    }
    if tokens.get("refresh_token"):
        google_tokens["refresh_token"] = tokens["refresh_token"]
        token_update = {"$set": {"google_tokens": google_tokens}}
    else:
        token_update = {"$set": {f"google_tokens.{k}": v for k, v in google_tokens.items()}}

    existing = await db.users.find_one({"google_id": google_id})
    if not existing:
        # Match a stub record created via CSV roster import (no google_id yet)
        stub = await db.users.find_one({"email": email, "google_id": {"$exists": False}})
        if stub:
            await db.users.update_one(
                {"_id": stub["_id"]},
                {"$set": {"google_id": google_id, "name": name}},
            )
            existing = await db.users.find_one({"_id": stub["_id"]})
        else:
            role = "admin" if email == ADMIN_EMAIL else "student"
            await db.users.insert_one({
                "email": email,
                "name": name,
                "google_id": google_id,
                "role": role,
            })
            existing = await db.users.find_one({"google_id": google_id})

    await db.users.update_one({"_id": existing["_id"]}, token_update)

    token = jwt.encode(
        {"sub": str(existing["_id"]), "email": email, "role": existing["role"]},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )
    return RedirectResponse(f"{FRONTEND_URL}/auth/callback?token={token}")


@router.get("/me")
async def me(user=Depends(get_current_user)):
    return {
        "id": str(user["_id"]),
        "email": user["email"],
        "name": user["name"],
        "role": user["role"],
    }
