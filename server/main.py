import os
import logging
from typing import List, Literal, Optional, Dict, Any

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from jinja2 import Environment, FileSystemLoader, select_autoescape
from dotenv import load_dotenv

# OpenAI (>=1.x)
from openai import OpenAI
import httpx

load_dotenv()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("server.main")

# -----------------------
# Config / OpenAI Client
# -----------------------
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
PRIMARY_MODEL = os.getenv("PRIMARY_MODEL", "gpt-5")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gpt-4o")
TTS_MODEL = os.getenv("TTS_MODEL", "gpt-4o-mini-tts")
TTS_VOICE = os.getenv("TTS_VOICE", "alloy")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*")

if not OPENAI_API_KEY:
    raise RuntimeError("Missing OPENAI_API_KEY in environment.")

client = OpenAI(api_key=OPENAI_API_KEY)

# -----------------------
# FastAPI + CORS + Static
# -----------------------
app = FastAPI(title="AI Life Coach (Python)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if ALLOWED_ORIGINS == "*" else [ALLOWED_ORIGINS],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static and templates
STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")
TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "..", "templates")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

jinja_env = Environment(
    loader=FileSystemLoader(TEMPLATES_DIR),
    autoescape=select_autoescape(["html", "xml"])
)

# -----------------------
# Prompt Builder (compact)
# -----------------------
CORE_PROMPT = """SYSTEM / coach_core_v1
You are Miss Sunny, a warm, patient, safety‑first AI life coach for young children (ages 3–8).
Goals: (1) keep the child engaged with very short turns, (2) teach through play, (3) assess gently and adapt, (4) produce clear next steps for the parent/guardian.
Constraints:
• Age‑aware: adjust vocabulary, sentence length, difficulty, and pacing to the child’s age.
• Voice‑first: speak in 2–3 short sentences max, then end every turn with exactly ONE simple question.
• Engagement: rotate between check‑in → tiny lesson → quick practice → praise → next question.
• Multi‑modal context is audio only; do not reference visuals unless the app provides them.
• Never ask for personal/contact info. Do not collect identifying data. Keep topics child‑safe.
• If child is silent: offer 1 gentle re‑ask, then simplify or switch activity.
• If off‑topic: validate briefly, then redirect with a playful bridge.
• ALWAYS stay positive, specific with praise.
• Output formatting: plain text only (no lists/markdown).
• Turn budget: ≤ 35 words.

End each reply with exactly one simple question.
"""

SESSION_PRIMER = """SYSTEM / session_primer_v1
Child name: {name}
Age: {age}
Mode: {mode}
Persona: Cheerful, kind, playful teacher.
Today’s objective: {objective}
Accept short or partial answers and scaffold quickly. If the child asks to stop, wrap up kindly.
"""

ENGAGEMENT_RULES = """SYSTEM / engagement_rules_v1
• Micro‑turns: 1 tiny idea + 1 question.
• Vary activities: feelings → sound → counting → observe → kindness.
• Praise technique, not just outcome.
• Offer choices often.
• Switch to lighter activity if frustration.
"""

SAFETY = """SYSTEM / safety_rules_kids_v1
No medical, legal, or crisis advice.
If harm/abuse/self‑harm → add tag [[ESCALATE_GROWNUP]] on its own line after reply.
Age‑appropriate topics only.
"""

TURN_RECIPE = """SYSTEM / turn_recipe_v1
For each turn:
1) Acknowledge child’s last utterance (or silence).
2) One tiny teaching idea (≤2 short sentences).
3) Invite an action in the room.
4) End with exactly one question.
If stalled: offer a choice of two activities.
"""

SILENCE_POLICY = """SYSTEM / silence_handling_v1
If empty/unclear answer:
• Try one easier re‑ask (≤15 words).
• Then offer a choice of two activities.
• Do not repeat identical phrasing; vary it.
"""

DAILY_SEED = """Start with a warm greeting using the child’s name. Do a feelings check with three choices (happy / okay / not great). Then ask one micro challenge appropriate to age (e.g., “What sound does M make?”). Keep it under 30 words total."""

def _ctx_json(name: str, age: int, mode: str) -> str:
    # Tiny JSON blob to bias the model; do NOT ask it to repeat this.
    return (
        '{"child":{"name":"%s","age":%d},"mode":"%s",'
        '"constraints":{"one_question_only":true,"max_words":35}}'
    ) % (name, age, mode)

