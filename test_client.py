#!/usr/bin/env python3
import argparse
import json
import sys
import requests

API = "http://127.0.0.1:8000/chat"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", action="store_true", help="send a seeded first turn (empty user_text)")
    ap.add_argument("--text", default="", help="user text to send (ignored if --seed)")
    ap.add_argument("--name", default="Emily")
    ap.add_argument("--age", type=int, default=5)
    ap.add_argument("--mode", default="child", choices=["child", "teen"])
    ap.add_argument("--objective", default="gentle morning warm-up")
    args = ap.parse_args()

    payload = {
        "user_text": "" if args.seed else args.text,
        "name": args.name,
        "age": args.age,
        "mode": args.mode,
        "objective": args.objective,
        "include_seed": bool(args.seed),
    }

    print("POST /chat with payload:")
    print(json.dumps(payload, indent=2))

    try:
        r = requests.post(API, json=payload, timeout=60)
    except Exception as e:
        print(f"❌ HTTP error: {e}")
        sys.exit(1)

    # Robust JSON handling
    data = None
    try:
        # Prefer server-declared JSON
        if r.headers.get("content-type", "").lower().startswith("application/json"):
            data = r.json()
        else:
            # Fallback: attempt to parse the text body
            data = json.loads(r.text.strip())
    except Exception:
        print("❌ Could not parse JSON:\n", r.text)
        sys.exit(1)

    # Pretty output
    reply = data.get("reply", "").strip()
    model_used = data.get("model_used") or data.get("model") or "<unknown>"
    meta = data.get("meta", {})

    print("\n=== Chat Response ===")
    print(f"Model: {model_used}")
    print(f"Reply: {reply if reply else '<empty>'}")

    if meta:
        try:
            print("\nMeta:", json.dumps(meta, indent=2))
        except Exception:
            print("\nMeta:", meta)

if __name__ == "__main__":
    main()
