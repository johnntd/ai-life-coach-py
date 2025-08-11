// static/app.js
// -----------------------------------------------------------------------------
// Frontend controller (keeps same IDs, handlers, and hands-free loop).
// - Start: Miss Sunny greets, then mic opens
// - TTS: plays server audio; on failure shows friendly fallback
// - STT: prefers MediaRecorder -> /stt; falls back to Web Speech Recognition
// - Preserves existing IDs: #start #stop #send #text #log #status #model
//   #teen #name #age #lang #ttsAudio
// -----------------------------------------------------------------------------

(() => {
  // ---- Elements (unchanged IDs) ----
  const startBtn  = document.getElementById("start");
  const stopBtn   = document.getElementById("stop");
  const sendBtn   = document.getElementById("send");
  const textIn    = document.getElementById("text");
  const logEl     = document.getElementById("log");
  const statusEl  = document.getElementById("status");
  const modelEl   = document.getElementById("model");
  const teenCbx   = document.getElementById("teen");
  const nameIn    = document.getElementById("name");
  const ageSel    = document.getElementById("age");
  const langSel   = document.getElementById("lang");
  const audioEl   = document.getElementById("ttsAudio");

  // ---- State ----
  let listening = false;
  let talking   = false;
  let cooldown  = false;
  let lastCoach = "";
  const history = []; // {sender:"you"|"coach", text}

  // MediaRecorder STT
  let mediaStream = null;
  let recorder    = null;
  let sttLoopOn   = false;

  // Web Speech fallback
  let recognizer  = null;

  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  function setStatus(s){ statusEl && (statusEl.textContent = s); }
  function addBubble(text, who){
    const div = document.createElement("div");
    div.className = `bubble ${who==="you"?"you":"coach"}`;
    div.textContent = (who==="you" ? `You: ${text}` : `Miss Sunny: ${text}`);
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }
  async function fetchJSON(url, body){
    const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body||{}) });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return res.json();
  }

  // ------------------------------ TTS ----------------------------------------
  async function speak(text, { voice } = {}){
    cooldown = true;
    talking = true;
    pauseSTT();
    setStatus("Speaking…");

    let blob = null;
    try {
      const res = await fetch("/tts", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ text, voice: voice || undefined })
      });
      if (!res.ok) {
        console.warn("[tts] non-200", res.status);
      } else {
        blob = await res.blob();
      }
    } catch (e){
      console.warn("[tts] network error", e);
    }

    if (!blob || !blob.size) {
      console.warn("[tts] Empty audio blob");
      talking = false;
      setStatus("Listening…");
      await sleep(800); // short guard
      cooldown = false;
      resumeSTT();
      return;
    }

    const url = URL.createObjectURL(blob);
    audioEl.src = url;
    try { await audioEl.play(); } catch { /* user gesture / autoplay issues */ }

    // Wait to finish or fail
    await new Promise((res)=>{ audioEl.onended = res; audioEl.onerror = res; });

    talking = false;
    setStatus("Listening…");
    await sleep(IS_IOS ? 1600 : 1000); // echo guard
    cooldown = false;
    resumeSTT();
  }

  // ------------------------------ Chat ---------------------------------------
  async function chatTurn(userText){
    try{
      setStatus("Thinking…");
      const payload = {
        user_text: userText || "",
        name: nameIn.value || "Emily",
        age: parseInt(ageSel.value,10)||5,
        mode: teenCbx.checked ? "teen":"child",
        objective: "gentle warm-up",
        include_seed: !userText,     // first turn only
        history,
        lang: langSel.value || "en-US",
      };
      const data = await fetchJSON("/chat", payload);
      modelEl && (modelEl.textContent = `Model: ${data.model_used || "?"}`);
      const reply = (data.reply || "").trim();
      if (reply){
        addBubble(reply, "coach");
        history.push({ sender:"coach", text: reply });
        lastCoach = reply;
        await speak(reply, {});
      }
      setStatus("Listening…");
    }catch(e){
      console.error(e);
      addBubble("I had trouble starting. Try again?", "coach");
      setStatus("Idle");
    }
  }

  // --------------------------- STT (MediaRecorder) ---------------------------
  function startSTT(){
    if (!mediaStream || sttLoopOn) return;
    if (!window.MediaRecorder){ startSR(); return; }
    stopSR();

    sttLoopOn = true;
    recorder = new MediaRecorder(mediaStream, { mimeType:"audio/webm" });
    recorder.ondataavailable = async (ev)=>{
      if (!ev.data || !ev.data.size) return;
      if (!listening || talking || cooldown) return;

      try{
        const res = await fetch("/stt", { method:"POST", headers:{ "Content-Type":"audio/webm" }, body: ev.data });
        if (!res.ok) return;
        const { text } = await res.json();
        const txt = (text||"").trim();
        if (!txt) return;

        // Echo guard: skip if it's just echo of last coach line
        if (lastCoach && lastCoach.toLowerCase().includes(txt.toLowerCase())) return;

        addBubble(txt, "you");
        history.push({ sender:"you", text: txt });
        await chatTurn(txt);
      }catch(e){ console.warn("stt send error", e); }
    };
    recorder.start(1200); // ~1.2s chunks
  }
  function pauseSTT(){
    try{ recorder && recorder.state==="recording" && recorder.stop(); }catch{}
    sttLoopOn = false;
  }
  function resumeSTT(){
    if (!listening || talking || cooldown) return;
    startSTT();
  }
  function stopSTT(){
    sttLoopOn = false;
    try{ recorder && recorder.state==="recording" && recorder.stop(); }catch{}
    recorder = null;
  }

  // --------------------------- SR fallback -----------------------------------
  function startSR(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    if (recognizer) return;

    recognizer = new SR();
    recognizer.lang = langSel.value || "en-US";
    recognizer.continuous = true;
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;

    recognizer.onresult = async (ev)=>{
      const last = ev.results?.[ev.results.length-1];
      if (!last || !last.isFinal) return;
      const txt = (last[0]?.transcript || "").trim();
      if (!txt || talking || cooldown) return;

      if (lastCoach && lastCoach.toLowerCase().includes(txt.toLowerCase())) return;

      addBubble(txt, "you");
      history.push({ sender:"you", text: txt });
      await chatTurn(txt);
    };
    recognizer.onerror = (e)=> addBubble(`Mic error: ${e.error}`, "coach");

    try{ recognizer.start(); }catch{}
  }
  function stopSR(){
    try{ recognizer && recognizer.stop(); }catch{}
    recognizer = null;
  }

  // ------------------------------- Flow --------------------------------------
  async function startFlow(){
    if (listening) return;
    listening = true;
    startBtn.disabled = true;
    stopBtn.disabled  = false;

    // Request mic once on Start (keeps your original UX)
    try{
      setStatus("Requesting mic…");
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio:true });
    }catch(err){
      addBubble("Please allow microphone access to start.", "coach");
      setStatus("Idle");
      startBtn.disabled = false;
      stopBtn.disabled  = true;
      listening = false;
      return;
    }

    addBubble("(Starting)", "you");
    await chatTurn(""); // include_seed = true on first turn
    setStatus("Listening…");
    startSTT();
  }

  function stopFlow(){
    listening = false;
    stopSTT();
    stopSR();
    startBtn.disabled = false;
    stopBtn.disabled  = true;
    setStatus("Idle");
  }

  // ------------------------------- UI ----------------------------------------
  startBtn.addEventListener("click", startFlow);
  stopBtn.addEventListener("click", stopFlow);

  sendBtn.addEventListener("click", async ()=>{
    const v = (textIn.value||"").trim();
    if (!v) return;
    textIn.value = "";
    addBubble(v, "you");
    history.push({ sender:"you", text: v });
    await chatTurn(v);
  });
  textIn.addEventListener("keydown",(e)=>{
    if (e.key==="Enter"){ e.preventDefault(); sendBtn.click(); }
  });

  window.addEventListener("load", ()=> setStatus("Idle"));
})();
