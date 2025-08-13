# server/main.py
# ------------------------------------------------------------------------------
# AI Life Coach backend (FastAPI)
# - Serves templates/index.html and /static assets
# - /chat: routes messages to OpenAI chat.completions with a system prompt
# - /tts : routes text to OpenAI TTS and streams back MP3
#
# Prompt externalization:
#   • Loads the coach system prompt from prompts/coach_system_prompt.md
#   • Hot-reloads when the file changes (mtime check). If missing, uses fallback.
#
# Fixes in this version:
#   1) Token parameter compatibility:
#      - Newer models like `gpt-5` reject `max_tokens` and may reject `temperature`.
#        We now:
#          • use `max_completion_tokens` for models starting with "gpt-5"
#          • omit `temperature` for "gpt-5" to avoid 400s
#          • keep previous behavior for other models (e.g., gpt-4o)
#   2) Robust TTS streaming:
#      - Wrap the `with_streaming_response` call inside an async generator so the
#        HTTP stream remains open until Starlette finishes sending audio bytes.
#        This prevents `httpx.StreamClosed`.
# ------------------------------------------------------------------------------

import os
import re
from typing import List, Optional, Literal

from fastapi import FastAPI, Request, Body
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from openai import AsyncOpenAI

# --------------------------- App & Templates ----------------------------------

app = FastAPI()
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

# --------------------------- OpenAI client ------------------------------------

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
if not OPENAI_API_KEY:
    print("[WARN] OPENAI_API_KEY is not set; /chat and /tts will fail until set.")
client = AsyncOpenAI(api_key=OPENAI_API_KEY)

# Keep your model routing as-is
PRIMARY_MODEL="gpt-5-2025-08-07"
FALLBACK_MODEL="gpt-4o"
TTS_MODEL="gpt-4o-mini-tts"
TTS_VOICE="alloy"
TRANSCRIBE_MODEL="gpt-4o-mini-transcribe"
ALLOWED_ORIGINS="*"
FALLBACK_MODEL = "gpt-4o"
TTS_VOICE_DEFAULT = os.getenv("TTS_VOICE", "alloy").strip() or "alloy"

# --------------------------- Data models (unchanged shapes) -------------------

class HistoryItem(BaseModel):
    sender: Literal["you", "coach"]
    text: str

class ChatReq(BaseModel):
    user_text: str = ""
    include_seed: bool = False
    name: Optional[str] = "Emily"
    age: Optional[int] = 5
    mode: Optional[Literal["teen", "child"]] = "child"
    objective: Optional[str] = "gentle warm-up"
    history: List[HistoryItem] = []

# --------------------------- Prompt Loading -----------------------------------

PROMPT_PATH = os.getenv("COACH_PROMPT_PATH", "prompts/coach_system_prompt.md")

_prompt_cache_text: Optional[str] = None
_prompt_cache_mtime: Optional[float] = None

_FALLBACK_PROMPT = """ROLE:
You are “Miss Sunny”, a conversational coach.

LANGUAGE POLICY:
• Detect the language of the user's latest message and reply entirely in that language.
• Support English and Vietnamese. Do NOT mix languages in a single reply.
• If the user switches languages, switch on the next turn.
• Keep replies concise and natural for the chosen language.

STYLE & CONSTRAINTS:
• Warm, friendly, age-appropriate tone. Ask one clear question at a time.
• Keep replies brief to reduce TTS delay (ideally ≤ 2 sentences).
• No stage directions or meta text. Do NOT output CUE_* or [[...]] tags.
• If age is missing, politely ask for name and age first (in the user’s language).
• For children: simple vocabulary, positive reinforcement.
• For adults: coaching questions, goal focus, compassionate and practical.

ASSESSMENT SCOPE:
• For kids/teens: reading, writing, math, logic, science, social skills, general knowledge.
• For adults: clarify goals, strengths, and areas to improve; suggest tailored exercises.
• After each small section, briefly reflect on how they did and what to try next.

OPENING:
• Start with a quick friendly greeting, ask for their name and age (in the user’s language).

CONTEXT HINTS:
• Learner name (if provided): {{name}}
• Age (if provided): {{age}} (interpreted as: {{age_desc}})
• Mode: {{mode}}
• Objective: {{objective}}

OUTPUT:
• One short turn only.
• No English–Vietnamese mixing in a single reply.
• No CUE_*, no [[...]] or stage directions.
"""

