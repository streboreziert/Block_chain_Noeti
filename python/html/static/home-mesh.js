/**
 * Noeti home — white stage, morphing lattice that clearly moves.
 * Stretches / shears / ripples while spinning. Always animates.
 */
(() => {
  const canvas = document.getElementById("mesh");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  let w = 0;
  let h = 0;
  let dpr = 1;
  /** @type {{ox:number,oy:number,oz:number,phase:number}[]} */
  let pts = [];
  /** @type {[number, number][]} */
  let edges = [];
  /** @type {{e:number,t:number,speed:number,w:number}[]} */
  let pulses = [];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, window.innerWidth);
    h = Math.max(1, window.innerHeight);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    pts = [];
    edges = [];
    pulses = [];
    const n = w < 700 ? 6 : 7;
    const idx = (i, j, k) => i + j * n + k * n * n;

    for (let k = 0; k < n; k++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          pts.push({
            ox: i / (n - 1) - 0.5,
            oy: j / (n - 1) - 0.5,
            oz: k / (n - 1) - 0.5,
            phase: (i + j * 3 + k * 7) * 0.4,
          });
        }
      }
    }

    for (let k = 0; k < n; k++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const id = idx(i, j, k);
          if (i + 1 < n) edges.push([id, idx(i + 1, j, k)]);
          if (j + 1 < n) edges.push([id, idx(i, j + 1, k)]);
          if (k + 1 < n) edges.push([id, idx(i, j, k + 1)]);
        }
      }
    }

    for (let i = 0; i < Math.min(70, edges.length); i++) {
      pulses.push({
        e: (Math.random() * edges.length) | 0,
        t: Math.random(),
        speed: 0.35 + Math.random() * 0.45,
        w: 1.1 + Math.random(),
      });
    }
  }

  function deform(p, t) {
    // Strong, readable form change
    const sx = 1 + Math.sin(t * 0.7) * 0.42;
    const sy = 1 + Math.cos(t * 0.55) * 0.38;
    const sz = 1 + Math.sin(t * 0.48 + 1.1) * 0.45;

    let x = p.ox * sx;
    let y = p.oy * sy;
    let z = p.oz * sz;

    // Shear — box skews into new shapes
    x += y * Math.sin(t * 0.4) * 0.35 + z * Math.cos(t * 0.33) * 0.28;
    y += z * Math.sin(t * 0.37 + 0.5) * 0.3;

    // Ripple field
    const ripple = Math.sin(p.ox * 5 + t * 1.4 + p.phase) * Math.cos(p.oy * 4 - t * 1.1);
    x += ripple * 0.08;
    y += Math.sin(p.oz * 4.5 + t * 1.2) * 0.07;
    z += ripple * 0.09;

    // Flatten pulse
    y *= 0.65 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.35));

    return { x, y, z };
  }

  function rotate(p, yaw, pitch, roll) {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    let x = p.x * cy - p.z * sy;
    let z = p.x * sy + p.z * cy;
    let y = p.y;

    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const y2 = y * cp - z * sp;
    z = y * sp + z * cp;
    y = y2;

    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const x2 = x * cr - y * sr;
    y = x * sr + y * cr;
    x = x2;
    return { x, y, z };
  }

  function project(p, yaw, pitch, roll) {
    const r = rotate(p, yaw, pitch, roll);
    const depth = r.z + 2.15;
    const size = Math.min(w, h) * (w < 700 ? 1.15 : 1.35);
    const scale = size / Math.max(0.5, depth);
    return {
      x: w * 0.5 + r.x * scale,
      y: h * 0.5 + r.y * scale * 0.9,
      z: r.z,
      depth,
      a: Math.max(0.1, Math.min(0.4, 0.28 - r.z * 0.16)),
    };
  }

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  function frame(now) {
    const t = now * (reduceMotion ? 0.00025 : 0.001);

    // Direct time-driven spin — always moving
    const yaw = t * 0.35;
    const pitch = 0.35 + Math.sin(t * 0.45) * 0.35;
    const roll = Math.sin(t * 0.28) * 0.2;

    ctx.clearRect(0, 0, w, h);

    const proj = pts.map((p) => project(deform(p, t), yaw, pitch, roll));

    // Edges
    for (let i = 0; i < edges.length; i++) {
      const a = proj[edges[i][0]];
      const b = proj[edges[i][1]];
      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const dx = (mx - w * 0.5) / (Math.min(w, h) * 0.18);
      const dy = (my - h * 0.5) / (Math.min(w, h) * 0.08);
      const fade = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const alpha = Math.min(a.a, b.a) * (0.45 + fade * 0.55);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = "rgba(17,17,17," + alpha + ")";
      ctx.lineWidth = 0.85 + (1.2 - Math.min(a.depth, b.depth)) * 0.45;
      ctx.stroke();
    }

    // Flow
    const pulseStep = reduceMotion ? 0.003 : 0.012;
    for (let i = 0; i < pulses.length; i++) {
      const p = pulses[i];
      p.t = (p.t + p.speed * pulseStep) % 1;
      const a = proj[edges[p.e][0]];
      const b = proj[edges[p.e][1]];
      const t0 = Math.max(0, p.t - 0.08);
      const x0 = a.x + (b.x - a.x) * t0;
      const y0 = a.y + (b.y - a.y) * t0;
      const x = a.x + (b.x - a.x) * p.t;
      const y = a.y + (b.y - a.y) * p.t;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x, y);
      ctx.strokeStyle = "rgba(17,17,17,0.4)";
      ctx.lineWidth = 1.8 * p.w;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 1.6 * p.w, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(17,17,17,0.82)";
      ctx.fill();
    }

    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);

  resize();
  requestAnimationFrame(frame);
})();
