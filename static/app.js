// static/app.js
// Miss Sunny – client app (kid/teen coach UI + fast SR + TTS handoff)
// BASELINE-PRESERVING: All IDs, handlers, and previously working logic are retained.

// ✅ Firebase core
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

// ✅ Firebase Auth
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ✅ Firebase Firestore
import {
  getFirestore,
  doc,
  setDoc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ✅ Your Firebase project config
const firebaseConfig = {
  apiKey: "AIzaSyAJqZ04ON-lsX2_08ET6CMUAZzxvbHsUpc",
  authDomain: "ai-life-coach-694f9.firebaseapp.com",
  projectId: "ai-life-coach-694f9",
  storageBucket: "ai-life-coach-694f9.appspot.com",
  messagingSenderId: "328321656985",
  appId: "1:328321656985:web:041c0d8585741cdcbdb008",
  measurementId: "G-K75Q06YF6X"
};

// ✅ Initialize Firebase app, auth, and firestore
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Camera / Upload elements
const cameraBtn       = document.getElementById("cameraBtn");
const uploadBtn       = document.getElementById("uploadBtn");
const fileInput       = document.getElementById("fileInput");
const cameraModal     = document.getElementById("cameraModal");
const cameraVideo     = document.getElementById("cameraVideo");
const cameraCanvas    = document.getElementById("cameraCanvas");
const captureBtn      = document.getElementById("captureBtn");
const retakeBtn       = document.getElementById("retakeBtn");
const sendSnapshotBtn = document.getElementById("sendSnapshotBtn");
const closeCameraBtn  = document.getElementById("closeCamera");

// ---------- Elements ----------
const $           = (s) => document.querySelector(s);
const logEl       = $("#log");
const statusEl    = $("#status");
const modelEl     = $("#model");
const emailEl     = $("#email");
const passEl      = $("#password");
const signupExtra = $("#signupExtra");

const firstNameEl = $("#firstName");
const lastNameEl  = $("#lastName");
const ageEl       = $("#age");
const sexEl       = $("#sex");
// UPDATED: support either #language or #lang (whichever your HTML uses)
const langEl      = document.getElementById("language") || document.getElementById("lang"); // UPDATED

// UPDATED: robust selectors for both naming styles
const startBtn = document.getElementById("startBtn") || document.getElementById("start");
const stopBtn  = document.getElementById("stopBtn")  || document.getElementById("stop");
// UPDATED: support either ...Btn or plain ids
const loginBtn  = document.getElementById("loginBtn")  || document.getElementById("login");
const logoutBtn = document.getElementById("logoutBtn") || document.getElementById("logout");
const signupBtn = document.getElementById("signupBtn") || document.getElementById("signup");

const sendBtn     = $("#send");
const textEl      = $("#text");

const avatarEl     = $("#avatar");     // legacy CSS “talking” hook
const audioEl      = $("#ttsAudio");
const authStatusEl = document.getElementById("authStatus");

// ---------- Config (kept from your baseline; only COOLDOWN_TTS tuned earlier) ----------
// CHANGE: Replace with authoritative latency policy
const CONFIG = {
  SILENCE_HOLD : 350,   // CHANGE: was 500
  MAX_UTT      : 5000,
  MIN_TALK     : 300,
  TIMESLICE    : 200,   // CHANGE: was 80
  COOLDOWN_TTS : 650    // CHANGE: was 600
};

// ---------- State ----------
let currentUid      = null;
let listening = false;     // session running
let talking   = false;     // TTS speaking
let cooldown  = false;     // short guard after TTS
let history   = [];        // {sender: "you"|"coach", text}
let lastCoach = "";
let running   = false;     // mirrors listening
let currentLang = (langEl?.value || "en-US"); // initialize with dropdown/default

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// [ADD] Proactive follow-up (silence watchdog) — GLOBAL so all handlers can use it
let silenceTimer = null;
const SILENCE_MS = 7000; // 7s is kid-friendly; tweak as you like
function clearSilenceTimer() {
  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
}
async function startSilenceTimer() {
  clearSilenceTimer();
  silenceTimer = setTimeout(async () => {
    try {
      // Only nudge if we’re in-session and not currently speaking
      if (!listening || talking) return;

      // Use the same callChat() so profile/age/mode are consistent
      const data = await callChat({ user_text: "", include_seed: false, no_reply: true }); // [ADD no_reply]
      const reply = (data.reply ?? data.text ?? "").trim();
      if (reply) {
        appendBubble("coach", reply);
        history.push({ sender: "coach", text: reply });
        lastCoach = reply;
        await speakInChunks(reply); // CHANGE: use chunked speech
        ensureSRStart(40);   // restart listening after coach speaks
        startSilenceTimer(); // re-arm in case of continued silence
      }
    } catch (err) {
      console.warn("[silence] follow-up failed", err);
    }
  }, SILENCE_MS);
}

// ---------- Helpers ----------

// ADDED: quick utility to test computed visibility
function isVisible(el) {
  if (!el) return false;
  const s = window.getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// UPDATED: appendBubble now uses #messages if available, else falls back to #log
function appendBubble(sender, text) { // UPDATED
  const container = document.getElementById("messages") || logEl;
  const div = document.createElement("div");
  div.className = `bubble ${sender === "you" ? "you" : "coach"}`;
  div.innerHTML = `<b>${sender === "you" ? "You" : "Miss Sunny"}:</b> ${escapeHtml(text)}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function setStatus(s) { if (statusEl) statusEl.textContent = s; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// ---------- File/Camera helpers ----------
let camStream = null;

function openCameraModal() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Camera not supported in this browser.");
    return;
  }
  cameraModal.style.display = "flex";
  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
    .then(stream => {
      camStream = stream;
      cameraVideo.srcObject = stream;
      captureBtn.style.display = "inline-block";
      retakeBtn.style.display = "none";
      sendSnapshotBtn.style.display = "none";
    })
    .catch(err => {
      console.error(err);
      alert("Could not access camera.");
      cameraModal.style.display = "none";
    });
}

function closeCameraModal() {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  cameraVideo.srcObject = null;
  cameraModal.style.display = "none";
}

function captureFrame() {
  const w = cameraVideo.videoWidth;
  const h = cameraVideo.videoHeight;
  if (!w || !h) return;

  cameraCanvas.width  = w;
  cameraCanvas.height = h;
  const ctx = cameraCanvas.getContext("2d");
  ctx.drawImage(cameraVideo, 0, 0, w, h);

  // Show send/retake
  captureBtn.style.display = "none";
  retakeBtn.style.display = "inline-block";
  sendSnapshotBtn.style.display = "inline-block";
}

function dataURLToBlob(dataURL) {
  const [head, data] = dataURL.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i=0; i<bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Send any File/Blob to the server for analysis
async function sendFileToAnalyze(file, userPrompt = "Please help me with this.") {
  const form = new FormData();
  form.append("file", file);
  // pass profile basics
  const uid = auth.currentUser?.uid || "";
  const name = `${firstNameEl?.value || ""} ${lastNameEl?.value || ""}`.trim() || "Friend";
  const age  = Number(ageEl?.value || 18);
  const mode = age < 13 ? "child" : age < 18 ? "teen" : "adult";
  form.append("uid", uid);
  form.append("name", name);
  form.append("age", age);
  form.append("mode", mode);
  form.append("prompt", userPrompt);

  setStatus("Analyzing…");
  try {
    const res = await fetch("/analyze", { method: "POST", body: form });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const reply = (data.text || "I’ve received the file.").trim();
    appendBubble("coach", reply);
    history.push({ sender: "coach", text: reply });
    lastCoach = reply;
    await speakInChunks(reply); // CHANGE: chunked speech
    setStatus("Listening…");
    startSilenceTimer(); // [ADD] re-arm after coach speaks
  } catch (e) {
    console.error(e);
    appendBubble("coach", "I couldn't analyze that file right now.");
    setStatus("Ready");
  }
}

// ---------- Backend calls (unchanged contract) ----------
async function callChat({ user_text = "", include_seed = false, no_reply = false }) { // [MODIFY] accept no_reply
  const user = auth.currentUser;

  // Safely combine first and last name
  const name = `${firstNameEl?.value || ""} ${lastNameEl?.value || ""}`.trim() || "Emily";

  const age = Number(ageEl?.value || 5);
  const mode = age < 13 ? "child" : age < 18 ? "teen" : "adult";

  const payload = {
    user_text,
    include_seed,
    uid: user?.uid || null,
    name,
    age,
    mode,
    objective: "gentle warm-up assessment",
    history,
    no_reply, // [ADD]
  };

  const res = await fetch("/chat", {
    method: "POST", 
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error("chat failed");
  return res.json();
}

// ---------- TTS helpers ----------
function detectVietnamese(text) {
  return /[ạảãáàâấầẩẫậăắằẳẵặđêếềểễệôốồổỗộơớờởỡợưứừửữự]/i.test(text);
}

// CHANGE: Promise-based Web Speech fallback that follows currentLang and resolves on end
function speakWeb(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = (typeof currentLang === "string" && currentLang) ? currentLang : "en-US";
    const voices = window.speechSynthesis.getVoices?.() || [];
    const match = voices.find(v => v.lang === u.lang) || voices.find(v => v.lang?.startsWith(u.lang.split("-")[0]));
    if (match) u.voice = match;

    return new Promise((resolve) => {
      u.onend = resolve;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    });
  } catch (e) {
    console.error("Web Speech fallback failed:", e);
    return Promise.resolve();
  }
}

// CHANGE: Server TTS resolves only when audio playback finishes (so we can chain chunks)
async function speak(text) {
  const t = (text ?? "").trim();
  if (!t) {
    console.warn("speak(): empty text; skipping TTS");
    return;
  }

  try {
    const res = await fetch("/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: t,
        voice: "alloy",  // Always use OpenAI Alloy
        format: "mp3"
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`TTS HTTP ${res.status}${errText ? `: ${errText}` : ""}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    const audioNode = document.getElementById("ttsAudio");
    if (audioNode) {
      audioNode.src = url;
      await audioNode.play().catch(async (e) => {
        console.warn("Audio play failed; fallback to Web Speech:", e);
        URL.revokeObjectURL(url);
        await speakWeb(t);
      });
      await new Promise((resolve) => {
        audioNode.onended = () => { URL.revokeObjectURL(url); resolve(); };
      });
    } else {
      await new Promise(async (resolve) => {
        const a = new Audio(url);
        a.play().catch(async (e) => {
          console.warn("Temp Audio() play failed; fallback to Web Speech:", e);
          URL.revokeObjectURL(url);
          await speakWeb(t);
          resolve();
        });
        a.onended = () => { URL.revokeObjectURL(url); resolve(); };
      });
    }

  } catch (err) {
    console.warn("Server TTS failed; using Web Speech fallback:", err);
    await speakWeb(t);
  }
}

// CHANGE: Chunking helpers so no single utterance exceeds ~15s
function chunkTextForTTS(text, maxChars = 220) {
  const s = (text || "").trim();
  if (!s) return [];
  const sentences = s.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let buf = "";

  const push = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };

  for (const sent of sentences) {
    if ((buf + " " + sent).trim().length <= maxChars) {
      buf = (buf ? buf + " " : "") + sent;
    } else {
      if (buf) push();
      if (sent.length <= maxChars) {
        buf = sent;
      } else {
        for (let i = 0; i < sent.length; i += maxChars) {
          chunks.push(sent.slice(i, i + maxChars));
        }
        buf = "";
      }
    }
  }
  if (buf) push();
  return chunks;
}

