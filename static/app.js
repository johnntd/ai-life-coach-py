// static/app.js
// ─────────────────────────────────────────────────────────────────────────────
// What’s new (keeping all IDs/handlers and prior behavior):
// • Deterministic intro (Hi → ask name → ask age → then assessment).
// • Faster listening via lightweight silence detection (VAD) for the fallback.
// • Auto-extract child name/age from spoken text and update the UI live.
// • Persist profile + a tiny rolling chat memory to localStorage.
// • Send client_id + profile on every /chat so server can remember across runs.
// ─────────────────────────────────────────────────────────────────────────────

const $        = (s)=>document.querySelector(s);
const logEl    = $("#log");
const statusEl = $("#status");
const modelEl  = $("#model");
const nameEl   = $("#name");
const ageEl    = $("#age");
const teenEl   = $("#teen");
const langEl   = $("#lang");
const startBtn = $("#start");
const stopBtn  = $("#stop");
const sendBtn  = $("#send");
const textEl   = $("#text");
const audioEl  = $("#ttsAudio");
const avatarEl = $("#avatar");

// ── Client identity & local memory ───────────────────────────────────────────
function getClientId(){
  let id = localStorage.getItem("coach_client_id");
  if (!id){
    id = crypto.randomUUID();
    localStorage.setItem("coach_client_id", id);
  }
  return id;
}
const CLIENT_ID = getClientId();

function loadProfile(){
  try{
    const p = JSON.parse(localStorage.getItem("coach_profile")||"{}");
    return { name:p.name||"", age: Number(p.age||0) || undefined, notes: p.notes||"" };
  }catch(_){ return { name:"", age:undefined, notes:"" }; }
}
function saveProfile(p){
  localStorage.setItem("coach_profile", JSON.stringify(p||{}));
}
let profile = loadProfile();

// Warm the UI from saved profile (keeps existing form elements/IDs)
if (nameEl && profile.name) nameEl.value = profile.name;
if (ageEl && profile.age)  ageEl.value  = String(profile.age);

// ── Chat state ───────────────────────────────────────────────────────────────
let running = false;
let cooldown = false;
let history = [];                 // {sender:"you"|"coach", text}
let lastCoach = "";
let currentLang = "en-US";

// Mic paths
let recognizer = null;            // Web Speech API (preferred)
let mediaStream = null;           // Fallback
let recorder = null;
let parts = [];                   // MediaRecorder chunks
let sttActive = false;            // are we waiting for STT?
let vadTimer = null;              // VAD poller
let audioCtx = null;
let analyser = null;
let dataArray = null;
let speechActive = false;
let silenceMs = 0;
let talkMs = 0;

