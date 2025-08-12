// static/app.js
// Miss Sunny – client app (kid/teen coach UI + fast SR + TTS handoff)
// BASELINE-PRESERVING: All IDs, handlers, and previously working logic are retained.

// ---------- Elements ----------
const $         = (s) => document.querySelector(s);
const logEl     = $("#log");
const statusEl  = $("#status");
const modelEl   = $("#model");
const nameEl    = $("#name");
const ageEl     = $("#age");
const teenEl    = $("#teen");
const langEl    = $("#lang");
const startBtn  = $("#start");
const stopBtn   = $("#stop");
const sendBtn   = $("#send");
const textEl    = $("#text");
const avatarEl  = $("#avatar");     // legacy CSS “talking” hook
const audioEl   = $("#ttsAudio");

// ---------- Config (kept from your baseline; only COOLDOWN_TTS tuned earlier) ----------
const CONFIG = {
  SILENCE_HOLD : 350,   // quiet ms to finalize (compat)
  MAX_UTT      : 5000,  // cap per utterance ms (compat)
  MIN_TALK     : 300,
  TIMESLICE    : 200,
  COOLDOWN_TTS : 650    // short guard so SR doesn't hear TTS tail
};

// ---------- State ----------
let listening = false;     // session running
let talking   = false;     // TTS speaking
let cooldown  = false;     // short guard after TTS
let history   = [];        // {sender: "you"|"coach", text}
let lastCoach = "";
let running   = false;     // mirrors listening

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function appendBubble(sender, text) {
  const div = document.createElement("div");
  div.className = `bubble ${sender === "you" ? "you" : "coach"}`;
  div.innerHTML = `<b>${sender === "you" ? "You" : "Miss Sunny"}:</b> ${escapeHtml(text)}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(s) { statusEl.textContent = s; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// ---------- Backend calls (unchanged contract) ----------
async function callChat({ user_text = "", include_seed = false }) {
  const payload = {
    user_text,
    include_seed,
    name: nameEl.value || "Emily",
    age: Number(ageEl.value || 5),
    mode: teenEl.checked ? "teen" : "child",
    objective: "gentle warm-up assessment",
    history, // keep thread for continuity + assessment plan
  };
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("chat failed");
  return res.json();
}

// ---------- TTS (unchanged API; adds safe SR restart) ----------
async function speak(text, { voice } = {}){
  cooldown = true;
  talking = true;
  avatarEl.classList.add("talking");
  setStatus("Speaking…");

  const res = await fetch("/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Server accepts { text, voice?, format:"mp3" }
    body: JSON.stringify({ text, voice: voice || undefined, format: "mp3" })
  });
  if (!res.ok){
    talking = false;
    avatarEl.classList.remove("talking");
    cooldown = false;
    setStatus("Listening…");
    appendBubble("coach", "Sorry, TTS failed.");
    ensureSRStart(180);
    return;
  }

  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  audioEl.src = url;

  // Try to play (twice) to survive autoplay hiccups
  try { await audioEl.play(); }
  catch { await sleep(100); try { await audioEl.play(); } catch {} }

  // Wait for audio to finish (or error)
  await new Promise((resolve)=>{ audioEl.onended = resolve; audioEl.onerror = resolve; });

  talking = false;
  avatarEl.classList.remove("talking");
  setStatus("Listening…");

  // Cooldown so SR doesn't catch the TTS tail
  await sleep(CONFIG.COOLDOWN_TTS);
  cooldown = false;

  // Immediately re-arm SR (smaller delay so second turn is snappy)
  ensureSRStart(20);
}

// ---------- Chat turn (unchanged UX) ----------
async function chatTurn(userText){
  try{
    setStatus("Thinking…");
    const data  = await callChat({ user_text: userText, include_seed: false });
    const reply = (data.reply || "").trim();
    modelEl.textContent = `Model: ${data.model_used || data.model || "?"}`;

    if (reply){
      appendBubble("coach", reply);
      history.push({ sender: "coach", text: reply });
      lastCoach = reply;
      await speak(reply, {});
    }else{
      appendBubble("coach", "Sorry, I didn’t get a reply.");
    }
    setStatus("Listening…");
  }catch(err){
    console.error(err);
    appendBubble("coach", "Network hiccup. Let's try again?");
    setStatus("Listening…");
    ensureSRStart(140);
  }
}

// ==================================================================
// ROBUST SpeechRecognition with debounced start + clean state machine
// ==================================================================
const SRCls = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer      = null;
let srRunning       = false;   // true after onstart
let srStarting      = false;   // between .start() and onstart
let srStartTimer    = null;    // debouncer
let srKeepAlive     = null;    // interval id
let srLastHeardAt   = 0;

// Safer echo-guard: only drop if the user text is long enough and
// mostly a substring of the coach line (prevents filtering short answers).
function looksLikeEcho(txt, coach){
  if (!txt || !coach) return false;
  const clean = (s)=> s.toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();
  const a = clean(txt);
  const b = clean(coach);
  if (a.length < 8) return false;               // let short answers pass
  if (!b.includes(a)) return false;
  const ratio = a.length / Math.max(1, b.length);
  return ratio >= 0.35; // consider it echo only if the match is a big chunk
}

// Debounced request to (re)start SR. Multiple calls collapse into one.
function ensureSRStart(delay = 100){
  if (!SRCls) return;              // Browser not supported
  if (!listening) return;          // only when session is on
  if (talking || cooldown) {
    if (!srStartTimer) srStartTimer = setTimeout(()=>{ srStartTimer=null; ensureSRStart(60); }, 120);
    return;
  }
  if (srRunning || srStarting) return;

  if (srStartTimer) return;
  srStartTimer = setTimeout(()=>{
    srStartTimer = null;
    realStartSR();
  }, Math.max(0, delay|0));
}

// Force a clean SR cycle after each final result. This avoids Chrome’s
// “stuck continuous” issue after the first turn.
function cycleSRSoon(ms = 50){
  if (!recognizer) return;
  if (!listening) return;
  if (talking || cooldown) return;
  setTimeout(() => {
    try { recognizer.stop(); } catch {}
    // onend -> ensureSRStart()
  }, ms);
}

// The actual start logic (never call directly from outside; use ensureSRStart)
function realStartSR(){
  if (!SRCls || !listening) return;
  if (srRunning || srStarting) return;

  // Hard reset any stale recognizer (abort won't throw if already ended)
  try { recognizer && recognizer.abort(); } catch {}
  recognizer = new SRCls();

  recognizer.lang = (langEl?.value || "en-US");
  recognizer.continuous = true;             // keep continuous, but cycle after result
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;

  recognizer.onstart = () => {
    srStarting = false;
    srRunning  = true;
    srLastHeardAt = performance.now();
  };
  recognizer.onaudiostart = () => { srLastHeardAt = performance.now(); };
  recognizer.onaudioend   = () => { srLastHeardAt = performance.now(); };
  recognizer.onsoundstart = () => { srLastHeardAt = performance.now(); };
  recognizer.onspeechend  = () => { srLastHeardAt = performance.now(); };

  recognizer.onresult = async (ev) => {
    const last = ev.results?.[ev.results.length - 1];
    if (!last || !last.isFinal) return;

    const txt = (last[0]?.transcript || "").trim();
    if (!txt) { cycleSRSoon(40); return; }

    // Echo guard vs. our own last coach line (gentler)
    if (looksLikeEcho(txt, lastCoach)) {
      srLastHeardAt = performance.now();
      cycleSRSoon(40);
      return;
    }

    if (talking || cooldown) { cycleSRSoon(60); return; }

    srLastHeardAt = performance.now();
    appendBubble("you", txt);
    history.push({ sender: "you", text: txt });

    // IMPORTANT: kick a cycle so we don't get stuck waiting for a new segment
    cycleSRSoon(40);

    await chatTurn(txt);
  };

  recognizer.onerror = (e) => {
    const err = e?.error || "";
    srRunning  = false;
    srStarting = false;

    if (err === "not-allowed" || err === "service-not-allowed"){
      setStatus("Mic blocked — allow microphone in the browser.");
      return;
    }

    // 'no-speech' is common after silence; restart gently
    ensureSRStart(err === "no-speech" ? 200 : 300);
  };

  recognizer.onend = () => {
    srRunning = false;
    srStarting = false;
    if (!listening) return;
    ensureSRStart(120);
  };

  try {
    srStarting = true;
    recognizer.start();
  } catch {
    srStarting = false;
    ensureSRStart(250);
  }

  // Keep-alive: if quiet for >10s, nudge SR by aborting (onend will restart)
  clearInterval(srKeepAlive);
  srKeepAlive = setInterval(() => {
    if (!recognizer || !listening) return;
    if (talking || cooldown || !srRunning) return;
    const idle = performance.now() - srLastHeardAt;
    if (idle > 10000) {
      try { recognizer.abort(); } catch {}
      // onend -> ensureSRStart()
    }
  }, 3000);
}

function stopSR(){
  clearInterval(srKeepAlive);
  srKeepAlive = null;
  srRunning = false;
  srStarting = false;
  try { recognizer && recognizer.abort(); } catch {}
  recognizer = null;
}

// TTS lifecycle hooks -> coordinate with SR (don’t stack restarts)
audioEl.addEventListener("play", () => {
  // A definite TTS start – pause SR immediately
  stopSR();
});
audioEl.addEventListener("ended", () => {
  // After TTS tail guard, restart listening (debounced)
  ensureSRStart((CONFIG.COOLDOWN_TTS || 650) + 20);
});

// ---------- Start/Stop flow (preserved) ----------
async function startFlow(){
  if (listening) return;
  listening = true;
  running   = true;

  startBtn.disabled = true;
  stopBtn.disabled  = false;
  setStatus("Starting…");

  try{
    // Seed: greet + begin assessment (server logic unchanged)
    const seed = await callChat({ include_seed: true });
    const reply = (seed.reply || "").trim();
    modelEl.textContent = `Model: ${seed.model_used || seed.model || "?"}`;

    if (reply){
      appendBubble("coach", reply);
      history.push({ sender: "coach", text: reply });
      lastCoach = reply;
      await speak(reply, {});
    } else {
      appendBubble("coach", "I had trouble starting. Try again?");
    }

    setStatus("Listening…");
    // Begin recognition after the first TTS completes
    ensureSRStart(20);
  }catch(e){
    console.error(e);
    setStatus("Idle");
    appendBubble("coach", "I had trouble starting. Try again?");
    listening = false;
    running   = false;
    startBtn.disabled = false;
    stopBtn.disabled  = true;
  }
}

function stopFlow(){
  listening = false;
  running   = false;
  stopSR();
  startBtn.disabled = false;
  stopBtn.disabled  = true;
  setStatus("Idle");
}

// ---------- UI wiring (preserved) ----------
startBtn.addEventListener("click", () => { if (!running) startFlow(); });
stopBtn.addEventListener("click", stopFlow);

sendBtn.addEventListener("click", async () => {
  const msg = (textEl.value || "").trim();
  if (!msg) return;
  textEl.value = "";

  appendBubble("you", msg);
  history.push({ sender: "you", text: msg });
  await chatTurn(msg);
});

textEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

// Initial UI
setStatus("Idle");
