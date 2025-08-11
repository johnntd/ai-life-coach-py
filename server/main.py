# server/main.py
# ─────────────────────────────────────────────────────────────────────────────
# What’s new (while keeping all earlier behavior, routes, IDs):
# • Deterministic session intro (Hi → ask NAME → ask AGE → then assessment).
# • Single-language responses (no bilingual mixing).
# • TTS uses the current SDK call signature (no deprecated args).
# • Lightweight “profile memory” across sessions, keyed by client_id.
#   - We store {name, age, notes} per user in ./data/memory.json.
#   - Client sends client_id + profile each /chat; server merges & persists.
# • Strip [[CUE_*]] placeholders from model text.
# • Still serves index.html from your original template/ directory.
# • Endpoints preserved: GET /, POST /chat, POST /tts, POST /stt
# ─────────────────────────────────────────────────────────────────────────────

import os
import io
import re
import json
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from openai import AsyncOpenAI, OpenAI

# ---------- Paths ----------
BASE_DIR = Path(__file__).resolve().parents[1]
STATIC_DIR = BASE_DIR / "static"

# Keep your original index in template/ if that’s where it lives
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
    INDEX_HTML = CANDIDATES[-1]  # last fallback; we’ll 500 if it doesn’t exist

DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
MEM_PATH = DATA_DIR / "memory.json"  # simple JSON store for lightweight memory

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

# ---------- OpenAI ----------
aclient = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))  # async (chat)
sclient = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))       # sync (tts, stt)

PRIMARY_MODEL  = os.getenv("PRIMARY_MODEL",  "gpt-5-2025-08-07")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gpt-4o")
TTS_MODEL      = os.getenv("TTS_MODEL",      "gpt-4o-mini-tts")
TTS_VOICE      = os.getenv("TTS_VOICE",      "alloy")
STT_MODEL      = os.getenv("STT_MODEL",      "gpt-4o-transcribe")  # or "whisper-1"

# ---------- Models ----------
class HistoryItem(BaseModel):
    sender: str
    text: str

class Profile(BaseModel):
    name: Optional[str] = None
    age: Optional[int] = None
    notes: Optional[str] = None  # freeform extra memory

class ChatIn(BaseModel):
    user_text: str = ""
    include_seed: bool = False
    name: str = "Emily"                # kept for backward compat
    age: int = 5
    mode: str = "child"                # "teen" | "child"
    objective: str = "assessment"      # preserved
    history: Optional[List[HistoryItem]] = None
    lang: str = "en-US"
    client_id: Optional[str] = None    # NEW: persisted memory key
    profile: Optional[Profile] = None  # NEW: client-side profile state

class TTSIn(BaseModel):
    text: str
    voice: Optional[str] = None
    model: Optional[str] = None  # kept for compatibility

# ---------- Memory helpers ----------
def _load_mem() -> Dict[str, Any]:
    if MEM_PATH.exists():
        try:
            return json.loads(MEM_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}

