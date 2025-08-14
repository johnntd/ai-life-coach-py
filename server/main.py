"""
server/main.py
Miss Sunny backend – FastAPI version
"""

# =========================
# Standard & third-party
# =========================
from fastapi import FastAPI, Request, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse, HTMLResponse, PlainTextResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware

import os
from dotenv import load_dotenv

from io import BytesIO
import base64
import mimetypes

try:
    from PyPDF2 import PdfReader
    HAVE_PDF = True
except Exception:
    HAVE_PDF = False

try:
    from PIL import Image  # noqa: F401  (kept for future use)
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False

from openai import OpenAI
from pathlib import Path
from fastapi.staticfiles import StaticFiles

# =========================
# Bootstrap
# =========================
load_dotenv()

# CHANGE: Authoritative model/env knobs (default to your requested values)
PRIMARY_MODEL      = os.getenv("PRIMARY_MODEL", "gpt-5-2025-08-07")  # CHANGE
FALLBACK_MODEL     = os.getenv("FALLBACK_MODEL", "gpt-4o")           # CHANGE
TTS_MODEL          = os.getenv("TTS_MODEL", "gpt-4o-mini-tts")       # CHANGE
TTS_VOICE          = os.getenv("TTS_VOICE", "alloy")                 # CHANGE
TRANSCRIBE_MODEL   = os.getenv("TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")
CORS_ALLOWED       = os.getenv("ALLOWED_ORIGINS", "*").split(",")

app = FastAPI(title="Miss Sunny Backend", version="1.0.0")

BASE_DIR     = Path(__file__).resolve().parents[1]
STATIC_DIR   = BASE_DIR / "static"
TEMPLATE_DIR = BASE_DIR / "templates"
INDEX_FILE   = TEMPLATE_DIR / "index.html"

print(f"[boot] INDEX_FILE: {INDEX_FILE} exists={INDEX_FILE.exists()}")
print(f"[boot] STATIC_DIR: {STATIC_DIR} exists={STATIC_DIR.exists()}")

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# =========================
# Prompt loader (file-based)
# =========================
APP_DIR = Path(__file__).resolve().parent
# CHANGE: directory name is 'prompts' in your repo
PROMPT_FILE = (APP_DIR / ".." / "prompts" / "coach_system_prompt.md").resolve()  # CHANGE

_prompt_cache = {"text": None, "mtime": None, "path": None}

def _resolve_prompt_path() -> Path:
    env_path = os.getenv("PROMPT_PATH")
    if env_path:
        return Path(env_path).resolve()
    ver = os.getenv("PROMPT_VERSION")
    if ver:
        return (APP_DIR / ".." / "prompts" / f"coach_system_prompt.v{ver}.md").resolve()  # CHANGE
    return PROMPT_FILE

def load_system_prompt() -> str:
    path = _resolve_prompt_path()
    try:
        st = path.stat()
    except FileNotFoundError:
        return ("You are Miss Sunny, a warm, encouraging life coach and tutor. "
                "Be concise (1–3 sentences) and use Camera/Upload when helpful.")
    if (_prompt_cache["text"] is None
        or _prompt_cache["mtime"] != st.st_mtime
        or _prompt_cache["path"] != str(path)):
        text = path.read_text(encoding="utf-8")
        if text.startswith("---"):
            end = text.find("\n---", 3)
            if end != -1:
                text = text[end+4:].lstrip()
        _prompt_cache.update({"text": text, "mtime": st.st_mtime, "path": str(path)})
        print(f"[prompt] Loaded: {path}")
    return _prompt_cache["text"]

def build_session_prompt(payload: dict) -> str:
    """File-based master prompt + per-session context."""
    base = load_system_prompt()
    bits = []
    if payload.get("name"): bits.append(f"User: {payload['name']}")
    if payload.get("age") is not None: bits.append(f"Age: {payload['age']}")
    if payload.get("mode"): bits.append(f"Mode: {payload['mode']}")
    if payload.get("objective"): bits.append(f"Objective: {payload['objective']}")
    if payload.get("lang"): bits.append(f"Preferred language: {payload['lang']}")
    return f"{base}\n\n---\nSESSION CONTEXT\n" + "\n".join(bits) if bits else base

