/* Noeti Compute Lab — network adoption model (illustrative)
   Hybrid dynamics: Bass (1969) diffusion + viral K + two-sided matching
   + partial-adjustment compute supply. Discrete daily ticks; soft caps. */
(function () {
  "use strict";

  const W_DESKTOP = 1.0;
  const W_BROWSER = 0.35;
  const W_SITE = 80;
  const DRAW_CAP = 48;

  const BASE_REWARD = 10;
  const SEED_USERS = 10;
  const SEED_DESKTOPS = 2;
  const SEED_BROWSERS = 1;
  const JOB_RATE = 0.04;
  const COMPUTE_FRAC_FAST = 0.12;
  const COMPUTE_FRAC_VERIFIED = 0.18;
  const COMPUTE_FRAC_SOFT_MAX = 0.22;
  const DESK_SHARE = 0.68;
  // Illustrative TAM: worldwide AI-chat-scale addressable users
  const U_MAX = 8e6;
  const U_MAX_BLITZ = 14e6;
  const DESK_SOFT_CAP = 110000;
  const BROW_SOFT_CAP = 50000;

  // Bass innovation p by media (Off / Low / Blitz) — scaled for discrete days
  const BASS_P = { off: 2.2e-7, low: 1.8e-5, blitz: 2.4e-4 };
  // Bass imitation q (word-of-mouth / network effects)
  const BASS_Q = { off: 0.085, low: 0.22, blitz: 0.48 };
  // Viral coefficient bases: K = i · c
  const VIRAL_I = { off: 0.12, low: 0.55, blitz: 2.4 };
  const VIRAL_C = { off: 0.18, low: 0.32, blitz: 0.55 };
  // Matching efficiency κ; Cobb–Douglas blend weight
  const MATCH_KAPPA = 0.92;
  const MATCH_BETA = 0.55;
  // Partial-adjustment speed λ toward ρ·U
  const LAMBDA_BASE = 0.1;
  const LAMBDA_MEDIA = 0.38;
  const HISTORY_MAX = 220;
  const DEMO_SPEED = 9;
  const FAIL_PRESSURE = 0.22;

  // Illustrative MLC price scenario (NOT a forecast / not financial advice)
  const INITIAL_FLOAT = 50000; // assumed early circulating MLC
  const PRICE_P0 = 0.05; // USD scenario at t0
  const PRICE_ALPHA = 0.65;
  const PRICE_FLOOR = 0.01;
  const PRICE_CAP = 48;
  const V0_INDEX = 1;

  const MEDIA_LEVEL = { off: 0, low: 0.35, blitz: 1 };

  const COLORS = {
    users: "#00ff88",
    compute: "#00ccff",
    jobs: "#7dffb0",
    site: "#e8ffe8",
    desktop: "#00ff88",
    browser: "#7dffb0",
    price: "#ffcc66",
    circ: "#00ccff",
    grid: "rgba(0, 255, 136, 0.07)",
    axis: "rgba(90, 143, 106, 0.85)",
    label: "rgba(180, 200, 190, 0.7)",
  };

  const chartCanvas = document.getElementById("chartCanvas");
  const chartCtx = chartCanvas.getContext("2d");
  const priceCanvas = document.getElementById("priceCanvas");
  const priceCtx = priceCanvas ? priceCanvas.getContext("2d") : null;
  const miniCanvas = document.getElementById("miniCanvas");
  const miniCtx = miniCanvas ? miniCanvas.getContext("2d") : null;

  const el = {
    users: document.getElementById("stUsers"),
    compute: document.getElementById("stCompute"),
    day: document.getElementById("stDay"),
    kHero: document.getElementById("stK"),
    regime: document.getElementById("stRegime"),
    regimeBadge: document.getElementById("regimeBadge"),
    desktops: document.getElementById("stDesktops"),
    browsers: document.getElementById("stBrowsers"),
    coords: document.getElementById("stCoords"),
    served: document.getElementById("stServed"),
    media: document.getElementById("stMedia"),
    reward: document.getElementById("stReward"),
    p: document.getElementById("stP"),
    q: document.getElementById("stQ"),
    k: document.getElementById("stKSide"),
    rho: document.getElementById("stRho"),
    serve: document.getElementById("stServe"),
    vIndex: document.getElementById("stV"),
    vHero: document.getElementById("stVHero"),
    price: document.getElementById("stPrice"),
    circ: document.getElementById("stCirc"),
    priceSide: document.getElementById("stPriceSide"),
    circSide: document.getElementById("stCircSide"),
    caption: document.getElementById("simCaption"),
    priceCaption: document.getElementById("priceCaption"),
    mediaHint: document.getElementById("mediaHint"),
    liveDot: document.getElementById("liveDot"),
    btnPlay: document.getElementById("btnPlay"),
    btnReset: document.getElementById("btnReset"),
    btnSkyrocket: document.getElementById("btnSkyrocket"),
    stake: document.getElementById("pStake"),
    valStake: document.getElementById("valStake"),
    btnFaucetOn: document.getElementById("btnFaucetOn"),
    btnFaucetOff: document.getElementById("btnFaucetOff"),
    btnConsFast: document.getElementById("btnConsFast"),
    btnConsVerified: document.getElementById("btnConsVerified"),
    btnMediaOff: document.getElementById("btnMediaOff"),
    btnMediaLow: document.getElementById("btnMediaLow"),
    btnMediaBlitz: document.getElementById("btnMediaBlitz"),
  };

  const state = {
    site: 1,
    desktops: SEED_DESKTOPS,
    browsers: SEED_BROWSERS,
    users: SEED_USERS,
    capital: 40,
    attractiveness: 1,
    effReward: BASE_REWARD,
    tick: 0,
    servedTotal: 0,
    failedTotal: 0,
    recentServed: SEED_USERS * JOB_RATE * 0.5,
    recentFailRate: 0.05,
    recentServeRate: 0.85,
    outageMul: 1,
    growthRate: 0,
    mode: "cold",
    mediaPhase: 0,
    computeCatchUp: false,
    // Live model readouts
    bassP: BASS_P.off,
    bassQ: BASS_Q.off,
    viralK: VIRAL_I.off * VIRAL_C.off,
    rho: COMPUTE_FRAC_FAST,
    serveRate: 0.85,
    vIndex: 0,
    mlcPaid: 0,
    circulating: INITIAL_FLOAT,
    priceUsd: PRICE_P0,
    history: {
      day: [1],
      users: [SEED_USERS],
      compute: [SEED_DESKTOPS + SEED_BROWSERS],
      jobs: [0],
      price: [PRICE_P0],
      circulating: [INITIAL_FLOAT],
      vIndex: [1],
    },
  };

  let particles = [];
  let running = true;
  let faucetOn = true;
  let consensus = "fast";
  let mediaMode = "off";
  let speed = 3;
  let lastTs = 0;
  let accum = 0;
  let pulse = 0;
  let demoActive = false;

  function params() {
    return {
      stake: +el.stake.value,
      faucet: faucetOn,
      consensus: consensus,
      media: mediaMode,
      mediaLevel: MEDIA_LEVEL[mediaMode] || 0,
      speed: speed,
    };
  }

  function slotsPerJob(p) {
    return p.consensus === "verified" ? 2.5 : 1;
  }

  function jobDemand(users) {
    return Math.max(0.2, users * JOB_RATE);
  }

  function capacityOf(s) {
    // C = D + 0.35 B + C_site (weighted)
    return (W_SITE * s.site + W_DESKTOP * s.desktops + W_BROWSER * s.browsers) * s.outageMul;
  }

  function softCapNow() {
    return mediaMode === "blitz" || demoActive ? U_MAX_BLITZ : U_MAX;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function randn() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function poisson(lambda) {
    if (lambda <= 0) return 0;
    if (lambda > 8) {
      return Math.max(0, Math.round(lambda + randn() * Math.sqrt(lambda)));
    }
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }

  function fmt(n) {
    if (!isFinite(n)) return "—";
    const sign = n < 0 ? "-" : "";
    const v = Math.abs(n);
    if (v >= 1e6) {
      const m = v / 1e6;
      return sign + (m >= 10 ? m.toFixed(0) : m.toFixed(1)) + "M";
    }
    if (v >= 1e3) {
      const k = v / 1e3;
      return sign + (k >= 10 ? k.toFixed(0) : k.toFixed(1)) + "K";
    }
    if (v >= 100) return sign + Math.round(v).toString();
    if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9) {
      return sign + Math.round(v).toString();
    }
    return sign + v.toFixed(1);
  }

  function fmtSci(n) {
    if (!isFinite(n) || n === 0) return "0";
    if (n >= 0.01) return n.toFixed(3);
    return n.toExponential(1);
  }

  function dayLabel(tick) {
    return "Day " + (tick + 1);
  }

  function computeNodes() {
    return state.desktops + state.browsers;
  }

  function computeFracTarget(p) {
    return p.consensus === "verified" ? COMPUTE_FRAC_VERIFIED : COMPUTE_FRAC_FAST;
  }

  function syncLabels() {
    if (el.valStake) el.valStake.textContent = el.stake.value;
  }

  function setFaucet(on) {
    faucetOn = on;
    el.btnFaucetOn.classList.toggle("active", on);
    el.btnFaucetOff.classList.toggle("active", !on);
  }

  function setConsensus(mode) {
    consensus = mode === "verified" ? "verified" : "fast";
    el.btnConsFast.classList.toggle("active", consensus === "fast");
    el.btnConsVerified.classList.toggle("active", consensus === "verified");
  }

  function mediaHintText(mode) {
    if (mode === "blitz") {
      return "Blitz — raises Bass p and viral K (i·c); expect takeoff when K>1.";
    }
    if (mode === "low") {
      return "Low — modest innovation p on top of imitation q (WOM).";
    }
    return "Media off — Bass innovation p near zero; organic imitation only.";
  }

  function setMedia(mode, opts) {
    const m = mode === "low" || mode === "blitz" ? mode : "off";
    mediaMode = m;
    el.btnMediaOff.classList.toggle("active", m === "off");
    el.btnMediaLow.classList.toggle("active", m === "low");
    el.btnMediaBlitz.classList.toggle("active", m === "blitz");
    if (el.media) el.media.textContent = m === "blitz" ? "blitz" : m;
    if (el.mediaHint) el.mediaHint.textContent = mediaHintText(m);
    if (!opts || !opts.silent) {
      if (m === "blitz") {
        setCaption(dayLabel(state.tick) + " · Media blitz — Bass p↑, viral K rising", "hot");
      } else if (m === "low") {
        setCaption(dayLabel(state.tick) + " · Low media — modest Bass innovation", "hot");
      } else if (state.tick === 0) {
        setCaption(
          "Day 1 · 10 users · cold start — media off; Bass imitation (q) only.",
          ""
        );
      } else {
        setCaption(dayLabel(state.tick) + " · Media off — organic Bass diffusion", "");
      }
    }
  }

  function faucetFactor(p, capital) {
    if (p.faucet) return 1;
    if (capital > 40) return 0.45;
    return 0.15;
  }

  function computeEffReward(unmetFrac, overRatio, idleFrac) {
    const scarcity = 0.55 + 0.9 * unmetFrac;
    const oversupply = 1 + Math.max(0, overRatio - 1) * 1.15 + idleFrac * 0.35;
    return clamp(BASE_REWARD * (scarcity / oversupply), 2.5, 18);
  }

  /** Media intensity envelope: ramp → peak → soft land into S-curve. */
  function mediaEnvelope() {
    const level = MEDIA_LEVEL[mediaMode] || 0;
    if (level <= 0) {
      state.mediaPhase = 0;
      return 0;
    }
    const step = mediaMode === "blitz" ? 0.016 : 0.008;
    state.mediaPhase = Math.min(1, state.mediaPhase + step);
    const t = state.mediaPhase;
    let env;
    if (t < 0.18) env = t / 0.18;
    else if (t < 0.62) env = 1;
    else env = Math.max(0.2, 1 - (t - 0.62) / 0.45);
    return level * env;
  }

  /**
   * Bass diffusion (discrete day):
   *   dU/dt = (p + q · U/U_max) · (U_max − U)
   */
  function bassDeltaU(U, Umax, p, q) {
    const sat = clamp(U / Math.max(1, Umax), 0, 1);
    return (p + q * sat) * (Umax - U);
  }

  /**
   * Viral coefficient K = i · c (invites × conversion).
   * Media blitz temporarily raises effective i and c.
   */
  function viralParams(mediaEnv, quality) {
    const i0 = VIRAL_I[mediaMode] || VIRAL_I.off;
    const c0 = VIRAL_C[mediaMode] || VIRAL_C.off;
    const i = i0 * (0.55 + 0.45 * Math.max(mediaEnv, mediaMode === "off" ? 0.35 : mediaEnv));
    const c = c0 * (0.65 + 0.35 * clamp(quality, 0.3, 1.4));
    return { i: i, c: c, K: i * c };
  }

  /**
   * Two-sided matching (Uber/Airbnb-style):
   *   S = min(J, κ · C / s)
   * Optional Cobb–Douglas blend: J^β · (κ C / s)^(1−β), clamped by min.
   */
  function matchServed(J, C, s) {
    const linearCap = (MATCH_KAPPA * C) / Math.max(0.5, s);
    const minMatch = Math.min(J, linearCap);
    if (J <= 0 || linearCap <= 0) return 0;
    const cd = Math.pow(J, MATCH_BETA) * Math.pow(linearCap, 1 - MATCH_BETA);
    return Math.min(J, Math.max(minMatch * 0.85, Math.min(minMatch, cd)));
  }

  /** Metcalfe-style network value index (illustrative): V ∝ U · C */
  function metcalfeIndex(U, C) {
    const raw = U * Math.max(1, C);
    // Normalize to a readable index (~1 at cold start)
    const seed = SEED_USERS * (W_SITE + W_DESKTOP * SEED_DESKTOPS + W_BROWSER * SEED_BROWSERS);
    return raw / Math.max(1, seed);
  }

  function circulatingSupply() {
    // Float narrative: initial assumption + cumulative rewards paid in sim
    return INITIAL_FLOAT + Math.max(0, state.mlcPaid);
  }

  function priceScenario(V, S) {
    // P_t = clip(P0 * (V/V0) * (S0/S)^α, floor, cap) — illustrative only
    const ratioV = Math.max(0.05, V) / V0_INDEX;
    const ratioS = Math.pow(INITIAL_FLOAT / Math.max(INITIAL_FLOAT, S), PRICE_ALPHA);
    const raw = PRICE_P0 * ratioV * ratioS;
    return clamp(raw, PRICE_FLOOR, PRICE_CAP);
  }

  function fmtUsd(n) {
    if (!isFinite(n)) return "—";
    if (n >= 10) return "$" + n.toFixed(2);
    if (n >= 1) return "$" + n.toFixed(2);
    if (n >= 0.1) return "$" + n.toFixed(3);
    return "$" + n.toFixed(4);
  }

  function pushHistory() {
    const h = state.history;
    h.day.push(state.tick + 1);
    h.users.push(state.users);
    h.compute.push(computeNodes());
    h.jobs.push(state.servedTotal);
    h.price.push(state.priceUsd);
    h.circulating.push(state.circulating);
    h.vIndex.push(state.vIndex);
    while (h.day.length > HISTORY_MAX) {
      h.day.shift();
      h.users.shift();
      h.compute.shift();
      h.jobs.shift();
      h.price.shift();
      h.circulating.shift();
      h.vIndex.shift();
    }
  }

  function reset(silent) {
    demoActive = false;
    speed = 3;
    state.site = 1;
    state.desktops = SEED_DESKTOPS;
    state.browsers = SEED_BROWSERS;
    state.users = SEED_USERS;
    state.capital = 40;
    state.attractiveness = 1;
    state.effReward = BASE_REWARD;
    state.tick = 0;
    state.servedTotal = 0;
    state.failedTotal = 0;
    state.recentServed = SEED_USERS * JOB_RATE * 0.5;
    state.recentFailRate = 0.05;
    state.recentServeRate = 0.85;
    state.outageMul = 1;
    state.growthRate = 0;
    state.mode = "cold";
    state.mediaPhase = 0;
    state.computeCatchUp = false;
    state.bassP = BASS_P.off;
    state.bassQ = BASS_Q.off;
    state.viralK = VIRAL_I.off * VIRAL_C.off;
    state.rho = COMPUTE_FRAC_FAST;
    state.serveRate = 0.85;
    state.vIndex = metcalfeIndex(SEED_USERS, capacityOf(state));
    state.mlcPaid = 0;
    state.circulating = INITIAL_FLOAT;
    state.priceUsd = PRICE_P0;
    state.history = {
      day: [1],
      users: [SEED_USERS],
      compute: [SEED_DESKTOPS + SEED_BROWSERS],
      jobs: [0],
      price: [PRICE_P0],
      circulating: [INITIAL_FLOAT],
      vIndex: [state.vIndex],
    };
    rebuildParticles();
    updateStats();
    syncLabels();
    if (!silent) {
      setMedia(mediaMode, { silent: true });
      setCaption(
        "Day 1 · 10 users · cold start — media off; Bass imitation (q) only.",
        ""
      );
      if (mediaMode !== "off") {
        setCaption(
          "Day 1 · 10 users · " +
            (mediaMode === "blitz"
              ? "media blitz armed — Bass p + viral K ready"
              : "low media — modest Bass innovation"),
          mediaMode === "blitz" ? "hot" : ""
        );
      }
    }
    drawAll();
  }

  /** One-click: cold start → media blitz → play hockey-stick in ~15–20s. */
  function runSkyrocket() {
    setFaucet(true);
    setConsensus("fast");
    el.stake.value = "2";
    syncLabels();
    reset(true);
    setMedia("blitz", { silent: true });
    demoActive = true;
    speed = DEMO_SPEED;
    setRunning(true);
    setCaption("Day 1 · 10 users · Media blitz — Bass + viral takeoff", "hot");
    drawAll();
  }

  function step() {
    const p = params();
    const slots = slotsPerJob(p);
    let cap = capacityOf(state);
    const Umax = softCapNow();
    const jobs = jobDemand(state.users);
    const mediaEnv = mediaEnvelope();
    const mediaOn = mediaEnv > 0.05;
    const rho = computeFracTarget(p);
    state.rho = rho;

    // —— Quality from prior matching (feeds Bass / viral) ——
    const qualityRaw = clamp(cap / Math.max(1, jobs * slots * 0.9), 0, 1.6);
    const quality = mediaOn ? Math.max(qualityRaw, 0.55) : qualityRaw;

    // —— A. Bass p, q (media maps → innovation p) ——
    const pBase = BASS_P[mediaMode] || BASS_P.off;
    const qBase = BASS_Q[mediaMode] || BASS_Q.off;
    const bassP =
      mediaMode === "off"
        ? pBase
        : pBase * (0.25 + 0.75 * mediaEnv) * (0.7 + 0.3 * quality);
    const bassQ = qBase * (0.85 + 0.15 * quality) * (0.9 + 0.1 * state.attractiveness);
    state.bassP = bassP;
    state.bassQ = bassQ;

    // —— B. Viral K = i · c ——
    const vir = viralParams(mediaEnv, quality);
    state.viralK = vir.K;

    // —— Demand: Bass + viral explosive term when K>1 ——
    let dU = bassDeltaU(state.users, Umax, bassP, bassQ);

    // Soft awareness floor so blitz can leave ~10 users (ads create innovators)
    if (mediaMode === "blitz") {
      dU += (18 + 220 * mediaEnv) * (0.55 + 0.45 * quality);
    } else if (mediaMode === "low") {
      dU += (3 + 22 * mediaEnv) * (0.6 + 0.4 * quality);
    } else {
      dU += 0.35;
    }

    // Explosive regime: when K>1, add consumer-internet viral compounding
    if (vir.K > 1) {
      const headroom = Math.max(0.02, 1 - state.users / Umax);
      const viralBoost =
        state.users * (vir.K - 1) * 0.085 * headroom * (0.75 + 0.25 * quality);
      dU += viralBoost;
      // Extra kick once past tiny base (network effects visible)
      if (state.users > 80) dU *= 1.12;
      if (state.users > 5000) dU *= 1.08;
    }

    const shrink = FAIL_PRESSURE * state.recentFailRate * (mediaOn ? 0.28 : 1);
    const noise = 1 + randn() * (mediaOn ? 0.03 : 0.012);
    dU = Math.max(0, dU * (1 - shrink) * noise);

    const inertia = mediaOn ? 0.28 : 0.7;
    let nextUsers = inertia * state.users + (1 - inertia) * (state.users + dU);

    if (nextUsers > Umax) {
      nextUsers = Umax + (nextUsers - Umax) * 0.1;
    }
    nextUsers = clamp(nextUsers, 8, Umax * 1.04);

    const prevUsers = state.users;
    state.users = Math.round(nextUsers);
    state.growthRate =
      prevUsers > 0 ? ((state.users - prevUsers) / prevUsers) * 100 : 0;

    // —— C. Two-sided marketplace matching ——
    const J = jobDemand(state.users);
    cap = capacityOf(state);
    const served = matchServed(J, cap, slots);
    const failed = Math.max(0, J - served);
    state.servedTotal += served;
    state.failedTotal += failed;

    const needSlots = J * slots;
    const unmetFrac = J > 0 ? failed / J : 0;
    const serveRate = J > 0 ? served / J : 1;
    state.serveRate = serveRate;
    const util = cap > 0 ? Math.min(1, needSlots / cap) : 0;
    const idleFrac = clamp(1 - util, 0, 1);
    const earnTarget = state.users * rho;
    const overRatio = (state.desktops + state.browsers) / Math.max(1, earnTarget);

    const emaA = mediaOn ? 0.55 : 0.8;
    state.recentServed = emaA * state.recentServed + (1 - emaA) * served;
    state.recentFailRate = emaA * state.recentFailRate + (1 - emaA) * unmetFrac;
    state.recentServeRate = emaA * state.recentServeRate + (1 - emaA) * serveRate;

    state.effReward = computeEffReward(unmetFrac, overRatio, idleFrac);
    state.mlcPaid += served * state.effReward;
    const rewardNorm = state.effReward / BASE_REWARD;
    state.capital = Math.max(0, state.capital + served * rewardNorm * 0.028 - 0.5);
    state.attractiveness = clamp(
      0.85 * state.attractiveness + 0.15 * (0.45 + rewardNorm * (1 - unmetFrac * 0.7)),
      0.4,
      2.2
    );

    // —— D. Compute supply: partial adjustment ΔN = λ (ρU − (D+B)) · f ——
    const ff = faucetFactor(p, state.capital);
    const stakeF = 1 / (0.55 + p.stake / 10);
    const rewardSignal = state.effReward / BASE_REWARD;
    const lambda =
      (mediaOn ? LAMBDA_MEDIA * (0.7 + 0.3 * mediaEnv) : LAMBDA_BASE) *
      ff *
      stakeF *
      (0.75 + 0.25 * rewardSignal);

    const earnMax = Math.min(
      state.users * COMPUTE_FRAC_SOFT_MAX,
      DESK_SOFT_CAP + BROW_SOFT_CAP
    );
    const deskTarget = Math.min(DESK_SOFT_CAP, Math.max(2, earnTarget * DESK_SHARE));
    const browTarget = Math.min(BROW_SOFT_CAP, Math.max(1, earnTarget * (1 - DESK_SHARE)));
    const deskCeil = Math.min(
      DESK_SOFT_CAP,
      Math.max(deskTarget * 1.15, earnMax * DESK_SHARE)
    );
    const browCeil = Math.min(
      BROW_SOFT_CAP,
      Math.max(browTarget * 1.15, earnMax * (1 - DESK_SHARE))
    );

    const nodesNow = state.desktops + state.browsers;
    const gapTotal = earnTarget - nodesNow;
    state.computeCatchUp = gapTotal > earnTarget * 0.15 && (mediaOn || unmetFrac > 0.08);

    // Allocate partial adjustment across desktops / browsers
    let dDesk = lambda * (deskTarget - state.desktops);
    let dBrow = lambda * (browTarget - state.browsers);
    // Demand boost when jobs fail (Uber cold-start: more supply when demand unmet)
    if (unmetFrac > 0.05) {
      dDesk += unmetFrac * Math.max(1, state.users * 0.002) * ff * stakeF;
      dBrow += unmetFrac * Math.max(1, state.users * 0.001) * ff * stakeF * 0.85;
    }

    const deskRoom = Math.max(0, Math.floor(deskCeil - state.desktops));
    const browRoom = Math.max(0, Math.floor(browCeil - state.browsers));
    const deskFloor =
      mediaOn && deskTarget - state.desktops > 8
        ? Math.floor((deskTarget - state.desktops) * lambda * 0.85)
        : 0;
    const browFloor =
      mediaOn && browTarget - state.browsers > 4
        ? Math.floor((browTarget - state.browsers) * lambda * 0.8)
        : 0;

    const deskJoins = Math.min(
      deskRoom,
      Math.max(poisson(Math.max(0, dDesk)), deskFloor)
    );
    const browJoins = Math.min(
      browRoom,
      Math.max(poisson(Math.max(0, dBrow)), browFloor)
    );

    // Leave rate rises with idle capacity (oversupply)
    const aboveShareSoft = nodesNow > earnTarget * 1.12;
    const aboveShareHard = nodesNow > earnMax;
    let deskLeaveLam =
      idleFrac * 0.1 * state.desktops * 0.025 +
      (aboveShareSoft
        ? (nodesNow / Math.max(1, earnTarget) - 1) * state.desktops * 0.045
        : 0);
    if (mediaOn && !aboveShareHard) deskLeaveLam *= 0.18;
    if (aboveShareHard) deskLeaveLam *= 1.45;
    deskLeaveLam = clamp(deskLeaveLam, 0, state.desktops * 0.05);
    const deskLeaves = Math.min(
      Math.max(0, state.desktops - 2),
      poisson(deskLeaveLam)
    );

    let browLeaveLam =
      (0.1 + idleFrac * 0.4) * 0.15 * state.browsers * 0.045 +
      (aboveShareSoft
        ? (nodesNow / Math.max(1, earnTarget) - 1) * state.browsers * 0.055
        : 0);
    if (mediaOn && !aboveShareHard) browLeaveLam *= 0.18;
    if (aboveShareHard) browLeaveLam *= 1.45;
    browLeaveLam = clamp(browLeaveLam, 0, state.browsers * 0.08);
    const browLeaves = Math.min(
      Math.max(0, state.browsers - 1),
      poisson(browLeaveLam)
    );

    state.desktops = Math.max(2, state.desktops + deskJoins - deskLeaves);
    state.browsers = Math.max(1, state.browsers + browJoins - browLeaves);
    state.site = 1;

    // —— E. Metcalfe readout (illustrative; does not drive users alone) ——
    state.vIndex = metcalfeIndex(state.users, capacityOf(state));
    state.circulating = circulatingSupply();
    state.priceUsd = priceScenario(state.vIndex, state.circulating);

    // Mode / narrative
    const satFrac = state.users / Umax;
    if (vir.K > 1 && mediaEnv > 0.2 && satFrac < 0.85) {
      state.mode = "skyrocket";
    } else if (
      satFrac > 0.88 ||
      (mediaMode === "blitz" && state.mediaPhase > 0.85 && state.growthRate < 4)
    ) {
      state.mode = "saturate";
    } else if (mediaMode === "low" && state.growthRate > 2) {
      state.mode = "ads";
    } else if (state.growthRate > 2) {
      state.mode = "growing";
    } else if (mediaMode === "off" && state.users < 40) {
      state.mode = "cold";
    } else {
      state.mode = "balanced";
    }

    if (demoActive && (satFrac > 0.9 || state.users >= U_MAX * 0.95)) {
      demoActive = false;
      speed = 4;
    }

    state.tick++;
    pushHistory();
    syncParticles();
    updateStats();
    updateNarrative();
    drawAll();
  }

  function regimeLabel(K) {
    return K > 1 ? "viral K>1" : "sub-viral";
  }

  function updateStats() {
    const compute = computeNodes();
    if (el.users) el.users.textContent = fmt(state.users);
    if (el.compute) el.compute.textContent = fmt(compute);
    if (el.day) el.day.textContent = dayLabel(state.tick);
    if (el.kHero) el.kHero.textContent = state.viralK.toFixed(2);
    if (el.regime) el.regime.textContent = regimeLabel(state.viralK);
    if (el.regimeBadge) {
      el.regimeBadge.classList.toggle("viral", state.viralK > 1);
      el.regimeBadge.classList.toggle("subviral", state.viralK <= 1);
      el.regimeBadge.hidden = false;
    }
    el.desktops.textContent = fmt(state.desktops);
    el.browsers.textContent = fmt(state.browsers);
    el.coords.textContent = String(state.site);
    el.served.textContent = fmt(state.servedTotal);
    if (el.media) el.media.textContent = mediaMode === "blitz" ? "blitz" : mediaMode;
    if (el.reward) el.reward.textContent = state.effReward.toFixed(1);
    if (el.p) el.p.textContent = fmtSci(state.bassP);
    if (el.q) el.q.textContent = state.bassQ.toFixed(2);
    if (el.k) el.k.textContent = state.viralK.toFixed(2);
    if (el.rho) el.rho.textContent = (state.rho * 100).toFixed(0) + "%";
    if (el.serve) el.serve.textContent = (state.serveRate * 100).toFixed(0) + "%";
    if (el.vIndex) el.vIndex.textContent = fmt(state.vIndex);
    if (el.vHero) el.vHero.textContent = fmt(state.vIndex);
    if (el.price) el.price.textContent = fmtUsd(state.priceUsd);
    if (el.circ) el.circ.textContent = fmt(state.circulating);
    if (el.priceSide) el.priceSide.textContent = fmtUsd(state.priceUsd);
    if (el.circSide) el.circSide.textContent = fmt(state.circulating);
    if (el.priceCaption) {
      el.priceCaption.textContent =
        dayLabel(state.tick) +
        " · " +
        fmtUsd(state.priceUsd) +
        " scenario · circ " +
        fmt(state.circulating) +
        " MLC · V=" +
        fmt(state.vIndex) +
        " — not a prediction";
    }
  }

  function setCaption(text, cls) {
    el.caption.textContent = text;
    el.caption.className = "sim-caption" + (cls ? " " + cls : "");
  }

  function updateNarrative() {
    const day = dayLabel(state.tick);
    const u = fmt(state.users);
    const c = fmt(computeNodes());
    const kStr = "K=" + state.viralK.toFixed(2);
    if (state.viralK > 1 && (state.mode === "skyrocket" || mediaMode === "blitz")) {
      setCaption(
        day +
          " · " +
          u +
          " users · " +
          kStr +
          " viral · " +
          c +
          " compute chasing ρ·U",
        "hot"
      );
      return;
    }
    if (state.computeCatchUp && (state.mode === "skyrocket" || mediaMode !== "off")) {
      setCaption(
        day + " · " + u + " users · " + c + " compute · partial adj. toward ρ·U",
        "hot"
      );
      return;
    }
    if (state.mode === "skyrocket") {
      setCaption(
        day + " · " + u + " users · " + kStr + " · Bass + media takeoff",
        "hot"
      );
      return;
    }
    if (state.mode === "saturate") {
      setCaption(day + " · " + u + " users · approaching U_max (soft saturation)", "warn");
      return;
    }
    if (state.mode === "ads") {
      setCaption(day + " · " + u + " users · low media lifting Bass p", "hot");
      return;
    }
    if (state.mode === "growing") {
      setCaption(day + " · " + u + " users · imitation q compounding", "hot");
      return;
    }
    if (state.mode === "cold") {
      setCaption(
        day + " · " + u + " users · cold start — media off; Bass q only",
        ""
      );
      return;
    }
    setCaption(
      day + " · " + u + " users · " + kStr + " sub-viral — live mesh → /observer",
      ""
    );
  }

  /* ——— Optional tiny sample map ——— */

  function spawnParticle(kind) {
    const ang = Math.random() * Math.PI * 2;
    const r =
      kind === "site" ? 0 : kind === "user" ? 0.2 + Math.random() * 0.4 : 0.15 + Math.random() * 0.45;
    return {
      kind,
      x: 0.5 + Math.cos(ang) * r * 0.85,
      y: 0.5 + Math.sin(ang) * r * 0.7,
      vx: (Math.random() - 0.5) * 0.001,
      vy: (Math.random() - 0.5) * 0.001,
      phase: Math.random() * Math.PI * 2,
    };
  }

  function sampleTargets() {
    const desk = Math.max(0, state.desktops);
    const brow = Math.max(0, state.browsers);
    const users = Math.max(0, state.users);
    const pop = desk + brow + users;
    const budget = DRAW_CAP - 1;
    if (pop <= 0) return { site: 1, desktop: 0, browser: 0, user: 0 };
    let nDesk = Math.max(desk > 0 ? 1 : 0, Math.round((budget * desk) / pop));
    let nBrow = Math.max(brow > 0 ? 1 : 0, Math.round((budget * brow) / pop));
    let nUser = Math.max(0, budget - nDesk - nBrow);
    let sum = nDesk + nBrow + nUser;
    while (sum > budget) {
      if (nUser > 1) nUser--;
      else if (nBrow > 1) nBrow--;
      else if (nDesk > 1) nDesk--;
      else break;
      sum = nDesk + nBrow + nUser;
    }
    return { site: 1, desktop: nDesk, browser: nBrow, user: nUser };
  }

  function rebuildParticles() {
    const want = sampleTargets();
    particles = [spawnParticle("site")];
    particles[0].x = 0.5;
    particles[0].y = 0.5;
    for (let i = 0; i < want.desktop; i++) particles.push(spawnParticle("desktop"));
    for (let i = 0; i < want.browser; i++) particles.push(spawnParticle("browser"));
    for (let i = 0; i < want.user; i++) particles.push(spawnParticle("user"));
  }

  function countKind(kind) {
    let n = 0;
    for (let i = 0; i < particles.length; i++) if (particles[i].kind === kind) n++;
    return n;
  }

  function syncParticles() {
    const want = sampleTargets();
    ["desktop", "browser", "user"].forEach((kind) => {
      let have = countKind(kind);
      const target = want[kind];
      while (have > target) {
        for (let i = particles.length - 1; i >= 0; i--) {
          if (particles[i].kind === kind) {
            particles.splice(i, 1);
            have--;
            break;
          }
        }
      }
      while (have < target) {
        particles.push(spawnParticle(kind));
        have++;
      }
    });
  }

  function drawMini() {
    if (!miniCtx || !miniCanvas) return;
    const details = document.querySelector(".sim-sample-map");
    if (details && !details.open) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = miniCanvas.clientWidth || 400;
    const cssH = 88;
    if (
      miniCanvas.width !== Math.round(cssW * dpr) ||
      miniCanvas.height !== Math.round(cssH * dpr)
    ) {
      miniCanvas.width = Math.round(cssW * dpr);
      miniCanvas.height = Math.round(cssH * dpr);
    }
    miniCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW;
    const h = cssH;
    miniCtx.fillStyle = "#020604";
    miniCtx.fillRect(0, 0, w, h);

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.kind !== "site") {
        p.x = clamp(p.x + p.vx, 0.06, 0.94);
        p.y = clamp(p.y + p.vy, 0.1, 0.9);
        p.vx *= 0.98;
        p.vy *= 0.98;
        p.vx += (Math.random() - 0.5) * 0.00015;
        p.vy += (Math.random() - 0.5) * 0.00015;
      } else {
        p.x = 0.5;
        p.y = 0.5;
      }
      const r = p.kind === "site" ? 4 : p.kind === "desktop" ? 2.2 : 1.6;
      miniCtx.beginPath();
      miniCtx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
      miniCtx.fillStyle =
        p.kind === "site"
          ? COLORS.site
          : p.kind === "desktop"
            ? COLORS.desktop
            : p.kind === "browser"
              ? COLORS.browser
              : "#00ccff";
      miniCtx.fill();
    }
  }

  /* ——— Primary line chart ——— */

  function niceMax(v) {
    if (v <= 10) return 10;
    if (v <= 20) return 20;
    if (v <= 50) return 50;
    if (v <= 100) return 100;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / exp;
    let nice;
    if (n <= 1.5) nice = 1.5;
    else if (n <= 2) nice = 2;
    else if (n <= 3) nice = 3;
    else if (n <= 5) nice = 5;
    else nice = 10;
    return nice * exp;
  }

  function drawChart() {
    pulse += 0.03;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = chartCanvas.clientWidth || 900;
    const cssH = Math.max(280, Math.round(cssW * 0.48));

    if (
      chartCanvas.width !== Math.round(cssW * dpr) ||
      chartCanvas.height !== Math.round(cssH * dpr)
    ) {
      chartCanvas.width = Math.round(cssW * dpr);
      chartCanvas.height = Math.round(cssH * dpr);
      chartCanvas.style.height = cssH + "px";
    }

    chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW;
    const h = cssH;

    chartCtx.fillStyle = "#020604";
    chartCtx.fillRect(0, 0, w, h);

    const pad = { l: 54, r: 18, t: 22, b: 40 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const hist = state.history;
    const n = hist.users.length;
    let maxY = 10;
    for (let i = 0; i < n; i++) {
      maxY = Math.max(maxY, hist.users[i], hist.compute[i], hist.jobs[i] * 0.15);
    }
    if (state.users < 200) maxY = Math.max(maxY, 200);
    else if (state.users < 5000) maxY = Math.max(maxY, state.users * 1.15);
    maxY = niceMax(maxY * 1.08);

    if (mediaMode === "blitz" && state.mode === "skyrocket") {
      const g = chartCtx.createLinearGradient(pad.l, pad.t, pad.l, pad.t + plotH);
      g.addColorStop(0, "rgba(0, 255, 136, 0.07)");
      g.addColorStop(1, "transparent");
      chartCtx.fillStyle = g;
      chartCtx.fillRect(pad.l, pad.t, plotW, plotH);
    }

    chartCtx.font = "11px 'IBM Plex Mono', monospace";
    chartCtx.fillStyle = COLORS.label;
    chartCtx.strokeStyle = COLORS.grid;
    chartCtx.lineWidth = 1;
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const t = i / yTicks;
      const y = pad.t + plotH - t * plotH;
      chartCtx.beginPath();
      chartCtx.moveTo(pad.l, y + 0.5);
      chartCtx.lineTo(pad.l + plotW, y + 0.5);
      chartCtx.stroke();
      chartCtx.textAlign = "right";
      chartCtx.textBaseline = "middle";
      chartCtx.fillText(fmt(maxY * t), pad.l - 8, y);
    }

    const xTicks = Math.min(6, Math.max(2, n - 1));
    chartCtx.textAlign = "center";
    chartCtx.textBaseline = "top";
    for (let i = 0; i <= xTicks; i++) {
      const t = i / xTicks;
      const idx = Math.min(n - 1, Math.round(t * (n - 1)));
      const x = pad.l + t * plotW;
      chartCtx.fillStyle = COLORS.label;
      chartCtx.fillText("Day " + hist.day[idx], x, pad.t + plotH + 8);
    }

    function xAt(i) {
      if (n <= 1) return pad.l;
      return pad.l + (i / (n - 1)) * plotW;
    }
    function yAt(v) {
      return pad.t + plotH - (v / maxY) * plotH;
    }

    function strokeSeries(arr, color, width, dashed, scale) {
      const s = scale || 1;
      chartCtx.beginPath();
      chartCtx.strokeStyle = color;
      chartCtx.lineWidth = width;
      chartCtx.lineJoin = "round";
      chartCtx.lineCap = "round";
      if (dashed) chartCtx.setLineDash([5, 4]);
      else chartCtx.setLineDash([]);
      for (let i = 0; i < n; i++) {
        const x = xAt(i);
        const y = yAt(arr[i] * s);
        if (i === 0) chartCtx.moveTo(x, y);
        else chartCtx.lineTo(x, y);
      }
      chartCtx.stroke();
      chartCtx.setLineDash([]);
    }

    if (n > 1) {
      chartCtx.beginPath();
      chartCtx.moveTo(xAt(0), yAt(0));
      for (let i = 0; i < n; i++) chartCtx.lineTo(xAt(i), yAt(hist.users[i]));
      chartCtx.lineTo(xAt(n - 1), yAt(0));
      chartCtx.closePath();
      const fill = chartCtx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
      fill.addColorStop(0, "rgba(0, 255, 136, 0.18)");
      fill.addColorStop(1, "rgba(0, 255, 136, 0.01)");
      chartCtx.fillStyle = fill;
      chartCtx.fill();
    }

    strokeSeries(hist.jobs, COLORS.jobs, 1.5, true, 0.15);
    strokeSeries(hist.compute, COLORS.compute, 2.2, false, 1);
    strokeSeries(hist.users, COLORS.users, 3.2, false, 1);

    if (n > 0) {
      const last = n - 1;
      [
        [hist.users[last], COLORS.users, 1],
        [hist.compute[last], COLORS.compute, 1],
      ].forEach(function (item) {
        chartCtx.beginPath();
        chartCtx.arc(xAt(last), yAt(item[0] * item[2]), 4, 0, Math.PI * 2);
        chartCtx.fillStyle = item[1];
        chartCtx.fill();
      });
    }

    chartCtx.strokeStyle = "rgba(0, 255, 136, 0.25)";
    chartCtx.lineWidth = 1;
    chartCtx.strokeRect(pad.l + 0.5, pad.t + 0.5, plotW - 1, plotH - 1);

    chartCtx.fillStyle = COLORS.label;
    chartCtx.font = "11px 'IBM Plex Mono', monospace";
    chartCtx.textAlign = "left";
    chartCtx.textBaseline = "top";
    chartCtx.fillText("users · compute · jobs (×0.15 visual)", pad.l, 6);

    // Big users + K / regime callout near chart numbers during blitz / takeoff
    if (state.mode === "skyrocket" || state.users >= 1000 || mediaMode === "blitz") {
      chartCtx.textAlign = "right";
      chartCtx.fillStyle = COLORS.users;
      chartCtx.font = "600 13px 'IBM Plex Mono', monospace";
      chartCtx.fillText(fmt(state.users) + " users", pad.l + plotW - 4, 6);
      chartCtx.font = "600 11px 'IBM Plex Mono', monospace";
      chartCtx.fillStyle = state.viralK > 1 ? "#00ff88" : COLORS.label;
      const reg = state.viralK > 1 ? "viral" : "sub-viral";
      chartCtx.fillText(
        "K=" + state.viralK.toFixed(2) + " · " + reg,
        pad.l + plotW - 4,
        22
      );
    }
  }


  function drawPriceChart() {
    if (!priceCanvas || !priceCtx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = priceCanvas.clientWidth || 900;
    const cssH = Math.max(240, Math.round(cssW * 0.4));

    if (
      priceCanvas.width !== Math.round(cssW * dpr) ||
      priceCanvas.height !== Math.round(cssH * dpr)
    ) {
      priceCanvas.width = Math.round(cssW * dpr);
      priceCanvas.height = Math.round(cssH * dpr);
      priceCanvas.style.height = cssH + "px";
    }

    priceCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW;
    const h = cssH;

    priceCtx.fillStyle = "#020604";
    priceCtx.fillRect(0, 0, w, h);

    const pad = { l: 54, r: 54, t: 22, b: 40 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const hist = state.history;
    const n = hist.price ? hist.price.length : 0;
    if (n < 1) return;

    let maxP = PRICE_P0;
    let maxS = INITIAL_FLOAT;
    for (let i = 0; i < n; i++) {
      maxP = Math.max(maxP, hist.price[i]);
      maxS = Math.max(maxS, hist.circulating[i]);
    }
    maxP = niceMax(maxP * 1.12);
    maxS = niceMax(maxS * 1.12);

    if (mediaMode === "blitz" && state.mode === "skyrocket") {
      const g = priceCtx.createLinearGradient(pad.l, pad.t, pad.l, pad.t + plotH);
      g.addColorStop(0, "rgba(255, 204, 102, 0.08)");
      g.addColorStop(1, "transparent");
      priceCtx.fillStyle = g;
      priceCtx.fillRect(pad.l, pad.t, plotW, plotH);
    }

    priceCtx.font = "11px 'IBM Plex Mono', monospace";
    priceCtx.fillStyle = COLORS.label;
    priceCtx.strokeStyle = COLORS.grid;
    priceCtx.lineWidth = 1;
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const t = i / yTicks;
      const y = pad.t + plotH - t * plotH;
      priceCtx.beginPath();
      priceCtx.moveTo(pad.l, y + 0.5);
      priceCtx.lineTo(pad.l + plotW, y + 0.5);
      priceCtx.stroke();
      priceCtx.textAlign = "right";
      priceCtx.textBaseline = "middle";
      priceCtx.fillStyle = COLORS.price;
      priceCtx.fillText(fmtUsd(maxP * t), pad.l - 8, y);
      priceCtx.textAlign = "left";
      priceCtx.fillStyle = COLORS.circ;
      priceCtx.fillText(fmt(maxS * t), pad.l + plotW + 8, y);
    }

    const xTicks = Math.min(6, Math.max(2, n - 1));
    priceCtx.textAlign = "center";
    priceCtx.textBaseline = "top";
    priceCtx.fillStyle = COLORS.label;
    for (let i = 0; i <= xTicks; i++) {
      const t = i / xTicks;
      const idx = Math.min(n - 1, Math.round(t * (n - 1)));
      const x = pad.l + t * plotW;
      priceCtx.fillText("Day " + hist.day[idx], x, pad.t + plotH + 8);
    }

    function xAt(i) {
      if (n <= 1) return pad.l;
      return pad.l + (i / (n - 1)) * plotW;
    }
    function yPrice(v) {
      return pad.t + plotH - (v / maxP) * plotH;
    }
    function yCirc(v) {
      return pad.t + plotH - (v / maxS) * plotH;
    }

    // Circulating (dashed, right scale)
    if (n > 1) {
      priceCtx.beginPath();
      priceCtx.strokeStyle = COLORS.circ;
      priceCtx.lineWidth = 1.5;
      priceCtx.setLineDash([5, 4]);
      for (let i = 0; i < n; i++) {
        const x = xAt(i);
        const y = yCirc(hist.circulating[i]);
        if (i === 0) priceCtx.moveTo(x, y);
        else priceCtx.lineTo(x, y);
      }
      priceCtx.stroke();
      priceCtx.setLineDash([]);
    }

    // Price fill + line
    if (n > 1) {
      priceCtx.beginPath();
      priceCtx.moveTo(xAt(0), yPrice(0));
      for (let i = 0; i < n; i++) priceCtx.lineTo(xAt(i), yPrice(hist.price[i]));
      priceCtx.lineTo(xAt(n - 1), yPrice(0));
      priceCtx.closePath();
      const fill = priceCtx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
      fill.addColorStop(0, "rgba(255, 204, 102, 0.22)");
      fill.addColorStop(1, "rgba(255, 204, 102, 0.01)");
      priceCtx.fillStyle = fill;
      priceCtx.fill();
    }

    priceCtx.beginPath();
    priceCtx.strokeStyle = COLORS.price;
    priceCtx.lineWidth = 3;
    priceCtx.lineJoin = "round";
    priceCtx.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const x = xAt(i);
      const y = yPrice(hist.price[i]);
      if (i === 0) priceCtx.moveTo(x, y);
      else priceCtx.lineTo(x, y);
    }
    priceCtx.stroke();

    if (n > 0) {
      const last = n - 1;
      priceCtx.beginPath();
      priceCtx.arc(xAt(last), yPrice(hist.price[last]), 4, 0, Math.PI * 2);
      priceCtx.fillStyle = COLORS.price;
      priceCtx.fill();
    }

    priceCtx.strokeStyle = "rgba(255, 204, 102, 0.28)";
    priceCtx.lineWidth = 1;
    priceCtx.strokeRect(pad.l + 0.5, pad.t + 0.5, plotW - 1, plotH - 1);

    priceCtx.fillStyle = COLORS.label;
    priceCtx.font = "11px 'IBM Plex Mono', monospace";
    priceCtx.textAlign = "left";
    priceCtx.textBaseline = "top";
    priceCtx.fillText("illustrative USD scenario · not a prediction", pad.l, 6);

    priceCtx.textAlign = "right";
    priceCtx.fillStyle = COLORS.price;
    priceCtx.font = "600 13px 'IBM Plex Mono', monospace";
    priceCtx.fillText(fmtUsd(state.priceUsd) + " MLC", pad.l + plotW - 4, 6);
  }

  function drawAll() {
    drawChart();
    drawPriceChart();
    drawMini();
  }

  function loop(ts) {
    if (!lastTs) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;

    if (running) {
      const p = params();
      const interval = 1000 / Math.max(0.5, p.speed);
      accum += dt;
      while (accum >= interval) {
        accum -= interval;
        step();
      }
    } else {
      drawAll();
    }

    requestAnimationFrame(loop);
  }

  function setRunning(on) {
    running = on;
    el.btnPlay.textContent = running ? "pause" : "play";
    el.liveDot.classList.toggle("paused", !running);
    if (running) accum = 0;
  }

  el.stake.addEventListener("input", syncLabels);
  el.btnFaucetOn.addEventListener("click", function () {
    setFaucet(true);
  });
  el.btnFaucetOff.addEventListener("click", function () {
    setFaucet(false);
  });
  el.btnConsFast.addEventListener("click", function () {
    setConsensus("fast");
  });
  el.btnConsVerified.addEventListener("click", function () {
    setConsensus("verified");
  });
  el.btnMediaOff.addEventListener("click", function () {
    demoActive = false;
    speed = 3;
    setMedia("off");
  });
  el.btnMediaLow.addEventListener("click", function () {
    demoActive = false;
    speed = 4;
    setMedia("low");
  });
  el.btnMediaBlitz.addEventListener("click", function () {
    speed = Math.max(speed, 6);
    setMedia("blitz");
  });
  el.btnSkyrocket.addEventListener("click", runSkyrocket);
  el.btnPlay.addEventListener("click", function () {
    setRunning(!running);
  });
  el.btnReset.addEventListener("click", function () {
    setMedia("off", { silent: true });
    reset();
    setRunning(true);
  });

  window.addEventListener("resize", drawAll);

  const sampleDetails = document.querySelector(".sim-sample-map");
  if (sampleDetails) {
    sampleDetails.addEventListener("toggle", drawMini);
  }

  setFaucet(true);
  setConsensus("fast");
  setMedia("off", { silent: true });
  syncLabels();
  reset();
  setRunning(true);
  requestAnimationFrame(loop);
})();
