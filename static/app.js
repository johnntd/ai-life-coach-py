(() => {
  // ========= DOM =========
  const startBtn = document.getElementById("start");
  const stopBtn  = document.getElementById("stop");
  const sendBtn  = document.getElementById("send");
  const textIn   = document.getElementById("text");
  const logEl    = document.getElementById("log");
  const statusEl = document.getElementById("status");
  const modelEl  = document.getElementById("model");
  const teenCbx  = document.getElementById("teen");
  const nameIn   = document.getElementById("name");
  const ageSel   = document.getElementById("age");
  const langSel  = document.getElementById("lang");
  const audioEl  = document.getElementById("ttsAudio");

  const toast    = document.getElementById("consentToast");
  const enableBtn= document.getElementById("enableStart");
  const skipBtn  = document.getElementById("skipEnable");

  // ========= State =========
  let listening = false;
  let talking   = false;
  let cooldown  = false;   // echo guard
  let hasMicPermission = false;
  let mediaStream = null;
  let recognizer = null;   // SpeechRecognition instance (browser)
  let lang = "en-US";

  // ========= Utils =========
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function setStatus(s){ statusEl.textContent = s; }
  function setTalking(on){
    talking = on;
    // auto-pause microphone while speaking to avoid feedback
    if (on) pauseMic();
    else resumeMic();
  }

  function addBubble(text, who){
    const div = document.createElement("div");
    div.className = `bubble ${who === "you" ? "you" : "coach"}`;
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function fetchJSON(url, body){
    const res = await fetch(url, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(body||{})
    });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return res.json();
  }

  // ========= Mic Permission Toast =========
  function showToast(){ toast.classList.add("show"); }
  function hideToast(){ toast.classList.remove("show"); }

  async function requestMicPermission({autoStart=false}={}){
    try{
      setStatus("Requesting mic…");
      mediaStream = await navigator.mediaDevices.getUserMedia({audio:true});
      // immediately close tracks; we only needed permission probe here
      mediaStream.getTracks().forEach(t=>t.stop());
      hasMicPermission = true;
      hideToast();
      setStatus("Ready");
      if (autoStart) startFlow();
    }catch(err){
      console.warn("Mic permission error:", err);
      hasMicPermission = false;
      hideToast();               // never block UI
      setStatus("Mic not enabled");
    }
  }

  // ========= STT (browser SpeechRecognition) =========
  function createRecognizer(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = lang;
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (ev)=>{
      const txt = ev.results[0][0].transcript.trim();
      if (!txt) return;
      addBubble(txt, "you");
      chatTurn(txt);
    };
    r.onerror = (e)=> addBubble(`Mic error: ${e.error}`, "coach");
    r.onend = () => { if (listening && !talking) startRecognizer(); };
    return r;
  }

  function startRecognizer(){
    try{
      if (!recognizer) recognizer = createRecognizer();
      if (recognizer) recognizer.start();
    }catch(_){/* sometimes throws if already started */}
  }
  function stopRecognizer(){
    try{ recognizer && recognizer.stop(); }catch(_){}
  }
  function pauseMic(){ stopRecognizer(); }
  function resumeMic(){ if (listening) startRecognizer(); }

  // ========= TTS =========
  async function speak(text, { voice } = {}){
    cooldown = true;
    setTalking(true);
    setStatus("Speaking…");
    addMouthCue(text); // avatar cue parsing stays visual-only

    const res = await fetch("/tts", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        text,
        voice: voice || undefined,
        model: undefined,
        format: "mp3"
      }),
    });

    if (!res.ok){
      setTalking(false);
      cooldown = false;
      addBubble("Sorry, TTS failed.", "coach");
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    audioEl.src = url;

    try { await audioEl.play(); }
    catch(e){ await sleep(250); try{ await audioEl.play(); } catch(_){/* ignore */} }

    await new Promise(resolve=>{
      audioEl.onended = resolve;
      audioEl.onerror = resolve;
    });

    setTalking(false);
    setStatus("Listening…");
    await sleep(900); // shorter echo-guard tail
    cooldown = false;
  }

  function addMouthCue(text){
    // If you’re driving lip-sync elsewhere, parse [[CUE_*]] here if needed.
    // (No-op for now to keep previous behavior intact.)
    return text;
  }

  // ========= Chat turn =========
  async function chatTurn(userText){
    try{
      setStatus("Thinking…");
      const payload = {
        user_text: userText || "",
        name: nameIn.value || "Emily",
        age: parseInt(ageSel.value,10) || 5,
        mode: teenCbx.checked ? "teen" : "child",
        objective: "gentle morning warm-up",
        include_seed: !userText, // seed on first auto prompt
        lang: lang
      };
      const data = await fetchJSON("/chat", payload);

      if (data.reply){
        addBubble(data.reply, "coach");
        await speak(data.reply, { voice: undefined });
      }else{
        addBubble("Sorry, I didn’t get a reply.", "coach");
      }
      setStatus("Listening…");
    }catch(err){
      addBubble(`Network error talking to /chat`, "coach");
      console.error(err);
      setStatus("Ready");
    }
  }

  // ========= Flow controls =========
  async function startFlow(){
    if (listening) return;
    listening = true;
    startBtn.disabled = true;
    stopBtn.disabled  = false;
    lang = langSel.value || "en-US";
    modelEl.textContent = "Model: gpt-4o";

    // Kick off with a seed turn
    addBubble("Hi friend! I’m Miss Sunny. How are you feeling—happy, okay, or not great?", "coach");
    await speak("Hi friend! I’m Miss Sunny. How are you feeling—happy, okay, or not great?", {});

    setStatus("Listening…");
    resumeMic();
  }

  function stopFlow(){
    listening = false;
    stopRecognizer();
    startBtn.disabled = false;
    stopBtn.disabled  = true;
    setStatus("Idle");
  }

  // ========= Wire up UI =========
  startBtn.addEventListener("click", async ()=>{
    if (!hasMicPermission){
      await requestMicPermission({autoStart:true});
    }else{
      startFlow();
    }
  });

  stopBtn.addEventListener("click", stopFlow);

  sendBtn.addEventListener("click", ()=>{
    const v = (textIn.value||"").trim();
    if (!v) return;
    textIn.value = "";
    addBubble(v, "you");
    chatTurn(v);
  });

  textIn.addEventListener("keydown",(e)=>{
    if (e.key === "Enter"){
      e.preventDefault();
      sendBtn.click();
    }
  });

  enableBtn.addEventListener("click", ()=> requestMicPermission({autoStart:true}));
  skipBtn.addEventListener("click", ()=> hideToast());

  // Show mic toast on load (non-blocking)
  window.addEventListener("load", async ()=>{
    // Try to hint permission state; always show toast in HTTP (localhost) where
    // Permissions API may be limited.
    try{
      if (navigator.permissions && navigator.permissions.query){
        const p = await navigator.permissions.query({name:"microphone"});
        if (p.state !== "granted") showToast();
        p.onchange = () => {
          if (p.state === "granted"){ hasMicPermission = true; hideToast(); }
        };
      }else{
        showToast();
      }
    }catch{ showToast(); }
    setStatus("Ready");
  });

})();
