// static/app.js
// ─────────────────────────────────────────────────────────────────────────────
// Focus: lower latency listening while preserving all prior UI/logic.
// Key improvements:
//  • Calibrated VAD (ambient noise → dynamic threshold) for fast, reliable EOU.
//  • Shorter silence window (default 420ms) + max-utterance cutoff.
//  • MediaRecorder timeslice (200ms) → tiny chunks → quick STT.
//  • Web Speech API continuous with interim + watchdog restart.
//  • Better mic constraints (AEC/NS/AGC).
// Everything else remains: IDs, handlers, bubbles, memory, deterministic intro.
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

// ── Local identity/memory (unchanged behavior) ──────────────────────────────
function getClientId(){
  let id = localStorage.getItem("coach_client_id");
  if (!id){ id = crypto.randomUUID(); localStorage.setItem("coach_client_id", id); }
  return id;
}
const CLIENT_ID = getClientId();

function loadProfile(){
  try{ return JSON.parse(localStorage.getItem("coach_profile")||"{}"); }
  catch(_){ return {}; }
}
function saveProfile(p){ localStorage.setItem("coach_profile", JSON.stringify(p||{})); }

let profile = loadProfile();
if (nameEl && profile.name) nameEl.value = profile.name;
if (ageEl && profile.age)   ageEl.value  = String(profile.age);

// ── State ───────────────────────────────────────────────────────────────────
let running   = false;
let cooldown  = false;
let history   = [];               // {sender:"you"|"coach", text}
let lastCoach = "";
let currentLang = "en-US";

// Web Speech API
let recognizer     = null;
let srWatchdog     = null;

// Fallback recorder + VAD
let mediaStream    = null;
let recorder       = null;
let parts          = [];
let sttActive      = false;

let audioCtx       = null;
let analyser       = null;
let dataArray      = null;
let vadRAF         = null;
let calibrated     = false;
let noiseFloor     = 0.008;       // updated by calibration
let VOICE_TH       = 0.022;       // updated by calibration

let talkingMs      = 0;
let silenceMs      = 0;
let speechActive   = false;

const CONFIG = {
  SILENCE_HOLD : 350,   // ms quiet to finalize
  MAX_UTT      : 5000,  // ms max utterance
  MIN_TALK     : 300,   // ignore blips shorter than this
  TIMESLICE    : 200,   // MediaRecorder chunk ms
  COOLDOWN_TTS : 800,   // echo guard after TTS
};

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

// ── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(s){ if (statusEl) statusEl.textContent = s; }
function setTalking(on){ if (avatarEl) avatarEl.classList.toggle("talking", !!on); }
function escapeHtml(s){ return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function addBubble(sender, text){
  const div = document.createElement("div");
  div.className = `bubble ${sender==="you"?"you":"coach"}`;
  div.innerHTML = `<b>${sender==="you"?"You":"Miss Sunny"}:</b> ${escapeHtml(text||"")}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Simple name/age extraction (unchanged) ───────────────────────────────────
const WORD2NUM = {zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19};
function maybeExtractAge(text){
  if (!text) return undefined;
  const d = text.match(/\b(\d{1,2})\b/);
  if (d){ const n = Number(d[1]); if (n>=3 && n<=18) return n; }
  const w = text.toLowerCase().match(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/);
  if (w){ const n = WORD2NUM[w[1]]; if (n>=3 && n<=18) return n; }
  return undefined;
}
function maybeExtractName(text){
  if (!text) return "";
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
    if (nm){ profile.name = nm; if (nameEl) nameEl.value = nm; changed = true; }
  }
  if (!profile.age){
    const ag = maybeExtractAge(text);
    if (ag){ profile.age = ag; if (ageEl) ageEl.value = String(ag); changed = true; }
  }
  if (changed) saveProfile(profile);
}

// ── Backend calls (unchanged interface) ─────────────────────────────────────
async function fetchJSON(url, body){
  const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body||{}) });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}
async function callChat({user_text="", include_seed=false}){
  if (nameEl && nameEl.value) profile.name = nameEl.value.trim();
  if (ageEl && ageEl.value)   profile.age  = Number(ageEl.value) || undefined;
  saveProfile(profile);

  const payload = {
    user_text, include_seed,
    name: nameEl?.value || "Emily",
    age : Number(ageEl?.value || 5),
    mode: teenEl?.checked ? "teen" : "child",
    objective: "assessment",
    history,
    lang: currentLang,
    client_id: CLIENT_ID,
    profile
  };
  const data = await fetchJSON("/chat", payload);
  if (data.profile){
    profile = {...profile, ...data.profile};
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
    const res = await fetch("/tts",{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ text }) });
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
  await sleep(IS_IOS ? CONFIG.COOLDOWN_TTS+300 : CONFIG.COOLDOWN_TTS);
  cooldown = false;
}

// ── Web Speech API (preferred when available) ───────────────────────────────
function stopSR(){
  try{ recognizer && recognizer.stop(); }catch(_){}
  recognizer = null;
  if (srWatchdog){ clearTimeout(srWatchdog); srWatchdog=null; }
}
function startSR(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;

  recognizer = new SR();
  recognizer.lang = currentLang;
  recognizer.continuous = true;
  recognizer.interimResults = true;   // get early finals faster
  recognizer.maxAlternatives = 1;

  const restart = ()=>{ if (running && !cooldown){ try{ recognizer.start(); }catch(_){} } };
  const kickWatchdog = ()=>{
    if (srWatchdog) clearTimeout(srWatchdog);
    // If nothing heard for 20s, restart SR (Chrome sometimes stalls).
    srWatchdog = setTimeout(()=>{ try{ recognizer.stop(); }catch(_){ } }, 20000);
  };

  recognizer.onstart = kickWatchdog;
  recognizer.onresult = async (ev)=>{
    kickWatchdog();
    if (!running || cooldown) return;
    // Use last *final* result as soon as we get it.
    for (let i=ev.resultIndex; i<ev.results.length; i++){
      const r = ev.results[i];
      if (!r.isFinal) continue;
      const txt = (r[0]?.transcript || "").trim();
      if (!txt) continue;
      if (lastCoach && lastCoach.toLowerCase().includes(txt.toLowerCase())) continue;

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
    }
  };
  recognizer.onerror = (_)=>{};
  recognizer.onend = restart;

  try{ recognizer.start(); }catch(_){}
  return true;
}

// ── Fallback: MediaRecorder + calibrated VAD ────────────────────────────────
function stopVAD(){
  if (vadRAF){ cancelAnimationFrame(vadRAF); vadRAF=null; }
  if (audioCtx){ try{ audioCtx.close(); }catch(_){ } audioCtx=null; }
  analyser=null; dataArray=null; calibrated=false;
}
function stopRecorder(){
  try{ recorder && recorder.state==="recording" && recorder.stop(); }catch(_){}
  recorder=null; parts=[]; sttActive=false; stopVAD();
}
async function ensureMic(){
  try{
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000
      }
    });
    mediaStream = stream;
    return true;
  }catch(_){ return false; }
}

function rmsFrom(data){
  let sum=0;
  for (let i=0;i<data.length;i++){
    const v=(data[i]-128)/128;
    sum+=v*v;
  }
  return Math.sqrt(sum/data.length);
}

// Calibrate ambient noise for 600ms, set dynamic threshold
async function calibrateNoise(){
  calibrated=false;
  if (!mediaStream) return;
  audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  dataArray = new Uint8Array(analyser.fftSize);

  const t0 = performance.now();
  let maxR = 0;
  while (performance.now()-t0 < 600){
    analyser.getByteTimeDomainData(dataArray);
    const r = rmsFrom(dataArray);
    if (r>maxR) maxR=r;
    await sleep(16);
  }
  noiseFloor = Math.max(0.006, maxR);         // ambient ceiling
  VOICE_TH   = Math.max(0.018, noiseFloor*2.5);
  calibrated = true;
}

async function sendUtterance(){
  if (!parts.length || sttActive || cooldown) return;
  sttActive = true;
  try{
    const blob = new Blob(parts, { type:"audio/webm" });
    parts = [];
    if (!blob.size){ sttActive=false; return; }
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
  finally{ sttActive=false; }
}

function startVADLoop(){
  if (!analyser) return;
  talkingMs=0; silenceMs=0; speechActive=false;

  const step = (ts)=>{
    if (!running || cooldown || !analyser) return;
    analyser.getByteTimeDomainData(dataArray);
    const rms = rmsFrom(dataArray);
    const voice = rms > VOICE_TH;

    const now = performance.now();
    if (voice){
      // start of speech
      speechActive = true;
      talkingMs += 16;
      silenceMs = 0;
    }else if (speechActive){
      silenceMs += 16;
    }

    // Decide end-of-utterance quickly
    if (speechActive && (silenceMs >= CONFIG.SILENCE_HOLD || talkingMs >= CONFIG.MAX_UTT)){
      if (talkingMs >= CONFIG.MIN_TALK){
        try{ recorder && recorder.requestData(); }catch(_){}
        setTimeout(()=>sendUtterance(), 40);
      }
      speechActive=false; talkingMs=0; silenceMs=0;
    }
    vadRAF = requestAnimationFrame(step);
  };
  vadRAF = requestAnimationFrame(step);
}

function startRecorder(){
  const MR = window.MediaRecorder;
  if (!MR || !mediaStream) return false;

  recorder = new MR(mediaStream, { mimeType:"audio/webm;codecs=opus", audioBitsPerSecond: 128000 });
  recorder.ondataavailable = (ev)=>{ if (ev.data && ev.data.size) parts.push(ev.data); };
  recorder.onerror = ()=>{};
  try{ recorder.start(CONFIG.TIMESLICE); }catch(_){ return false; }

  startVADLoop();
  return true;
}

// ── Main flow ────────────────────────────────────────────────────────────────
async function startFlow(){
  if (running) return;
  running = true;
  if (startBtn) startBtn.disabled = true;
  if (stopBtn)  stopBtn.disabled  = false;

  currentLang = langEl?.value || "en-US";
  setStatus("Starting…");
  addBubble("you","(Starting)");

  try{
    const seed = await callChat({ include_seed:true });
    if (modelEl) modelEl.textContent = `Model: ${seed.model_used || seed.model || "?"}`;
    if (seed.reply){
      addBubble("coach", seed.reply);
      history.push({sender:"coach", text:seed.reply});
      lastCoach = seed.reply;
      await speak(seed.reply);
    }
  }catch(_){
    addBubble("coach","I had trouble starting. Try again?");
    stopFlow();
    return;
  }

  // Prefer Web Speech API first for lowest overhead
  const srOK = startSR();
  if (!srOK){
    const ok = await ensureMic();
    if (!ok){
      addBubble("coach","Mic blocked. On iPhone open the HTTPS link (not the 192.168 address).");
      setStatus("Idle");
      return;
    }
    // Calibrate room noise once and kick off VAD
    await calibrateNoise();
    startRecorder();
  }

  setStatus("Listening… (say something)");
}

function stopFlow(){
  running = false;
  stopSR();
  stopRecorder();
  if (startBtn) startBtn.disabled = false;
  if (stopBtn)  stopBtn.disabled  = true;
  setStatus("Stopped");
}

// ── Text send (unchanged) ───────────────────────────────────────────────────
sendBtn?.addEventListener("click", async ()=>{
  const msg = (textEl?.value || "").trim();
  if (!msg) return;
  textEl.value = "";

  maybeUpdateProfileFromUtterance(msg);

  addBubble("you", msg);
  history.push({sender:"you", text:msg});
  const data = await callChat({user_text:msg, include_seed:false});
  if (modelEl) modelEl.textContent = `Model: ${data.model_used || data.model || "?"}`;
  if (data.reply){
    addBubble("coach", data.reply);
    history.push({sender:"coach", text:data.reply});
    lastCoach = data.reply;
    await speak(data.reply);
  }
});
textEl?.addEventListener("keydown",(e)=>{ if (e.key==="Enter") sendBtn.click(); });

// ── Buttons ─────────────────────────────────────────────────────────────────
startBtn?.addEventListener("click", startFlow);
stopBtn ?.addEventListener("click", stopFlow);

// ── Init ────────────────────────────────────────────────────────────────────
setStatus("Idle");
