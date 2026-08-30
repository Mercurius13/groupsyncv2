from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import auth, licenses

# BACKEND.md (pivoted 2026-07-03): the backend does ONE job — professor
# accounts + licensing + entitlement gating. Classes/assignments/groups/
# disclosure-records/summaries routers were deleted in the pivot: Canvas
# owns class organization, and no analysis output or student data of any
# kind ever reaches this server (C1/N1 — FERPA posture: GroupSync's server
# side never becomes a processor of student education records).

app = FastAPI(title="GroupSync API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(licenses.router)


@app.get("/health")
def health():
    return {"status": "ok"}