const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// ── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(s){ statusEl && (statusEl.textContent = s); }
function setTalking(on){ avatarEl && avatarEl.classList.toggle("talking", !!on); }
function escapeHtml(s){ return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function addBubble(sender, text){
  const div = document.createElement("div");
  div.className = `bubble ${sender==="you"?"you":"coach"}`;
  div.innerHTML = `<b>${sender==="you"?"You":"Miss Sunny"}:</b> ${escapeHtml(text||"")}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Entity extraction (name/age) — simple, fast heuristics on-device ─────────
const WORD2NUM = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19
};
function maybeExtractAge(text){
  if (!text) return undefined;
  // 1) digits
  const d = text.match(/\b(\d{1,2})\b/);
  if (d){
    const n = Number(d[1]);
    if (n>=3 && n<=18) return n;
  }
  // 2) word number like "five" or "I'm five"
  const w = text.toLowerCase().match(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/);
  if (w && WORD2NUM[w[1]]!=null){
    const n = WORD2NUM[w[1]];
    if (n>=3 && n<=18) return n;
  }
  return undefined;
}
function maybeExtractName(text){
  if (!text) return "";
  // Look for "my name is X" / "I'm X" / "I am X"
  const m1 = text.match(/\bmy name is\s+([A-Za-z][A-Za-z'-]{1,20})\b/i);
  if (m1) return m1[1];
  const m2 = text.match(/\b(i[' ]?m|i am)\s+([A-Za-z][A-Za-z'-]{1,20})\b/i);
  if (m2) return m2[2];
  return "";
}
function maybeUpdateProfileFromUtterance(text){
  let changed = false;
  if (!profile.name){
    const nm = maybeExtractName(text);
    if (nm){
      profile.name = nm;
      if (nameEl) nameEl.value = nm;
      changed = true;
    }
  }
  if (!profile.age){
    const ag = maybeExtractAge(text);
    if (ag){
      profile.age = ag;
      if (ageEl) ageEl.value = String(ag);
      changed = true;
    }
  }
  if (changed) saveProfile(profile);
}

// ── Backend ──────────────────────────────────────────────────────────────────
async function fetchJSON(url, body){
  const res = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(body||{})
  });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}
async function callChat({user_text="", include_seed=false}){
  // Sync UI form → profile before sending
  if (nameEl && nameEl.value) profile.name = nameEl.value.trim();
  if (ageEl && ageEl.value)  profile.age  = Number(ageEl.value) || undefined;
  saveProfile(profile);

  const payload = {
    user_text,
    include_seed,
    name: nameEl?.value || "Emily",            // legacy fields (server still supports)
    age: Number(ageEl?.value || 5),
    mode: teenEl?.checked ? "teen" : "child",
    objective: "assessment",
    history,
    lang: currentLang,
    client_id: CLIENT_ID,                      // NEW: tells server who we are
    profile                                   : profile,     // NEW: local memory snapshot
  };
  const data = await fetchJSON("/chat", payload);
  // Accept server-updated memory (e.g., if persisted earlier)
  if (data.profile){
    profile = { ...profile, ...data.profile };
    if (profile.name && nameEl) nameEl.value = profile.name;
    if (profile.age  && ageEl)  ageEl.value  = String(profile.age);
    saveProfile(profile);
  }
  return data;
}
async function speak(text){
  cooldown = true;
  setTalking(true);
  setStatus("Speaking…");
  try{
    const res = await fetch("/tts", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ text })
    });
    const blob = await res.blob();
    if (blob && blob.size){
      const url = URL.createObjectURL(blob);
      audioEl.src = url;
      try{ await audioEl.play(); }catch(_){ await sleep(120); try{ await audioEl.play(); }catch(__){} }
      await new Promise((resolve)=>{ audioEl.onended=resolve; audioEl.onerror=resolve; });
    }else{
      addBubble("coach","Sorry, my audio didn’t load—let’s keep chatting!");
    }
  }catch(_){
    addBubble("coach","Sorry, my audio didn’t load—let’s keep chatting!");
  }
  setTalking(false);
  setStatus("Listening…");
  await sleep(IS_IOS ? 1400 : 900); // echo guard
  cooldown = false;
}

// ── Web Speech API (preferred) ───────────────────────────────────────────────
function stopSR(){ try{ recognizer && recognizer.stop(); }catch(_){} recognizer=null; }
function startSR(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;
  recognizer = new SR();
  recognizer.lang = currentLang;
  recognizer.continuous = true;
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;

  recognizer.onresult = async (ev)=>{
    if (!running || cooldown) return;
    const last = ev.results?.[ev.results.length-1];
    if (!last || !last.isFinal) return;
    const txt = (last[0]?.transcript || "").trim();
    if (!txt) return;
    if (lastCoach && lastCoach.toLowerCase().includes(txt.toLowerCase())) return;

    // Update profile live if we hear name/age
    maybeUpdateProfileFromUtterance(txt);

    addBubble("you", txt);
    history.push({sender:"you", text:txt});
    const data = await callChat({user_text:txt, include_seed:false});
    modelEl && (modelEl.textContent = `Model: ${data.model_used || data.model || "?"}`);
    if (data.reply){
      addBubble("coach", data.reply);
      history.push({sender:"coach", text:data.reply});
      lastCoach = data.reply;
      await speak(data.reply);
    }
  };
  recognizer.onerror = (_)=>{};
  recognizer.onend = ()=>{ if (running && !cooldown) { try{ recognizer.start(); }catch(_){} } };
  try{ recognizer.start(); }catch(_){}
  return true;
}

// ── MediaRecorder + lightweight VAD fallback ────────────────────────────────
function stopVAD(){
  if (vadTimer){ cancelAnimationFrame(vadTimer); vadTimer=null; }
  if (audioCtx){ try{ audioCtx.close(); }catch(_){} audioCtx=null; }
  analyser = null; dataArray = null;
}
function stopRecorder(){
  try{ recorder && recorder.state==="recording" && recorder.stop(); }catch(_){}
  recorder = null;
  parts = [];
  sttActive = false;
  stopVAD();
}

async function ensureMic(){
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({audio:true});
    return true;
  }catch(_){ return false; }
}

async function sendUtterance(){
  if (!parts.length || sttActive || cooldown) return;
  sttActive = true;
  try{
    const blob = new Blob(parts, { type:"audio/webm" });
    parts = [];
    const res = await fetch("/stt", { method:"POST", headers:{ "Content-Type":"audio/webm" }, body: blob });
    const { text } = await res.json().catch(()=>({text:""}));
    const txt = (text||"").trim();
    if (!txt) return;
    if (lastCoach && lastCoach.toLowerCase().includes(txt.toLowerCase())) return;

    maybeUpdateProfileFromUtterance(txt);

    addBubble("you", txt);
    history.push({sender:"you", text:txt});
    const data = await callChat({user_text:txt, include_seed:false});
    modelEl && (modelEl.textContent = `Model: ${data.model_used || data.model || "?"}`);
    if (data.reply){
      addBubble("coach", data.reply);
      history.push({sender:"coach", text:data.reply});
      lastCoach = data.reply;
      await speak(data.reply);
    }
  }catch(_){}
  finally{ sttActive = false; }
}

function startVAD(){
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  dataArray = new Uint8Array(analyser.fftSize);
  speechActive = false;
  silenceMs = 0;
  talkMs = 0;

  const SILENCE_HOLD = 600; // ms of quiet to finalize (tune 400–700)
  const MAX_UTT = 7000;     // hard stop after 7s

  let lastTs = performance.now();
  const loop = (ts)=>{
    if (!running || cooldown || !analyser) return;
    const dt = ts - lastTs; lastTs = ts;

    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i=0;i<dataArray.length;i++){
      const v = (dataArray[i]-128)/128;
      sum += v*v;
    }
    const rms = Math.sqrt(sum / dataArray.length);

    const VOICE = rms > 0.025; // threshold (tune 0.02–0.035)
    if (VOICE){
      talkMs += dt; silenceMs = 0; speechActive = true;
    }else if (speechActive){
      silenceMs += dt;
    }

    if (speechActive && (silenceMs >= SILENCE_HOLD || talkMs >= MAX_UTT)){
      try{ recorder && recorder.requestData(); }catch(_){}
      setTimeout(()=>{ sendUtterance(); }, 60);
      speechActive = false; silenceMs = 0; talkMs = 0;
    }
    vadTimer = requestAnimationFrame(loop);
  };
  vadTimer = requestAnimationFrame(loop);
}

function startRecorder(){
  const MR = window.MediaRecorder;
  if (!MR) return false;
  recorder = new MR(mediaStream, { mimeType:"audio/webm" });

  recorder.ondataavailable = (ev)=>{
    if (ev.data && ev.data.size){ parts.push(ev.data); }
  };
  recorder.onerror = ()=>{};
  try{ recorder.start(); }catch(_){ return false; }

  startVAD();
  return true;
}

// ── Flow ────────────────────────────────────────────────────────────────────
async function startFlow(){
  if (running) return;
  running = true;
  startBtn && (startBtn.disabled = true);
  stopBtn  && (stopBtn.disabled  = false);
  currentLang = langEl?.value || "en-US";

  setStatus("Starting…");
  addBubble("you","(Starting)");

  try{
    const seed = await callChat({ include_seed:true });
    modelEl && (modelEl.textContent = `Model: ${seed.model_used || seed.model || "?"}`);
    if (seed.reply){
      addBubble("coach", seed.reply);
      history.push({sender:"coach", text:seed.reply});
      lastCoach = seed.reply;
      await speak(seed.reply);
    }
  }catch(_e){
    addBubble("coach","I had trouble starting. Try again?");
    stopFlow();
    return;
  }

  // Prefer Web Speech API (desktop/laptops)
  const srOK = startSR();
  if (!srOK){
    const ok = await ensureMic();
    if (!ok){
      addBubble("coach","Mic blocked. On iPhone open the HTTPS link (not the 192.168 address).");
      setStatus("Idle");
      return;
    }
    startRecorder();
  }
  setStatus("Listening… (say something)");
}

function stopFlow(){
  running = false;
  stopSR();
  stopRecorder();
  startBtn && (startBtn.disabled = false);
  stopBtn  && (stopBtn.disabled  = true);
  setStatus("Stopped");
}

// ── Send (text box) ─────────────────────────────────────────────────────────
sendBtn && sendBtn.addEventListener("click", async ()=>{
  const msg = (textEl?.value || "").trim();
  if (!msg) return;
  textEl.value = "";

  maybeUpdateProfileFromUtterance(msg);

  addBubble("you", msg);
  history.push({sender:"you", text:msg});
  const data = await callChat({user_text:msg, include_seed:false});
  modelEl && (modelEl.textContent = `Model: ${data.model_used || data.model || "?"}`);
  if (data.reply){
    addBubble("coach", data.reply);
    history.push({sender:"coach", text:data.reply});
    lastCoach = data.reply;
    await speak(data.reply);
  }
});
textEl && textEl.addEventListener("keydown",(e)=>{ if (e.key==="Enter") sendBtn.click(); });

// ── Start/Stop buttons ───────────────────────────────────────────────────────
startBtn && startBtn.addEventListener("click", startFlow);
stopBtn  && stopBtn.addEventListener("click", stopFlow);

// ── Init ────────────────────────────────────────────────────────────────────
setStatus("Idle");