# =========================
# Health / Root
# =========================
@app.get("/", response_class=HTMLResponse)
def root_page():
    if INDEX_FILE.exists():
        return FileResponse(str(INDEX_FILE))
    return HTMLResponse("<!doctype html><h1>Miss Sunny backend is running.</h1>")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED,  # CHANGE
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

oai = OpenAI()

# =========================
# Utilities
# =========================
def clamp_two_sentences(text: str) -> str:
    import re
    s = (text or "").strip()
    if not s:
        return s
    parts = re.split(r'(?<=[.!?])\s+', s)
    return " ".join(parts[:2]).strip()

_VI_DIAC = "ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽềểễệọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ"
def detect_lang_from_text(text: str, session_lang: str = "en-US") -> str:
    t = (text or "").lower()
    if any(ch in t for ch in _VI_DIAC):
        return "vi-VN"
    for kw in ("chào", "em", "anh", "chị", "cảm ơn", "vui lòng"):
        if kw in t:
            return "vi-VN"
    return session_lang if session_lang in ("vi-VN", "en-US") else "en-US"

# CHANGE: seed/proactive helper text (ensures non-empty starts)
def default_seed_line(name: str, age: int, mode: str, lang: str) -> str:
    if (age or 0) < 13:
        return f"Hi, {name}! I’m Miss Sunny. Want to play a quick learning game with me?"
    if (age or 0) < 18:
        return f"Hey {name}, ready for a fast check-in and a mini study plan?"
    return f"Hi {name}, I’m Miss Sunny. What would you like to work on first?"

# CHANGE: message composer (handles include_seed and no_reply)
def compose_messages(payload: dict) -> list:
    sys = build_session_prompt(payload)
    messages = [{"role": "system", "content": sys}]

    history_list = payload.get("history") or []
    for turn in history_list:
        role = turn.get("sender")
        txt  = (turn.get("text") or "").strip()
        if not txt: 
            continue
        messages.append({"role": "assistant" if role in ("coach","assistant") else "user", "content": txt})

    user_text = (payload.get("user_text") or "").strip()
    include_seed = bool(payload.get("include_seed") or False)
    no_reply = bool(payload.get("no_reply") or False)

    if include_seed:
        # Ask the model to proactively start the plan for the right age group
        seed = ("Please greet warmly and immediately begin a brief, age-appropriate assessment or starter plan. "
                "Ask one short question the learner can answer out loud.")
        messages.append({"role": "user", "content": seed})
    elif no_reply and not user_text:
        # Proactive nudge when the learner stays silent
        nudge = ("The learner is quiet. Keep the session moving with the next short step or question. "
                 "Be encouraging and specific.")
        messages.append({"role": "user", "content": nudge})
    elif user_text:
        messages.append({"role": "user", "content": user_text})

    return messages

