/* static/avatar3d.js
   Human-capable avatar loader with graceful fallback to our lightweight stylized avatar.

   ✅ Public API (unchanged):
     Avatar3D.init(canvas)
     Avatar3D.setFullscreen(bool)         // or setTheme("kid"|"teen")
     Avatar3D.setTheme("kid"|"teen")
     Avatar3D.startTalk()
     Avatar3D.stopTalk()
     Avatar3D.setMouth(amount 0..1)
     Avatar3D.setGaze(nx, ny)             // [-1..1] each axis

   HOW IT WORKS
   ------------
   - If window.AVATAR_MODEL_URL is set, we load that GLB (e.g., a realistic Ready Player Me avatar).
   - We try to find bones by common names (Jaw, Head, Eye_L/Eye_R, LeftEye/RightEye).
   - Lip sync uses jaw rotation; gaze uses eye bones; blink uses eyelids if present, else simulated.
   - If loading fails, we fall back to the stylized “space coach” built from primitives (previous behavior).

   iOS/Performance:
   - Uses THREE.WebGLRenderer(alpha:true, antialias:true) and clamps DPR to 2.
   - No ES modules; dynamically injects GLTFLoader UMD if needed.
*/

(function () {
  // ---------- tiny helpers ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp  = (a, b, t) => a + (b - a) * t;

  function loadScriptOnce(url) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-once="${url}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.defer = true;
      s.setAttribute("data-once", url);
      s.onload = () => resolve();
      s.onerror = (e) => reject(new Error(`Failed to load: ${url}`));
      document.head.appendChild(s);
    });
  }

  function findNodeByRegex(root, regex) {
    let found = null;
    root.traverse((o) => {
      if (!found && o.name && regex.test(o.name)) found = o;
    });
    return found;
  }

  // ---------- Fallback badge texture ----------
  function makeCheckTexture({ c1 = "#FFD447", c2 = "#FFB300", size = 128 } = {}) {
    const cnv = document.createElement("canvas");
    cnv.width = cnv.height = size;
    const ctx = cnv.getContext("2d");
    const s = size / 4;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        ctx.fillStyle = (x + y) % 2 ? c1 : c2;
        ctx.fillRect(x * s, y * s, s, s);
      }
    }
    const tex = new THREE.CanvasTexture(cnv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  const Avatar3D = {
    // core
    _inited: false,
    _scene: null,
    _camera: null,
    _renderer: null,
    _root: null,
    _headGroup: null,
    _bodyGroup: null,

    // rig references when GLB is used
    _jawBone: null,
    _headBone: null,
    _eyeLBone: null,
    _eyeRBone: null,
    _lidLBone: null,
    _lidRBone: null,

    // fallback parts
    _mouthMesh: null,
    _jawGroup: null,
    _pupilL: null,
    _pupilR: null,
    _blinkL: null,
    _blinkR: null,

    // state
    _raf: null,
    _talking: false,
    _mouthTarget: 0,
    _theme: "kid",
    _isGLB: false,

    // gaze smoothing
    _gazeTx: 0, _gazeTy: 0,
    _gazeX: 0, _gazeY: 0,

    async init(canvas) {
      if (this._inited) return;
      this._inited = true;

      // ----- scene / renderer -----
      const scene = new THREE.Scene();
      scene.background = null;

      const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
      cam.position.set(0, 1.25, 4.2);

      const renderer = new THREE.WebGLRenderer({
        canvas, alpha: true, antialias: true, powerPreference: "high-performance",
      });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

      const resize = () => {
        const w = canvas.clientWidth || canvas.parentElement.clientWidth || 640;
        const h = canvas.clientHeight || canvas.parentElement.clientHeight || 360;
        renderer.setSize(w, h, false);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      };
      resize();
      new ResizeObserver(resize).observe(canvas);

      // ----- lights -----
      scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.8));
      const key = new THREE.DirectionalLight(0xffffff, 1.1);
      key.position.set(2.5, 3, 2);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x9fb2ff, 0.7);
      rim.position.set(-3, 2, -2);
      scene.add(rim);

      // ----- root -----
      const root = new THREE.Group();
      scene.add(root);

      // Try to load a human GLB if provided
      let loadedGLB = false;
      const modelURL = (typeof window !== "undefined") ? window.AVATAR_MODEL_URL : null;

      if (modelURL) {
        try {
          if (!THREE.GLTFLoader) {
            // UMD loader that attaches THREE.GLTFLoader
            await loadScriptOnce("https://unpkg.com/three@0.158.0/examples/js/loaders/GLTFLoader.js");
          }
          const loader = new THREE.GLTFLoader();
          const gltf = await new Promise((resolve, reject) => {
            loader.load(modelURL, resolve, undefined, reject);
          });

          const avatar = gltf.scene || gltf.scenes?.[0];
          if (avatar) {
            // Center and scale to a nice view
            avatar.traverse((o) => {
              if (o.isMesh) {
                o.castShadow = false;
                o.receiveShadow = false;
                if (o.material && o.material.map) {
                  o.material.map.colorSpace = THREE.SRGBColorSpace;
                }
              }
            });

            // Heuristic scale
            const box = new THREE.Box3().setFromObject(avatar);
            const size = new THREE.Vector3();
            box.getSize(size);
            const targetHeight = 2.0;
            const scale = size.y > 0 ? targetHeight / size.y : 1;
            avatar.scale.setScalar(scale);
            const center = box.getCenter(new THREE.Vector3());
            avatar.position.sub(center.multiplyScalar(scale)); // center to origin
            avatar.position.y = 0.0;

            root.add(avatar);

            // Bone discovery
            const jaw   = findNodeByRegex(avatar, /(jaw|Jaw|JAW|LowerJaw)/);
            const head  = findNodeByRegex(avatar, /(Head|head|HEAD)/);
            const eyeL  = findNodeByRegex(avatar, /(Eye_L|eye_L|LeftEye|EyeLeft|LeftEyeJoint)/);
            const eyeR  = findNodeByRegex(avatar, /(Eye_R|eye_R|RightEye|EyeRight|RightEyeJoint)/);
            const lidL  = findNodeByRegex(avatar, /(Eyelid_L|UpperLid_L|Blink_L)/);
            const lidR  = findNodeByRegex(avatar, /(Eyelid_R|UpperLid_R|Blink_R)/);

            this._jawBone  = jaw || null;
            this._headBone = head || null;
            this._eyeLBone = eyeL || null;
            this._eyeRBone = eyeR || null;
            this._lidLBone = lidL || null;
            this._lidRBone = lidR || null;

            this._isGLB = true;
            loadedGLB = true;
          }
        } catch (err) {
          console.warn("[avatar3d] GLB load failed; falling back. Reason:", err && err.message ? err.message : err);
        }
      }

      // If GLB not loaded, build the previous stylized fallback (keeps existing look/behavior).
      if (!loadedGLB) {
        this._isGLB = false;
        const bodyGroup = new THREE.Group();
        root.add(bodyGroup);
        const headGroup = new THREE.Group();
        headGroup.position.y = 1.0;
        root.add(headGroup);

        // Skin
        const skin = new THREE.MeshStandardMaterial({ color: 0xffe4d6, metalness: 0.1, roughness: 0.9 });
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.94, 42, 42), skin);
        headGroup.add(head);

        // Hair (blue crown + purple tips)
        const hairBlue = new THREE.Mesh(
          new THREE.SphereGeometry(1.03, 42, 42),
          new THREE.MeshStandardMaterial({ color: 0x2b6bd9, metalness: 0.2, roughness: 0.6 })
        );
        hairBlue.scale.set(1.02, 0.86, 1.02);
        hairBlue.position.y = 0.05;
        headGroup.add(hairBlue);

        const hairPurple = new THREE.Mesh(
          new THREE.SphereGeometry(1.02, 42, 42),
          new THREE.MeshStandardMaterial({ color: 0xb14ecb, metalness: 0.25, roughness: 0.55 })
        );
        hairPurple.scale.set(1.02, 0.5, 1.02);
        hairPurple.position.y = -0.25;
        headGroup.add(hairPurple);

        // Eyes + pupils
        const scleraMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.05, roughness: 0.8 });
        const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 24), scleraMat);
        const eyeR = eyeL.clone();
        eyeL.position.set(-0.31, 0.1, 0.83);
        eyeR.position.set( 0.31, 0.1, 0.83);
        headGroup.add(eyeL, eyeR);

        const pupilMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
        const pupilL = new THREE.Mesh(new THREE.SphereGeometry(0.062, 16, 16), pupilMat);
        const pupilR = pupilL.clone();
        pupilL.position.set(-0.31, 0.1, 0.94);
        pupilR.position.set( 0.31, 0.1, 0.94);
        headGroup.add(pupilL, pupilR);
        this._pupilL = pupilL; this._pupilR = pupilR;

        // Simple lids (for simulated blink)
        const lidMat = skin.clone();
        const lidL = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.13, 0.05), lidMat);
        const lidR = lidL.clone();
        lidL.position.set(-0.31, 0.18, 0.86);
        lidR.position.set( 0.31, 0.18, 0.86);
        headGroup.add(lidL, lidR);
        this._blinkL = lidL; this._blinkR = lidR;

        // Mouth + jaw group
        const mouth = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.16, 0.02, 8, 16),
          new THREE.MeshStandardMaterial({ color: 0x8d0c3a, metalness: 0.1, roughness: 0.6 })
        );
        mouth.position.set(0, -0.2, 0.92);
        headGroup.add(mouth);
        this._mouthMesh = mouth;

        const jaw = new THREE.Group();
        jaw.position.set(0, -0.24, 0.86);
        headGroup.add(jaw);
        this._jawGroup = jaw;

        // Suit (lightweight)
        const suitMat = new THREE.MeshStandardMaterial({ color: 0xe7eaef, metalness: 0.2, roughness: 0.6 });
        const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.60, 0.8, 18, 36), suitMat);
        torso.position.y = 0.15;
        bodyGroup.add(torso);

        const neck = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.045, 16, 40),
          new THREE.MeshStandardMaterial({ color: 0xbec7d3, metalness: 0.4, roughness: 0.4 }));
        neck.rotation.x = Math.PI/2; neck.position.y = 0.85; bodyGroup.add(neck);

        const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x9b69ff, metalness: 0.3, roughness: 0.5 });
        const shL = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.25, 8, 16), shoulderMat);
        const shR = shL.clone(); shL.position.set(0.47, 0.55, 0.02); shR.position.set(-0.47, 0.55, 0.02);
        bodyGroup.add(shL, shR);

        const armMat = new THREE.MeshStandardMaterial({ color: 0xe7eaef, metalness: 0.2, roughness: 0.6 });
        const upperL = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.55, 18), armMat);
        const upperR = upperL.clone(); upperL.position.set(0.62, 0.25, 0.02); upperL.rotation.z = -0.1;
        upperR.position.set(-0.62, 0.25, 0.02); upperR.rotation.z = 0.1; bodyGroup.add(upperL, upperR);

        const foreL = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.5, 18), armMat);
        const foreR = foreL.clone(); foreL.position.set(0.75, -0.05, 0.02); foreR.position.set(-0.75, -0.05, 0.02);
        bodyGroup.add(foreL, foreR);

        const gloveMat = new THREE.MeshStandardMaterial({ color: 0xD7DBE6, metalness: 0.25, roughness: 0.5 });
        const gloveL = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 20), gloveMat);
        const gloveR = gloveL.clone(); gloveL.position.set(0.75, -0.34, 0.02); gloveR.position.set(-0.75, -0.34, 0.02);
        bodyGroup.add(gloveL, gloveR);

        const hips = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.25, 12, 24), suitMat);
        hips.position.y = -0.45; bodyGroup.add(hips);

        const legMat = new THREE.MeshStandardMaterial({ color: 0xE3E7EE, metalness: 0.2, roughness: 0.7 });
        const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.19, 0.85, 16), legMat);
        const legR = legL.clone(); legL.position.set(0.22, -1.0, 0.01); legR.position.set(-0.22, -1.0, 0.01);
        bodyGroup.add(legL, legR);

        const belt = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 12, 60),
          new THREE.MeshStandardMaterial({ color: 0x3d3f4b, metalness: 0.3, roughness: 0.5 }));
        belt.rotation.x = Math.PI/2; belt.position.y = -0.38; bodyGroup.add(belt);

        const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.02),
          new THREE.MeshStandardMaterial({ color: 0xffd76a, metalness: 0.7, roughness: 0.25 }));
        buckle.position.set(0, -0.38, 0.42); bodyGroup.add(buckle);

        const pouch = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.12, 10, 20),
          new THREE.MeshStandardMaterial({ color: 0xbec7d3, metalness: 0.35, roughness: 0.45 }));
        pouch.position.set(0.36, -0.45, 0.32); bodyGroup.add(pouch);

        const badge = new THREE.Mesh(
          new THREE.PlaneGeometry(0.22, 0.34, 1, 1),
          new THREE.MeshStandardMaterial({ map: makeCheckTexture(), metalness: 0.2, roughness: 0.7 })
        );
        badge.position.set(-0.28, 0.45, 0.62); badge.rotation.y = -0.25; bodyGroup.add(badge);

        this._headGroup = headGroup;
        this._bodyGroup = bodyGroup;
      }

      // Store and start loop
      this._scene = scene; this._camera = cam; this._renderer = renderer; this._root = root;

      let t = 0;
      let blinkOpen = 1;
      let blinkTimer = 0;

      const updateBlink = (dt) => {
        blinkTimer -= dt;
        if (blinkTimer <= 0) {
          blinkTimer = (this._talking ? 2.0 : 2.7) + Math.random() * 2.0;
          blinkOpen = 0;
        }
        const speed = 9;
        if (blinkOpen < 1) blinkOpen = Math.min(1, blinkOpen + dt * speed);

        const y = lerp(0.1, 1.0, blinkOpen);

        if (this._isGLB) {
          // If eyelids bones exist, move them slightly down/up
          if (this._lidLBone) this._lidLBone.position.y = lerp(0.0, -0.006, 1 - blinkOpen);
          if (this._lidRBone) this._lidRBone.position.y = lerp(0.0, -0.006, 1 - blinkOpen);
        } else {
          if (this._blinkL) this._blinkL.scale.y = y;
          if (this._blinkR) this._blinkR.scale.y = y;
        }
      };

      const loop = () => {
        this._raf = requestAnimationFrame(loop);
        t += 0.016;

        const talkBoost = this._talking ? 1.0 : 0.6;
        const bob = Math.sin(t * 1.3) * 0.01 * talkBoost;
        root.position.y = bob;

        // Smooth gaze
        this._gazeX = lerp(this._gazeX, this._gazeTx, 0.15);
        this._gazeY = lerp(this._gazeY, this._gazeTy, 0.15);

        // Apply gaze
        if (this._isGLB) {
          const gx = clamp(this._gazeX, -1, 1);
          const gy = clamp(this._gazeY, -1, 1);
          const ex = 0.18 * gx;
          const ey = 0.15 * -gy;
          if (this._eyeLBone) { this._eyeLBone.rotation.y = ex; this._eyeLBone.rotation.x = ey; }
          if (this._eyeRBone) { this._eyeRBone.rotation.y = ex; this._eyeRBone.rotation.x = ey; }
          if (!this._eyeLBone && this._headBone) {
            this._headBone.rotation.y = lerp(this._headBone.rotation.y, ex * 0.6, 0.12);
            this._headBone.rotation.x = lerp(this._headBone.rotation.x, ey * 0.6, 0.12);
          }
        } else {
          const maxOff = 0.05;
          const ox = clamp(this._gazeX, -1, 1) * maxOff;
          const oy = clamp(this._gazeY, -1, 1) * maxOff;
          if (this._pupilL) this._pupilL.position.set(-0.31 + ox, 0.1 - oy, 0.94);
          if (this._pupilR) this._pupilR.position.set( 0.31 + ox, 0.1 - oy, 0.94);
          if (this._headGroup) {
            const yawT = clamp(this._gazeX, -1, 1) * 0.18;
            const pitT = clamp(-this._gazeY, -1, 1) * 0.14 + Math.sin(t * 1.1) * 0.03 * talkBoost;
            this._headGroup.rotation.y = lerp(this._headGroup.rotation.y, yawT, 0.15);
            this._headGroup.rotation.x = lerp(this._headGroup.rotation.x, pitT, 0.15);
          }
        }

        // Mouth / jaw
        if (this._isGLB) {
          if (this._jawBone) {
            const jr = this._mouthTarget * 0.22;
            this._jawBone.rotation.x = lerp(this._jawBone.rotation.x, jr, 0.18);
          }
        } else {
          if (this._mouthMesh) {
            const curr = this._mouthMesh.scale.y || 1;
            const target = 0.6 + this._mouthTarget * 0.9;
            this._mouthMesh.scale.y = lerp(curr, target, 0.25);
          }
          if (this._jawGroup) {
            const jr = this._mouthTarget * 0.22;
            this._jawGroup.rotation.x = lerp(this._jawGroup.rotation.x, jr, 0.18);
          }
        }

        updateBlink(0.016);
        renderer.render(scene, cam);
      };
      loop();
    },

    // Layout hooks (unchanged)
    setFullscreen(isKid) { document.body.classList.toggle("kid-mode", !!isKid); this._theme = isKid ? "kid" : "teen"; },
    setTheme(mode) { this.setFullscreen(mode === "kid"); },

    startTalk() { this._talking = true; },
    stopTalk()  { this._talking = false; this._mouthTarget = 0; },

    // Lip-sync amplitude 0..1
    setMouth(v) { this._mouthTarget = clamp(v || 0, 0, 1); },

    // normalized gaze in [-1..1]
    setGaze(nx, ny) {
      this._gazeTx = clamp(nx || 0, -1, 1);
      this._gazeTy = clamp(ny || 0, -1, 1);
    }
  };

  window.Avatar3D = Avatar3D;
})();
