// static/app.js
// Keeps all IDs/handlers you already wired. Improves STT and enforces single-language chat.

const $       = (s) => document.querySelector(s);
const logEl   = $("#log");
const statusEl= $("#status");
const modelEl = $("#model");
const nameEl  = $("#name");
const ageEl   = $("#age");
const teenEl  = $("#teen");
const langEl  = $("#lang");
const startBtn= $("#start");
const stopBtn = $("#stop");
const sendBtn = $("#send");
const textEl  = $("#text");
const audioEl = $("#ttsAudio");
const avatar  = $("#avatar");

// ---- State ----
let running = false;
let cooldown = false;           // blocks mic while TTS is speaking
let history = [];               // {sender:"you"|"coach", text:string}
let lastCoach = "";
let currentLang = "en-US";

// STT choices
let mediaStream = null;         // for MediaRecorder fallback
let recorder = null;
let sttLoopOn = false;
let recognizer = null;          // Web Speech (preferred when available)

// small helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// ---- UI helpers ----
function setStatus(s){ statusEl && (statusEl.textContent = s); }
function setTalking(on){ avatar && avatar.classList.toggle("talking", !!on); }
function escapeHtml(s){ return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function addBubble(sender, text){
  const div = document.createElement("div");
  div.className = `bubble ${sender==="you"?"you":"coach"}`;
  div.innerHTML = `<b>${sender==="you"?"You":"Miss Sunny"}:</b> ${escapeHtml(text)}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- Backend ----
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
  const payload = {
    user_text,
    include_seed,
    name: nameEl?.value || "Emily",
    age: Number(ageEl?.value || 5),
    mode: teenEl?.checked ? "teen" : "child",
    objective: "gentle warm-up",
    history,
    lang: currentLang
  };
  const data = await fetchJSON("/chat", payload);
  return data;
}

async function speak(text){
  cooldown = true;
  setTalking(true);
  setStatus("Speaking…");

  let ok = false;
  try{
    const res = await fetch("/tts", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ text })
    });
    ok = res.ok;
    const blob = await res.blob();
    if (blob && blob.size > 0){
      const url = URL.createObjectURL(blob);
      audioEl.src = url;

      // On Safari/iOS, play() can reject—retry once
      try{ await audioEl.play(); }catch(_){ await sleep(150); try{ await audioEl.play(); }catch(__){} }

      await new Promise(resolve => { audioEl.onended = resolve; audioEl.onerror = resolve; });
    }
  }catch(e){
    // fallthrough to on-screen notice
  }

  if (!ok){
    addBubble("coach", "Sorry, my audio didn’t load—let’s keep chatting!");
  }
  setTalking(false);
  setStatus("Listening…");
  await sleep(IS_IOS ? 1600 : 1000); // echo guard
  cooldown = false;
}

// ---- STT: prefer Web Speech API, fallback to MediaRecorder->/stt ----
function stopSR(){ try{ recognizer && recognizer.stop(); }catch(_){} recognizer=null; }
function startSR(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;

  recognizer = new SR();
  recognizer.lang = currentLang;
  recognizer.continuous = true;        // keep listening
  recognizer.interimResults = false;

  recognizer.onresult = async (ev) => {
    if (!running || cooldown) return;
    const last = ev.results[ev.results.length-1];
    if (!last || !last.isFinal) return;
    const txt = (last[0]?.transcript || "").trim();
    if (!txt) return;

    // echo guard: ignore if it’s mostly the coach’s line
    if (lastCoach && lastCoach.toLowerCase().includes(txt.toLowerCase())) return;

    addBubble("you", txt);
    history.push({sender:"you", text: txt});

    const data = await callChat({user_text: txt, include_seed: false});
    modelEl && (modelEl.textContent = `Model: ${data.model_used || data.model || "?"}`);
    if (data.reply){
      addBubble("coach", data.reply);
      history.push({sender:"coach", text: data.reply});
      lastCoach = data.reply;
      await speak(data.reply);
    }
  };

  recognizer.onerror = (e)=> { /* keep silent, SR can be flaky */ };
  recognizer.onend = ()=> { if (running && !cooldown) { try{ recognizer.start(); }catch(_){ /* busy */ } } };
  try{ recognizer.start(); }catch(_){}
  return true;
}

// --- MediaRecorder fallback (desktop Chrome if SR unavailable) ---
let lastChunkTime = 0;
let carryText = ""; // simple aggregator for closely spaced chunks

function stopRecorder(){
  try{ recorder && recorder.state==="recording" && recorder.stop(); }catch(_){}
  recorder = null;
  sttLoopOn = false;
}
function pauseRecorder(){ stopRecorder(); }
function resumeRecorder(){
  if (!mediaStream || sttLoopOn || !running) return;
  const MR = window.MediaRecorder;
  if (!MR){ return; }

  sttLoopOn = true;
  recorder = new MR(mediaStream, { mimeType: "audio/webm" });

  recorder.ondataavailable = async (ev)=>{
    if (!running || cooldown) return;
    if (!ev.data || !ev.data.size) return;

    try{
      const res = await fetch("/stt", { method:"POST", headers:{ "Content-Type":"audio/webm" }, body: ev.data });
      if (!res.ok) return;
      const { text } = await res.json();
      const txt = (text||"").trim();
      if (!txt) return;

      // Combine chunks that arrive very close together to avoid truncation
      const now = Date.now();
      if (carryText && (now - lastChunkTime) < 900){
        carryText = `${carryText} ${txt}`.trim();
      }else{
        // flush previous
        if (carryText){
          addBubble("you", carryText);
          history.push({sender:"you", text: carryText});
          const data = await callChat({user_text: carryText, include_seed:false});
          modelEl && (modelEl.textContent = `Model: ${data.model_used || data.model || "?"}`);
          if (data.reply){
            addBubble("coach", data.reply);
            history.push({sender:"coach", text: data.reply});
            lastCoach = data.reply;
            await speak(data.reply);
          }
          carryText = "";
        }
        // start new
        carryText = txt;
      }
      lastChunkTime = now;
    }catch(_e){}
  };

  // Longer timeslice so we get full phrases, not 1-word nibbles
  recorder.start(2500);
}

async function ensureMic(){
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({audio:true});
    return true;
  }catch(_){
    return false;
  }
}

// ---- Flow ----
async function startFlow(){
  if (running) return;

  // UI setup
  running = true;
  startBtn && (startBtn.disabled = true);
  stopBtn  && (stopBtn.disabled  = false);
  currentLang = langEl?.value || "en-US";
  setStatus("Starting…");
  addBubble("you", "(Starting)");

  // Kick off with seed turn (coach speaks first)
  try{
    const seed = await callChat({ include_seed: true });
    modelEl && (modelEl.textContent = `Model: ${seed.model_used || seed.model || "?"}`);
    if (seed.reply){
      addBubble("coach", seed.reply);
      history.push({sender:"coach", text: seed.reply});
      lastCoach = seed.reply;
      await speak(seed.reply);
    }
  }catch(_e){
    addBubble("coach", "I had trouble starting. Try again?");
    stopFlow();
    return;
  }

  // Prefer browser SR (better whole-sentence capture). If not available, use server STT.
  let srOK = startSR();
  if (!srOK){
    const ok = await ensureMic();
    if (!ok){
      addBubble("coach", "Mic blocked. On iPhone you must open the HTTPS link (not your 192.168 address).");
      setStatus("Idle");
      return;
    }
    resumeRecorder();
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

// ---- Send button (text input) ----
sendBtn && sendBtn.addEventListener("click", async ()=>{
  const msg = (textEl?.value || "").trim();
  if (!msg) return;
  textEl.value = "";
  addBubble("you", msg);
  history.push({sender:"you", text: msg});
  const data = await callChat({user_text: msg, include_seed:false});
  modelEl && (modelEl.textContent = `Model: ${data.model_used || data.model || "?"}`);
  if (data.reply){
    addBubble("coach", data.reply);
    history.push({sender:"coach", text: data.reply});
    lastCoach = data.reply;
    await speak(data.reply);
  }
});
textEl && textEl.addEventListener("keydown", (e)=>{ if (e.key==="Enter") sendBtn.click(); });

// ---- Start/Stop ----
startBtn && startBtn.addEventListener("click", startFlow);
stopBtn  && stopBtn.addEventListener("click", stopFlow);

// ---- Initial status ----
setStatus("Idle");
