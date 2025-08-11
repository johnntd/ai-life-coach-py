# server/main.py
# ─────────────────────────────────────────────────────────────────────────────
# Full FastAPI server preserving prior routes and behavior, with:
# • Deterministic intro flow (name → age → assessment), single language.
# • Memory persisted under ./data/memory.json (keyed by client_id).
# • TTS/STT wired to OpenAI SDK (compatible calls).
# • [[CUE_*]] removal.
# • Short-turn constraint + token caps to keep replies brief.
# • Optional faster model only for the very first seed turn (not used if
#   frontend does instant greeting; kept for compatibility).
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
BASE_DIR   = Path(__file__).resolve().parents[1]
STATIC_DIR = BASE_DIR / "static"

CANDIDATES = [
    BASE_DIR / "template" / "index.html",   # original location
    BASE_DIR / "templates" / "index.html",
    BASE_DIR / "index.html",
]
for p in CANDIDATES:
    if p.exists():
        INDEX_HTML = p
        break
else:
    INDEX_HTML = CANDIDATES[-1]

DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
MEM_PATH = DATA_DIR / "memory.json"

# ---------- App ----------
log = logging.getLogger("server")
logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# ---------- OpenAI ----------
aclient = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))  # async chat
sclient = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))       # sync stt/tts

PRIMARY_MODEL   = os.getenv("PRIMARY_MODEL",  "gpt-5-2025-08-07")
FALLBACK_MODEL  = os.getenv("FALLBACK_MODEL", "gpt-4o")
FAST_SEED_MODEL = os.getenv("FAST_SEED_MODEL","gpt-4o-mini")  # for *seed only*

TTS_MODEL  = os.getenv("TTS_MODEL", "gpt-4o-mini-tts")
TTS_VOICE  = os.getenv("TTS_VOICE", "alloy")
STT_MODEL  = os.getenv("STT_MODEL", "gpt-4o-transcribe")  # or whisper-1

# ---------- Models ----------
class HistoryItem(BaseModel):
    sender: str
    text: str

class Profile(BaseModel):
    name: Optional[str] = None
    age: Optional[int] = None
    notes: Optional[str] = None

class ChatIn(BaseModel):
    user_text: str = ""
    include_seed: bool = False
    name: str = "Emily"
    age: int = 5
    mode: str = "child"
    objective: str = "assessment"
    history: Optional[List[HistoryItem]] = None
    lang: str = "en-US"
    client_id: Optional[str] = None
    profile: Optional[Profile] = None

class TTSIn(BaseModel):
    text: str
    voice: Optional[str] = None
    model: Optional[str] = None

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
    if not client_id:
        return incoming or Profile()
    mem = _load_mem()
    current = mem.get(client_id, {})
    inc = (incoming.model_dump(exclude_none=True) if incoming else {})
    merged = {**current, **inc}
    mem[client_id] = merged
    _save_mem(mem)
    return Profile(**{k: merged.get(k) for k in ("name", "age", "notes")})

# ---------- Utils ----------
def strip_cues(text: str) -> str:
    return re.sub(r"\[\[.*?\]\]", "", text or "").strip()

def lang_name(lang_code: str) -> str:
    # Force English output to avoid mixed-language replies
    return "English"

