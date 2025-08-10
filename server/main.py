import os
import logging
from typing import List, Optional, Literal

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
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
PRIMARY_MODEL = os.getenv("PRIMARY_MODEL", "gpt-5")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gpt-4o")
TTS_MODEL = os.getenv("TTS_MODEL", "gpt-4o-mini-tts")
TTS_VOICE = os.getenv("TTS_VOICE", "alloy")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*")

if not OPENAI_API_KEY:
    log.warning("OPENAI_API_KEY is missing")

client = OpenAI(api_key=OPENAI_API_KEY)

# Use short replies to keep TTS fast
MAX_COMPLETION_TOKENS = 140  # ~ ≤35 words target

# ------------------------------------------------------------------------------
# App & Static
# ------------------------------------------------------------------------------
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in ALLOWED_ORIGINS.split(",")] if ALLOWED_ORIGINS else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
templates_dir = os.path.join(BASE_DIR, "templates")
static_dir = os.path.join(BASE_DIR, "static")

env = Environment(
    loader=FileSystemLoader(templates_dir),
    autoescape=select_autoescape(["html", "xml"])
)

app.mount("/static", StaticFiles(directory=static_dir), name="static")

# ------------------------------------------------------------------------------
# Models
# ------------------------------------------------------------------------------
class HistoryItem(BaseModel):
    sender: Literal["you", "coach"]
    text: str

class ChatRequest(BaseModel):
    user_text: str = ""
    name: str = "Friend"
    age: int = 5
    mode: Literal["child", "teen", "adult"] = "child"
    lang: Literal["en-US", "vi-VN"] = "en-US"
    include_seed: bool = False
    history: List[HistoryItem] = Field(default_factory=list)

class ChatResponse(BaseModel):
    reply: str
    model_used: str
    meta: Optional[dict] = None

class TTSRequest(BaseModel):
    text: str

# ------------------------------------------------------------------------------
# Prompt shaping (aligned to your Master Prompt)
# ------------------------------------------------------------------------------
CORE_SYSTEM = (
    "You are Miss Sunny, a warm, patient, bilingual (English↔Vietnamese) AI life coach and language teacher. "
    "You interact via a life-like avatar. Keep turns short, lively, interactive, and child-safe. "
    "Once teaching, be in Study Mode."
)

ENGAGEMENT_RULES = (
    "For child/teen: ≤35 words per turn. For adult: ≤60 words. "
    "Always end with exactly one simple question. "
    "Use playful tone for kids; respectful, clear tone for adults."
)

BILINGUAL_RULES = (
    "If learner’s primary language is English and they are learning Vietnamese: mainly Vietnamese with brief English clarifications and bilingual pairs. "
    "If learner’s primary language is Vietnamese and learning English: mainly English with brief Vietnamese clarifications and bilingual pairs. "
    "Gradually increase target language usage as skill improves."
)

TURN_RECIPE = (
    "Each turn: 1) Acknowledge last input. 2) One tiny teaching point. "
    "3) Invite an action/response. 4) End with exactly one question. "
    "Include optional one avatar cue tag at end like [[CUE_SMILE]] "
    "Do not include lists or markdown."
)

SAFETY = (
    "Never ask for personal info beyond name and age for personalization. "
    "If user mentions harm or unsafe: respond with empathy, say you will get someone to help, and output [[ESCALATE_GROWNUP]] on a new line."
)

def mode_limits(mode: str) -> str:
    if mode in ("child", "teen"):
        return "Keep it ≤35 words. Exactly one question."
    return "Keep it ≤60 words. Exactly one question."

def seed_opening(name: str, mode: str, lang: str) -> str:
    # Short warm start that the frontend also speaks once
    if mode in ("child", "teen"):
        return f"Hi {name}! How are you feeling—happy, okay, or not great?"
    return f"Hello {name}. How are you feeling today?"

def build_messages(req: ChatRequest) -> List[dict]:
    system_pack = [
        {"role": "system", "content": CORE_SYSTEM},
        {"role": "system", "content": ENGAGEMENT_RULES},
        {"role": "system", "content": BILINGUAL_RULES},
        {"role": "system", "content": TURN_RECIPE},
        {"role": "system", "content": SAFETY},
        {"role": "system", "content":
            f"Mode: {req.mode}. Learner age: {req.age}. UI language: {req.lang}. "
            f"{mode_limits(req.mode)}"}
    ]

    msgs: List[dict] = []
    msgs.extend(system_pack)

    # roll short chat history
    for m in req.history[-12:]:
        role = "assistant" if m.sender == "coach" else "user"
        msgs.append({"role": role, "content": m.text})

    # include seed hint once if requested
    if req.include_seed:
        msgs.append({
            "role": "developer",
            "content": "Start with a warm greeting using the learner’s name, then one tiny challenge appropriate to age. Keep it short and end with one question."
        })
        msgs.append({"role": "user", "content": seed_opening(req.name, req.mode, req.lang)})

    # user turn (can be empty on seed)
    if req.user_text:
        msgs.append({"role": "user", "content": req.user_text})

    return msgs

# ------------------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def home(_: Request):
    tpl = env.get_template("index.html")
    return tpl.render()

@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    # Build messages
    messages = build_messages(req)

    # Primary → Fallback
    model_used = PRIMARY_MODEL
    try:
        log.info("[router] calling model=%s", PRIMARY_MODEL)
        r = client.chat.completions.create(
            model=PRIMARY_MODEL,
            messages=messages,
            max_completion_tokens=MAX_COMPLETION_TOKENS,
        )
        reply = (r.choices[0].message.content or "").strip()
        if not reply:
            raise RuntimeError("Empty reply from primary")
    except Exception as e:
        log.info("[router] primary failed: %s", e)
        model_used = FALLBACK_MODEL
        r = client.chat.completions.create(
            model=FALLBACK_MODEL,
            messages=messages,
            max_tokens=MAX_COMPLETION_TOKENS,
        )
        reply = (r.choices[0].message.content or "").strip()

    # Hard guard: keep it tiny so TTS is snappy
    if req.mode in ("child", "teen") and len(reply.split()) > 40:
        reply = "Let’s keep it short. How are you feeling—happy, okay, or not great?"

    return JSONResponse(ChatResponse(reply=reply, model_used=model_used, meta=None).model_dump())

@app.post("/tts")
async def tts(body: TTSRequest):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Missing text")

    try:
        # Non‑streaming: lowest error rate with our frontend; still quick for short lines
        # In v1+ this returns a binary body; we can read .content directly.
        res = client.audio.speech.create(
            model=TTS_MODEL,
            voice=TTS_VOICE,
            input=text,
            response_format="mp3",
        )
        return Response(content=res.content, media_type="audio/mpeg")
    except Exception as e:
        log.exception("TTS failed: %s", e)
        raise HTTPException(status_code=500, detail="TTS failed")

@app.get("/health")
async def health():
    return {"ok": True}
