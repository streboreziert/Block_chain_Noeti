/**
 * In-browser Earn worker — register first, then load model.
 * Registers with runtime: "browser" so the hub never mixes with Ollama majority.
 * X25519 + AES-GCM task crypto (tweetnacl) matches desktop/site hub-blind path.
 * iOS: Transformers.js first (more reliable). Android/desktop: WebLLM → Transformers.
 */
import { ensureStakeForNode, loadWallet, signTransaction } from "./wallet.js";

const HEARTBEAT_MS = 15_000;
const POLL_MS = 4_000;
const WEBLLM_TIMEOUT_MS = 45_000;
const PHONE_NODE_KEY = "noetis_phone_node_id";
const ENC_KEY_STORAGE = "noetis_browser_enc_keypair";

const DEFAULT_WEBLLM = "Qwen2.5-0.5B-Instruct-q4f16_1";
const DEFAULT_TRANSFORMERS = "Xenova/LaMini-Flan-T5-248M";
const TWEETNACL_URLS = [
  "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm",
  "https://esm.sh/tweetnacl@1.0.3",
];

let _running = false;
let _stopping = false;
let _status = "stopped"; // stopped | starting | loading_model | running | inferring
let _loopPromise = null;
let _wakeLock = null;
let _timers = { heartbeat: null, poll: null };
let _engine = null;
let _engineKind = null; // "webllm" | "transformers"
let _modelLabel = "";
let _opts = null;
let _nacl = null;
let _encPub = "";
let _encPriv = "";

function log(msg, kind = "info") {
  try {
    _opts?.onLog?.(msg, kind);
  } catch {
    /* ignore */
  }
}

function setStatus(status) {
  _status = status;
  try {
    _opts?.onStatus?.(status);
  } catch {
    /* ignore */
  }
}

function reportProgress(pct, detail) {
  try {
    _opts?.onProgress?.(pct, detail);
  } catch {
    /* ignore */
  }
  if (detail) log(detail, "info");
}

function hubBase() {
  const hub = (_opts?.hub || "").replace(/\/$/, "");
  return hub;
}

function api(path) {
  const base = hubBase();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function isIOSUA() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS desktop UA
  return navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1;
}

function provisionalModelLabel(preferred) {
  const label = String(preferred || "").trim();
  if (label.startsWith("webllm:") || label.startsWith("transformersjs:")) return label;
  if (isIOSUA()) return `transformersjs:${DEFAULT_TRANSFORMERS}`;
  return `webllm:${DEFAULT_WEBLLM}`;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const s = String(hex || "").trim();
  if (!s || s.length % 2) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function loadTweetNaCl() {
  if (_nacl) return _nacl;
  let lastErr;
  for (const url of TWEETNACL_URLS) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      const nacl = mod.default || mod.nacl || mod;
      if (!nacl?.box?.keyPair || !nacl?.scalarMult) throw new Error("tweetnacl incomplete");
      _nacl = nacl;
      return _nacl;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("tweetnacl unavailable");
}

async function ensureEncKeys() {
  if (_encPub && _encPriv) return { pub: _encPub, priv: _encPriv };
  try {
    const raw = localStorage.getItem(ENC_KEY_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.enc_pubkey && parsed?.enc_privkey) {
        _encPub = String(parsed.enc_pubkey);
        _encPriv = String(parsed.enc_privkey);
        return { pub: _encPub, priv: _encPriv };
      }
    }
  } catch {
    /* regenerate */
  }
  const nacl = await loadTweetNaCl();
  const kp = nacl.box.keyPair();
  _encPub = bytesToHex(kp.publicKey);
  _encPriv = bytesToHex(kp.secretKey);
  try {
    localStorage.setItem(
      ENC_KEY_STORAGE,
      JSON.stringify({ enc_pubkey: _encPub, enc_privkey: _encPriv })
    );
  } catch {
    /* ignore */
  }
  return { pub: _encPub, priv: _encPriv };
}

