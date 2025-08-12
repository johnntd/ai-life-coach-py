import os
import re
import io
import time
import json
import tempfile
import logging
from typing import List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from openai import OpenAI

# ------------------------------------------------------------------------------
# Boot
# ------------------------------------------------------------------------------
load_dotenv()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("server.main")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
PRIMARY_MODEL = os.getenv("PRIMARY_MODEL", "gpt-5")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gpt-4o")
TTS_MODEL = os.getenv("TTS_MODEL", "gpt-4o-mini-tts")
TRANSCRIBE_MODEL = os.getenv("TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")
TTS_VOICE = os.getenv("TTS_VOICE", "alloy")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*")

if not OPENAI_API_KEY:
    log.warning("OPENAI_API_KEY is missing")

client = OpenAI(api_key=OPENAI_API_KEY)

app = FastAPI()

# Static files (unchanged: keep your /static dir as-is)
app.mount("/static", StaticFiles(directory="static"), name="static")

# CORS (keep your previous behavior)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in ALLOWED_ORIGINS.split(",")] if ALLOWED_ORIGINS else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------------------------
# Models / Schemas (preserve IDs/fields used by app.js)
# ------------------------------------------------------------------------------

class HistoryItem(BaseModel):
    sender: str
    text: str

class ChatReq(BaseModel):
    user_text: Optional[str] = ""
    include_seed: Optional[bool] = False
    name: Optional[str] = "Emily"
    age: Optional[int] = 5
    mode: Optional[str] = "child"  # "child" or "teen"
    objective: Optional[str] = "gentle warm-up"
    history: Optional[List[HistoryItem]] = []
    lang: Optional[str] = "en-US"

class ChatRes(BaseModel):
    reply: str
    model_used: str

class TTSReq(BaseModel):
    text: str
    voice: Optional[str] = None
    model: Optional[str] = None  # kept for compatibility with older app.js

# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------

def system_prompt_for_miss_sunny(req: ChatReq) -> str:
    """
    Keep your master prompt, trimmed for latency; no [[CUE_...]] in audio.
    Bilingual behavior guided by 'lang' and mode.
    """
    # Short, clean, and deterministic prompt for your flow
    mode_line = "Child / Teen Coaching" if req.mode in ("child", "teen") else "Adult Coaching"
    lang_target = "Vietnamese" if req.lang.startswith("vi") else "English"
    other_lang = "English" if lang_target == "Vietnamese" else "Vietnamese"

    return (
        "Role: You are Miss Sunny, a warm, patient, bilingual AI life coach and language teacher.\n"
        "Constraints:\n"
        f"- Speak mainly in {lang_target}; briefly explain tricky points in {other_lang}.\n"
        "- Keep turns short and interactive; end with exactly one simple question.\n"
        "- No bracketed cues like [[CUE_*]] in your text.\n"
        f"Mode: {mode_line}.  Keep it cheerful and age-appropriate.\n"
        "Goal: Help the learner via a fun, spoken assessment and adaptive coaching.\n"
        "If first turn (no user text), start with a friendly greeting, ask for name and age.\n"
    )

