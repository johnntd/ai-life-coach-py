// static/app.js
// Miss Sunny – client app (kid/teen coach UI + fast SR + TTS handoff)

// ==================== PATCH BLOCK: CONFIG (authoritative) ==================
const CONFIG = {
  SILENCE_HOLD : 350,
  MAX_UTT      : 5000,
  MIN_TALK     : 300,
  TIMESLICE    : 200,
  COOLDOWN_TTS : 650
};
// ==========================================================================

// ✅ Firebase core
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ✅ Your Firebase project config (unchanged)
const firebaseConfig = {
  apiKey: "AIzaSyAJqZ04ON-lsX2_08ET6CMUAZzxvbHsUpc",
  authDomain: "ai-life-coach-694f9.firebaseapp.com",
  projectId: "ai-life-coach-694f9",
  storageBucket: "ai-life-coach-694f9.firebasestorage.app",
  messagingSenderId: "328321656985",
  appId: "1:328321656985:web:041c0d8585741cdcbdb008",
  measurementId: "G-K75Q06YF6X"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------- Elements ----------
const $           = (s) => document.querySelector(s);
const logEl       = $("#log");
const statusEl    = $("#status");
const modelEl     = $("#model");
const emailEl     = $("#email");
const passEl      = $("#password");
const signupExtra = $("#signupExtra");

const firstNameInputTop = $("#firstName");          // CHANGE: clarify naming
const lastNameInputTop  = $("#lastName");
const ageInputTop       = $("#age");
const sexInputTop       = $("#sex");
const langEl            = document.getElementById("language") || document.getElementById("lang");

const startBtn = document.getElementById("startBtn") || document.getElementById("start");
const stopBtn  = document.getElementById("stopBtn")  || document.getElementById("stop"); // may be null
const loginBtn  = document.getElementById("loginBtn")  || document.getElementById("login");
const logoutBtn = document.getElementById("logoutBtn") || document.getElementById("logout");
const signupBtn = document.getElementById("signupBtn") || document.getElementById("signup");

const sendBtn = $("#send");
const textEl  = $("#text");

const avatarEl     = $("#avatar");
const audioEl      = $("#ttsAudio");
const authStatusEl = document.getElementById("authStatus");

// ---------- State ----------
let currentUid = null;
let listening  = false;
let talking    = false;
let cooldown   = false;
let history    = [];
let lastCoach  = "";
let running    = false;
let currentLang = (langEl?.value || "en-US");

// ==================== PATCH BLOCK: PROFILE CACHE ===========================
// CHANGE: remember server-side profile so Start uses the real name, not “Emily”
let profileCache = {
  firstName: "",
  lastName: "",
  age: null,
  sex: "",
  lang: null,
  get fullName() {
    const fn = (this.firstName || "").trim();
    const ln = (this.lastName || "").trim();
    return (fn || ln) ? `${fn} ${ln}`.trim() : "";
  }
};
// ==========================================================================

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

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

// [ADD] Proactive follow-up (silence watchdog)
let silenceTimer = null;
const SILENCE_MS = 7000;
function clearSilenceTimer() { if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; } }
async function startSilenceTimer() {
  clearSilenceTimer();
  silenceTimer = setTimeout(async () => {
    try {
      if (!listening || talking) return;
      const data = await callChat({ user_text: "", include_seed: false, no_reply: true });
      const reply = (data.reply ?? data.text ?? "").trim();
      if (reply) {
        appendBubble("coach", reply);
        history.push({ sender: "coach", text: reply });
        lastCoach = reply;
        await queueSpeakInChunks(reply);
        ensureSRStart(40);
        startSilenceTimer();
      }
    } catch (err) {
      console.warn("[silence] follow-up failed", err);
    }
  }, SILENCE_MS);
}