async function sharedAesKey(peerPubHex, myPrivHex) {
  const nacl = await loadTweetNaCl();
  const shared = nacl.scalarMult(hexToBytes(myPrivHex), hexToBytes(peerPubHex));
  const digest = await crypto.subtle.digest("SHA-256", shared);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function decryptTaskPayload(task, encPrivHex) {
  if (!task?.encrypted) return String(task?.prompt || "");
  if (!task.ephem_pubkey || !task.ciphertext || !task.nonce) {
    throw new Error("encrypted task missing fields");
  }
  const key = await sharedAesKey(task.ephem_pubkey, encPrivHex);
  const nonce = b64ToBytes(task.nonce);
  const cipher = b64ToBytes(task.ciphertext);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher);
  return new TextDecoder().decode(plainBuf);
}

async function encryptResponsePayload(response, hubEphemPubHex, encPrivHex) {
  const key = await sharedAesKey(hubEphemPubHex, encPrivHex);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(String(response ?? ""))
  );
  return {
    response_encrypted: true,
    response_ciphertext: bytesToB64(new Uint8Array(cipherBuf)),
    response_nonce: bytesToB64(nonce),
  };
}

async function buildAttestation(wallet, { taskId, model, response, inferenceMs, promptHash = "" }) {
  const outputHash = await sha256Hex(response);
  const modelHash = await sha256Hex(String(model || "").trim());
  const body = {
    type: "model_attestation",
    from: wallet.address,
    public_key: wallet.public_key,
    task_id: taskId,
    model,
    model_hash: modelHash,
    output_hash: outputHash,
    prompt_hash: promptHash || "",
    // integers only — avoids Python/JS float canonicalization mismatch
    inference_ms: Math.round(Number(inferenceMs) || 0),
    timestamp: Math.floor(Date.now() / 1000),
  };
  return signTransaction(wallet, body);
}

async function requestWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    _wakeLock = await navigator.wakeLock.request("screen");
    _wakeLock.addEventListener?.("release", () => {
      _wakeLock = null;
    });
    log("screen wake lock on", "ok");
  } catch (e) {
    log(`wake lock unavailable: ${e.message || e}`, "info");
  }
}

async function releaseWakeLock() {
  try {
    await _wakeLock?.release?.();
  } catch {
    /* ignore */
  }
  _wakeLock = null;
}

