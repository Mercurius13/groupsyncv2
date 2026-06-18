import json
import logging
import os
from datetime import datetime

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException

logger = logging.getLogger(__name__)
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from config import GOOGLE_SERVICE_ACCOUNT_KEY
from database import db
from dependencies import get_current_user
from routers.submissions import parse_doc_url

router = APIRouter(prefix="/contributions")

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]


def _load_key_info() -> dict:
    if not GOOGLE_SERVICE_ACCOUNT_KEY:
        raise HTTPException(
            status_code=503,
            detail="Contribution reports are not configured yet. Add GOOGLE_SERVICE_ACCOUNT_KEY to .env.",
        )
    # Support either a file path or raw JSON string
    key = GOOGLE_SERVICE_ACCOUNT_KEY.strip()
    if key.endswith(".json") or os.path.exists(key):
        path = key if os.path.isabs(key) else os.path.join(os.path.dirname(__file__), "..", key)
        with open(path) as f:
            return json.load(f)
    return json.loads(key)


def _drive_service():
    try:
        info = _load_key_info()
        creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
        return build("drive", "v3", credentials=creds, cache_discovery=False)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Service account config error: {e}")


def _service_account_email() -> str:
    try:
        return _load_key_info().get("client_email", "")
    except Exception:
        return ""


def _fetch_revisions(service, file_id: str) -> list[dict]:
    revisions = []
    page_token = None
    while True:
        try:
            req = service.revisions().list(
                fileId=file_id,
                fields="nextPageToken,revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress),exportLinks)",
                pageSize=200,
                **({"pageToken": page_token} if page_token else {}),
            )
            result = req.execute()
        except HttpError as e:
            logger.warning("Drive HttpError status=%s reason=%s content=%s", e.status_code, getattr(e, "reason", None), e.content)
            if e.status_code == 404:
                msg = (
                    f"Document not found or not shared with the service account. "
                    f"Share the doc with {_service_account_email()} and try again."
                )
                logger.warning("contributions 400: %s", msg)
                raise HTTPException(status_code=400, detail=msg)
            if e.status_code == 403:
                msg = (
                    f"No permission to read this document. "
                    f"Share the doc with {_service_account_email()} (Viewer access is enough)."
                )
                logger.warning("contributions 400: %s", msg)
                raise HTTPException(status_code=400, detail=msg)
            logger.error("contributions Drive API error: %s", e)
            raise HTTPException(status_code=502, detail=f"Google Drive API error: {e}")
        revisions.extend(result.get("revisions", []))
        page_token = result.get("nextPageToken")
        if not page_token:
            break
    return revisions


def _compute_scores(stats: dict[str, dict], members: list[dict]) -> list[dict]:
    """
    Pure-length contribution scores scoped to group members only.

    stats: {email_lower: {name, edits, chars_added}}
    members: [{_id (ObjectId), email, name, ...}]

    Non-member editors are ignored. Group members absent from revision history
    receive 0 chars_added and 0%. Percentages sum to 100 across group members
    (or all 0 if no group member made any edits).
    """
    member_chars: dict[str, int] = {}
    member_by_email: dict[str, dict] = {}
    for m in members:
        email = m["email"].lower()
        member_by_email[email] = m
        member_chars[email] = stats.get(email, {}).get("chars_added", 0)

    total = sum(member_chars.values())

    scores = []
    for email, chars in member_chars.items():
        m = member_by_email[email]
        scores.append({
            "user_id": str(m["_id"]),
            "name": m["name"],
            "email": email,
            "edits": stats.get(email, {}).get("edits", 0),
            "chars_added": chars,
            "score": round(chars / total * 100, 1) if total > 0 else 0.0,
        })

    scores.sort(key=lambda s: s["score"], reverse=True)
    return scores


