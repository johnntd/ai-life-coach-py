# server/main.py
# ------------------------------------------------------------------------------
# AI Life Coach backend
# - Robust index.html resolver (with embedded fallback UI)
# - Static files:            /static/*
# - Chat endpoint:           /chat
# - Text-to-Speech (TTS):    /tts
# - Speech-to-Text (STT):    /stt
# All previous IDs/handlers/logic preserved.
# ------------------------------------------------------------------------------

import os
import re
import logging
from typing import List, Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    StreamingResponse,
    FileResponse,
)

# ✅ Missing import fixed:
from pydantic import BaseModel

# OpenAI async client (SDK >= 1.40)
from openai import AsyncOpenAI

# ------------------------------------------------------------------------------
# Boot & Config
# ------------------------------------------------------------------------------
load_dotenv()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("server.main")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
PRIMARY_MODEL = os.getenv("PRIMARY_MODEL", "gpt-5")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gpt-4o")
TTS_MODEL = os.getenv("TTS_MODEL", "gpt-4o-mini-tts")
TTS_VOICE = os.getenv("TTS_VOICE", "alloy")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*")
INDEX_HTML_ENV = os.getenv("INDEX_HTML", "").strip()

if not OPENAI_API_KEY:
    log.warning("OPENAI_API_KEY is missing")

# Async client with sensible timeout
client = AsyncOpenAI(api_key=OPENAI_API_KEY, timeout=30)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in ALLOWED_ORIGINS.split(",")] if ALLOWED_ORIGINS else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------------------------
# Helpers to locate index.html (robust against repo layout changes)
# ------------------------------------------------------------------------------
def _candidate_paths_for_index() -> list:
    if INDEX_HTML_ENV:
        return [INDEX_HTML_ENV]

    this_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(this_dir, ".."))

    return [
        os.path.join(repo_root, "index.html"),
        os.path.join(repo_root, "static", "index.html"),
        os.path.join(repo_root, "public", "index.html"),
        os.path.join(repo_root, "www", "index.html"),
        os.path.join(repo_root, "client", "index.html"),
    ]

def _find_index_html() -> Optional[str]:
    for p in _candidate_paths_for_index():
        if p and os.path.isfile(p):
            return p
    return None