function phoneNodeId(preferred) {
  if (preferred && String(preferred).trim()) return String(preferred).trim();
  try {
    const existing = localStorage.getItem(PHONE_NODE_KEY);
    if (existing && existing.startsWith("phone-")) return existing;
  } catch {
    /* ignore */
  }
  const id = `phone-${Math.random().toString(36).slice(2, 10)}`;
  try {
    localStorage.setItem(PHONE_NODE_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}

function parseProgressPct(text) {
  const m = String(text || "").match(/(\d{1,3})\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

async function loadWebLLM(modelId, onProgress) {
  const urls = [
    "https://esm.run/@mlc-ai/web-llm",
    "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm",
  ];
  let lastErr;
  for (const url of urls) {
    if (_stopping) throw new Error("stopped");
    try {
      log(`loading WebLLM from ${url}…`, "info");
      const webllm = await import(/* @vite-ignore */ url);
      const CreateMLCEngine = webllm.CreateMLCEngine || webllm.default?.CreateMLCEngine;
      if (!CreateMLCEngine) throw new Error("CreateMLCEngine missing");
      const engine = await CreateMLCEngine(modelId, {
        initProgressCallback: (report) => {
          const text = report?.text || report?.progress || "";
          if (text) {
            const pct = parseProgressPct(text);
            onProgress?.(pct, String(text));
          }
        },
      });
      return { engine, modelId, kind: "webllm" };
    } catch (e) {
      lastErr = e;
      log(`WebLLM load failed (${url}): ${e.message || e}`, "err");
    }
  }
  throw lastErr || new Error("WebLLM unavailable");
}

async function loadTransformers(modelId, onProgress) {
  const urls = [
    "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2",
    "https://esm.sh/@xenova/transformers@2.17.2",
  ];
  let lastErr;
  for (const url of urls) {
    if (_stopping) throw new Error("stopped");
    try {
      log(`loading Transformers.js from ${url}…`, "info");
      onProgress?.(5, "downloading tiny browser model…");
      const mod = await import(/* @vite-ignore */ url);
      const pipeline = mod.pipeline || mod.default?.pipeline;
      if (!pipeline) throw new Error("pipeline missing");
      onProgress?.(40, "building pipeline…");
      let generator;
      try {
        generator = await pipeline("text2text-generation", modelId);
      } catch {
        generator = await pipeline("text-generation", modelId);
      }
      onProgress?.(100, "transformers model ready");
      return { engine: generator, modelId, kind: "transformers" };
    } catch (e) {
      lastErr = e;
      log(`Transformers.js load failed (${url}): ${e.message || e}`, "err");
    }
  }
  throw lastErr || new Error("Transformers.js unavailable");
}

async function ensureEngine(modelLabel) {
  if (_engine) return;
  const label = String(modelLabel || "").trim();
  let webllmId = DEFAULT_WEBLLM;
  let transformersId = DEFAULT_TRANSFORMERS;
  let forceTransformers = false;
  let forceWebllm = false;

  if (label.startsWith("transformersjs:")) {
    forceTransformers = true;
    transformersId = label.slice("transformersjs:".length) || DEFAULT_TRANSFORMERS;
  } else if (label.startsWith("webllm:")) {
    forceWebllm = true;
    webllmId = label.slice("webllm:".length) || DEFAULT_WEBLLM;
  } else if (label) {
    webllmId = label;
  }

  const ios = isIOSUA();
  // iPhone/iOS: Transformers first. Android/other: WebLLM (45s) then Transformers.
  let order;
  if (forceTransformers) order = ["transformers", "webllm"];
  else if (forceWebllm) order = ios ? ["transformers", "webllm"] : ["webllm", "transformers"];
  else if (ios) order = ["transformers", "webllm"];
  else order = ["webllm", "transformers"];

  const onProgress = (pct, text) => {
    if (pct != null) reportProgress(pct, text);
    else if (text) reportProgress(null, text);
  };

  let lastErr;
  for (const kind of order) {
    if (_stopping) throw new Error("stopped");
    try {
      if (kind === "webllm") {
        log(`trying WebLLM (${webllmId})…`, "info");
        const loaded = await withTimeout(
          loadWebLLM(webllmId, onProgress),
          WEBLLM_TIMEOUT_MS,
          "WebLLM"
        );
        _engine = loaded.engine;
        _engineKind = loaded.kind;
        _modelLabel = `webllm:${loaded.modelId}`;
        log(`browser model ready · ${_modelLabel}`, "ok");
        return;
      }
      log(`trying Transformers.js (${transformersId})…`, "info");
      const loaded = await loadTransformers(transformersId, onProgress);
      _engine = loaded.engine;
      _engineKind = loaded.kind;
      _modelLabel = `transformersjs:${loaded.modelId}`;
      log(`browser model ready · ${_modelLabel}`, "ok");
      return;
    } catch (e) {
      lastErr = e;
      if (_stopping) throw e;
      log(`${kind} unavailable — ${e.message || e}`, "info");
    }
  }
  throw lastErr || new Error("no browser inference engine available");
}

async function runInference(prompt) {
  await ensureEngine(_opts?.modelLabel || _modelLabel);
  const started = performance.now();
  let text = "";

  if (_engineKind === "webllm") {
    const reply = await _engine.chat.completions.create({
      messages: [{ role: "user", content: String(prompt || "") }],
      temperature: 0,
      top_p: 1,
      max_tokens: 1024,
    });
    text = reply?.choices?.[0]?.message?.content || "";
  } else if (_engineKind === "transformers") {
    const out = await _engine(String(prompt || ""), {
      max_new_tokens: 512,
      temperature: 0,
      do_sample: false,
    });
    if (Array.isArray(out)) {
      text = out[0]?.generated_text || out[0]?.translation_text || "";
    } else {
      text = out?.generated_text || "";
    }
    const p = String(prompt || "");
    if (text.startsWith(p)) text = text.slice(p.length).trim();
  } else {
    throw new Error("no inference engine loaded");
  }

  const inferenceMs = performance.now() - started;
  return { response: String(text || "").trim() || "(empty)", inferenceMs, model: _modelLabel };
}

async function registerNode(nodeId, wallet, modelOverride) {
  const model =
    modelOverride ||
    _modelLabel ||
    _opts?.modelLabel ||
    provisionalModelLabel(_opts?.modelLabel);
  const { pub } = await ensureEncKeys();
  const res = await fetch(api("/api/compute/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_id: nodeId,
      model,
      wallet_address: wallet.address,
      runtime: "browser",
      enc_pubkey: pub,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `register HTTP ${res.status}`);
  return data;
}

async function heartbeat(nodeId) {
  const res = await fetch(api("/api/compute/heartbeat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: nodeId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `heartbeat HTTP ${res.status}`);
  }
}

async function listOffers(nodeId) {
  const res = await fetch(api(`/api/compute/offers?node_id=${encodeURIComponent(nodeId)}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `offers HTTP ${res.status}`);
  return Array.isArray(data.offers) ? data.offers : [];
}

async function claimTask(nodeId, taskId) {
  const res = await fetch(api("/api/compute/claim"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, task_id: taskId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `claim HTTP ${res.status}`);
  return data?.task_id ? data : null;
}

async function pollTask(nodeId) {
  // Mesh-first: offers → claim, then poll fallback.
  try {
    const offers = await listOffers(nodeId);
    if (offers.length) {
      const claimed = await claimTask(nodeId, offers[0].task_id);
      if (claimed) return claimed;
    }
  } catch (e) {
    log(`offers/claim: ${e.message || e}`, "info");
  }
  const res = await fetch(api(`/api/compute/poll?node_id=${encodeURIComponent(nodeId)}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `poll HTTP ${res.status}`);
  return data?.task_id ? data : null;
}

async function submitResult(nodeId, wallet, task, result) {
  let attestation = null;
  try {
    attestation = await buildAttestation(wallet, {
      taskId: task.task_id,
      model: result.model,
      response: result.response,
      inferenceMs: result.inferenceMs,
      promptHash: task.prompt_hash || "",
    });
  } catch (e) {
    log(`attestation skipped: ${e.message || e}`, "info");
  }
  const body = {
    task_id: task.task_id,
    node_id: nodeId,
    response: result.response,
    inference_ms: result.inferenceMs,
    model: result.model,
  };
  if (attestation) body.attestation = attestation;
  if (task?.encrypted && task?.ephem_pubkey && _encPriv) {
    try {
      const enc = await encryptResponsePayload(result.response, task.ephem_pubkey, _encPriv);
      Object.assign(body, enc);
      body.response = ""; // hub-blind: ciphertext only
    } catch (e) {
      log(`response encrypt failed: ${e.message || e}`, "err");
    }
  }
  const res = await fetch(api("/api/compute/result"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `result HTTP ${res.status}`);
  return data;
}

async function unregister(nodeId) {
  try {
    await fetch(api("/api/compute/unregister"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: nodeId }),
    });
  } catch {
    /* ignore */
  }
}

function clearTimers() {
  if (_timers.heartbeat) clearInterval(_timers.heartbeat);
  if (_timers.poll) clearInterval(_timers.poll);
  _timers = { heartbeat: null, poll: null };
}

async function workerLoop() {
  const nodeId = _opts.nodeId;
  const wallet = _opts.wallet;
  let busy = false;

  const tickHeartbeat = async () => {
    if (!_running || _stopping) return;
    try {
      await heartbeat(nodeId);
    } catch (e) {
      log(`heartbeat: ${e.message || e}`, "err");
    }
  };

  const tickPoll = async () => {
    if (!_running || _stopping || busy) return;
    busy = true;
    try {
      const task = await pollTask(nodeId);
      if (!task || _stopping) return;
      let prompt = "";
      try {
        if (task.encrypted) {
          const { priv } = await ensureEncKeys();
          prompt = await decryptTaskPayload(task, priv);
        } else {
          prompt = String(task.prompt || "");
        }
      } catch (e) {
        log(`decrypt failed: ${e.message || e}`, "err");
        return;
      }
      if (!prompt) {
        log("task has no prompt (missing ciphertext and plaintext) — skipping", "err");
        return;
      }
      log(`task ${task.task_id} · inferring…`, "info");
      setStatus("inferring");
      const result = await runInference(prompt);
      if (_stopping) return;
      await submitResult(nodeId, wallet, task, result);
      log(`task ${task.task_id} done in ${result.inferenceMs.toFixed(0)}ms`, "ok");
      setStatus("running");
    } catch (e) {
      log(`poll/infer: ${e.message || e}`, "err");
      setStatus("running");
    } finally {
      busy = false;
    }
  };

  _timers.heartbeat = setInterval(tickHeartbeat, HEARTBEAT_MS);
  _timers.poll = setInterval(tickPoll, POLL_MS);
  await tickHeartbeat();
  await tickPoll();

  while (_running && !_stopping) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function start(options = {}) {
  if (_running) return { ok: true, already: true };

  const wallet = options.wallet || loadWallet();
  if (!wallet?.address || !wallet?.private_key_hex) {
    throw new Error("wallet required — create one in the app first");
  }

  const nodeId = phoneNodeId(options.nodeId);
  const provisional = provisionalModelLabel(options.modelLabel);
  _opts = {
    hub: options.hub || "",
    nodeId,
    wallet,
    modelLabel: options.modelLabel || provisional,
    onLog: options.onLog,
    onStatus: options.onStatus,
    onProgress: options.onProgress,
  };
  _modelLabel = provisional;
  _stopping = false;
  _running = true;
  setStatus("starting");
  log(`phone earn starting · ${nodeId}`, "info");

  let registered = false;
  try {
    log("ensuring stake…", "info");
    await ensureStakeForNode(wallet, nodeId, 10);
    if (_stopping) {
      _running = false;
      setStatus("stopped");
      return { ok: false, stopped: true };
    }

    // X25519 keys before register so hub-blind can encrypt tasks immediately.
    const enc = await ensureEncKeys();
    log(`e2e encrypt · ${enc.pub.slice(0, 16)}…`, "ok");

    // Register immediately so the hub shows an online browser node while the model loads.
    await registerNode(nodeId, wallet, provisional);
    registered = true;
    log(`registered · runtime=browser · ${provisional} (model loading…)`, "ok");
    if (_stopping) {
      await unregister(nodeId);
      _running = false;
      setStatus("stopped");
      return { ok: false, stopped: true };
    }

    setStatus("loading_model");
    log("loading browser model (first time can take a bit)…", "info");
    reportProgress(0, "loading model…");
    await ensureEngine(_opts.modelLabel);
    if (_stopping) {
      await unregister(nodeId);
      _running = false;
      setStatus("stopped");
      return { ok: false, stopped: true };
    }

    // Re-register / heartbeat with final model label once engine is ready.
    try {
      await registerNode(nodeId, wallet, _modelLabel);
      await heartbeat(nodeId);
      log(`model online · ${_modelLabel}`, "ok");
    } catch (e) {
      log(`re-register after model: ${e.message || e}`, "info");
    }

    await requestWakeLock();
    setStatus("running");
    reportProgress(100, "ready");
    _loopPromise = workerLoop().catch((e) => {
      log(`worker stopped: ${e.message || e}`, "err");
    });
    return { ok: true, nodeId, model: _modelLabel };
  } catch (e) {
    _running = false;
    if (registered) await unregister(nodeId);
    setStatus("stopped");
    clearTimers();
    await releaseWakeLock();
    const msg = e?.message || String(e);
    log(`phone earn failed: ${msg}`, "err");
    throw new Error(msg);
  }
}

async function stop() {
  if (!_running && !_stopping && _status === "stopped") {
    setStatus("stopped");
    return { ok: true };
  }
  _stopping = true;
  _running = false;
  clearTimers();
  const nodeId = _opts?.nodeId;
  if (nodeId) await unregister(nodeId);
  await releaseWakeLock();
  setStatus("stopped");
  log("phone earn stopped", "ok");
  _stopping = false;
  try {
    await _loopPromise;
  } catch {
    /* ignore */
  }
  _loopPromise = null;
  return { ok: true };
}

function isRunning() {
  return !!_running;
}

function getStatus() {
  return _status;
}

window.NoetiBrowserCompute = {
  start,
  stop,
  isRunning,
  getStatus,
  phoneNodeId,
};

export { start, stop, isRunning, getStatus, phoneNodeId };