# =========================
# TTS – text-to-speech
# =========================
@app.post("/tts")
async def tts(request: Request):
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    text = (data.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text provided")

    try:
        with oai.audio.speech.with_streaming_response.create(
            model=TTS_MODEL,                  # CHANGE
            voice=TTS_VOICE,                  # CHANGE
            input=text
        ) as resp:
            audio_bytes = resp.read()
        return StreamingResponse(BytesIO(audio_bytes), media_type="audio/mpeg")
    except Exception as e:
        print("TTS error:", repr(e))
        return PlainTextResponse(f"TTS failed: {e}", status_code=500)

# =========================
# /chat – main conversation
# =========================
@app.post("/chat")
async def chat(request: Request):
    body = await request.json()
    name  = (body.get("name") or "Friend").strip()
    age   = int(body.get("age") or 18)
    mode  = body.get("mode") or ("child" if age < 13 else "teen" if age < 18 else "adult")
    session_lang = body.get("lang") or "en-US"

    # Compose messages from payload (seed/silence-aware)
    messages = compose_messages({
        "name": name,
        "age": age,
        "mode": mode,
        "objective": body.get("objective") or "gentle warm-up assessment",
        "lang": session_lang,
        "history": body.get("history") or [],
        "user_text": body.get("user_text") or "",
        "include_seed": bool(body.get("include_seed") or False),
        "no_reply": bool(body.get("no_reply") or False),  # CHANGE
    })

    text = ""
    model_used = PRIMARY_MODEL

    # CHANGE: Primary (gpt-5-*) uses Responses API semantics; avoid unsupported params.
    try:
        if PRIMARY_MODEL.startswith("gpt-5"):
            resp = oai.responses.create(                      # CHANGE
                model=PRIMARY_MODEL,
                input=messages                                # CHANGE: responses API accepts 'input'
            )
            # Pull the first text item safely
            out = resp.output_text if hasattr(resp, "output_text") else None  # CHANGE
            text = (out or "").strip()
        else:
            # Standard Chat Completions path
            resp = oai.chat.completions.create(
                model=PRIMARY_MODEL,
                messages=messages
                # NOTE: no temperature/max_tokens here for gpt-5 strictness
            )
            text = (resp.choices[0].message.content or "").strip()
    except Exception as e:
        print("[chat] primary failed; falling back:", repr(e))
        model_used = FALLBACK_MODEL
        try:
            resp = oai.chat.completions.create(
                model=FALLBACK_MODEL,
                messages=messages,
                max_tokens=220,            # CHANGE: only on fallback path
                temperature=0.6            # CHANGE
            )
            text = (resp.choices[0].message.content or "").strip()
        except Exception as e2:
            print("[chat] fallback failed:", repr(e2))
            text = ""

    # Guarantee a non-empty first line so Start never stalls
    if not text:
        text = default_seed_line(name=name, age=age, mode=mode, lang=session_lang)  # CHANGE

    # Clamp and lang detect for TTS friendliness
    text = clamp_two_sentences(text)
    lang = detect_lang_from_text(text, session_lang=session_lang)

    return JSONResponse({
        "text": text,
        "lang": lang,
        "profile": { "name": name, "age": age, "mode": mode },
        "model_used": model_used
    })

# =========================
# /analyze – images/PDFs for tutoring
# =========================
@app.post("/analyze")
async def analyze_file(
    file: UploadFile = File(...),
    uid: str  = Form(""),
    name: str = Form("Friend"),
    age: int  = Form(18),
    mode: str = Form("adult"),
    prompt: str = Form("Please help me with this."),
    lang: str = Form("en-US"),
):
    mime = file.content_type or mimetypes.guess_type(file.filename)[0] or "application/octet-stream"
    data = await file.read()

    def sys_prompt(objective: str):
        # CHANGE: reuse file-based prompt
        return build_session_prompt({
            "name": name, "age": age, "mode": mode,
            "objective": objective, "lang": lang
        })

    def clamp2(s: str) -> str:
        return clamp_two_sentences(s or "")

    try:
        if mime.startswith("image/"):
            b64 = base64.b64encode(data).decode("ascii")
            data_url = f"data:{mime};base64,{b64}"
            messages = [
                {"role": "system", "content": sys_prompt("image/file tutoring")},
                {"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ]},
            ]
            # Use fallback model for vision reliably
            resp = oai.chat.completions.create(
                model=FALLBACK_MODEL,
                messages=messages,
                max_tokens=200,
                temperature=0.5,
            )
            text = (resp.choices[0].message.content or "").strip()
            return JSONResponse({"text": clamp2(text)})

        if mime == "application/pdf":
            if not HAVE_PDF:
                return JSONResponse({"text": "PDF reading isn’t available on this server. Please send a screenshot instead."})
            reader = PdfReader(BytesIO(data))
            pages = []
            for i, page in enumerate(reader.pages[:3]):
                try:
                    pages.append(page.extract_text() or "")
                except Exception:
                    pages.append("")
            excerpt = "\n\n---\n\n".join(pages).strip()[:6000]
            if not excerpt:
                return JSONResponse({"text": "I received the PDF but couldn’t read its text. Please send a screenshot of the page."})
            messages = [
                {"role": "system", "content": sys_prompt("document tutoring")},
                {"role": "user", "content": f"{prompt}\n\nDocument excerpt:\n{excerpt}"},
            ]
            resp = oai.chat.completions.create(
                model=FALLBACK_MODEL,
                messages=messages,
                max_tokens=220,
                temperature=0.5,
            )
            text = (resp.choices[0].message.content or "").strip()
            return JSONResponse({"text": clamp2(text)})

        return JSONResponse({"text": "I got the file. For best results, send an image (jpg/png) or a PDF."})

    except Exception as e:
        print("Analyze error:", e)
        return JSONResponse({"text": "I had trouble analyzing that. Can you try another photo or PDF?"})
