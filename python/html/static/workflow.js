(() => {
  const form = document.getElementById("wfForm");
  const query = document.getElementById("wfQuery");
  const msg = document.getElementById("wfMsg");
  const runBtn = document.getElementById("wfRun");
  const stepsEl = document.getElementById("wfSteps");
  const gateEl = document.getElementById("wfGate");
  const grid = document.getElementById("wfGrid");
  const sourcesEl = document.getElementById("wfSources");
  const graphEl = document.getElementById("wfGraph");
  const judgesSec = document.getElementById("wfJudges");
  const judgeBoard = document.getElementById("wfJudgeBoard");
  const togglesEl = document.getElementById("wfJudgeToggles");
  const pipeline = document.getElementById("wfPipeline");
  const live = document.getElementById("wfLive");
  const liveLabel = document.getElementById("wfLiveLabel");
  const activitySec = document.getElementById("wfActivity");
  const activityList = document.getElementById("wfActivityList");
  if (!form) return;

  const DEFAULT_JUDGES = [
    { role: "speed_judge", label: "Speed judge (0.5B)", id: "qwen2.5:0.5b", prompt: "Fast triage" },
    { role: "balance_judge", label: "Balance judge (1.5B)", id: "qwen2.5:1.5b", prompt: "Weigh sources" },
    { role: "skeptic_judge", label: "Skeptic judge (0.5B)", id: "qwen2.5:0.5b", prompt: "Hostile skeptic" },
    { role: "editor_judge", label: "Editor judge (1.5B)", id: "qwen2.5:1.5b", prompt: "Publish gate" },
    { role: "wire_judge", label: "Wire judge (0.5B)", id: "qwen2.5:0.5b", prompt: "Prefer primaries" },
  ];

  let judgeDefs = DEFAULT_JUDGES.slice();
  const STAGE_ORDER = ["search", "atomize", "graph", "judges", "gate"];
  let animTimer = null;

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setPipeline(active, doneThrough) {
    if (!pipeline) return;
    const items = [...pipeline.querySelectorAll("li")];
    items.forEach((li) => {
      const stage = li.dataset.stage;
      li.classList.remove("is-active", "is-done");
      const idx = STAGE_ORDER.indexOf(stage);
      if (doneThrough != null && idx <= doneThrough) li.classList.add("is-done");
      if (stage === active) li.classList.add("is-active");
    });
  }

  function startLocalAnim() {
    live.hidden = false;
    let i = 0;
    const labels = [
      "Searching internet + wire…",
      "Atomizing on smallest worker…",
      "Drawing sourcing graph…",
      "Multi-judge panel voting…",
      "Publish gate deciding…",
    ];
    setPipeline(STAGE_ORDER[0], -1);
    liveLabel.textContent = labels[0];
    clearInterval(animTimer);
    animTimer = setInterval(() => {
      i = (i + 1) % STAGE_ORDER.length;
      setPipeline(STAGE_ORDER[i], i - 1);
      liveLabel.textContent = labels[i];
    }, 1400);
  }

  function stopLocalAnim(finalStage) {
    clearInterval(animTimer);
    animTimer = null;
    setPipeline(finalStage || "gate", STAGE_ORDER.length - 1);
    liveLabel.textContent = "Desk complete";
  }

  function renderToggles(list) {
    togglesEl.innerHTML = list
      .map(
        (j) => `<label class="wf-toggle">
        <input type="checkbox" name="judge" value="${esc(j.role)}" checked data-model="${esc(j.id)}" />
        <span>
          <strong>${esc(j.label)}</strong>
          <em>${esc(j.id)}</em>
          <small>${esc(j.prompt || "")}</small>
        </span>
      </label>`
      )
      .join("");
  }

  function selectedRoles() {
    return [...togglesEl.querySelectorAll('input[name="judge"]:checked')].map((el) => el.value);
  }

  function renderGraph(graph) {
    const nodes = graph?.nodes || [];
    const edges = graph?.edges || [];
    const w = 640,
      h = 360;
    const typed = { desk: [], claim: [], channel: [], source: [] };
    nodes.forEach((n) => (typed[n.type] || (typed[n.type] = [])).push(n));
    const pos = {};
    function layout(list, y) {
      const n = Math.max(list.length, 1);
      list.forEach((node, i) => {
        pos[node.id] = { x: 40 + ((w - 80) * (i + 1)) / (n + 1), y };
      });
    }
    layout(typed.desk || [], 40);
    layout(typed.channel || [], 110);
    layout(typed.source || [], 200);
    layout(typed.claim || [], 300);

    let lines = "";
    edges.forEach((e, idx) => {
      const a = pos[e.from],
        b = pos[e.to];
      if (!a || !b) return;
      const op = e.rel === "supports" ? 0.55 : 0.22;
      lines += `<line class="wf-edge" style="--d:${idx * 40}ms" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#111" stroke-opacity="${op}" stroke-width="1"/>`;
    });
    let circles = "";
    nodes.forEach((n, idx) => {
      const p = pos[n.id];
      if (!p) return;
      const r = n.type === "desk" ? 10 : n.type === "claim" ? 8 : 6;
      const fill = n.type === "claim" ? "#111" : n.type === "source" ? "#555" : "#999";
      circles += `<circle class="wf-node" style="--d:${200 + idx * 35}ms" cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}"></circle>`;
      circles += `<text class="wf-node-label" style="--d:${260 + idx * 35}ms" x="${p.x}" y="${p.y + 18}" text-anchor="middle" font-size="9" fill="#666">${esc((n.label || "").slice(0, 18))}</text>`;
    });
    graphEl.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="360">${lines}${circles}</svg>
      <p class="dim">${graph.stats?.claims || 0} claims · ${graph.stats?.sources || 0} sources · ${graph.stats?.edges || 0} edges</p>`;
  }

  function renderActivity(rows) {
    activitySec.hidden = false;
    activityList.innerHTML = "";
    (rows || []).forEach((row, i) => {
      const li = document.createElement("li");
      li.className = `wf-act wf-act-${esc(row.stage || "step")} wf-act-in`;
      li.style.setProperty("--d", `${i * 70}ms`);
      const meta = [
        row.model ? `<code>${esc(row.model)}</code>` : "",
        row.role ? `<span class="wf-pill">${esc(row.role)}</span>` : "",
        row.verdict ? `<span class="wf-verdict ${esc(row.verdict)}">${esc(row.verdict)}</span>` : "",
        row.latency_ms != null ? `<span class="dim">${esc(row.latency_ms)}ms</span>` : "",
      ]
        .filter(Boolean)
        .join(" ");
      li.innerHTML = `<header><strong>${esc(row.actor)}</strong>${meta}</header>
        <p>${esc(row.did)}</p>
        ${row.reason ? `<p class="dim">${esc(row.reason)}</p>` : ""}
        ${row.claim ? `<p class="wf-act-claim">${esc(row.claim)}</p>` : ""}`;
      activityList.appendChild(li);
    });
  }

  async function loadJudges() {
    try {
      const res = await fetch("/api/workflow/judges");
      const data = await res.json();
      if (data.ok && Array.isArray(data.judges) && data.judges.length) {
        judgeDefs = data.judges;
      }
    } catch (_) {
      /* keep defaults */
    }
    renderToggles(judgeDefs);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const roles = selectedRoles();
    if (!roles.length) {
      msg.textContent = "Enable at least one judge in settings.";
      return;
    }
    msg.textContent = "Running local animated desk…";
    runBtn.disabled = true;
    stepsEl.hidden = gateEl.hidden = grid.hidden = judgesSec.hidden = activitySec.hidden = true;
    startLocalAnim();
    try {
      const res = await fetch("/api/workflow/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.value, judges: roles }),
      });
      const data = await res.json();
      if (!data.ok) {
        stopLocalAnim("search");
        liveLabel.textContent = "Failed";
        msg.textContent = data.message || "Workflow failed";
        return;
      }
      stopLocalAnim("gate");
      msg.textContent = `Done in ${data.latency_ms}ms · worker ${data.worker_model} · ${roles.length} judges on`;

      stepsEl.hidden = false;
      stepsEl.innerHTML = (data.steps || [])
        .map((s, i) => {
          const meta = { ...s };
          delete meta.id;
          delete meta.label;
          return `<div class="wf-step wf-step-in" style="--d:${i * 80}ms"><strong>${esc(s.label)}</strong><span>${esc(JSON.stringify(meta))}</span></div>`;
        })
        .join("");

      gateEl.hidden = false;
      gateEl.textContent = `Publish gate: ${data.summary.publish_gate} · supported ${data.summary.supported} · contested ${data.summary.contested}`;
      gateEl.className =
        "gate " +
        (data.summary.publish_gate === "ready" ? "ok" : data.summary.publish_gate === "blocked" ? "blocked" : "");

      renderActivity(data.activity || []);

      grid.hidden = false;
      sourcesEl.innerHTML =
        (data.sources || [])
          .map(
            (s, i) =>
              `<li class="wf-src-in" style="--d:${i * 60}ms"><strong>${esc(s.channel || "src")}</strong><span><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><br/>${esc(s.snippet || "")}</span></li>`
          )
          .join("") || '<li class="dim">No sources</li>';
      renderGraph(data.graph);

      judgesSec.hidden = false;
      judgeBoard.innerHTML = "";
      for (const row of data.judgements || []) {
        const art = document.createElement("article");
        art.className = "claim-card " + (row.aggregate?.final_verdict || "");
        const judges = (row.judges || [])
          .map(
            (j) => `<li class="wf-judge-row">
            <div><strong>${esc(j.label)}</strong>
              <code>${esc(j.model)}</code>
              <span class="wf-verdict ${esc(j.verdict)}">${esc(j.verdict)}</span>
              ${j.latency_ms != null ? `<span class="dim">${esc(j.latency_ms)}ms</span>` : ""}
            </div>
            <p>${esc(j.reason)}</p>
          </li>`
          )
          .join("");
        art.innerHTML = `<header><span>claim</span><em>${esc(row.aggregate?.final_verdict)}</em></header>
          <p>${esc(row.claim)}</p><ul>${judges}</ul>`;
        judgeBoard.appendChild(art);
      }
    } catch (err) {
      stopLocalAnim("search");
      liveLabel.textContent = "Error";
      msg.textContent = String(err);
    } finally {
      runBtn.disabled = false;
    }
  });

  loadJudges();
  setPipeline(null, -1);
})();
