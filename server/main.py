# server/main.py
# Keeps all existing endpoints & behavior. Adds strict single-language output and robust TTS.
import os
import io
import re
import json
import logging
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from openai import AsyncOpenAI, OpenAI

# ---------- Paths ----------
BASE_DIR = Path(__file__).resolve().parents[1]

# Serve your existing template without moving anything
CANDIDATES = [
    BASE_DIR / "template" / "index.html",
    BASE_DIR / "templates" / "index.html",
    BASE_DIR / "index.html",
]
for p in CANDIDATES:
    if p.exists():
        INDEX_HTML = p
        break
else:
    INDEX_HTML = CANDIDATES[-1]  # final fallback (may not exist)

STATIC_DIR = BASE_DIR / "static"

# ---------- App ----------
log = logging.getLogger("server")
logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# ---------- OpenAI Clients ----------
aclient = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))  # async for chat
sclient = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))       # sync for TTS/STT helpers

PRIMARY_MODEL  = os.getenv("PRIMARY_MODEL",  "gpt-5-2025-08-07")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gpt-4o")
TTS_MODEL      = os.getenv("TTS_MODEL",      "gpt-4o-mini-tts")
TTS_VOICE      = os.getenv("TTS_VOICE",      "alloy")
STT_MODEL      = os.getenv("STT_MODEL",      "gpt-4o-transcribe")  # or "whisper-1"

# ---------- Models ----------
class HistoryItem(BaseModel):
    sender: str
    text: str

class ChatIn(BaseModel):
    user_text: str = ""
    include_seed: bool = False
    name: str = "Emily"
    age: int = 5
    mode: str = "child"        # "teen" | "child"
    objective: str = "gentle warm-up"
    history: Optional[List[HistoryItem]] = None
    lang: str = "en-US"        # from the dropdown (kept for compatibility)

class TTSIn(BaseModel):
    text: str
    voice: Optional[str] = None
    model: Optional[str] = None  # ignored but preserved for compatibility

# ---------- Helpers ----------
def strip_cues(text: str) -> str:
    """Remove [[CUE_*]] tokens if any slipped through."""
    return re.sub(r"\[\[.*?\]\]", "", text or "").strip()

def lang_name(lang_code: str) -> str:
    """Map locale to friendly language name for instructions."""
    lc = (lang_code or "").lower()
    if lc.startswith("vi"):
        return "Vietnamese"
    if lc.startswith("en"):
        return "English"
    # default to English if unknown
    return "English"

def build_messages(payload: ChatIn) -> List[dict]:
    """Compose system + history + user. Single-language rule enforced here."""
    learner_lang = lang_name(payload.lang)
    session_role = "Teen Coaching" if payload.mode == "teen" else "Child Coaching"

    system = (
        "You are Miss Sunny, a warm, patient children’s coach.\n"
        f"- Session Mode: {session_role}. Learner age: {payload.age}. Objective: {payload.objective}.\n"
        f"- Speak ONLY in {learner_lang}. Do NOT translate or repeat in any other language.\n"
        "- Keep turns short, friendly, and end with exactly one question.\n"
        "- No bracketed cues like [[CUE_SMILE]]."
    )

    seed = (
        f"Hi {payload.name}! How are you feeling—happy, okay, or not great? "
        "Let’s play a tiny game: tell me one fun thing you like to do!"
    )

    msgs: List[dict] = [{"role": "system", "content": system}]

    # Replay short history (preserves your format)
    if payload.history:
        for h in payload.history:
            if not h.text:
                continue
            role = "user" if h.sender == "you" else "assistant"
            msgs.append({"role": role, "content": strip_cues(h.text)})

    # First turn seed vs normal user text
    if payload.include_seed and not payload.user_text:
        msgs.append({"role": "assistant", "content": seed})
    else:
        msgs.append({"role": "user", "content": payload.user_text or ""})
    return msgs

async def call_chat(messages: List[dict]) -> dict:
    """Primary + fallback; keep params minimal for newest models."""
    try:
        log.info("[router] calling model=%s", PRIMARY_MODEL)
        r = await aclient.chat.completions.create(model=PRIMARY_MODEL, messages=messages)
        txt = (r.choices[0].message.content or "").strip()
        if not txt:
            raise RuntimeError("Empty reply from primary")
        return {"model_used": PRIMARY_MODEL, "reply": strip_cues(txt)}
    except Exception as e:
        log.info("[router] Primary failed: %s", getattr(e, "message", str(e)))
        log.info("[router] calling model=%s", FALLBACK_MODEL)
        r = await aclient.chat.completions.create(model=FALLBACK_MODEL, messages=messages)
        txt = (r.choices[0].message.content or "").strip()
        return {"model_used": FALLBACK_MODEL, "reply": strip_cues(txt)}

def tts_bytes(text: str, voice: Optional[str]) -> bytes:
    """Current OpenAI SDK TTS: no 'format' arg; return raw bytes for the browser <audio>."""
    try:
        res = sclient.audio.speech.create(model=TTS_MODEL, voice=voice or TTS_VOICE, input=text)
        # Most recent SDKs expose .read() to get bytes:
        if hasattr(res, "read"):
            return res.read() or b""
        # Fallbacks for older shapes:
        for attr in ("to_bytes", "bytes", "content"):
            if hasattr(res, attr):
                val = getattr(res, attr)
                return val() if callable(val) else (val or b"")
        # Last resort: stream chunks
        if hasattr(res, "stream"):
            buf = io.BytesIO()
            for chunk in res.stream:
                buf.write(chunk)
            return buf.getvalue()
    except Exception as e:
        log.error("TTS failed: %r", e)
    return b""

def stt_text(raw: bytes) -> str:
    """Server STT for webm chunks (Chrome desktop path)."""
    try:
        file_tuple = ("speech.webm", io.BytesIO(raw), "audio/webm")
        tr = sclient.audio.transcriptions.create(model=STT_MODEL, file=file_tuple)
        text = getattr(tr, "text", None) or (tr.__dict__.get("text") if hasattr(tr, "__dict__") else "")
        return (text or "").strip()
    except Exception as e:
        log.error("STT failed: %r", e)
        return ""

# ---------- Routes ----------
@app.get("/")
async def index():
    if not INDEX_HTML.exists():
        return PlainTextResponse(
            "index.html not found.\nLooked in:\n- template/index.html\n- templates/index.html\n- ./index.html\n",
            status_code=500,
        )
    return FileResponse(str(INDEX_HTML))

@app.post("/chat")
async def chat(payload: ChatIn):
    messages = build_messages(payload)
    res = await call_chat(messages)
    return JSONResponse(res)

@app.post("/tts")
async def tts(body: TTSIn):
    audio = tts_bytes(body.text, body.voice)
    # We intentionally return application/octet-stream so your existing <audio> plays it
    return Response(content=audio, media_type="application/octet-stream")

@app.post("/stt")
async def stt(request: Request):
    raw = await request.body()
    text = stt_text(raw)
    return JSONResponse({"text": text})

# ---------- Dev entry ----------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server.main:app", host="127.0.0.1", port=8000, reload=True)
