from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import auth, classes, assignments, groups, roster, disclosure, summaries

app = FastAPI(title="GroupSync API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(classes.router)
app.include_router(assignments.router)
app.include_router(groups.router)
app.include_router(roster.router)
app.include_router(disclosure.router)
app.include_router(summaries.router)


@app.get("/health")
def health():
    return {"status": "ok"}
