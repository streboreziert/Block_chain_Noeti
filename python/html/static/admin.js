(() => {
  const keyEl = document.getElementById("adminKey");
  const msg = document.getElementById("adminMsg");
  const panel = document.getElementById("adminPanel");
  const loginCard = document.getElementById("adminLoginCard");
  const overview = document.getElementById("adminOverview");

  function key() {
    return (keyEl?.value || localStorage.getItem("noeti_admin_key") || "").trim();
  }

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    const k = key();
    if (k) headers["X-Admin-Key"] = k;
    const res = await fetch(path, { credentials: "same-origin", ...opts, headers });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function load() {
    msg.textContent = "Loading…";
    const { res, data } = await api("/api/admin/overview");
    if (!res.ok || !data.ok) {
      msg.textContent = data.message || data.error || "Unauthorized";
      panel.hidden = true;
      loginCard.hidden = false;
      return;
    }
    msg.textContent = "OK";
    panel.hidden = false;
    loginCard.hidden = true;
    overview.textContent = JSON.stringify(data, null, 2);

    // Remote network connection banner
    try {
      const { res: gres, data: g } = await api("/api/golem/status");
      const banner = document.getElementById("golemConnBanner");
      if (banner) {
        if (gres.ok && g.ok) {
          banner.textContent = g.network || g.backend === "network"
            ? `Network catalog: connected · default ${g.model || "openai/gpt-4o-mini"}`
            : g.connected
            ? `Network: connected (${g.label}${g.network_base_url || g.golem_base_url ? " · " + (g.network_base_url || g.golem_base_url) : ""})`
            : "Network catalog not set — paste API key below to unlock the full model list.";
          banner.style.borderColor = (g.network || g.connected) ? "rgba(80,180,120,0.45)" : "rgba(200,140,60,0.45)";
        } else {
          banner.textContent = "Network status unavailable";
        }
      }
    } catch (_) {
      const banner = document.getElementById("golemConnBanner");
      if (banner) banner.textContent = "Network status unavailable";
    }

    const s = data.settings || {};
    document.getElementById("golemUrl").value = s.golem_chat_base_url || "";
    document.getElementById("golemModel").value = s.golem_chat_model || "";
    const orModel = document.getElementById("openrouterModel");
    if (orModel) orModel.value = s.openrouter_default_model || "openai/gpt-4o-mini";
    const orKey = document.getElementById("openrouterKey");
    if (orKey) orKey.placeholder = s.openrouter_api_key_set ? "Network key set — paste to replace" : "Network catalog API key";
    const caps = s.usage_caps || {};
    document.getElementById("capTrial").value = caps.trial ?? 10;
    document.getElementById("capSolo").value = caps.solo ?? 80;
    document.getElementById("capDesk").value = caps.desk ?? 400;
    document.getElementById("capNewsroom").value = caps.newsroom ?? 1500;
  }

  document.getElementById("adminLoginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "Signing in…";
    const { data } = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("adminUser").value.trim(),
        password: document.getElementById("adminPass").value,
      }),
    });
    if (!data.ok) {
      msg.textContent = data.error || "Login failed";
      return;
    }
    await load();
  });

  document.getElementById("btnLoadKey")?.addEventListener("click", () => {
    localStorage.setItem("noeti_admin_key", key());
    load();
  });

  document.getElementById("btnAdminLogout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    localStorage.removeItem("noeti_admin_key");
    panel.hidden = true;
    loginCard.hidden = false;
    msg.textContent = "Logged out";
  });

  document.getElementById("openrouterForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      openrouter_default_model: document.getElementById("openrouterModel").value.trim() || "openai/gpt-4o-mini",
    };
    const k = document.getElementById("openrouterKey").value.trim();
    if (k) body.openrouter_api_key = k;
    const { data } = await api("/api/admin/settings", { method: "POST", body: JSON.stringify(body) });
    msg.textContent = data.ok
      ? (data.settings?.openrouter_api_key_set ? "Network catalog saved — models unlocked" : "Saved (paste an API key to unlock)")
      : (data.message || "Failed");
    if (data.ok) {
      document.getElementById("openrouterKey").value = "";
      load();
    }
  });

  document.getElementById("golemForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      golem_chat_base_url: document.getElementById("golemUrl").value.trim(),
      golem_chat_model: document.getElementById("golemModel").value.trim(),
    };
    const k = document.getElementById("golemKey").value.trim();
    if (k) body.golem_chat_api_key = k;
    const { data } = await api("/api/admin/settings", { method: "POST", body: JSON.stringify(body) });
    msg.textContent = data.ok ? "Compute settings saved" : (data.message || "Failed");
    if (data.ok) load();
  });

  document.getElementById("capsForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      usage_caps: {
        trial: Number(document.getElementById("capTrial").value),
        solo: Number(document.getElementById("capSolo").value),
        desk: Number(document.getElementById("capDesk").value),
        newsroom: Number(document.getElementById("capNewsroom").value),
      },
    };
    const { data } = await api("/api/admin/settings", { method: "POST", body: JSON.stringify(body) });
    msg.textContent = data.ok ? "Caps saved" : (data.message || "Failed");
    if (data.ok) load();
  });

  document.getElementById("pullForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const model = document.getElementById("pullModel").value.trim();
    const { data } = await api("/api/admin/pull-model", { method: "POST", body: JSON.stringify({ model }) });
    msg.textContent = data.message || (data.ok ? "Pull started" : "Pull failed");
  });

  // Auto-try session if already logged in as admin
  load();
})();
