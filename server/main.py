# server/main.py
# Full file — preserves all working endpoints/IDs/logic and adds robust template path + TTS fix.
import os
import io
import re
import json
import logging
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from openai import AsyncOpenAI, OpenAI

# -----------------------------
# Paths & static/templates
# -----------------------------
BASE_DIR = Path(__file__).resolve().parents[1]

# Support either "template" or "templates" without forcing a rename.
CANDIDATES = [BASE_DIR / "template" / "index.html", BASE_DIR / "templates" / "index.html"]
for p in CANDIDATES:
    if p.exists():
        INDEX_HTML = p
        break
else:
    # Last resort: a root index.html if a user drops it there.
    INDEX_HTML = BASE_DIR / "index.html"

STATIC_DIR = BASE_DIR / "static"

# -----------------------------
# App setup
# -----------------------------
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

# -----------------------------
# Models & clients
# -----------------------------
PRIMARY_MODEL = os.getenv("PRIMARY_MODEL", "gpt-5-2025-08-07")  # your preferred primary
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gpt-4o")

# Async client for chat calls
aclient = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
# Sync client for blocking helpers (e.g., TTS/STT done in a thread inside our async handlers)
sclient = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# -----------------------------
# Data models (preserve fields your JS sends)
# -----------------------------
class HistoryItem(BaseModel):
    sender: str  # "you" | "coach"
    text: str

class ChatIn(BaseModel):
    user_text: str = ""
    include_seed: bool = False
    name: str = "Emily"
    age: int = 5
    mode: str = "child"      # "teen" or "child"
    objective: str = "gentle warm-up"
    history: Optional[List[HistoryItem]] = None

class TTSIn(BaseModel):
    text: str
    voice: Optional[str] = None  # keep for compatibility
    model: Optional[str] = None  # ignored; we use a TTS-capable model internally

# -----------------------------
# Helpers
# -----------------------------
def strip_cues(text: str) -> str:
    """Remove [[CUE_*]] tags; keep everything else."""
    return re.sub(r"\[\[.*?\]\]", "", text or "").strip()

def build_messages(payload: ChatIn) -> List[dict]:
    """Compose system + history + user message. Keep behavior you already had."""
    role = "Teen Coaching" if payload.mode == "teen" else "Child Coaching"
    system = (
        "You are Miss Sunny, a warm, patient, bilingual (English ↔ Vietnamese) AI life coach and language teacher. "
        "You keep turns short and interactive. Follow the session mode, adapt to age/personality, and end with exactly one question. "
        "Never include bracketed cue tags like [[CUE_*]] in your text output."
    )
    # Seed opening used when include_seed=True
    seed = (
        f"Hi {payload.name}! How are you feeling—happy, okay, or not great? "
        f"Let’s do something fun! What’s something you like to do?"
    )

    msgs = [
        {"role": "system", "content": system},
        {"role": "system", "content": f"Session Mode: {role}. Learner age: {payload.age}. Objective: {payload.objective}."},
    ]

    # Rebuild short history into assistant/user turns
    if payload.history:
        for h in payload.history:
            if not h.text:
                continue
            role = "user" if h.sender == "you" else "assistant"
            msgs.append({"role": role, "content": strip_cues(h.text)})

    if payload.include_seed and not payload.user_text:
        msgs.append({"role": "assistant", "content": seed})
    else:
        msgs.append({"role": "user", "content": payload.user_text or ""})

    return msgs

async def call_chat(messages: List[dict]) -> dict:
    """Try primary model; gracefully fall back to gpt-4o. Avoid params newer models reject."""
    # Keep payload minimal to avoid 'unsupported' errors on evolving models.
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

def tts_blocking(text: str, voice: Optional[str]) -> bytes:
    """
    Use current OpenAI SDK TTS without the old 'format' arg (which now errors).
    We request a default audio format the SDK returns (often WAV/MP3) and
    feed it back to the browser. Your JS just plays whatever Blob it receives.
    """
    # A TTS-capable model; adjust if you use a different one in your account.
    tts_model = os.getenv("TTS_MODEL", "gpt-4o-mini-tts")
    sel_voice = voice or os.getenv("TTS_VOICE", "alloy")
    try:
        # Non-streaming call; returns an object with bytes.
        r = sclient.audio.speech.create(model=tts_model, voice=sel_voice, input=text)
        # The SDK exposes different helpers across versions; try a few:
        audio_bytes = None
        for attr in ("to_bytes", "read", "bytes", "content"):
            if hasattr(r, attr):
                val = getattr(r, attr)
                audio_bytes = val() if callable(val) else val
                break
        if not audio_bytes:
            # Fallback: some versions have .stream for chunks
            if hasattr(r, "stream"):
                b = io.BytesIO()
                for chunk in r.stream:
                    b.write(chunk)
                audio_bytes = b.getvalue()
        return audio_bytes or b""
    except Exception as e:
        log.error("TTS failed: %s", repr(e))
        return b""

def stt_blocking(raw_bytes: bytes) -> str:
    """
    Server STT for MediaRecorder/webm chunks. Keep for desktop Chrome path.
    If iOS blocks mic on HTTP, your frontend falls back to browser SR.
    """
    try:
        model = os.getenv("STT_MODEL", "gpt-4o-transcribe")
        # Provide a filename & mimetype so the API can infer decoder
        file_tuple = ("speech.webm", io.BytesIO(raw_bytes), "audio/webm")
        tr = sclient.audio.transcriptions.create(model=model, file=file_tuple)
        text = getattr(tr, "text", None) or (tr.__dict__.get("text") if hasattr(tr, "__dict__") else "")
        return (text or "").strip()
    except Exception as e:
        log.error("STT failed: %s", repr(e))
        return ""

# -----------------------------
# Routes
# -----------------------------
@app.get("/")
async def index():
    if not INDEX_HTML.exists():
        # Clear, friendly error for the exact path being used.
        return PlainTextResponse(
            f"index.html not found. Looked in:\n- {CANDIDATES[0]}\n- {CANDIDATES[1]}\n- {BASE_DIR/'index.html'}\n",
            status_code=500,
        )
    # Serve the existing file under template/ or templates/
    return FileResponse(str(INDEX_HTML))

@app.post("/chat")
async def chat(payload: ChatIn):
    messages = build_messages(payload)
    res = await call_chat(messages)
    return JSONResponse(res)

@app.post("/tts")
async def tts(body: TTSIn):
    audio = await app.state.anyio.to_thread.run_sync(tts_blocking, body.text, body.voice) if hasattr(app.state, "anyio") \
        else tts_blocking(body.text, body.voice)
    if not audio:
        # Return 200 with empty audio is what your JS currently handles as
        # “Sorry, my audio didn’t load—let’s keep chatting!”
        return Response(content=b"", media_type="application/octet-stream")
    # Don’t hardcode type; generic is fine because the <audio> element will sniff.
    return Response(content=audio, media_type="application/octet-stream")

@app.post("/stt")
async def stt(request: Request):
    # Accept raw bytes (MediaRecorder webm).
    raw = await request.body()
    text = await app.state.anyio.to_thread.run_sync(stt_blocking, raw) if hasattr(app.state, "anyio") \
        else stt_blocking(raw)
    return JSONResponse({"text": text})

# -----------------------------
# Uvicorn entry (optional)
# -----------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server.main:app", host="127.0.0.1", port=8000, reload=True)