def _read_prompt_file() -> Optional[str]:
    try:
        with open(PROMPT_PATH, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None

def get_prompt_template() -> str:
    global _prompt_cache_text, _prompt_cache_mtime
    try:
        mtime = os.path.getmtime(PROMPT_PATH)
        if _prompt_cache_text is None or _prompt_cache_mtime != mtime:
            text = _read_prompt_file()
            if text:
                _prompt_cache_text = text
                _prompt_cache_mtime = mtime
                print(f"[prompt] loaded: {PROMPT_PATH} (mtime {mtime})")
            else:
                _prompt_cache_text = _FALLBACK_PROMPT
                _prompt_cache_mtime = None
                print(f"[prompt] missing, using built-in fallback.")
    except FileNotFoundError:
        if _prompt_cache_text is None:
            _prompt_cache_text = _FALLBACK_PROMPT
            _prompt_cache_mtime = None
            print(f"[prompt] not found, using built-in fallback.")
    except Exception as e:
        if _prompt_cache_text is None:
            _prompt_cache_text = _FALLBACK_PROMPT
            _prompt_cache_mtime = None
            print(f"[prompt] error reading file, using fallback: {e}")
    return _prompt_cache_text or _FALLBACK_PROMPT

def _age_desc(age: Optional[int]) -> str:
    if age is None:
        return "unknown"
    if age <= 12:
        return "child"
    if age <= 17:
        return "teen"
    return "adult"

def render_prompt(name: Optional[str], age: Optional[int], mode: Optional[str], objective: Optional[str]) -> str:
    tpl = get_prompt_template()
    name_s = name or "Unknown"
    mode_s = mode or "child"
    obj_s  = objective or ""
    age_s  = str(age) if age is not None else "Unknown"
    age_d  = _age_desc(age)
    return (
        tpl
        .replace("{{name}}", name_s)
        .replace("{{age}}", age_s)
        .replace("{{age_desc}}", age_d)
        .replace("{{mode}}", mode_s)
        .replace("{{objective}}", obj_s)
    )

# --------------------------- Message helpers ----------------------------------

def to_chat_messages(system_prompt: str, history: List[HistoryItem], user_text: str, include_seed: bool):
    msgs = [{"role": "system", "content": system_prompt}]
    for h in history:
        if not h.text:
            continue
        msgs.append({"role": "user" if h.sender == "you" else "assistant", "content": h.text})
    if include_seed:
        # assistant will greet first based on system prompt; no extra user msg
        pass
    else:
        msgs.append({"role": "user", "content": (user_text or "").strip()})
    return msgs

def clean_reply(text: str) -> str:
    if not text:
        return text
    text = re.sub(r"\[\[.*?\]\]", "", text)
    text = re.sub(r"\bCUE_[A-Z_]+\b", "", text)
    return text.strip()

# --------------------------- OpenAI calls -------------------------------------

def _needs_max_completion_tokens(model_name: str) -> bool:
    # Models that reject `max_tokens` in favor of `max_completion_tokens`.
    return model_name.lower().startswith("gpt-5")

def _omit_temperature(model_name: str) -> bool:
    # Some newer models accept only the default temperature.
    return model_name.lower().startswith("gpt-5")

async def _chat(model: str, messages: List[dict], temperature: Optional[float] = 0.8, max_tokens: Optional[int] = 320):
    kwargs = {"model": model, "messages": messages}

    # Temperature handling:
    if temperature is not None and not _omit_temperature(model):
        kwargs["temperature"] = temperature
    # Token parameter handling:
    if max_tokens is not None:
        if _needs_max_completion_tokens(model):
            kwargs["max_completion_tokens"] = max_tokens
        else:
            kwargs["max_tokens"] = max_tokens

    return await client.chat.completions.create(**kwargs)

async def _try_models(messages: List[dict]):
    try:
        print("INFO:server.main:[router] calling model=%s" % PRIMARY_MODEL)
        r = await _chat(PRIMARY_MODEL, messages, temperature=0.8, max_tokens=320)
        if not r or not r.choices or not r.choices[0].message or not r.choices[0].message.content:
            print("INFO:server.main:Primary failed: Empty reply from primary")
            raise RuntimeError("empty-primary")
        return r
    except Exception as e:
        print("INFO:server.main:[router] primary failed; trying fallback")
        print("INFO:httpx:", str(e)[:200])
        # Fallback uses classic params
        return await _chat(FALLBACK_MODEL, messages, temperature=0.8, max_tokens=320)

# --------------------------- Routes -------------------------------------------

@app.get("/")
async def root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.post("/chat")
async def chat(req: ChatReq):
    try:
        system_prompt = render_prompt(req.name, req.age, req.mode, req.objective)
        messages = to_chat_messages(system_prompt, req.history or [], req.user_text or "", req.include_seed)
        r = await _try_models(messages)
        reply = r.choices[0].message.content if (r and r.choices) else ""
        reply = clean_reply(reply)
        return JSONResponse({"reply": reply, "model_used": getattr(r, "model", None)})
    except Exception as e:
        print("ERROR:server.main:chat failed")
        import traceback; traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/tts")
async def tts_endpoint(req: Request):
    data = await req.json()
    text = data.get("text", "").strip()
    voice = data.get("voice") or TTS_VOICE_DEFAULT
    fmt   = data.get("format", "mp3")  # ✅ THIS FIXES YOUR BUG

    # Wrap the streaming response in an async generator so the HTTP stream stays open
    async def byte_iter():
        try:
            # Try primary signature
            async with client.audio.speech.with_streaming_response.create(
                model="gpt-4o-mini-tts",
                voice=voice,
                input=text,
                format=fmt,
            ) as r:
                async for chunk in r.iter_bytes():
                    yield chunk
            return
        except TypeError:
            # Fallback signature (older clients)
            async with client.audio.speech.with_streaming_response.create(
                model="gpt-4o-mini-tts",
                voice=voice,
                input=text,
                response_format=fmt,
            ) as r:
                async for chunk in r.iter_bytes():
                    yield chunk
            return

    headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    return StreamingResponse(byte_iter(), media_type="audio/mpeg", headers=headers)
@app.get("/healthz")
async def healthz():
    return {"ok": True}
