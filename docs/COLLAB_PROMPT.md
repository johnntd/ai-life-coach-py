# AI Life Coach — Collaboration Master Prompt (LOCKED)

You are my code collaborator on the “AI Life Coach” web app.

## NON-NEGOTIABLE RULES
- **Never remove or alter any working feature unless I explicitly say so.**
- **Preserve all existing IDs, event handlers, and logic.** Keep file paths unchanged.
- **Keep the layout EXACTLY as-is:** 3D avatar fills the top; chat panel docked at the bottom.
- **Do not restructure files/folders.** Keep:
  - `templates/index.html`
  - `static/app.js`
  - `server/main.py`
  - `/static/vendor/...`
- **Three.js:** Use ES Modules + import map only. Do NOT use UMD or remote CDNs.
  - `"three": "/static/vendor/three-r152.2/build/three.module.js"`
  - `"three/addons/": "/static/vendor/three-r152.2/examples/jsm/"`
- **No external CDNs** unless I say so. Use vendored files under `/static/vendor`.
- **Prompt/input bar stays at the bottom.** Do not move it.
- **If something’s ambiguous:** make the **smallest safe change** and annotate it clearly in comments.
- **When you change code, always return the FULL file(s),** with clear comments for every change.

## AUDIO + LIP-SYNC INVARIANTS (DO NOT BREAK)
- **TTS must start only after a user gesture** (button click) for iOS/Safari.
- **Exactly one `<audio id="ttsAudio">` element**; reuse it for all playback.
- **Wire lip-sync once** per page load:
  - Prefer `audioEl.captureStream()` → `AudioContext.createMediaStreamSource(stream)`.
  - Fallback (Safari/iOS): `AudioContext.createMediaElementSource(audioEl)`.
  - **Never create more than one `MediaElementSourceNode`** for the same element.
  - Analyse with an `AnalyserNode`; **do not** connect analysis graph to `destination`.
- **Do not recreate AudioContext** per utterance. Create once and reuse.
- **After TTS ends, resume listening quickly**; avoid long cooldowns or stuck states.
- **Mouth driver**:
  - Drive a head mesh morph target (`mouthOpen` preferred, fallback `jawOpen`).
  - If a jaw bone exists, add small `rotation.x` for realism (≤ ~0.20 rad).
  - Keep adaptive noise floor and smoothing (open faster than close).
- **Eye/Head micro-gaze** can run, but must be lightweight (no dropped frames).

## CAMERA/FRAMING
- Camera must frame **head/shoulders** (no legs). Adjust only numeric offsets (camera position/target/FOV); **do not** change layout or import map.

## LATENCY
- Keep existing `CONFIG` values unless I explicitly ask; explain any tuning and preserve behavior.
- Current known-good:
  ```js
  const CONFIG = {
    SILENCE_HOLD : 350,
    MAX_UTT      : 5000,
    MIN_TALK     : 300,
    TIMESLICE    : 200,
    COOLDOWN_TTS : 650
  };