// ---------- Helpers ----------
function isVisible(el) {
  if (!el) return false;
  const s = window.getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
}
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function appendBubble(sender, text) {
  const container = document.getElementById("messages") || logEl;
  const div = document.createElement("div");
  div.className = `bubble ${sender === "you" ? "you" : "coach"}`;
  div.innerHTML = `<b>${sender === "you" ? "You" : "Miss Sunny"}:</b> ${escapeHtml(text)}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}
function setStatus(s) { if (statusEl) statusEl.textContent = s; }

// ---------- Backend calls ----------
async function callChat({ user_text = "", include_seed = false, no_reply = false }) {
  const user = auth.currentUser;

  // ==================== PATCH BLOCK: NAME SELECTION =======================
  // CHANGE: Prefer Firestore profile → inputs → displayName → email prefix
  let name =
    profileCache.fullName ||
    `${firstNameInputTop?.value || ""} ${lastNameInputTop?.value || ""}`.trim() ||
    (user?.displayName || "") ||
    (user?.email ? user.email.split("@")[0] : "") ||
    "Friend"; // never “Emily” unless typed by user
  // =======================================================================

  const age = Number(profileCache.age ?? ageInputTop?.value ?? 18);
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
    no_reply,
    lang: currentLang
  };

  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("chat failed");
  return res.json();
}

// ---------- Language detection ----------
function detectVietnamese(text) {
  if (/[ạảãáàâấầẩẫậăắằẳẵặđêếềểễệôốồổỗộơớờởỡợưứừửữự]/i.test(text)) return true;
  const t = (text || "").toLowerCase();
  return /\b(xin chao|cam on|vui long|khong|duoc|anh|chi|em|toi|ban|bai|hoc|gia su|bai tap)\b/.test(t);
}

// ==================== PATCH BLOCK: SINGLE-FLIGHT TTS QUEUE =================
let ttsQueue = Promise.resolve();

function chunkTextForTTS(text, maxChars = 220) {
  const s = (text || "").trim();
  if (!s) return [];
  const sentences = s.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let buf = "";
  const push = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ""; };
  for (const sent of sentences) {
    if ((buf + " " + sent).trim().length <= maxChars) buf = (buf ? buf + " " : "") + sent;
    else {
      if (buf) push();
      if (sent.length <= maxChars) buf = sent;
      else { for (let i=0;i<sent.length;i+=maxChars) chunks.push(sent.slice(i,i+maxChars)); buf=""; }
    }
  }
  if (buf) push();
  return chunks;
}

async function speakWeb(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = (typeof currentLang === "string" && currentLang) ? currentLang : "en-US";
    const voices = window.speechSynthesis.getVoices?.() || [];
    const match = voices.find(v => v.lang === u.lang) || voices.find(v => v.lang?.startsWith(u.lang.split("-")[0]));
    if (match) u.voice = match;
    talking = true;
    return await new Promise((resolve) => {
      u.onend = () => { talking = false; resolve(); };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    });
  } catch (e) {
    console.error("Web Speech fallback failed:", e);
    talking = false;
  }
}

async function speak(text) {
  const t = (text ?? "").trim();
  if (!t) return;

  try {
    const res = await fetch("/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: t, voice: "alloy", format: "mp3" })
    });
    if (!res.ok) throw new Error(await res.text().catch(()=> "TTS HTTP error"));

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audioNode = document.getElementById("ttsAudio");

    talking = true;
    cooldown = false;
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
  } finally {
    talking = false;
    cooldown = true;
    setTimeout(()=> { cooldown = false; }, CONFIG.COOLDOWN_TTS || 650);
  }
}

async function speakInChunks(text) {
  const pieces = chunkTextForTTS(text);
  for (const piece of pieces) { await speak(piece); }
}
async function queueSpeakInChunks(text) {
  ttsQueue = ttsQueue.then(() => speakInChunks(text)).catch(()=>{});
  return ttsQueue;
}
// ==========================================================================

// TTS lifecycle hooks -> coordinate with SR
audioEl?.addEventListener("play", () => { stopSR(); });
audioEl?.addEventListener("ended", () => { ensureSRStart((CONFIG.COOLDOWN_TTS || 650) + 20); });

// ---------- Chat turn ----------
async function chatTurn(userText){
  try{
    setStatus("Thinking…");
    const data  = await callChat({ user_text: userText, include_seed: false });

    const reply = (data.reply ?? data.text ?? "").trim();
    modelEl.textContent = `Model: ${data.model_used || data.model || "?"}`;

    if (reply){
      appendBubble("coach", reply);
      history.push({ sender: "coach", text: reply });
      lastCoach = reply;
      await queueSpeakInChunks(reply);
      startSilenceTimer();
    } else {
      appendBubble("coach", "Sorry, I didn’t get a reply.");
    }
    setStatus(`Listening… (${currentLang})`);
  } catch(err){
    console.error(err);
    appendBubble("coach", "Network hiccup. Let's try again?");
    setStatus(`Listening… (${currentLang})`);
    ensureSRStart(140);
  }
}

// ==================================================================
// SpeechRecognition state machine (kept; respects talking/cooldown)
// ==================================================================
const SRCls = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer      = null;
let srRunning       = false;
let srStarting      = false;
let srStartTimer    = null;
let srKeepAlive     = null;
let srLastHeardAt   = 0;

function looksLikeEcho(txt, coach){
  if (!txt || !coach) return false;
  const clean = (s)=> s.toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();
  const a = clean(txt);
  const b = clean(coach);
  if (a.length < 8) return false;
  if (!b.includes(a)) return false;
  const ratio = a.length / Math.max(1, b.length);
  return ratio >= 0.35;
}

function ensureSRStart(delay = 100){
  if (!SRCls) return;
  if (!listening) return;
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

function cycleSRSoon(ms = 50){
  if (!recognizer) return;
  if (!listening) return;
  if (talking || cooldown) return;
  setTimeout(() => {
    try { recognizer.stop(); } catch {}
  }, ms);
}

function realStartSR(){
  if (!SRCls || !listening) return;
  if (srRunning || srStarting) return;

  try { recognizer && recognizer.abort(); } catch {}
  recognizer = new SRCls();
  recognizer.lang = currentLang;
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 3;

  recognizer.onstart = () => {
    srStarting = false;
    srRunning  = true;
    srLastHeardAt = performance.now();
    setStatus(`Listening… (${currentLang})`);
  };
  recognizer.onaudiostart = () => { srLastHeardAt = performance.now(); };
  recognizer.onaudioend   = () => { srLastHeardAt = performance.now(); };
  recognizer.onsoundstart = () => { srLastHeardAt = performance.now(); clearSilenceTimer(); };
  recognizer.onspeechend  = () => { srLastHeardAt = performance.now(); };

  recognizer.onresult = async (ev) => {
    const last = ev.results?.[ev.results.length - 1];
    if (!last || !last.isFinal) return;

    clearSilenceTimer();

    const txt = (last[0]?.transcript || "").trim();
    if (!txt) { cycleSRSoon(40); return; }

    if (detectVietnamese(txt) && currentLang !== "vi-VN") {
      currentLang = "vi-VN";
      try { recognizer.abort(); } catch {}
      return;
    } else if (!detectVietnamese(txt) && currentLang !== "en-US") {
      if (!/[^\x00-\x7F]/.test(txt)) {
        currentLang = "en-US";
        try { recognizer.abort(); } catch {}
        return;
      }
    }

    if (looksLikeEcho(txt, lastCoach)) {
      srLastHeardAt = performance.now();
      cycleSRSoon(40);
      return;
    }
    if (talking || cooldown) { cycleSRSoon(60); return; }

    srLastHeardAt = performance.now();
    appendBubble("you", txt);
    history.push({ sender: "you", text: txt });

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

  clearInterval(srKeepAlive);
  srKeepAlive = setInterval(() => {
    if (!recognizer || !listening) return;
    if (talking || cooldown || !srRunning) return;
    const idle = performance.now() - srLastHeardAt;
    if (idle > 10000) {
      try { recognizer.abort(); } catch {}
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
  clearSilenceTimer();
}

// ==================== PATCH BLOCK: START/STOP SAFETY =======================
// CHANGE: If #stop is missing in HTML, morph the Start button into Stop
let morphedStopHandler = null;

async function startFlow(){
  if (listening) return;
  listening = true;
  running   = true;

  // Show Stop: prefer existing #stop; otherwise morph #start → “Stop”
  if (startBtn) startBtn.style.display = "none";
  if (stopBtn) {
    stopBtn.style.display = "inline-block";
  } else if (startBtn) {
    // Morph start into stop
    startBtn.style.display = "inline-block";
    startBtn.dataset.mode = "stop";
    const originalText = startBtn.textContent;
    startBtn.textContent = "Stop";
    startBtn.disabled = false;
    morphedStopHandler = () => { stopFlow(); };
    startBtn.addEventListener("click", morphedStopHandler, { once: true });
    // Restore text later inside stopFlow()
    startBtn.dataset.originalText = originalText || "Start";
  }

  setStatus("Starting…");

  try{
    const seed = await callChat({ include_seed: true });
    const reply = (seed.reply ?? seed.text ?? "").trim();
    modelEl.textContent = `Model: ${seed.model_used || seed.model || "?"}`;

    if (reply){
      appendBubble("coach", reply);
      history.push({ sender: "coach", text: reply });
      lastCoach = reply;
      await queueSpeakInChunks(reply);
      startSilenceTimer();
    } else {
      appendBubble("coach", "I had trouble starting. Try again?");
    }

    setStatus(`Listening… (${currentLang})`);
    ensureSRStart(20);
  }catch(e){
    console.error(e);
    setStatus("Idle");
    appendBubble("coach", "I had trouble starting. Try again?");
    listening = false;
    running   = false;
    // Restore buttons on failure
    if (stopBtn) stopBtn.style.display = "none";
    if (startBtn) {
      if (startBtn.dataset.mode === "stop") {
        startBtn.textContent = startBtn.dataset.originalText || "Start";
        startBtn.dataset.mode = "";
      }
      startBtn.style.display = "inline-block";
    }
  }
}

function stopFlow(){
  listening = false;
  running   = false;
  stopSR();
  if (stopBtn) stopBtn.style.display = "none";
  if (startBtn) {
    // If morphed, restore label and behavior
    if (startBtn.dataset.mode === "stop") {
      startBtn.textContent = startBtn.dataset.originalText || "Start";
      startBtn.dataset.mode = "";
    }
    startBtn.style.display = "inline-block";
  }
  setStatus("Idle");
}
// ==========================================================================

async function sendTypedMessage(){
  const txt = (textEl?.value || "").trim();
  if (!txt) return;

  if (detectVietnamese(txt) && currentLang !== "vi-VN") {
    currentLang = "vi-VN";
    try { recognizer?.abort?.(); } catch {}
  } else if (!detectVietnamese(txt) && currentLang !== "en-US") {
    if (!/[^\x00-\x7F]/.test(txt)) {
      currentLang = "en-US";
      try { recognizer?.abort?.(); } catch {}
    }
  }

  appendBubble("you", txt);
  history.push({ sender: "you", text: txt });
  textEl.value = "";
  sendBtn && (sendBtn.disabled = true);
  try { await chatTurn(txt); }
  finally { sendBtn && (sendBtn.disabled = false); textEl?.focus(); }
}

// Wire buttons
startBtn?.addEventListener("click", startFlow);
stopBtn?.addEventListener("click", stopFlow);

// ==================== PATCH BLOCK: AUTH → PROFILE CACHE ====================
// CHANGE: populate profileCache and make Start visible after sign-in
onAuthStateChanged(auth, async (user) => {
  const signupFields= document.getElementById("signupFields");
  const loginFields = document.getElementById("login-form") || document.getElementById("loginFields");

  if (user) {
    const uid = user.uid;
    const profileRef = doc(db, "users", uid);
    const snap = await getDoc(profileRef);
    const profile = snap.exists() ? snap.data() : {};

    // Cache for callChat()
    profileCache.firstName = profile.firstName || "";
    profileCache.lastName  = profile.lastName  || "";
    profileCache.age       = (typeof profile.age === "number") ? profile.age : (Number(ageInputTop?.value) || null);
    profileCache.sex       = profile.sex || "";
    profileCache.lang      = profile.lang || null;

    // Keep UI in sync (hidden inputs still carry values)
    firstNameInputTop && (firstNameInputTop.value = profileCache.firstName);
    lastNameInputTop  && (lastNameInputTop.value  = profileCache.lastName);
    ageInputTop       && (ageInputTop.value       = profileCache.age ?? "");
    sexInputTop       && (sexInputTop.value       = profileCache.sex);
    if (langEl) {
      currentLang = profileCache.lang || currentLang || "en-US";
      langEl.value = currentLang;
    }

    // Show Start, hide auth UI
    emailEl && (emailEl.style.display = "none");
    passEl  && (passEl.style.display  = "none");
    loginFields  && (loginFields.style.display  = "none");
    signupFields && (signupFields.style.display = "none");

    firstNameInputTop && (firstNameInputTop.style.display = "none");
    lastNameInputTop  && (lastNameInputTop.style.display  = "none");
    ageInputTop       && (ageInputTop.style.display       = "none");
    sexInputTop       && (sexInputTop.style.display       = "none");
    langEl            && (langEl.style.display            = "none");

    loginBtn   && (loginBtn.style.display   = "none");
    signupBtn  && (signupBtn.style.display  = "none");
    logoutBtn  && (logoutBtn.style.display  = "inline-block");

    // CHANGE: make sure Start actually appears even if inline style was "display:none"
    if (startBtn) {
      startBtn.style.removeProperty("display");
      startBtn.style.display = "inline-block";
    }

    currentUid = uid;
    statusEl && (statusEl.textContent = "Ready");
    authStatusEl && (authStatusEl.textContent = `Signed in as ${profileCache.firstName || user.email}`);
  } else {
    currentUid = null;

    // Hide Start/Stop; show Login/Signup
    if (startBtn) startBtn.style.display = "none";
    if (stopBtn)  stopBtn.style.display  = "none";

    loginBtn   && (loginBtn.style.display   = "inline-block");
    signupBtn  && (signupBtn.style.display  = "inline-block");
    logoutBtn  && (logoutBtn.style.display  = "none");

    setStatus("Logged out");
    authStatusEl && (authStatusEl.textContent = "Not signed in");
  }
});
// ==========================================================================

window.addEventListener("DOMContentLoaded", () => {
  // Camera / upload wiring (unchanged)
  cameraBtn?.addEventListener("click", () => {
    if (!navigator.mediaDevices?.getUserMedia) { alert("Camera not supported in this browser."); return; }
    cameraModal.style.display = "flex";
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(stream => { cameraVideo.srcObject = (window.camStream = stream); captureBtn.style.display = "inline-block"; retakeBtn.style.display = "none"; sendSnapshotBtn.style.display = "none"; })
      .catch(err => { console.error(err); alert("Could not access camera."); cameraModal.style.display = "none"; });
  });
  closeCameraBtn?.addEventListener("click", () => {
    if (window.camStream) { window.camStream.getTracks().forEach(t => t.stop()); window.camStream = null; }
    cameraVideo.srcObject = null; cameraModal.style.display = "none";
  });
  captureBtn?.addEventListener("click", () => {
    const w = cameraVideo.videoWidth, h = cameraVideo.videoHeight;
    if (!w || !h) return;
    cameraCanvas.width = w; cameraCanvas.height = h;
    cameraCanvas.getContext("2d").drawImage(cameraVideo, 0, 0, w, h);
    captureBtn.style.display = "none"; retakeBtn.style.display = "inline-block"; sendSnapshotBtn.style.display = "inline-block";
  });
  retakeBtn?.addEventListener("click", () => { captureBtn.style.display = "inline-block"; retakeBtn.style.display = "none"; sendSnapshotBtn.style.display = "none"; });
  sendSnapshotBtn?.addEventListener("click", async () => {
    cameraCanvas.toBlob(async (blob) => {
      if (!blob) return;
      await sendFileToAnalyze(new File([blob], "snapshot.jpg", { type: "image/jpeg" }), "Explain this homework/photo.");
      closeCameraBtn?.click();
    }, "image/jpeg", 0.92);
  });
  uploadBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await sendFileToAnalyze(file, "Please help me with this file.");
    fileInput.value = "";
  });

  // Send typed
  sendBtn?.addEventListener("click", (e) => { e.preventDefault(); sendTypedMessage(); });
  textEl?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendTypedMessage(); } });

  // Language dropdown live sync
  langEl?.addEventListener("change", () => {
    currentLang = langEl.value || "en-US";
    try { recognizer?.abort?.(); } catch {}
    setStatus(`Listening… (${currentLang})`);
  });

  // If auth hasn’t fired yet, keep Start hidden by default
  if (!auth.currentUser) {
    startBtn && (startBtn.style.display = "none");
    stopBtn  && (stopBtn.style.display  = "none");
  }
});

// Final initial status
setStatus("Idle");
