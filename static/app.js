// ---- State ---------------------------------------------------------------
let recognizing = false;
let recognition;
let isSpeaking = false;
let firstTurn = true;
let booted = false;

let userLang = "en-US";
let userAge = 5;
let sessionMode = "child"; // child | teen | adult
let userName = "Friend";

const history = []; // { sender: "you"|"coach", text: string }

// ---- Elements ------------------------------------------------------------
const gate = document.getElementById("gate");
const enableBtn = document.getElementById("enableBtn");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusChip = document.getElementById("status");
const modelChip = document.getElementById("modelChip");
const outputDiv = document.getElementById("output");
const audioEl = document.getElementById("ttsAudio");
const ageSel = document.getElementById("age");
const langSel = document.getElementById("lang");

// ---- Helpers -------------------------------------------------------------
function setStatus(text) {
  statusChip.textContent = text;
}
function addBubble(sender, text) {
  history.push({ sender, text });
  const el = document.createElement("div");
  el.className = `bubble ${sender === "you" ? "you" : "coach"}`;
  el.textContent = text;
  outputDiv.appendChild(el);
  outputDiv.scrollTop = outputDiv.scrollHeight;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Web Speech (STT) ----------------------------------------------------
async function initSTT() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert("SpeechRecognition not supported in this browser. Try Chrome.");
    return;
  }
  recognition = new SR();
  recognition.lang = userLang;
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onstart = () => {
    recognizing = true;
    setStatus("Listening…");
    startBtn.disabled = true; // already listening
    stopBtn.disabled = false;
  };
  recognition.onerror = (e) => {
    console.error("STT error:", e.error);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setStatus("Mic blocked. Allow mic in browser settings.");
    }
  };
  recognition.onend = () => {
    recognizing = false;
    if (!isSpeaking) setStatus("Idle");
    startBtn.disabled = false;
    stopBtn.disabled = true;
  };
  recognition.onresult = async (e) => {
    const res = e.results[e.results.length - 1];
    if (!res || res.isFinal !== true) return;
    const transcript = res[0]?.transcript?.trim();
    if (!transcript) return;
    addBubble("you", transcript);
    await handleUserText(transcript);
  };
}

function startListening() {
  try { recognition && recognition.start(); } catch {}
}
function stopListening() {
  try { recognition && recognition.stop(); } catch {}
}

// ---- Chat + TTS ----------------------------------------------------------
async function handleUserText(userText) {
  // Pause mic during model+tts cycle to avoid echo
  stopListening();
  setStatus("Thinking…");

  const payload = {
    user_text: userText || "",
    name: userName,
    age: userAge,
    mode: sessionMode,
    lang: userLang,
    include_seed: firstTurn,
    history
  };

  let data;
  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Chat failed");
  } catch (err) {
    console.error("Chat error:", err);
    setStatus("Chat error");
    // Resume listening so user can try again
    await sleep(300);
    startListening();
    return;
  }

  firstTurn = false;
  const coachText = data.reply || "";
  const modelUsed = data.model_used || "…";
  modelChip.textContent = `Model: ${modelUsed}`;
  addBubble("coach", coachText);

  await speak(coachText);

  // small tail to avoid self-capture on some devices
  await sleep(600);
  startListening();
}

async function speak(text) {
  if (!text) return;
  isSpeaking = true;
  setStatus("Speaking…");

  try {
    const res = await fetch("/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
      console.error("TTS failed:", await res.text());
      isSpeaking = false;
      setStatus("Idle");
      return;
    }
    const buf = await res.arrayBuffer();
    const blob = new Blob([buf], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);

    audioEl.src = url;

    // Attempt play; iOS needs resolved user gesture first (we gate with Enable button)
    try { await audioEl.play(); }
    catch (err) {
      console.warn("Audio play blocked, waiting for gesture:", err);
      setStatus("Tap Enable Audio");
      return;
    }

    await new Promise((resolve) => {
      audioEl.onended = resolve;
      audioEl.onerror = resolve;
    });
  } finally {
    isSpeaking = false;
    setStatus("Idle");
  }
}

// ---- Bootstrapping -------------------------------------------------------
async function unlockAudio() {
  // Create an AudioContext and resume to satisfy autoplay policies
  const AC = window.AudioContext || window.webkitAudioContext;
  try {
    const ctx = new AC();
    if (ctx.state === "suspended") await ctx.resume();
    // play a 1-frame silent buffer
    const node = ctx.createBufferSource();
    node.buffer = ctx.createBuffer(1, 1, 22050);
    node.connect(ctx.destination);
    node.start(0);
  } catch (e) {
    console.warn("AudioContext unlock failed", e);
  }
}

async function bootAndAutoStart() {
  if (booted) return;
  booted = true;

  // Read UI selections
  userLang = langSel.value || "en-US";
  userAge = parseInt(ageSel.value || "5", 10);
  sessionMode = userAge >= 12 ? "teen" : "child";

  await initSTT();

  // Miss Sunny greets first automatically
  addBubble("coach", "Hi friend! I’m Miss Sunny. How are you feeling—happy, okay, or not great?");
  await speak("Hi friend! I’m Miss Sunny. How are you feeling—happy, okay, or not great?");

  // seed turn with our backend so it knows to start the session context too
  await handleUserText(""); // include_seed will be true on first run
}

// ---- UI wiring -----------------------------------------------------------
enableBtn.addEventListener("click", async () => {
  enableBtn.disabled = true;
  setStatus("Starting…");
  try {
    await unlockAudio();
    gate.classList.add("hidden");
    // enable manual controls too
    startBtn.disabled = false;
    stopBtn.disabled = false;

    await bootAndAutoStart();
  } catch (e) {
    console.error(e);
    setStatus("Could not start. Refresh and try again.");
    enableBtn.disabled = false;
    gate.classList.remove("hidden");
  }
});

startBtn.addEventListener("click", () => {
  // manual resume listening if user wants
  startListening();
});
stopBtn.addEventListener("click", () => {
  stopListening();
  setStatus("Idle");
});

langSel.addEventListener("change", () => {
  userLang = langSel.value;
  if (recognition) recognition.lang = userLang;
});

ageSel.addEventListener("change", () => {
  userAge = parseInt(ageSel.value || "5", 10);
  sessionMode = userAge >= 12 ? "teen" : "child";
});

// Ready
document.addEventListener("DOMContentLoaded", () => {
  setStatus("Tap Enable & Start");
});
