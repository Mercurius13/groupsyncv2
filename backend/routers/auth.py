from urllib.parse import urlencode
import httpx
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import RedirectResponse
from jose import jwt

from config import (
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
    JWT_SECRET, JWT_ALGORITHM, FRONTEND_URL,
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

    # F1.4: professors only — every account created here is a professor.
    # Students are roster entries (see routers/roster.py), never users.
    existing = await db.professors.find_one({"google_id": google_id})
    if not existing:
        await db.professors.insert_one({
            "email": email,
            "name": name,
            "google_id": google_id,
            "institution_id": None,
        })
        existing = await db.professors.find_one({"google_id": google_id})

    token = jwt.encode(
        {"sub": str(existing["_id"]), "email": email},
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
        "institution_id": user.get("institution_id"),
    }
