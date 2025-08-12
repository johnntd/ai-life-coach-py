(() => {
  // Elements (preserved)
  const $ = (s) => document.querySelector(s);
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
  const avatarEl = $("#avatar");
  const audioEl  = $("#ttsAudio");

  // Sharper VAD knobs (requested)
  // - Shorter chunks, shorter silence, slightly stricter voice threshold,
  //   slower floor adaptation while quiet (prevents floor from rising during speech).
  const CONFIG = {
    SILENCE_HOLD : 260,   // ms quiet to finalize
    MAX_UTT      : 4500,  // cap per utterance
    MIN_TALK     : 240,   // ignore tiny blips
    TIMESLICE    : 120,   // recorder chunk size (was 200)
    COOLDOWN_TTS : 500    // smaller echo guard after TTS
  };

  let running   = false;
  let history   = [];
  let lastCoach = "";
  let cooldown  = false;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;

  // Recorder + VAD state
  let mediaStream = null;
  let recorder    = null;
  let chunks      = [];
  let vadTimer    = null;
  let ctx         = null;
  let analyser    = null;
  let speaking    = false;
  let speakingMs  = 0;
  let vadFloor    = 0.008;  // baseline rms
  const VAD_THRESH_MULT = 1.35; // speech if rms > floor * 1.35 (stricter)

  function setStatus(s){ statusEl.textContent = s; }
  function escapeHtml(s){ return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function appendBubble(sender, text) {
    const div = document.createElement("div");
    div.className = `bubble ${sender === "you" ? "you" : "coach"}`;
    div.innerHTML = `<b>${sender === "you" ? "You" : "Miss Sunny"}:</b> ${escapeHtml(text)}`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  // Backend calls (preserved shape)
  async function callChat({ user_text = "", include_seed = false, lang = "en-US" }) {
    const payload = {
      user_text,
      include_seed,
      name: nameEl.value || "Friend",
      age: Number(ageEl.value || 5),
      mode: teenEl.checked ? "teen" : "child",
      objective: "assessment warm-up",
      history,
      lang
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
    cooldown = true;
    avatarEl.classList.add("talking");
    setStatus("Speaking…");

    const res = await fetch("/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: voice || undefined, format: "mp3" }),
    });
    if (!res.ok){
      avatarEl.classList.remove("talking");
      cooldown = false;
      setStatus("Listening…");
      appendBubble("coach", "Sorry, TTS failed.");
      return;
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    audioEl.src = url;
    try { await audioEl.play(); } catch { await sleep(100); try{ await audioEl.play(); }catch{} }

    await new Promise((resolve)=>{ audioEl.onended = resolve; audioEl.onerror = resolve; });

    avatarEl.classList.remove("talking");
    setStatus("Listening…");
    await sleep(CONFIG.COOLDOWN_TTS);
    cooldown = false;
  }

  // Fast path: Web Speech
  function startSR(lang){
    if (!SR) return false;
    if (recognizer) return true;

    recognizer = new SR();
    recognizer.lang = lang || "en-US";
    recognizer.continuous = true;
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;

    recognizer.onresult = async (ev)=>{
      if (!running || cooldown) return;
      const last = ev.results[ev.results.length-1];
      if (!last || !last.isFinal) return;
      let txt = (last[0]?.transcript || "").trim();
      if (!txt) return;
      if (lastCoach && lastCoach.toLowerCase().includes(txt.toLowerCase())) return; // echo guard

      appendBubble("you", txt);
      history.push({ sender:"you", text:txt });
      setStatus("Thinking…");
      try{
        const data = await callChat({ user_text: txt, include_seed:false, lang });
        if (data.reply){
          const reply = data.reply.replace(/\[\[.*?\]\]/g,"").trim();
          modelEl.textContent = `Model: ${data.model_used || data.model || "?"}`;
          appendBubble("coach", reply);
          history.push({ sender:"coach", text:reply });
          lastCoach = reply;
          await speak(reply, {});
        }
      }catch{
        appendBubble("coach", "I lost the network for a moment—try again?");
      }
    };

    recognizer.onerror = (e)=> console.warn("SR error:", e.error||e.message);
    try{ recognizer.start(); }catch{}
    return true;
  }
  function stopSR(){ try{ recognizer && recognizer.stop(); }catch{} recognizer=null; }

  // Recorder + sharper VAD
  function rmsFromAnalyser(ana){
    const N = ana.fftSize;
    const buf = new Float32Array(N);
    ana.getFloatTimeDomainData(buf);
    let sum=0; for (let i=0;i<N;i++){ const v=buf[i]; sum += v*v; }
    return Math.sqrt(sum/N);
  }

  async function startRecorder(lang){
    if (recorder) return true;
    try{
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio:true });
    }catch(e){
      console.warn("mic permission denied", e);
      return false;
    }

    ctx = new (window.AudioContext||window.webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const src = ctx.createMediaStreamSource(mediaStream);
    src.connect(analyser);

    chunks = [];
    speaking = false;
    speakingMs = 0;

    recorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm" });
    recorder.ondataavailable = (e)=>{ if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(CONFIG.TIMESLICE); // faster cadence

    if (vadTimer) clearInterval(vadTimer);
    let lastVoiceTs = 0;

    vadTimer = setInterval(async ()=>{
      if (!running || !recorder) return;
      if (cooldown) { lastVoiceTs = performance.now(); return; } // ignore during TTS tail

      const rms = rmsFromAnalyser(analyser);

      // Slow floor adaptation ONLY when quiet (prevents rising during speech)
      const isAboveFloor = rms > vadFloor * 1.05;
      if (!isAboveFloor){
        vadFloor = 0.98*vadFloor + 0.02*rms; // very slow drift downwards
      }

      const isVoice = rms > (vadFloor * VAD_THRESH_MULT);
      const now = performance.now();

      if (isVoice){
        if (!speaking){
          speaking = true;
          speakingMs = 0;
          chunks = []; // start fresh
        }
        lastVoiceTs = now;
      }

      if (speaking){
        speakingMs += CONFIG.TIMESLICE;

        const quietFor = now - lastVoiceTs;
        const longTalk = speakingMs >= CONFIG.MAX_UTT;
        const endable  = (speakingMs >= CONFIG.MIN_TALK);

        if ((endable && quietFor >= CONFIG.SILENCE_HOLD) || longTalk){
          // finalize
          const blob = new Blob(chunks, { type: "audio/webm" });
          speaking = false;
          chunks = [];

          try{
            setStatus("Transcribing…");
            const res = await fetch("/stt", { method:"POST", headers:{ "Content-Type":"audio/webm" }, body: blob });
            const data = res.ok ? await res.json() : { text:"" };
            const txt = (data.text||"").trim();
            if (txt){
              appendBubble("you", txt);
              history.push({ sender:"you", text:txt });
              setStatus("Thinking…");
              const out = await callChat({ user_text: txt, include_seed:false, lang });
              if (out.reply){
                const reply = out.reply.replace(/\[\[.*?\]\]/g,"").trim();
                modelEl.textContent = `Model: ${out.model_used || out.model || "?"}`;
                appendBubble("coach", reply);
                history.push({ sender:"coach", text:reply });
                lastCoach = reply;
                await speak(reply, {});
              } else {
                setStatus("Listening…");
              }
            } else {
              setStatus("Listening…");
            }
          }catch(e){
            console.warn("stt error", e);
            setStatus("Listening…");
          }
        }
      }
    }, CONFIG.TIMESLICE);

    return true;
  }

  function stopRecorder(){
    try{ recorder && recorder.state !== "inactive" && recorder.stop(); }catch{}
    recorder = null;
    try{ vadTimer && clearInterval(vadTimer); }catch{}
    vadTimer = null;
    try{ mediaStream && mediaStream.getTracks().forEach(t=>t.stop()); }catch{}
    mediaStream = null;
    try{ ctx && ctx.close(); }catch{}
    ctx = null; analyser = null;
  }

  // Flow
  async function startFlow(){
    if (running) return;
    running = true;
    startBtn.disabled = true;
    stopBtn.disabled  = false;

    const lang = langEl.value || "en-US";
    setStatus("Starting…");

    // Seed: short greeting, name/age. No cue tags.
    try{
      const seed = await callChat({ include_seed:true, lang });
      modelEl.textContent = `Model: ${seed.model_used || seed.model || "?"}`;
      if (seed.reply){
        const reply = seed.reply.replace(/\[\[.*?\]\]/g,"").trim();
        appendBubble("coach", reply);
        history.push({ sender:"coach", text:reply });
        lastCoach = reply;
        await speak(reply, {});
      }
    }catch{
      appendBubble("coach", "I had trouble starting. Tap Start again?");
      running = false;
      startBtn.disabled = false;
      stopBtn.disabled  = true;
      setStatus("Idle");
      return;
    }

    setStatus("Listening…");
    const srOK = startSR(lang);
    if (!srOK){
      const ok = await startRecorder(lang);
      if (!ok){
        appendBubble("coach", "I can’t access your microphone. Please allow mic and try again.");
        stopFlow();
        return;
      }
    }
  }

  function stopFlow(){
    running = false;
    stopSR();
    stopRecorder();
    startBtn.disabled = false;
    stopBtn.disabled  = true;
    setStatus("Idle");
  }

  // UI wiring (preserved)
  startBtn.addEventListener("click", startFlow);
  stopBtn.addEventListener("click", stopFlow);

  sendBtn.addEventListener("click", async ()=>{
    const msg = textEl.value.trim();
    if (!msg) return;
    textEl.value = "";
    appendBubble("you", msg);
    history.push({ sender:"you", text:msg });
    setStatus("Thinking…");
    try{
      const lang = langEl.value || "en-US";
      const res = await callChat({ user_text: msg, include_seed:false, lang });
      modelEl.textContent = `Model: ${res.model_used || res.model || "?"}`;
      const reply = (res.reply||"").replace(/\[\[.*?\]\]/g,"").trim();
      if (reply){
        appendBubble("coach", reply);
        history.push({ sender:"coach", text:reply });
        lastCoach = reply;
        await speak(reply, {});
      }
    }catch{
      appendBubble("coach", "I couldn’t send that. Try again?");
    }
  });

  textEl.addEventListener("keydown",(e)=>{ if (e.key==="Enter") sendBtn.click(); });

  setStatus("Idle");
})();
