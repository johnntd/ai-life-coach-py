# server/main.py
# --------------------------------------------------------------------------------------
# FastAPI backend for AI Life Coach
# - Keeps existing routes: GET /  , POST /chat  , POST /tts
# - Age-agnostic Miss Sunny prompt (all ages)
# - TTS endpoint is now SDK-version-agnostic and falls back to raw HTTP
# --------------------------------------------------------------------------------------

from __future__ import annotations

import os
from typing import List, Optional

import httpx
from fastapi import FastAPI, Request, Body, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from openai import OpenAI

# --------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is not set")

PRIMARY_MODEL = os.getenv("PRIMARY_MODEL", "gpt-5")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gpt-4o")
TTS_MODEL = os.getenv("TTS_MODEL", "gpt-4o-mini-tts")
TTS_VOICE_DEFAULT = os.getenv("TTS_VOICE", "alloy")
TTS_FORMAT_DEFAULT = "mp3"

client = OpenAI(api_key=OPENAI_API_KEY)

app = FastAPI()

# Static + templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


# --------------------------------------------------------------------------------------
# Prompt builder: age-agnostic
# --------------------------------------------------------------------------------------

def build_system_prompt(
    name: str,
    age: Optional[int],
    teen_mode: bool,
    objective: str = "assessment",
) -> str:
    who = name.strip() if name else "friend"
    a = age if (isinstance(age, int) and age > 0) else None

    is_child = a is not None and a < 13
    is_teen = a is not None and 13 <= a < 18
    is_adult = a is None or a >= 18  # default adult-friendly if unknown

    if is_child:
        tone = (
            "Use warm, playful language, very short sentences, and gentle pacing. "
            "Avoid complex vocabulary; define new words simply."
        )
        focus = (
            "Focus on: reading (phonics or sight words), writing letters/words, "
            "numbers and simple math, logic puzzles, early science ideas, social skills, "
            "and basic general knowledge."
        )
    elif is_teen or teen_mode:
        tone = (
            "Be friendly, encouraging, and concise. One actionable question at a time. "
            "No baby talk."
        )
        focus = (
            "Focus on: reading/writing clarity, math appropriate to level, logic & problem "
            "solving, science fundamentals, social/communication skills, and general knowledge."
        )
    else:
        tone = (
            "Be respectful, supportive, and efficient. One concise question at a time. "
            "Avoid condescension."
        )
        focus = (
            "Focus on: everyday literacy & numeracy, reasoning, practical general knowledge "
            "(health & safety basics), light digital/financial literacy as appropriate, "
            "and a quick goals/wellbeing check-in."
        )

    opener = (
        "Start with a brief hello as Miss Sunny. If you do not know the learner's name or age, "
        "politely ask for them. Then proceed with an age-appropriate quick assessment."
    )

    output_rules = (
        "Speak in short, easy-to-hear lines. Ask exactly one question at a time. "
        "After each short section, briefly reflect on how they did and what to try next. "
        "If they seem unsure or silent, offer a simpler option or a fun alternative."
    )

    objective_text = (
        "Objective: run a short, age-appropriate checkup and keep it fun. "
        "End with one personalized suggestion or activity."
    )

    return f"""
You are Miss Sunny, a friendly, encouraging learning coach for all ages.
Learner: "{who}" • Age: {a if a is not None else "unknown"} • Mode teen={teen_mode}

{opener}

Style & Tone:
- {tone}

What to assess (adapt depth to the learner):
- {focus}

Response Rules:
- {output_rules}
- Keep turns short so speech works well.
- Never criticize; always encourage.
- If asked to switch topics or pace, happily adapt.

{objective_text}
""".strip()


# --------------------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------------------

class HistoryItem(BaseModel):
    sender: str  # "you" | "coach"
    text: str


class ChatPayload(BaseModel):
    user_text: str = ""
    include_seed: bool = False
    name: Optional[str] = None
    age: Optional[int] = None
    mode: str = "child"  # "child" | "teen"
    objective: Optional[str] = "assessment"
    history: List[HistoryItem] = []


# --------------------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------------------

@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


def _chat(model: str, messages: List[dict], temperature: Optional[float] = None, max_tokens: int = 320):
    kwargs = dict(model=model, messages=messages, max_tokens=max_tokens)
    if temperature is not None:
        kwargs["temperature"] = temperature
    return client.chat.completions.create(**kwargs)


def _try_models(messages: List[dict]):
    try:
        r = _chat(PRIMARY_MODEL, messages, temperature=None, max_tokens=320)
        return r, PRIMARY_MODEL
    except Exception:
        print("INFO:server.main:[router] primary failed; trying fallback")
        r = _chat(FALLBACK_MODEL, messages, temperature=0.8, max_tokens=320)
        return r, FALLBACK_MODEL


