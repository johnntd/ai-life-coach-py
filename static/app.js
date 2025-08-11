// ---- Elements ----
const $ = (s) => document.querySelector(s);
const logEl = $("#log");
const statusEl = $("#status");
const modelEl = $("#model");
const nameEl = $("#name");
const ageEl = $("#age");
const teenEl = $("#teen");
const langEl = $("#lang");
const startBtn = $("#start");
const stopBtn = $("#stop");
const sendBtn = $("#send");
const textEl = $("#text");
const avatarEl = $("#avatar");
const audioEl = $("#ttsAudio");

// ---- State ----
let running = false;
let history = []; // {sender: "you"|"coach", text}
let lastCoach = "";
let cooldown = false;

// iOS Safari needs user gesture to start audio; we start TTS after first click.
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// ---- Helpers ----
function appendBubble(sender, text) {
  const div = document.createElement("div");
  div.className = `bubble ${sender === "you" ? "you" : "coach"}`;
  div.innerHTML = `<b>${sender === "you" ? "You" : "Miss Sunny"}:</b> ${escapeHtml(
    text
  )}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setStatus(s) {
  statusEl.textContent = s;
}

function setTalking(on) {
  avatarEl.classList.toggle("talking", !!on);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Speech Recognition (browser) ----
function makeRecognizer(lang) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = lang || "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  return rec;
}

async function listenOnce(lang, timeoutMs = 10000) {
  const rec = makeRecognizer(lang);
  if (!rec) throw new Error("SpeechRecognition not supported.");
  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => {
      if (!done) {
        done = true;
        try { rec.stop(); } catch {}
        reject(new Error("timeout"));
      }
    }, timeoutMs);

    rec.onresult = (e) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      const txt = e.results?.[0]?.[0]?.transcript || "";
      resolve(txt);
    };
    rec.onerror = (e) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      reject(e.error || e.message || "rec-error");
    };
    rec.onend = () => {
      // If ended without result and not done yet, let timeout fire.
    };
    rec.start();
  });
}

// ---- Backend calls ----
async function callChat({ user_text = "", include_seed = false }) {
  const payload = {
    user_text,
    include_seed,
    name: nameEl.value || "Emily",
    age: Number(ageEl.value || 5),
    mode: teenEl.checked ? "teen" : "child",
    objective: "gentle warm-up",
    history,
  };
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("chat failed");
  return res.json();
}

async function speak(text, { voice } = {}) {
  // Pause mic via "cooldown" so we don’t hear our own TTS.
  cooldown = true;
  setTalking(true);
  setStatus("Speaking…");

  const res = await fetch("/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice: voice || undefined,
      model: undefined,
      format: "mp3",
    }),
  });
  if (!res.ok) throw new Error("tts failed");

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  audioEl.src = url;

  await new Promise((resolve) => {
    audioEl.onended = resolve;
    audioEl.onerror = resolve;
    audioEl.play().catch(resolve);
  });

  setTalking(false);
  setStatus("Listening…");
  // Short cooldown so recognizer doesn’t pick tail of TTS
  await sleep(IS_IOS ? 1800 : 1200);
  cooldown = false;
}

// ---- Main loop ----
async function handsFree() {
  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  // Seed (coach speaks first)
  try {
    setStatus("Starting…");
    appendBubble("you", "(Starting)");
    const seed = await callChat({ include_seed: true });
    modelEl.textContent = `Model: ${seed.model_used || seed.model || "?"}`;
    if (seed.reply) {
      appendBubble("coach", seed.reply);
      history.push({ sender: "coach", text: seed.reply });
      lastCoach = seed.reply;
      await speak(seed.reply, {});
    }
  } catch (e) {
    appendBubble("coach", "I had trouble starting. Try again?");
    setStatus("Idle");
    running = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    return;
  }

  // Loop: listen → send → speak
  while (running) {
    try {
      if (cooldown) {
        await sleep(200);
        continue;
      }
      setStatus("Listening… (say something)");
      let transcript = "";
      try {
        transcript = await listenOnce(langEl.value || "en-US", 12000);
      } catch (e) {
        // timeout or no mic — allow the loop to continue
        if (!running) break;
        continue;
      }
      transcript = (transcript || "").trim();

      // Echo guard: if transcript is too similar to last coach line, skip.
      if (lastCoach && transcript && lastCoach.toLowerCase().includes(transcript.toLowerCase())) {
        // likely echo
        continue;
      }

      if (transcript) {
        appendBubble("you", transcript);
        history.push({ sender: "you", text: transcript });
      }

      const res = await callChat({ user_text: transcript, include_seed: false });
      modelEl.textContent = `Model: ${res.model_used || res.model || "?"}`;

      const reply = (res.reply || "").trim();
      if (!reply) continue;

      appendBubble("coach", reply);
      history.push({ sender: "coach", text: reply });
      lastCoach = reply;

      await speak(reply, {});
      // slight idle pause
      await sleep(100);
    } catch (e) {
      console.error(e);
      appendBubble("coach", "Hmm, I lost you for a second. Let's try again?");
      await sleep(800);
    }
  }

  setStatus("Stopped");
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

// ---- UI wiring ----
startBtn.addEventListener("click", async () => {
  if (running) return;
  handsFree();
});
stopBtn.addEventListener("click", () => {
  running = false;
});

sendBtn.addEventListener("click", async () => {
  const msg = textEl.value.trim();
  if (!msg) return;
  textEl.value = "";
  appendBubble("you", msg);
  history.push({ sender: "you", text: msg });

  try {
    const res = await callChat({ user_text: msg, include_seed: false });
    modelEl.textContent = `Model: ${res.model_used || res.model || "?"}`;
    const reply = (res.reply || "").trim();
    if (!reply) return;
    appendBubble("coach", reply);
    history.push({ sender: "coach", text: reply });
    lastCoach = reply;
    await speak(reply, {});
  } catch (e) {
    appendBubble("coach", "I couldn’t send that. Try again?");
  }
});

textEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

// Initial UI
setStatus("Idle");