// CHANGE: Speak chunks sequentially (never mix languages in one utterance)
async function speakInChunks(text) {
  const pieces = chunkTextForTTS(text);
  for (const piece of pieces) {
    await speak(piece);
  }
}

// ---------- Chat turn ----------
async function chatTurn(userText){
  try{
    setStatus("Thinking…");
    const data  = await callChat({ user_text: userText, include_seed: false });

    // NOTE: server returns { reply, model_used, lang? } in your baseline
    const reply = (data.reply ?? data.text ?? "").trim();
    modelEl.textContent = `Model: ${data.model_used || data.model || "?"}`;

    if (reply){
      appendBubble("coach", reply);
      history.push({ sender: "coach", text: reply });
      lastCoach = reply;
      await speakInChunks(reply); // CHANGE: chunked speech
      startSilenceTimer();        // [ADD] arm proactive follow-up after coach speaks
    } else {
      appendBubble("coach", "Sorry, I didn’t get a reply.");
    }
    setStatus("Listening…");
  } catch(err){
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
  recognizer.lang = currentLang;
  recognizer.continuous = true;             // keep continuous, but cycle after result
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 3;

  recognizer.onstart = () => {
    srStarting = false;
    srRunning  = true;
    srLastHeardAt = performance.now();
    setStatus("Listening…");
  };
  recognizer.onaudiostart = () => { srLastHeardAt = performance.now(); };
  recognizer.onaudioend   = () => { srLastHeardAt = performance.now(); };
  recognizer.onsoundstart = () => { srLastHeardAt = performance.now(); clearSilenceTimer(); }; // [ADD]
  recognizer.onspeechend  = () => { srLastHeardAt = performance.now(); };

  recognizer.onresult = async (ev) => {
    const last = ev.results?.[ev.results.length - 1];
    if (!last || !last.isFinal) return;

    clearSilenceTimer(); // [ADD] user spoke → stop proactive timer

    const txt = (last[0]?.transcript || "").trim();
    if (!txt) { cycleSRSoon(40); return; }

    // 🔁 Auto-switch to Vietnamese if detected
    if (detectVietnamese(txt) && currentLang !== "vi-VN") {
      currentLang = "vi-VN";
      try { recognizer.abort(); } catch {}
    } else if (!detectVietnamese(txt) && currentLang !== "en-US") {
      currentLang = "en-US";
      try { recognizer.abort(); } catch {}
    }

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

// end of realStartSR

function stopSR(){
  clearInterval(srKeepAlive);
  srKeepAlive = null;
  srRunning = false;
  srStarting = false;
  try { recognizer && recognizer.abort(); } catch {}
  recognizer = null;
  clearSilenceTimer(); // [ADD]
}

// TTS lifecycle hooks -> coordinate with SR (don’t stack restarts)
audioEl?.addEventListener("play", () => {
  // A definite TTS start – pause SR immediately
  stopSR();
});
audioEl?.addEventListener("ended", () => {
  // After TTS tail guard, restart listening (debounced)
  ensureSRStart((CONFIG.COOLDOWN_TTS || 650) + 20);
});

// ---------- Start/Stop flow ----------
async function startFlow(){
  if (listening) return;
  listening = true;
  running   = true;

  // UPDATED: null-safe toggles
  if (startBtn) startBtn.style.display = "none";
  if (stopBtn)  stopBtn.style.display  = "inline-block";
  setStatus("Starting…");

  try{
    // Seed: greet + begin assessment (server logic unchanged)
    const seed = await callChat({ include_seed: true });
    const reply = (seed.reply ?? seed.text ?? "").trim(); // UPDATED 08/14/25
    modelEl.textContent = `Model: ${seed.model_used || seed.model || "?"}`;

    if (reply){
      appendBubble("coach", reply);
      history.push({ sender: "coach", text: reply });
      lastCoach = reply;
      await speakInChunks(reply); // CHANGE: chunked speech
      startSilenceTimer();        // [ADD] arm proactive follow-up after first seed
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
    startBtn && (startBtn.disabled = false);
    stopBtn  && (stopBtn.disabled  = true);
  }
}

function stopFlow(){
  listening = false;
  running   = false;
  stopSR();
  // UPDATED: null-safe toggles
  if (startBtn) startBtn.style.display = "inline-block";
  if (stopBtn)  stopBtn.style.display  = "none";
  setStatus("Idle");
}

// Wire buttons
startBtn?.addEventListener("click", startFlow);
stopBtn?.addEventListener("click", stopFlow);

// Update UI when login state changes
onAuthStateChanged(auth, async (user) => {
  const authForm    = document.getElementById("authForm"); // may be null in your layout
  const signupFields= document.getElementById("signupFields");
  const loginFields = document.getElementById("login-form") || document.getElementById("loginFields");

  if (user) {
    const uid = user.uid;
    const profileRef = doc(db, "users", uid);
    const snap = await getDoc(profileRef);
    const profile = snap.exists() ? snap.data() : {};

    // Hide all auth inputs/sections
    emailEl && (emailEl.style.display = "none");
    passEl  && (passEl.style.display  = "none");
    loginFields  && (loginFields.style.display  = "none");
    signupFields && (signupFields.style.display = "none");

    firstNameEl && (firstNameEl.style.display = "none");
    lastNameEl  && (lastNameEl.style.display  = "none");
    ageEl       && (ageEl.style.display       = "none");
    sexEl       && (sexEl.style.display       = "none");
    langEl      && (langEl.style.display      = "none");

    // Show main controls
    loginBtn   && (loginBtn.style.display   = "none");
    signupBtn  && (signupBtn.style.display  = "none");
    logoutBtn  && (logoutBtn.style.display  = "inline-block");
    startBtn   && (startBtn.style.display   = "inline-block");
    signupExtra&& (signupExtra.style.display= "none");
    authForm   && (authForm.style.display   = "none");

    currentUid  = uid;
    currentLang = profile.lang || currentLang || "en-US";

    // Prefill (in memory) if needed
    firstNameEl && (firstNameEl.value = profile.firstName || "");
    lastNameEl  && (lastNameEl.value  = profile.lastName  || "");
    ageEl       && (ageEl.value       = profile.age       || "");
    sexEl       && (sexEl.value       = profile.sex       || "");
    if (langEl) langEl.value = profile.lang || langEl.value || "en-US";

    statusEl && (statusEl.textContent = "Ready");
    authStatusEl && (authStatusEl.textContent = `Signed in as ${profile.firstName || user.email}`);
  } else {
    // Signed out → show only Login / Sign Up buttons
    currentUid = null;

    // Hide fields until user chooses an action
    firstNameEl && (firstNameEl.style.display = "none");
    lastNameEl  && (lastNameEl.style.display  = "none");
    ageEl       && (ageEl.style.display       = "none");
    sexEl       && (sexEl.style.display       = "none");
    langEl      && (langEl.style.display      = "none");
    emailEl     && (emailEl.style.display     = "none");
    passEl      && (passEl.style.display      = "none");

    loginBtn   && (loginBtn.style.display   = "inline-block");
    signupBtn  && (signupBtn.style.display  = "inline-block");
    logoutBtn  && (logoutBtn.style.display  = "none");
    startBtn   && (startBtn.style.display   = "none");
    signupExtra&& (signupExtra.style.display= "none");

    setStatus("Logged out");
    authStatusEl && (authStatusEl.textContent = "Not signed in");
  }
});

// ✅ Safely run all DOM code only after the page is fully loaded
window.addEventListener("DOMContentLoaded", () => {

  // Camera button
  cameraBtn?.addEventListener("click", openCameraModal);
  closeCameraBtn?.addEventListener("click", closeCameraModal);

  captureBtn?.addEventListener("click", () => {
    captureFrame();
  });

  retakeBtn?.addEventListener("click", () => {
    // Re-enable live preview
    captureBtn.style.display = "inline-block";
    retakeBtn.style.display = "none";
    sendSnapshotBtn.style.display = "none";
  });

  sendSnapshotBtn?.addEventListener("click", async () => {
    // Convert canvas to Blob and send
    cameraCanvas.toBlob(async (blob) => {
      if (!blob) return;
      await sendFileToAnalyze(new File([blob], "snapshot.jpg", { type: "image/jpeg" }), "Explain this homework/photo.");
      closeCameraModal();
    }, "image/jpeg", 0.92);
  });

  // Upload button
  uploadBtn?.addEventListener("click", () => fileInput?.click());

  fileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await sendFileToAnalyze(file, "Please help me with this file.");
    fileInput.value = ""; // reset
  });

  // Buttons
  // UPDATED: same robust selection in the DOM-ready scope
  const loginBtn   = document.getElementById("loginBtn")  || document.getElementById("login");
  const logoutBtn  = document.getElementById("logoutBtn") || document.getElementById("logout");
  const signupBtn  = document.getElementById("signupBtn") || document.getElementById("signup");
  const startUiBtn = document.getElementById("startBtn")  || document.getElementById("start");

  // Containers
  const loginForm    = document.getElementById("login-form");    // <-- ADDED
  // Add submit listener for login form
  if (loginForm) {
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault(); // stop page reload
      console.log("Login form submitted");
      login(); // call your existing login() function
    });
  }
  const loginFields  = document.getElementById("loginFields");   // email + password + enter
  const signupFields = document.getElementById("signupFields");  // full signup area

  // Login inputs
  const emailEl = document.getElementById("email");
  const passEl  = document.getElementById("password");

  // Signup inputs
  const emailSignupEl = document.getElementById("emailSignup");
  const passSignupEl  = document.getElementById("passwordSignup");
  const firstNameEl   = document.getElementById("firstName");
  const lastNameEl    = document.getElementById("lastName");
  const ageEl         = document.getElementById("age");
  const sexEl         = document.getElementById("sex");
  const langEl        = document.getElementById("lang") || document.getElementById("language"); // UPDATED

  // Status labels (optional)
  const authStatusEl = document.getElementById("authStatus");
  const statusEl     = document.getElementById("status");

  // Helpers
  const show       = (el, d = "flex") => el && (el.style.display = d);
  const showInline = (el) => el && (el.style.display = "inline-block");
  const hide       = (el) => el && (el.style.display = "none");
  const setText    = (el, t) => el && (el.textContent = t);

  function unhideLoginInputs() {
    const loginFields = document.getElementById("login-form") || document.getElementById("loginFields");
    const emailEl = document.getElementById("email");
    const passEl  = document.getElementById("password");
    if (loginFields) loginFields.style.display = "flex";
    showInline(emailEl);
    showInline(passEl);
    const signupFields = document.getElementById("signupFields");
    hide(signupFields);
  }

  function unhideSignupInputs() {
    const signupFields = document.getElementById("signupFields");
    const loginFields  = document.getElementById("login-form") || document.getElementById("loginFields");
    if (signupFields) signupFields.style.display = "flex";
    [firstNameEl, lastNameEl, ageEl, sexEl, langEl, emailSignupEl, passSignupEl].forEach(el => showInline(el));
    hide(loginFields);
  }

  function updateUIForSignedIn(user, profileName) {
    hide(loginFields);
    hide(signupFields);
    hide(emailEl);
    hide(passEl);
    [firstNameEl, lastNameEl, ageEl, sexEl, langEl, emailSignupEl, passSignupEl].forEach(hide);

    showInline(startUiBtn);
    showInline(logoutBtn);
    hide(loginBtn);
    hide(signupBtn);

    setText(statusEl, "Ready");
    setText(authStatusEl, `Signed in as ${profileName || user?.email || "your account"}`);
  }

  function updateUIForSignedOut() {
    // Default: hide all inputs; user must click Login/Sign Up to reveal
    hide(loginFields);
    hide(signupFields);
    hide(emailEl);
    hide(passEl);
    [firstNameEl, lastNameEl, ageEl, sexEl, langEl, emailSignupEl, passSignupEl].forEach(hide);

    hide(startUiBtn);
    hide(logoutBtn);
    showInline(loginBtn);
    showInline(signupBtn);

    setText(statusEl, "Logged out");
    setText(authStatusEl, "Not signed in");
  }

  // 🔐 Login button
  // UPDATED: Login button now submits if fields are visible and filled
  loginBtn?.addEventListener("click", async (e) => {
    e.preventDefault(); // UPDATED: stop form submit / page reload

    const loginFields  = document.getElementById("login-form") || document.getElementById("loginFields");
    const signupFields = document.getElementById("signupFields");
    const emailEl = document.getElementById("email");
    const passEl  = document.getElementById("password");

    // Already signed in → just surface Start/Logout
    if (auth.currentUser) {
      updateUIForSignedIn(auth.currentUser);
      return;
    }

    // If login form not visible yet → show it (and hide signup)
    if (!isVisible(loginFields)) {
      loginFields && (loginFields.style.display = "flex");
      signupFields && (signupFields.style.display = "none");
      authStatusEl && (authStatusEl.textContent = "Please sign in");
      showInline(emailEl);                     // <-- ADD THIS
      showInline(passEl);                      // <-- ADD THIS
      emailEl?.focus();
      return;
    }

    // Form is visible → if both fields filled, submit; else focus missing one
    const email = emailEl?.value?.trim();
    const pass  = passEl?.value?.trim();

    if (!email) { emailEl?.focus(); return; }
    if (!pass)  { passEl?.focus();  return; }

    try {
      await signInWithEmailAndPassword(auth, email, pass);
      // onAuthStateChanged will flip UI to Start/Logout
    } catch (e) {
      const code = e?.code || "";
      if (code === "auth/user-not-found") {
        alert("No account found for this email. Please sign up.");
        loginFields  && (loginFields.style.display  = "none");
        signupFields && (signupFields.style.display = "flex");
        authStatusEl && (authStatusEl.textContent   = "Create your account");
      } else if (code === "auth/wrong-password") {
        alert("Incorrect password. Please try again.");
        passEl?.focus();
      } else if (code === "auth/invalid-email") {
        alert("Please enter a valid email address.");
        emailEl?.focus();
      } else {
        alert("Login failed: " + e.message);
      }
    }
  });

  // 🆕 Signup button
  signupBtn?.addEventListener("click", () => {
    unhideSignupInputs();
    setText(authStatusEl, "Create your account");
  });

  // ✅ Handle Login
  document.getElementById("enterLogin")?.addEventListener("click", async () => {
    const email = emailEl?.value?.trim();
    const pass  = passEl?.value?.trim();
    if (!email || !pass) {
      alert("Please enter both email and password");
      // If inputs somehow hidden, re-show them now:
      unhideLoginInputs();
      return;
    }

    try {
      await signInWithEmailAndPassword(auth, email, pass);
      // onAuthStateChanged elsewhere will flip the UI to Start/Logout
    } catch (e) {
      const code = e?.code || "";
      if (code === "auth/user-not-found") {
        alert("No account found for this email. Please sign up.");
        unhideSignupInputs();
        setText(authStatusEl, "Create your account");
      } else if (code === "auth/wrong-password") {
        alert("Incorrect password. Please try again.");
        unhideLoginInputs();
      } else if (code === "auth/invalid-email") {
        alert("Please enter a valid email address.");
        unhideLoginInputs();
      } else {
        alert("Login failed: " + e.message);
        unhideLoginInputs();
      }
    }
  });

  // Login form submit → Firebase sign-in
  const _loginForm = document.getElementById("login-form");
  if (_loginForm) {
    _loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const email = document.getElementById("email")?.value?.trim();
      const pass  = document.getElementById("password")?.value?.trim();
      if (!email || !pass) {
        // make sure the fields are visible if the user tried to submit too early
        const lf = document.getElementById("login-form") || document.getElementById("loginFields");
        if (lf) lf.style.display = "flex";
        document.getElementById("email")?.focus();
        return;
      }

      try {
        await signInWithEmailAndPassword(auth, email, pass);
        // onAuthStateChanged will flip UI to Start + Logout
      } catch (e2) {
        const code = e2?.code || "";
        if (code === "auth/user-not-found") {
          alert("No account found for this email. Please sign up.");
          const lf = document.getElementById("login-form") || document.getElementById("loginFields");
          const sf = document.getElementById("signupFields");
          if (lf) lf.style.display = "none";
          if (sf) sf.style.display = "flex";
        } else if (code === "auth/wrong-password") {
          alert("Incorrect password. Please try again.");
          document.getElementById("password")?.focus();
        } else if (code === "auth/invalid-email") {
          alert("Please enter a valid email address.");
          document.getElementById("email")?.focus();
        } else {
          alert("Login failed: " + (e2?.message || e2));
        }
      }
    });
  }

  // ✅ Handle Signup
  document.getElementById("enterSignup")?.addEventListener("click", async () => {
    const email = emailSignupEl?.value?.trim();
    const pass  = passSignupEl?.value?.trim();
    const firstName = firstNameEl?.value?.trim();
    const lastName  = lastNameEl?.value?.trim();
    const age  = ageEl?.value?.trim();
    const sex  = sexEl?.value;
    const lang = langEl?.value;

    if (!email || !pass || !firstName || !age || !lang) {
      alert("Please fill out all required fields.");
      unhideSignupInputs();
      return;
    }

    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await setDoc(doc(db, "users", cred.user.uid), {
        firstName, lastName, age: parseInt(age, 10), sex, lang
      });
      alert("✅ Signup successful! Welcome to Miss Sunny.");
      // onAuthStateChanged will now show Start/Logout
    } catch (e) {
      alert("Signup failed: " + e.message);
      unhideSignupInputs();
    }
  });

  // 🚪 Logout
  logoutBtn?.addEventListener("click", async () => {
    try {
      await signOut(auth);
      updateUIForSignedOut();
    } catch (e) {
      alert("Logout failed: " + e.message);
    }
  });

  // First paint fallback (in case onAuthStateChanged hasn't fired yet)
  if (!auth.currentUser) {
    updateUIForSignedOut();
  }
});

// ---- IMPORTANT CLEANUP ----
// REMOVED: the duplicate “Start button wiring (initial greeting + voice loop) IIFE”
// It conflicted with the robust SR state machine and created a second recognizer.
// The functionality is now consolidated in startFlow/ensureSRStart above. // REMOVED

// Final initial status
setStatus("Idle");