@app.post("/chat")
async def chat(payload: ChatPayload):
    name = payload.name or ""
    age = payload.age if payload.age is not None else None
    teen_mode = bool(payload.mode == "teen")

    system_prompt = build_system_prompt(
        name=name, age=age, teen_mode=teen_mode, objective=payload.objective or "assessment"
    )

    messages: List[dict] = [{"role": "system", "content": system_prompt}]

    for h in payload.history or []:
        role = "assistant" if h.sender == "coach" else "user"
        if h.text:
            messages.append({"role": role, "content": h.text})

    if payload.include_seed:
        seed = (
            "Hi there! I’m Miss Sunny. What’s your name and how old are you? "
            "We’ll do a fun quick check-up together."
        )
        messages.append({"role": "assistant", "content": seed})

    if (payload.user_text or "").strip():
        messages.append({"role": "user", "content": payload.user_text.strip()})

    r, used_model = _try_models(messages)
    reply = (r.choices[0].message.content or "").strip()
    return {"reply": reply, "model_used": used_model}


# ----- TTS ---------------------------------------------------------------------------

class TtsIn(BaseModel):
    text: str
    voice: Optional[str] = None
    format: Optional[str] = TTS_FORMAT_DEFAULT


def _tts_via_sdk(text: str, voice: str, fmt: str) -> Optional[bytes]:
    """
    Try different SDK signatures so we work across versions.
    Returns bytes or None if not available.
    """
    # Signature 1: format=
    try:
        res = client.audio.speech.create(
            model=TTS_MODEL,
            voice=voice,
            input=text,
            format=fmt,
        )
        audio_bytes = getattr(res, "content", None)
        if audio_bytes:
            return audio_bytes
    except Exception as e:
        print(f"INFO:server.main:TTS via SDK (format=) failed: {e!r}")

    # Signature 2: response_format=
    try:
        res = client.audio.speech.create(
            model=TTS_MODEL,
            voice=voice,
            input=text,
            response_format=fmt,
        )
        audio_bytes = getattr(res, "content", None)
        if audio_bytes:
            return audio_bytes
    except Exception as e:
        print(f"INFO:server.main:TTS via SDK (response_format=) failed: {e!r}")

    return None


def _tts_via_http(text: str, voice: str, fmt: str) -> Optional[bytes]:
    """
    Raw HTTP fallback to /v1/audio/speech.
    Tries both 'format' and 'response_format'.
    """
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    url = "https://api.openai.com/v1/audio/speech"

    # Attempt A: format
    try:
        payload = {"model": TTS_MODEL, "voice": voice, "input": text, "format": fmt}
        with httpx.Client(timeout=30) as s:
            r = s.post(url, headers=headers, json=payload)
            if r.status_code == 200 and r.content:
                return bytes(r.content)
            print(f"INFO:server.main:TTS HTTP(format) status={r.status_code} body={r.text[:200]!r}")
    except Exception as e:
        print(f"INFO:server.main:TTS HTTP(format) failed: {e!r}")

    # Attempt B: response_format
    try:
        payload = {"model": TTS_MODEL, "voice": voice, "input": text, "response_format": fmt}
        with httpx.Client(timeout=30) as s:
            r = s.post(url, headers=headers, json=payload)
            if r.status_code == 200 and r.content:
                return bytes(r.content)
            print(f"INFO:server.main:TTS HTTP(response_format) status={r.status_code} body={r.text[:200]!r}")
    except Exception as e:
        print(f"INFO:server.main:TTS HTTP(response_format) failed: {e!r}")

    return None


@app.post("/tts")
async def tts(data: TtsIn = Body(...)):
    """
    TTS endpoint — contract unchanged.
    Returns 400 on empty text and 502 on generation failure,
    so the frontend never tries to play a zero-byte blob.
    """
    text = (data.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text for TTS")

    voice = data.voice or TTS_VOICE_DEFAULT
    fmt = (data.format or TTS_FORMAT_DEFAULT).lower()

    # Try SDK first, then raw HTTP as fallback
    audio_bytes = _tts_via_sdk(text, voice, fmt)
    if audio_bytes is None:
        audio_bytes = _tts_via_http(text, voice, fmt)

    if not audio_bytes:
        print("ERROR:server.main:TTS failed after all strategies")
        raise HTTPException(status_code=502, detail="TTS generation failed")

    # mp3 / mpeg — the browser will play fine
    return Response(content=audio_bytes, media_type="audio/mpeg")
