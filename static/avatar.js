(function(){
  const canvas = document.getElementById("avatar");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth/canvas.clientHeight, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  camera.position.set(0, 0.6, 2);

  const light = new THREE.DirectionalLight(0xffffff, 1.0);
  light.position.set(2,2,2);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, .5));

  // Head (sphere) + mouth (box) – simple avatar
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0xFFD591 })
  );
  scene.add(head);

  const mouth = new THREE.Mesh(
    new THREE.BoxGeometry(0.25, 0.06, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x8b3a3a })
  );
  mouth.position.set(0, -0.15, 0.55);
  scene.add(mouth);

  // Lip‑sync via WebAudio analyser
  let audio, ctx, src, analyser, data;
  function bindAudio(el){
    if (audio && audio !== el) { try{ audio.pause(); }catch{} }
    audio = el;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    src = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    data = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    analyser.connect(ctx.destination);
  }
  function stop(){
    if(ctx){ try{ ctx.close(); }catch{} }
    ctx = null; analyser=null; data=null; audio=null;
    mouth.scale.y = 1;
  }

  function animate(){
    requestAnimationFrame(animate);
    if(analyser && data){
      analyser.getByteTimeDomainData(data);
      // Rough amplitude from waveform variance
      let sum = 0;
      for(let i=0;i<data.length;i++){
        const v = (data[i]-128)/128;
        sum += v*v;
      }
      const amp = Math.min(1, Math.sqrt(sum/data.length)*4);
      mouth.scale.y = 1 + amp*2.0;   // open/close
    }
    renderer.render(scene,camera);
  }
  animate();

  // expose to window
  window.avatarBindAudio = bindAudio;
  window.avatarStop = stop;

  // handle resizing
  window.addEventListener("resize", ()=>{
    const w = canvas.clientWidth, h = canvas.clientHeight;
    camera.aspect = w/h; camera.updateProjectionMatrix();
    renderer.setSize(w,h);
  });
})();