def build_messages(payload: ChatIn, server_profile: Profile) -> List[dict]:
    learner_lang = lang_name(payload.lang)
    session_role = "Teen Coaching" if payload.mode == "teen" else "Child Coaching"

    child_name = (payload.profile and payload.profile.name) or server_profile.name or payload.name
    child_age  = (payload.profile and payload.profile.age)  or server_profile.age  or payload.age
    notes      = (payload.profile and payload.profile.notes) or server_profile.notes

    memory_line = f"Known child facts → Name: {child_name or 'Unknown'}, Age: {child_age or 'Unknown'}."
    if notes: memory_line += f" Extra notes: {notes}"

    # Tight brevity constraints for every turn
    brevity = (
        "Reply in at most TWO short sentences (≤ 25 words total). "
        "Ask EXACTLY one concise question. Avoid emojis and fillers."
    )

    system = (
        "You are Miss Sunny, a warm, patient children’s coach.\n"
        f"- Session Mode: {session_role}. Objective: {payload.objective}. Respond ONLY in {learner_lang}.\n"
        "- Start-of-session policy:\n"
        "  (1) If name unknown → greet and ask their name only.\n"
        "  (2) If name known but age unknown → ask their age only.\n"
        "  (3) If both known → begin the assessment.\n"
        "- Assessment order: Reading/Writing → Math → Logic → Science → Social skills → General knowledge.\n"
        "  Ask 1–2 items per section; after each, one-sentence feedback + one tip, then continue.\n"
        f"- {brevity}\n"
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
        # Server-side seed kept for compatibility, but the frontend now speaks
        # an instant local greeting, so this path will normally not be used.
        seed = "Hi! What’s your name?"
        if child_name and not child_age:
            seed = f"Hi {child_name}! How old are you?"
        elif child_name and child_age:
            seed = f"Great to see you, {child_name}! Ready to start your assessment?"
        msgs.append({"role": "assistant", "content": seed})
    else:
        msgs.append({"role": "user", "content": payload.user_text or ""})

    return msgs

def _cap_kwargs_for_model(model: str) -> dict:
    """
    Ensure short replies regardless of model family.
    GPT-5 family expects `max_completion_tokens`; GPT-4o expects `max_tokens`.
    """
    if model.startswith("gpt-5"):
        return {"max_completion_tokens": 96}  # ~ very short
    # otherwise fall back to classic param
    return {"max_tokens": 96}

async def call_chat(messages: List[dict], *, prefer_fast: bool = False) -> dict:
    model_choice = FAST_SEED_MODEL if prefer_fast else PRIMARY_MODEL
    try:
        log.info("[router] calling model=%s", model_choice)
        r = await aclient.chat.completions.create(
            model=model_choice,
            messages=messages,
            **_cap_kwargs_for_model(model_choice),
        )
        txt = (r.choices[0].message.content or "").strip()
        if not txt:
            raise RuntimeError("Empty reply from primary")
        return {"model_used": model_choice, "reply": strip_cues(txt)}
    except Exception as e:
        log.info("[router] Primary failed: %s", getattr(e, "message", str(e)))
        log.info("[router] calling model=%s", FALLBACK_MODEL)
        r = await aclient.chat.completions.create(
            model=FALLBACK_MODEL,
            messages=messages,
            **_cap_kwargs_for_model(FALLBACK_MODEL),
        )
        txt = (r.choices[0].message.content or "").strip()
        return {"model_used": FALLBACK_MODEL, "reply": strip_cues(txt)}

def tts_bytes(text: str, voice: Optional[str]) -> bytes:
    try:
        # New SDK returns a file-like object for speech
        res = sclient.audio.speech.create(model=TTS_MODEL, voice=voice or TTS_VOICE, input=text)
        if hasattr(res, "read"):
            return res.read() or b""
        for attr in ("to_bytes", "bytes", "content"):
            if hasattr(res, attr):
                v = getattr(res, attr)
                return v() if callable(v) else (v or b"")
    except Exception as e:
        log.error("TTS failed: %r", e)
    return b""

def stt_text(raw: bytes) -> str:
    try:
        file_tuple = ("speech.webm", io.BytesIO(raw), "audio/webm")
        tr = sclient.audio.transcriptions.create(model=STT_MODEL, file=file_tuple)
        text = getattr(tr, "text", None) or (getattr(tr, "__dict__", {}).get("text"))
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
    # Load + merge profile memory
    server_profile = get_profile_for(payload.client_id)
    merged = merge_and_save_profile(payload.client_id, payload.profile)

    messages = build_messages(payload, merged)

    # If this is a seed ask, prefer the fast model once
    res = await call_chat(messages, prefer_fast=payload.include_seed)
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
