import json, os
from pathlib import Path
import config

Path("data").mkdir(exist_ok=True)

def _load():
    if not os.path.exists(config.USER_DB_PATH):
        return {}
    with open(config.USER_DB_PATH, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except:
            return {}

def _save(db):
    with open(config.USER_DB_PATH, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

def get_or_create(user_id, name="Guest", age=5, lang="en"):
    db = _load()
    if user_id not in db:
        db[user_id] = {
            "name": name,
            "age": age,
            "lang": lang,
            "mode": "child",
            "history": []  # [{role:"user"/"assistant", content:"..."}]
        }
        _save(db)
    return db[user_id]

def update(user_id, **fields):
    db = _load()
    if user_id not in db: return
    db[user_id].update(fields)
    _save(db)

def append_history(user_id, role, content):
    db = _load()
    if user_id not in db: return
    hist = db[user_id].get("history", [])
    hist.append({"role": role, "content": content})
    # keep last 20
    db[user_id]["history"] = hist[-20:]
    _save(db)
