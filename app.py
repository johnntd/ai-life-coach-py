import os
from flask import Flask, request, jsonify, render_template, send_file
from flask_cors import CORS
from io import BytesIO

import config
from services.openai_client import chat
from services.user_profile import get_or_create, update, append_history
from services.tts_service import text_to_speech_mp3

app = Flask(__name__)
CORS(app)

@app.route("/")
def index():
    return render_template("index.html",
                           default_name=config.DEFAULT_COACH_NAME,
                           default_lang=config.DEFAULT_LANG)

@app.route("/api/profile", methods=["POST"])
def profile():
    # { user_id, name, age, lang, mode }
    d = request.json or {}
    user = get_or_create(d.get("user_id","guest"),
                         name=d.get("name","Guest"),
                         age=d.get("age",5),
                         lang=d.get("lang","en"))
    if "mode" in d: user["mode"] = d["mode"]
    update(d.get("user_id","guest"), **user)
    return jsonify({"ok": True, "profile": user})

@app.route("/api/chat", methods=["POST"])
def api_chat():
    """
    Body: { user_id, text, name?, age?, lang?, mode?, objective? }
    Returns: { reply, model }
    """
    d = request.json or {}
    uid = d.get("user_id","guest")
    user = get_or_create(uid,
                         name=d.get("name","Guest"),
                         age=d.get("age",5),
                         lang=d.get("lang","en"))
    # allow overrides
    name = d.get("name", user["name"])
    age  = int(d.get("age", user["age"]))
    lang = d.get("lang", user["lang"])
    mode = d.get("mode", user.get("mode","child"))
    objective = d.get("objective", "gentle warm‑up")
    text_in = d.get("text","")

    # chat
    reply, model = chat(name=name, age=age, lang=lang, mode=mode,
                        objective=objective,
                        history=user.get("history", []),
                        user_text=text_in or "(start)")
    # update memory
    if text_in:
        append_history(uid, "user", text_in)
    append_history(uid, "assistant", reply)

    return jsonify({"reply": reply, "model": model})

@app.route("/api/tts", methods=["POST"])
def api_tts():
    """
    Body: { text, lang }
    Returns: audio/mp3 stream
    """
    d = request.json or {}
    text = d.get("text","")
    lang = d.get("lang", config.DEFAULT_LANG)
    if not text.strip():
        return jsonify({"error":"Missing text"}), 400
    audio = text_to_speech_mp3(text, lang=lang)
    return send_file(BytesIO(audio),
                     mimetype="audio/mpeg",
                     as_attachment=False,
                     download_name="voice.mp3")

if __name__ == "__main__":
    assert config.OPENAI_API_KEY != "REPLACE_ME", "Set OPENAI_API_KEY env var first."
    app.run(host="0.0.0.0", port=5000, debug=True)