def _save_mem(mem: Dict[str, Any]) -> None:
    try:
        MEM_PATH.write_text(json.dumps(mem, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        log.error("Failed to save memory: %r", e)

def get_profile_for(client_id: Optional[str]) -> Profile:
    if not client_id:
        return Profile()
    mem = _load_mem()
    data = mem.get(client_id) or {}
    return Profile(**{k: data.get(k) for k in ("name", "age", "notes")})

def merge_and_save_profile(client_id: Optional[str], incoming: Optional[Profile]) -> Profile:
    """Merge server memory with incoming profile and persist."""
    if not client_id:
        return incoming or Profile()
    mem = _load_mem()
    current = mem.get(client_id, {})
    inc = (incoming.model_dump(exclude_none=True) if incoming else {})
    # keep previous values if incoming omitted
    merged = {**current, **inc}
    mem[client_id] = merged
    _save_mem(mem)
    return Profile(**{k: merged.get(k) for k in ("name", "age", "notes")})

# ---------- Misc helpers ----------
def strip_cues(text: str) -> str:
    return re.sub(r"\[\[.*?\]\]", "", text or "").strip()

def lang_name(lang_code: str) -> str:
    lc = (lang_code or "").lower()
    if lc.startswith("vi"): return "English"  # <- force English by default (adjust as needed)
    if lc.startswith("en"): return "English"
    return "English"

def build_messages(payload: ChatIn, server_profile: Profile) -> List[dict]:
    """Compose system + history + user; embed memory. Enforce single language & intro choreography."""
    learner_lang = lang_name(payload.lang)
    session_role = "Teen Coaching" if payload.mode == "teen" else "Child Coaching"

    # Use most reliable name/age: incoming > stored > legacy fields
    child_name = (payload.profile and payload.profile.name) or server_profile.name or payload.name
    child_age  = (payload.profile and payload.profile.age)  or server_profile.age  or payload.age
    notes      = (payload.profile and payload.profile.notes) or server_profile.notes

    memory_line = f"Known child facts → Name: {child_name or 'Unknown'}, Age: {child_age or 'Unknown'}."
    if notes:
        memory_line += f" Extra notes: {notes}"

    system = (
        "You are Miss Sunny, a warm, patient children’s coach.\n"
        f"- Session Mode: {session_role}. Objective: {payload.objective}. Respond ONLY in {learner_lang}.\n"
        "- START OF EVERY NEW SESSION (strict):\n"
        "  1) Greet and ask the child's NAME only.\n"
        "  2) After they say their name, ask their AGE only.\n"
        "  3) After age is known, begin the assessment.\n"
        "- When you already know the name/age from memory, briefly confirm and start assessment.\n"
        "- Keep turns short and end with exactly one question. No [[CUE_*]] style hints.\n"
        "- ASSESSMENT order: Reading/Writing → Math → Logic → Science → Social skills → General knowledge.\n"
        "  Ask 1–2 items per section; after each, give one-sentence feedback + one tip.\n"
        "  Finish with a brief overall summary + playful learning plan.\n"
        f"- Memory: {memory_line}\n"
    )

    msgs: List[dict] = [{"role": "system", "content": system}]

    if payload.history:
        for h in payload.history:
            if not h.text:
                continue
            role = "user" if h.sender == "you" else "assistant"
            msgs.append({"role": role, "content": strip_cues(h.text)})

    if payload.include_seed and not payload.user_text:
        # Deterministic kick-off so TTS can speak immediately
        if child_name:
            # We already know her name; ask age to move on quickly
            seed = f"Hi {child_name}! How old are you?"
        else:
            seed = "Hi! I’m Miss Sunny. What’s your name?"
        msgs.append({"role": "assistant", "content": seed})
    else:
        msgs.append({"role": "user", "content": payload.user_text or ""})

    return msgs

async def call_chat(messages: List[dict]) -> dict:
    """Router: try PRIMARY then FALLBACK (async)."""
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
    """TTS: compatible with current SDK; returns raw bytes or empty."""
    try:
        res = sclient.audio.speech.create(model=TTS_MODEL, voice=voice or TTS_VOICE, input=text)
        if hasattr(res, "read"):
            return res.read() or b""
        for attr in ("to_bytes", "bytes", "content"):
            if hasattr(res, attr):
                v = getattr(res, attr)
                return v() if callable(v) else (v or b"")
        if hasattr(res, "stream"):
            buf = io.BytesIO()
            for chunk in res.stream:
                buf.write(chunk)
            return buf.getvalue()
    except Exception as e:
        log.error("TTS failed: %r", e)
    return b""

def stt_text(raw: bytes) -> str:
    """STT: accepts audio/webm or m4a/mp3/wav etc."""
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
    # Merge known server memory with any incoming profile changes
    server_profile = get_profile_for(payload.client_id)
    merged = merge_and_save_profile(payload.client_id, payload.profile)
    # Build messages with the latest view of memory
    messages = build_messages(payload, merged)
    res = await call_chat(messages)
    # Return the latest profile back to the client so it can sync localStorage
    res["profile"] = merged.model_dump()
    return JSONResponse(res)

@app.post("/tts")
async def tts(body: TTSIn):
    audio = tts_bytes(body.text, body.voice)
    return Response(content=audio, media_type="application/octet-stream")

@app.post("/stt")
async def stt(request: Request):
    raw = await request.body()
    text = stt_text(raw)
    return JSONResponse({"text": text})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server.main:app", host="127.0.0.1", port=8000, reload=True)
