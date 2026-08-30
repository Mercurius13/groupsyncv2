from datetime import datetime

from fastapi import APIRouter, Depends

from database import db
from dependencies import get_current_user

router = APIRouter()

# F2 licensing + F3 access gating (BACKEND.md). Payments (F2.3) remain
# deferred until a processor is chosen (ME.MD): every professor is lazily
# auto-provisioned an active free-tier license, and `processor_ref` stays
# null. When a processor lands, its webhooks become the thing that changes
# `tier`/`status`/`term_end`/`seat_count` — no endpoint lets a client
# change its own license.
#
# Zero-student-data invariant (N1/C1): a license row is professor identity
# and plan only. `seat_count` is a purchased capacity number on
# institutional licenses — it is never derived from, or reconciled
# against, any student list, because the backend has none.

TIERS = ("free", "professor", "institution")


def _fmt(lic: dict) -> dict:
    return {
        "id": str(lic["_id"]),
        "professor_id": lic["professor_id"],
        "tier": lic["tier"],
        "status": lic["status"],
        # E3: purchased seat capacity, institutional tier only (null otherwise).
        "seat_count": lic.get("seat_count"),
        "term_end": lic.get("term_end"),
        "billing_period": lic.get("billing_period"),
        "processor_ref": lic.get("processor_ref"),
        "created_at": lic.get("created_at"),
    }


async def get_or_create_license(user: dict) -> dict:
    """E3 lazy provisioning: every professor gets an active free-tier license
    the first time anything asks for one. Works for accounts created before
    licensing existed, with no auth-callback hook or migration needed."""
    professor_id = str(user["_id"])
    lic = await db.licenses.find_one({"professor_id": professor_id})
    if lic:
        return lic
    doc = {
        "professor_id": professor_id,
        "tier": "free",
        "status": "active",
        "seat_count": None,
        "term_end": None,
        "billing_period": None,
        "processor_ref": None,
        "created_at": datetime.utcnow().isoformat(),
    }
    result = await db.licenses.insert_one(doc)
    doc["_id"] = result.inserted_id
    return doc


def _is_entitled(lic: dict) -> bool:
    """F3: active and not past its term. A null term_end never expires
    (free tier / not yet billed)."""
    if lic["status"] != "active":
        return False
    term_end = lic.get("term_end")
    if term_end and term_end < datetime.utcnow().isoformat():
        return False
    return True


@router.get("/licenses/me")
async def my_license(user=Depends(get_current_user)):
    """F2: the professor's own license, for the frontend plan page."""
    return _fmt(await get_or_create_license(user))


@router.get("/entitlement")
async def entitlement(user=Depends(get_current_user)):
    """F3.1/F3.2: entitlement check — valid/invalid, tier, expiry, and
    NOTHING else. It cannot carry class, student, or document data because
    the backend holds none (N1)."""
    lic = await get_or_create_license(user)
    return {
        "valid": _is_entitled(lic),
        "tier": lic["tier"],
        "expires_at": lic.get("term_end"),
    }