def sanitize_reply(text: str) -> str:
    # Strip [[CUE_...]] safely, just in case
    text = re.sub(r"\[\[.*?\]\]", "", text or "").strip()
    # Collapse excessive whitespace
    text = re.sub(r"\s+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text

def _chat(model: str, messages: List[dict], temperature: Optional[float] = None, max_tokens: Optional[int] = None):
    """
    Synchronous call to Chat Completions (SDK 1.x is sync for the default client).
    We avoid unsupported params on GPT-5 variants.
    """
    kwargs = {"model": model, "messages": messages}

    # Some models (e.g., certain gpt-5 variants) accept only default temperature.
    if temperature is not None and not model.startswith("gpt-5"):
        kwargs["temperature"] = temperature

    # Some models expect 'max_completion_tokens' instead of 'max_tokens'.
    if max_tokens is not None:
        if model.startswith("gpt-5"):
            kwargs["max_completion_tokens"] = max_tokens
        else:
            kwargs["max_tokens"] = max_tokens

    return client.chat.completions.create(**kwargs)

def _try_models(messages: List[dict]) -> ChatRes:
    """
    Try PRIMARY_MODEL first; if it returns an empty/invalid reply or errors, fallback.
    """
    used = None
    text = ""

    try:
        log.info(f"[router] calling model={PRIMARY_MODEL}")
        r = _chat(PRIMARY_MODEL, messages, temperature=None, max_tokens=320)
        used = PRIMARY_MODEL
        text = (r.choices[0].message.content or "").strip()
        if not text:
            log.info("Primary failed: Empty reply from primary")
            used = None
    except Exception as e:
        log.info(f"[router] primary failed; trying fallback")
        used = None

    if used is None:
        try:
            log.info(f"[router] calling model={FALLBACK_MODEL}")
            r = _chat(FALLBACK_MODEL, messages, temperature=0.8, max_tokens=320)
            used = FALLBACK_MODEL
            text = (r.choices[0].message.content or "").strip()
        except Exception as e:
            log.exception("Both models failed")
            raise

    return ChatRes(reply=sanitize_reply(text), model_used=used)

# ------------------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------------------

@app.get("/")
def index():
    """
    Keep serving your existing templates/index.html (you mentioned templates earlier).
    If your index.html is elsewhere, update the path below.
    """
    path = os.path.join("templates", "index.html")
    return FileResponse(path)

@app.post("/chat")
async def chat(req: ChatReq):
    """
    Build messages with a tight system prompt + short context from the last few history items.
    """
    # System prompt
    sys = system_prompt_for_miss_sunny(req)

    # A tiny rolling memory from the client history (kept short for latency)
    ctx: List[dict] = []
    for h in (req.history or [])[-6:]:
        role = "user" if (h.sender or "").lower() == "you" else "assistant"
        ctx.append({"role": role, "content": h.text or ""})

    # First-turn seed vs user text
    if req.include_seed and not (req.user_text or "").strip():
        user_line = ""  # Miss Sunny will start (greeting + name/age ask)
    else:
        user_line = req.user_text or ""

    messages = [{"role": "system", "content": sys}]
    if ctx:
        messages.extend(ctx)
    if user_line:
        messages.append({"role": "user", "content": user_line})

    try:
        res = _try_models(messages)
        return JSONResponse(content={"reply": res.reply, "model_used": res.model_used})
    except Exception as e:
        log.exception("chat failed")
        return JSONResponse(status_code=500, content={"error": "chat_failed"})

@app.post("/tts")
async def tts(req: TTSReq):
    """
    TTS endpoint (fixed for OpenAI Python >= 1.40):
    - DO NOT pass `format=`.
    - Use streaming API and return `audio/mpeg`.
    - We strip any [[CUE_...]] just to be safe.
    """
    text = sanitize_reply(req.text or "")
    voice = (req.voice or TTS_VOICE) or "alloy"
    model = (req.model or TTS_MODEL) or "gpt-4o-mini-tts"

    try:
        # Stream to a temporary MP3 and send it back
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as tmp:
            tmp_path = tmp.name

        # This is the supported pattern in the new SDK
        with client.audio.speech.with_streaming_response.create(
            model=model,
            voice=voice,
            input=text,
        ) as resp:
            resp.stream_to_file(tmp_path)

        # Return the MP3 bytes
        return FileResponse(tmp_path, media_type="audio/mpeg", filename="speech.mp3")
    except TypeError as te:
        # This is what you were seeing: unexpected keyword arg 'format'
        log.error(f"TTS failed: {te}")
        return JSONResponse(status_code=200, content={"error": "tts_failed"})
    except Exception as e:
        log.exception("TTS failed")
        return JSONResponse(status_code=200, content={"error": "tts_failed"})

@app.post("/stt")
async def stt(request: Request):
    """
    Server-side transcription for MediaRecorder chunks (audio/webm).
    We write bytes to a temp .webm and pass a file handle to the SDK
    (most reliable across versions).
    """
    try:
        data = await request.body()
        if not data:
            return JSONResponse(status_code=400, content={"error": "empty_audio"})

        with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        text_out = ""
        # Open and transcribe (synchronous call on the default client)
        with open(tmp_path, "rb") as f:
            tr = client.audio.transcriptions.create(
                model=TRANSCRIBE_MODEL,
                file=f,
            )
            # New SDK returns an object with 'text'
            text_out = (tr.text or "").strip()

        return JSONResponse(content={"text": text_out})
    except Exception as e:
        log.exception("STT failed")
        return JSONResponse(status_code=500, content={"error": "stt_failed"})

# ------------------------------------------------------------------------------
# Health
# ------------------------------------------------------------------------------

@app.get("/healthz")
def healthz():
    return {"ok": True}
