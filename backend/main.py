from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import auth, admin, classes, groups, assignments, invites, student, submissions, tasks, contributions

app = FastAPI(title="GroupSync API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(classes.router)
app.include_router(groups.router)
app.include_router(assignments.router)
app.include_router(invites.router)
app.include_router(student.router)
app.include_router(submissions.router)
app.include_router(tasks.router)
app.include_router(contributions.router)


@app.get("/health")
def health():
    return {"status": "ok"}
