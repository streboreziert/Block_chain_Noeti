(() => {
  const THEME_KEY = "noeti_theme";
  const LEGACY_KEY = "noeti_editor_theme";

  function readTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY) || localStorage.getItem(LEGACY_KEY) || "white";
      return t === "black" ? "black" : "white";
    } catch (_) {
      return "white";
    }
  }

  function applyTheme(theme) {
    const next = theme === "black" ? "black" : "white";
    document.documentElement.setAttribute("data-theme", next);
    if (document.body) document.body.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
      localStorage.setItem(LEGACY_KEY, next);
    } catch (_) {}
    const fab = document.getElementById("noetiThemeFab");
    if (fab) {
      fab.setAttribute("aria-label", next === "black" ? "Switch to light mode" : "Switch to dark mode");
      fab.setAttribute("title", next === "black" ? "Light" : "Dark");
      fab.setAttribute("aria-pressed", next === "black" ? "true" : "false");
    }
    document.querySelectorAll("[data-theme-set]").forEach((btn) => {
      btn.classList.toggle("is-on", btn.getAttribute("data-theme-set") === next);
    });
    window.dispatchEvent(new CustomEvent("noeti:theme", { detail: { theme: next } }));
    return next;
  }

  function toggleTheme() {
    applyTheme(readTheme() === "black" ? "white" : "black");
  }

  function ensureFab() {
    if (document.getElementById("noetiThemeFab")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "noetiThemeFab";
    btn.className = "theme-fab";
    btn.innerHTML = `
      <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
        <circle cx="12" cy="12" r="4"/>
        <path d="M12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/>
      </svg>
      <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20.5 14.2A8.2 8.2 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2z"/>
      </svg>
    `;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      toggleTheme();
    });

    const nav = document.querySelector(".topnav");
    if (nav) {
      let end = nav.querySelector(".nu-nav-end");
      if (!end) {
        end = document.createElement("div");
        end.className = "nu-nav-end";
        const cta = nav.querySelector(".nu-nav-cta");
        const toggle = nav.querySelector(".nav-toggle");
        if (cta) {
          cta.replaceWith(end);
          end.appendChild(cta);
        } else if (toggle) {
          nav.insertBefore(end, toggle);
        } else {
          nav.appendChild(end);
        }
        if (toggle && toggle.parentElement === nav) {
          end.appendChild(toggle);
        }
      }
      end.appendChild(btn);
      return;
    }

    btn.classList.add("is-float");
    document.body.appendChild(btn);
  }

  // Nav toggle (existing)
  const nav = document.querySelector(".topnav");
  const btn = document.querySelector(".nav-toggle");
  if (nav && btn) {
    btn.addEventListener("click", () => {
      const open = nav.classList.toggle("nav-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.querySelectorAll("ul a").forEach((a) => {
      a.addEventListener("click", () => {
        nav.classList.remove("nav-open");
        btn.setAttribute("aria-expanded", "false");
      });
    });
  }

  const boot = () => {
    applyTheme(readTheme());
    ensureFab();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Keep settings chips in sync if present
  document.addEventListener("click", (e) => {
    const set = e.target.closest?.("[data-theme-set]");
    if (!set) return;
    applyTheme(set.getAttribute("data-theme-set"));
  });

  window.NoetiTheme = { apply: applyTheme, toggle: toggleTheme, read: readTheme };
})();