def _fallback_index_html() -> str:
    # Minimal embedded UI—keeps your element IDs so /static/app.js works unchanged
    cache_buster = "ios-embedded"
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no"/>
    <title>AI Life Coach</title>
    <link rel="icon" href="/static/favicon.ico">
    <style>
      body {{ background:#0b1320; color:#e6eefc; font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; margin:0; }}
      .wrap {{ max-width:1100px; margin:24px auto; padding:0 16px; }}
      .row {{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }}
      #status, #model {{ font-size:12px; opacity:.8; }}
      #log {{
        background:#0f182a; border-radius:12px; height:60vh; overflow:auto; padding:16px; margin-top:16px;
        border:1px solid rgba(255,255,255,.08);
      }}
      .bubble {{ max-width:900px; padding:10px 12px; border-radius:10px; margin:10px 0; line-height:1.4; }}
      .bubble.coach {{ background:#d5f5df; color:#06250c; }}
      .bubble.you {{ background:#cfe1ff; color:#0e224a; margin-left:auto; }}
      .controls button {{ background:#3159ff; color:white; border:none; border-radius:10px; padding:8px 12px; cursor:pointer; }}
      .controls button:disabled {{ opacity:.55; cursor:not-allowed; }}
      .inputs input, .inputs select {{ background:#0f182a; color:#e6eefc; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:6px 8px; }}
      #ttsAudio {{ display:none; }}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="row">
        <img id="avatar" alt="avatar" src="/static/avatar.jpg" style="width:48px;height:48px;border-radius:50%;object-fit:cover;"/>
        <div style="font-size:22px;font-weight:700;">AI Life Coach</div>
        <div id="status">Idle</div>
        <div id="model" style="margin-left:auto;">Model: gpt-4o</div>
      </div>

      <div class="row inputs" style="margin-top:8px;">
        <input id="name" value="Emily" placeholder="Name" />
        <select id="age">
          <option>5</option><option>6</option><option>7</option><option>8</option><option>9</option><option>10</option>
        </select>
        <label style="display:flex;gap:6px;align-items:center;">
          <input type="checkbox" id="teen"/> Teen Mode
        </label>
        <select id="lang">
          <option value="en-US" selected>English</option>
          <option value="vi-VN">Vietnamese</option>
        </select>
        <div class="controls" style="margin-left:auto; display:flex; gap:8px;">
          <button id="start">▶ Start</button>
          <button id="stop" disabled>■ Stop</button>
        </div>
      </div>

      <div id="log"></div>

      <div class="row" style="margin-top:12px;">
        <input id="text" style="flex:1;" placeholder="(Optional) type a message & Enter"/>
        <button id="send">Send</button>
      </div>

      <div style="font-size:12px;opacity:.7;margin-top:10px;">
        Hands-free after Start. Mic auto-pauses during coach speech.
        Tip for iPhone/iPad: open this app via your HTTPS Cloudflare link; iOS may block mic on plain http://192.168…
      </div>
    </div>

    <audio id="ttsAudio" preload="auto"></audio>
    <script src="/static/app.js?v={cache_buster}"></script>
  </body>
</html>"""

# ------------------------------------------------------------------------------
# Static + Index
# ------------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index():
    index_path = _find_index_html()
    if index_path:
        return FileResponse(index_path)
    log.warning("index.html not found; serving embedded fallback page.")
    return HTMLResponse(_fallback_index_html())

@app.get("/static/{path:path}")
async def static_files(path: str):
    this_dir = os.path.dirname(os.path.abspath(__file__))
    www = os.path.abspath(os.path.join(this_dir, "..", "static"))
    full = os.path.join(www, path)
    return FileResponse(full)

# ------------------------------------------------------------------------------
# Chat models & prompting (unchanged behavior; safer knobs)
# ------------------------------------------------------------------------------
class HistoryItem(BaseModel):
    sender: Literal["you", "coach"]
    text: str

class ChatRequest(BaseModel):
    user_text: str = ""
    include_seed: bool = False
    name: str = "Emily"
    age: int = 5
    mode: Literal["child", "teen", "adult"] = "child"
    objective: Optional[str] = None
    history: List[HistoryItem] = []

MASTER_PROMPT = """You are Miss Sunny, a warm, patient, bilingual (English ↔ Vietnamese) AI life coach and language teacher.
You speak in short, lively, interactive turns and always end with exactly one question.
Pick a tone based on mode:
- child/teen: cheerful, ≤35 words, simple words, gentle corrections, frequent praise
- adult: respectful, ≤60 words, clear explanations

Bilingual rules:
- If primary is English and learning Vietnamese: mostly Vietnamese, brief English hints for tricky parts.
- If primary is Vietnamese and learning English: mostly English, brief Vietnamese hints for tricky parts.

Strict output rules:
- Plain text only (no markdown, no lists).
- DO NOT output any [[CUE_*]] tags or stage directions.
- Keep within the word limit for the mode.
- End with exactly one question.
"""

def system_for(name: str, age: int, mode: str) -> str:
    return (
        MASTER_PROMPT
        + f"\nLearner: {name}, age {age}. Mode: {mode}."
        + "\nStay upbeat and supportive. Keep turns short."
    )

def strip_cues(text: str) -> str:
    return re.sub(r"\[\[.*?\]\]", "", text or "").strip()

def build_messages(req: ChatRequest) -> List[dict]:
    msgs: List[dict] = [{"role": "system", "content": system_for(req.name, req.age, req.mode)}]
    for h in req.history:
        role = "assistant" if h.sender == "coach" else "user"
        msgs.append({"role": role, "content": h.text})

    if req.include_seed:
        msgs.append({
            "role": "user",
            "content": "Please start the session now with a friendly 1–2 sentence opener and exactly one simple question."
        })
    else:
        msgs.append({"role": "user", "content": (req.user_text or "").trim() if hasattr(str, "trim") else (req.user_text or "").strip()})

    return msgs

def model_params_for(model_name: str):
    # gpt-5 models require max_completion_tokens and support only default temperature
    if model_name.startswith("gpt-5"):
        return {"max_completion_tokens": 256}
    # gpt-4o and friends use max_tokens
    return {"max_tokens": 256, "temperature": 1}

async def call_chat(req: ChatRequest, model: str) -> dict:
    messages = build_messages(req)
    extra = model_params_for(model)
    payload = {"model": model, "messages": messages, **extra}

    try:
        log.info("[router] calling model=%s", model)
        r = await client.chat.completions.create(**payload)
    except Exception as e:
        log.info("[router] primary failed on %s: %s", model, repr(e))
        r = await client.chat.completions.create(
            **{**payload, "model": FALLBACK_MODEL, **model_params_for(FALLBACK_MODEL)}
        )

    content = ""
    try:
        content = (r.choices[0].message.content or "").strip()
    except Exception:
        content = ""

    content = strip_cues(content)
    if not content:
        if req.include_seed:
            content = f"Hi {req.name}! How are you feeling—happy, okay, or not great? What’s something fun you like to do?"
        else:
            content = "Could you say that again in a short sentence for me?"

    return {"reply": content, "model_used": getattr(r, "model", model)}

# ------------------------------------------------------------------------------
# Routes (preserved)
# ------------------------------------------------------------------------------
@app.post("/chat")
async def chat(request: Request):
    body = await request.json()
    req = ChatRequest(**body)
    res = await call_chat(req, PRIMARY_MODEL)
    return JSONResponse(res)

@app.post("/tts")
async def tts(request: Request):
    body = await request.json()
    text = (body.get("text") or "").strip()
    voice = (body.get("voice") or TTS_VOICE).strip() or TTS_VOICE
    if not text:
        return StreamingResponse(iter([b""]), media_type="audio/mpeg")
    try:
        async with client.audio.speech.with_streaming_response.create(
            model=TTS_MODEL,
            voice=voice,
            input=text,
        ) as resp:
            audio_bytes = await resp.get_bytes()
            return StreamingResponse(iter([audio_bytes]), media_type="audio/mpeg")
    except Exception as e:
        log.error("TTS failed: %s", repr(e))
        return StreamingResponse(iter([b""]), media_type="audio/mpeg")

@app.post("/stt")
async def stt(file: UploadFile = File(...)):
    try:
        data = await file.read()
        if not data:
            return JSONResponse({"text": ""})
        tr = await client.audio.transcriptions.create(
            model=os.getenv("TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe"),
            file=(file.filename or "audio.webm", data, file.content_type or "audio/webm"),
        )
        text = getattr(tr, "text", None) or getattr(tr, "text_content", None) or ""
        return JSONResponse({"text": text})
    except Exception as e:
        log.error("STT failed: %s", repr(e))
        return JSONResponse({"text": ""})
