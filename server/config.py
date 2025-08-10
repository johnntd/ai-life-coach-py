# server/config.py
import os
from dotenv import load_dotenv

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# Model routing
PRIMARY_MODEL = os.getenv("PRIMARY_MODEL", "gpt-5")          # newest-first policy
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gpt-4o")

# TTS + STT defaults
TTS_MODEL = os.getenv("TTS_MODEL", "gpt-4o-mini-tts")
TTS_VOICE = os.getenv("TTS_VOICE", "alloy")
TRANSCRIBE_MODEL = os.getenv("TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")

# CORS
ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")
]
