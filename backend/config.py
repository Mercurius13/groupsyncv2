import os
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../.env"))

GOOGLE_CLIENT_ID = os.environ["GOOGLE_CLIENT_ID"]
GOOGLE_CLIENT_SECRET = os.environ["GOOGLE_CLIENT_SECRET"]
JWT_SECRET = os.environ["JWT_SECRET"]
ADMIN_EMAIL = os.environ["ADMIN_EMAIL"]
MONGODB_URI = os.environ["MONGODB_URI"]
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")

GOOGLE_REDIRECT_URI = "http://localhost:8000/auth/callback"
FRONTEND_URL = "http://localhost:3000"
JWT_ALGORITHM = "HS256"