def build_seed_messages(
    name: str, age: int, mode: Literal["child", "teen"], objective: str
) -> List[Dict[str, str]]:
    return [
        {"role": "system", "content": CORE_PROMPT},
        {"role": "system", "content": SESSION_PRIMER.format(name=name, age=age, mode=mode, objective=objective)},
        {"role": "system", "content": ENGAGEMENT_RULES},
        {"role": "system", "content": SAFETY},
        {"role": "system", "content": TURN_RECIPE},
        {"role": "system", "content": SILENCE_POLICY},
        {"role": "developer", "content": DAILY_SEED},
        {"role": "user", "content": _ctx_json(name, age, mode)},
        {"role": "user", "content": ""}  # allow coach to start
    ]

def build_turn_messages(
    name: str,
    age: int,
    mode: Literal["child", "teen"],
    user_text: str,
    history: Optional[List[Dict[str, str]]] = None
) -> List[Dict[str, str]]:
    msgs: List[Dict[str, str]] = [
        {"role": "system", "content": TURN_RECIPE},
        {"role": "system", "content": SILENCE_POLICY},
        {"role": "user", "content": _ctx_json(name, age, mode)},
    ]
    if history:
        # history: [{sender: "coach"|"you", text: "..."}]
        for m in history[-8:]:
            role = "assistant" if m.get("sender") == "coach" else "user"
            msgs.append({"role": role, "content": m.get("text", "")})
    msgs.append({"role": "user", "content": user_text or ""})
    return msgs

# -----------------------
# Pydantic models
# -----------------------
class HistoryItem(BaseModel):
    sender: Literal["coach", "you"]
    text: str

class ChatRequest(BaseModel):
    user_text: str = ""
    name: str = "Emily"
    age: int = 5
    mode: Literal["child", "teen"] = "child"
    objective: str = "gentle morning warm-up"
    include_seed: bool = False
    history: Optional[List[HistoryItem]] = None

class ChatResponse(BaseModel):
    reply: str
    model: str
    model_used: str
    meta: Dict[str, Any] = Field(default_factory=dict)

class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    model: Optional[str] = None
    format: Literal["mp3", "wav", "opus"] = "mp3"

# -----------------------
# Model routing
# -----------------------
def _is_gpt5(model_name: str) -> bool:
    return model_name.startswith("gpt-5")

def _primary_params(model_name: str) -> Dict[str, Any]:
    # gpt-5 requires max_completion_tokens and ignores non-default temperature
    if _is_gpt5(model_name):
        return {"model": model_name, "max_completion_tokens": 300}
    return {"model": model_name, "max_tokens": 300, "temperature": 0.7}

def _call_chat(model_name: str, messages: List[Dict[str, str]]) -> Dict[str, Any]:
    params = _primary_params(model_name)
    log.info("[router] calling model=%s", model_name)
    resp = client.chat.completions.create(messages=messages, **params)
    return resp

def _extract_reply(resp: Dict[str, Any]) -> str:
    try:
        c = resp.choices[0].message.content
        return (c or "").strip()
    except Exception:
        return ""

# -----------------------
# Routes
# -----------------------
@app.get("/", response_class=HTMLResponse)
def root():
    tmpl = jinja_env.get_template("index.html")
    html = tmpl.render()
    return HTMLResponse(html)

@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    try:
        if req.include_seed:
            messages = build_seed_messages(req.name, req.age, req.mode, req.objective)
        else:
            messages = build_turn_messages(req.name, req.age, req.mode, req.user_text, req.history)

        # Primary
        try:
            resp = _call_chat(PRIMARY_MODEL, messages)
            reply = _extract_reply(resp)
            if not reply:
                raise RuntimeError("Empty reply from primary")
            return ChatResponse(
                reply=reply,
                model=PRIMARY_MODEL,
                model_used=PRIMARY_MODEL,
                meta={}
            )
        except Exception as e:
            log.error("[router] Primary failed: %s", e)
            # Fallback
            resp = _call_chat(FALLBACK_MODEL, messages)
            reply = _extract_reply(resp)
            if not reply:
                raise RuntimeError("Empty reply from fallback")
            return ChatResponse(
                reply=reply,
                model=FALLBACK_MODEL,
                model_used=FALLBACK_MODEL,
                meta={"warning": f"Primary failed: {type(e).__name__}: {e}"}
            )
    except Exception as e:
        log.error("Chat failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Chat failed")

@app.post("/tts")
def tts(req: TTSRequest):
    try:
        text = (req.text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="Missing text")
        model = req.model or TTS_MODEL
        voice = req.voice or TTS_VOICE
        fmt = req.format or "mp3"

        # Stream TTS back to the browser
        with client.audio.speech.with_streaming_response.create(
            model=model,
            voice=voice,
            input=text,
            format=fmt
        ) as stream:
            return StreamingResponse(
                stream.iter_bytes(),
                media_type="audio/mpeg" if fmt == "mp3" else "audio/wav"
            )
    except Exception as e:
        log.error("TTS failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="TTS failed")
