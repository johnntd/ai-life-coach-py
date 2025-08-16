# tools/guard.py
```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Repo guard: validates key invariants so we don't regress working behavior.

Checks:
- Layout & IDs exist in templates/index.html
- Import map points to local three-r152.2 (ESM); no UMD or remote CDNs for three
- Critical audio/lip-sync invariants in static/app.js
- CONFIG constants (known-good defaults) present
- No duplicate createMediaElementSource wiring
- Presence of morph target / lip-sync logic

Run manually:
  python tools/guard.py

(Optionally) install as a pre-commit hook:
  mkdir -p .git/hooks
  printf '#!/bin/sh\npython tools/guard.py || exit 1\n' > .git/hooks/pre-commit
  chmod +x .git/hooks/pre-commit
"""
from pathlib import Path
import re, sys, json

ROOT   = Path(__file__).resolve().parents[1]
INDEX  = ROOT / "templates" / "index.html"
APPJS  = ROOT / "static" / "app.js"
MAINPY = ROOT / "server" / "main.py"

errors = []
warns  = []

def must(cond, msg):
    if not cond:
        errors.append(msg)

def should(cond, msg):
    if not cond:
        warns.append(msg)

def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except Exception as e:
        errors.append(f"Cannot read {p}: {e}")
        return ""

# --- File existence ---
must(INDEX.exists(), f"{INDEX} missing")
must(APPJS.exists(), f"{APPJS} missing")
must(MAINPY.exists(), f"{MAINPY} missing")

index = read(INDEX)
appjs = read(APPJS)

# --- Layout / IDs ---
for frag in [
    'id="avatarCanvas"',
    'id="controlPanel"',
    'id="ttsAudio"',
    'id="log"',
    'id="status"',
    'id="model"',
    'id="name"',
    'id="age"',
    'id="teen"',
    'id="lang"',
    'id="start"',
    'id="stop"',
    'id="send"',
    'id="avatar"',
]:
    must(frag in index, f"templates/index.html missing required element: {frag}")

# --- Import map sanity (ESM three) ---
IM_THREE   = '/static/vendor/three-r152.2/build/three.module.js'
IM_ADDONS  = '/static/vendor/three-r152.2/examples/jsm/'
must(IM_THREE in index, "Import map must point 'three' to three-r152.2 module build")
must(IM_ADDONS in index, "Import map must point 'three/addons/' to examples/jsm/")

# Disallow UMD and remote CDNs for three
for bad in [
    "three.min.js",                       # UMD
    "https://unpkg.com/three",            # CDN
    "examples/js/loaders/GLTFLoader.js",  # old UMD examples
    "examples/js/controls/OrbitControls.js",
]:
    must(bad not in index, f"UMD/remote three usage not allowed: {bad}")

# --- Bottom dock: ensure control panel appears after avatar section in HTML order ---
avatar_pos = index.find('id="avatarCanvas"')
panel_pos  = index.find('id="controlPanel"')
must(0 <= avatar_pos < panel_pos, "Control panel must be below avatar (HTML order)")

# --- CONFIG constants (known-good) ---
cfg_pairs = {
    r"SILENCE_HOLD\s*:\s*350": "SILENCE_HOLD must be 350",
    r"MAX_UTT\s*:\s*5000":     "MAX_UTT must be 5000",
    r"MIN_TALK\s*:\s*300":     "MIN_TALK must be 300",
    r"TIMESLICE\s*:\s*200":    "TIMESLICE must be 200",
    r"COOLDOWN_TTS\s*:\s*650": "COOLDOWN_TTS must be 650",
}
for pat, msg in cfg_pairs.items():
    must(re.search(pat, appjs), f"static/app.js CONFIG check failed: {msg}")

# --- Lip-sync invariants in app.js ---
# Presence of captureStream OR createMediaElementSource (at least one path)
has_capture = "captureStream(" in appjs
has_elemsrc = "createMediaElementSource(" in appjs
must(has_capture or has_elemsrc, "Lip-sync path missing (need captureStream() or createMediaElementSource())")

# Not more than one createMediaElementSource call
elem_calls = len(re.findall(r"createMediaElementSource\s*\(", appjs))
must(elem_calls <= 1, "Multiple createMediaElementSource() calls detected (only one allowed)")

# Only one AudioContext creation
ctx_calls = len(re.findall(r"new\s+\(?window\.AudioContext|\bnew\s+AudioContext", appjs))
must(ctx_calls <= 1, "Multiple AudioContext creations detected (should be created once and reused)")

# Ensure we analyze with analyser and do not connect to destination in lip-sync graph
must("createAnalyser(" in appjs or ".createAnalyser(" in appjs, "AnalyserNode not found (lip-sync analysis expected)")
should("destination" not in appjs or "connect(analyser)" in appjs, "Check that analysis graph is not connected to destination")

# Morph target / mouthOpen driver present
must("morphTargetInfluences" in appjs, "Mouth morph driver missing (morphTargetInfluences)")
should("mouthOpen" in appjs or "jawOpen" in appjs, "Prefer mouthOpen (fallback jawOpen) not referenced")

# TTS cooldown kept modest
must(re.search(r"COOLDOWN_TTS\s*\?\?\s*650|COOLDOWN_TTS\s*[:=]\s*650", appjs) or "COOLDOWN_TTS : 650" in appjs,
    "TTS cooldown should remain ~650ms by default")

# --- Final verdict ---
if errors:
    print("\n❌ Guard failed with the following errors:")
    for e in errors:
        print("   -", e)
    if warns:
        print("\n⚠️  Warnings:")
        for w in warns:
            print("   -", w)
    sys.exit(1)

if warns:
    print("\n⚠️  Warnings:")
    for w in warns:
        print("   -", w)

print("✅ Guard passed.")
