import os, io, logging
from typing import List, Literal, Optional, Dict, Any

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from jinja2 import Environment, FileSystemLoader, select_autoescape
from dotenv import load_dotenv

from openai import OpenAI
import httpx

# ------------------------------------------------------------------------------
# Boot
# ------------------------------------------------------------------------------
load_dotenv()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("server.main")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
PRIMARY_MODEL   = os.getenv("PRIMARY_MODEL", "gpt-4o")
FALLBACK_MODEL  = os.getenv("FALLBACK_MODEL", "gpt-4o")
TTS_MODEL       = os.getenv("TTS_MODEL", "gpt-4o-mini-tts")
TTS_VOICE       = os.getenv("TTS_VOICE", "alloy")
TRANSCRIBE_MODEL= os.getenv("TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*")

if not OPENAI_API_KEY:
    log.warning("OPENAI_API_KEY is missing")

client = OpenAI(api_key=OPENAI_API_KEY)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in ALLOWED_ORIGINS.split(",")] if ALLOWED_ORIGINS else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static + templating
app.mount("/static", StaticFiles(directory="static"), name="static")
env = Environment(
    loader=FileSystemLoader("templates"),
    autoescape=select_autoescape(["html", "xml"])
)

# ------------------------------------------------------------------------------
# Prompt builder (kept simple and stable)
# ------------------------------------------------------------------------------
class ChatRequest(BaseModel):
    user_text: str = ""
    name: str = "Emily"
    age: int = 5
    mode: Literal["child","teen","adult"] = "child"
    objective: str = "gentle morning warm-up"
    include_seed: bool = False
    lang: str = "en-US"
    history: Optional[List[Dict[str, Any]]] = None

MASTER_PROMPT = (
    "You are Miss Sunny, a warm, patient, bilingual (English ↔ Vietnamese) AI life "
    "coach and language teacher. Keep turns short, lively, and interactive. "
    "Use Study Mode. Follow session mode limits. "
    "Child/Teen: ≤35 words, Adult: ≤60 words. End with exactly one question. "
    "For bilingual support: If primary language is English and learning Vietnamese, "
    "speak mainly Vietnamese with brief English hints; the reverse if Vietnamese is primary. "
    "Use short bilingual word pairs when introducing new words. Include one optional [[CUE_*]] tag at end."
)

def seed_turn(name:str, age:int, mode:str, lang:str) -> List[Dict[str,str]]:
    greeting = (
        "Hi there! 😊 Do you know how to say “hello” in Vietnamese? Try: “xin chào”! "
        "Can you say it with me? What should we learn next? [[CUE_WAVE]]"
        if lang.startswith("vi") else
        "Hello, friend! 😊 How are you feeling—happy, okay, or not great? "
        "What’s one thing you like to do? [[CUE_WAVE]]"
    )
    return [
        {"role":"system","content":MASTER_PROMPT},
        {"role":"user","content":f"My name is {name}, I am {age} years old. Mode: {mode}. Let's start."},
        {"role":"assistant","content":greeting}
    ]

def turn_messages(name:str, age:int, mode:str, user_text:str) -> List[Dict[str,str]]:
    return [
        {"role":"system","content":MASTER_PROMPT},
        {"role":"user","content":f"({name}, {age}, mode={mode}) {user_text}"}
    ]

# ------------------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
def index():
    tpl = env.get_template("index.html")
    return tpl.render()

@app.post("/chat")
def chat(req: ChatRequest):
    try:
        # choose model (PRIMARY_MODEL already changed in .env step)
        model_try = [PRIMARY_MODEL] + ([FALLBACK_MODEL] if FALLBACK_MODEL and FALLBACK_MODEL != PRIMARY_MODEL else [])

        messages = seed_turn(req.name, req.age, req.mode, req.lang) if req.include_seed \
            else turn_messages(req.name, req.age, req.mode, req.user_text or "")

        last_err = None
        for m in model_try:
            log.info("[router] calling model=%s", m)
            try:
                # chat.completions for wide compatibility
                res = client.chat.completions.create(
                    model=m,
                    messages=messages,
                    max_tokens=220
                )
                reply = (res.choices[0].message.content or "").strip()
                if reply:
                    return JSONResponse({"reply": reply, "model": m})
                raise RuntimeError("Empty reply")
            except Exception as e:
                last_err = e
                log.error("[router] model %s failed: %s", m, e)
                continue
        raise HTTPException(status_code=500, detail=f"Chat failed: {last_err}")
    except HTTPException:
        raise
    except Exception as e:
        log.exception("Chat failed")
        raise HTTPException(status_code=500, detail="Chat failed")

@app.post("/tts")
def tts(payload: Dict[str, Any]):
    try:
        text = (payload or {}).get("text","").strip()
        if not text:
            raise HTTPException(status_code=400, detail="Missing text")
        voice = (payload or {}).get("voice") or TTS_VOICE
        # streaming to memory buffer for minimal overhead
        with client.audio.speech.with_streaming_response.create(
            model=TTS_MODEL,
            voice=voice,
            input=text,
            format="mp3"
        ) as resp:
            return StreamingResponse(resp.iter_bytes(), media_type="audio/mpeg")
    except Exception as e:
        log.exception("TTS failed")
        raise HTTPException(status_code=500, detail="TTS failed")

# --- NEW: robust server STT using gpt‑4o‑mini‑transcribe ---
@app.post("/stt")
async def stt(request: Request):
    try:
        data = await request.body()
        if not data:
            raise HTTPException(status_code=400, detail="Empty audio")
        # data is audio/webm (Opus). Hand to OpenAI as a file-like.
        bio = io.BytesIO(data)
        bio.name = "clip.webm"  # filename hint
        tr = client.audio.transcriptions.create(
            model=TRANSCRIBE_MODEL,
            file=bio,
            response_format="json"
        )
        text = (tr.text or "").strip()
        return JSONResponse({"text": text})
    except HTTPException:
        raise
    except Exception as e:
        log.exception("STT failed")
        raise HTTPException(status_code=500, detail="STT failed")