def _revision_text_length(service, file_id: str, revision_id: str) -> int | None:
    try:
        rev = service.revisions().get(
            fileId=file_id,
            revisionId=revision_id,
            fields="exportLinks",
        ).execute()
        link = (rev.get("exportLinks") or {}).get("text/plain")
        if not link:
            return None
        import urllib.request
        creds = service._http.credentials
        token = creds.token
        req = urllib.request.Request(link, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return len(r.read().decode("utf-8", errors="ignore"))
    except Exception:
        return None


@router.get("/grades/{class_id}")
async def get_class_grades(class_id: str, user=Depends(get_current_user)):
    if user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403)
    try:
        cls_oid = ObjectId(class_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid class ID")
    cls = await db.classes.find_one({"_id": cls_oid})
    if not cls:
        raise HTTPException(status_code=404, detail="Class not found")

    student_oids = [ObjectId(s) for s in cls.get("students", [])]
    students = await db.users.find({"_id": {"$in": student_oids}}).to_list(None)
    assignments = await db.assignments.find({"class_id": class_id}).sort("created_at", 1).to_list(None)
    groups = await db.groups.find({"class_id": class_id}).to_list(None)

    student_to_group: dict[str, str] = {}
    for g in groups:
        for m in g.get("members", []):
            student_to_group[m] = str(g["_id"])

    assignment_ids = [str(a["_id"]) for a in assignments]
    submissions = await db.submissions.find({"assignment_id": {"$in": assignment_ids}}).to_list(None)

    sub_map: dict[tuple, str] = {}
    for sub in submissions:
        sub_map[(sub["assignment_id"], sub["group_id"])] = str(sub["_id"])

    submission_ids = list(sub_map.values())
    reports = await db.contribution_reports.find({"submission_id": {"$in": submission_ids}}).to_list(None)
    report_map: dict[str, dict] = {}
    for r in reports:
        report_map[r["submission_id"]] = {s["email"].lower(): s["score"] for s in r.get("scores", [])}

    rows = []
    for student in students:
        sid = str(student["_id"])
        gid = student_to_group.get(sid)
        email = student["email"].lower()
        scores: dict[str, dict] = {}
        for a in assignments:
            aid = str(a["_id"])
            if not gid:
                scores[aid] = {"status": "no_group"}
                continue
            sub_id = sub_map.get((aid, gid))
            if not sub_id:
                scores[aid] = {"status": "not_submitted"}
                continue
            report = report_map.get(sub_id)
            if not report:
                scores[aid] = {"status": "pending", "submission_id": sub_id}
                continue
            v = report.get(email)
            scores[aid] = {"status": "scored", "value": v} if v is not None else {"status": "no_contribution"}
        rows.append({"id": sid, "name": student["name"], "email": student["email"], "scores": scores})

    return {
        "assignments": [{"id": str(a["_id"]), "title": a["title"], "deadline": a["deadline"]} for a in assignments],
        "students": rows,
    }


@router.get("/service-account-email")
async def service_account_email(user=Depends(get_current_user)):
    if user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403, detail="Instructor access required")
    return {"email": _service_account_email()}


@router.get("/{submission_id}")
async def get_contributions(submission_id: str, user=Depends(get_current_user)):
    if user["role"] not in ("instructor", "admin"):
        raise HTTPException(status_code=403, detail="Instructor access required")

    cached = await db.contribution_reports.find_one({"submission_id": submission_id})
    if cached:
        return {
            "submission_id": submission_id,
            "scores": cached["scores"],
            "generated_at": cached["generated_at"],
            "cached": True,
        }

    try:
        oid = ObjectId(submission_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid submission ID")
    submission = await db.submissions.find_one({"_id": oid})
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    _, file_id = parse_doc_url(submission["doc_url"])
    service = _drive_service()
    revisions = _fetch_revisions(service, file_id)

    if not revisions:
        logger.warning("contributions 400: no revisions for file_id=%s submission=%s", file_id, submission_id)
        raise HTTPException(status_code=400, detail="No revision history found for this document")

    stats: dict[str, dict] = {}
    prev_len = 0
    for rev in revisions:
        author = rev.get("lastModifyingUser") or {}
        email = (author.get("emailAddress") or author.get("displayName") or "unknown").lower()
        entry = stats.setdefault(email, {
            "name": author.get("displayName") or email,
            "edits": 0,
            "chars_added": 0,
        })
        entry["edits"] += 1
        length = _revision_text_length(service, file_id, rev["id"])
        if length is not None:
            entry["chars_added"] += max(length - prev_len, 0)
            prev_len = length

    group = await db.groups.find_one({"_id": ObjectId(submission["group_id"])})
    member_oids = [ObjectId(m) for m in (group or {}).get("members", [])]
    members = await db.users.find({"_id": {"$in": member_oids}}).to_list(None)

    scores = _compute_scores(stats, members)

    generated_at = datetime.utcnow().isoformat()
    await db.contribution_reports.insert_one({
        "submission_id": submission_id,
        "scores": scores,
        "generated_at": generated_at,
    })
    return {
        "submission_id": submission_id,
        "scores": scores,
        "generated_at": generated_at,
        "cached": False,
    }
