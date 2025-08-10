import io
from openai import OpenAI
import config

client = OpenAI(api_key=config.OPENAI_API_KEY)

def text_to_speech_mp3(text, lang="en"):
    voice = config.TTS_VOICE_EN if lang.startswith("en") else config.TTS_VOICE_VI
    r = client.audio.speech.create(
        model=config.TTS_MODEL,
        voice=voice,
        input=text,
        format="mp3"
    )
    # r is a binary-compatible object in sdk 4.56
    blob = io.BytesIO(r.read())
    blob.seek(0)
    return blob.getvalue()
