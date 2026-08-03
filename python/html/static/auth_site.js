/** Maker gate — unlocks Chat/Canvas when session cookie or token is present.
 * Login itself is a normal HTML form POST to /login (sets cookies via navigation).
 */
(function () {
  "use strict";

  var TOKEN_KEY = "noeti_maker_token";
  var gate = document.getElementById("authGate");
  var app = document.querySelector("[data-auth-app]");
  var msg = document.getElementById("authMsg");
  var currentUser = null;

  function readCookie(name) {
    var parts = ("; " + document.cookie).split("; " + name + "=");
    if (parts.length < 2) return "";
    return decodeURIComponent(parts.pop().split(";").shift() || "");
  }

  function getToken() {
    try {
      var t = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";
      if (t) return t;
    } catch (e) {}
    return readCookie(TOKEN_KEY) || "";
  }

  function setToken(token) {
    try {
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.setItem(TOKEN_KEY, token);
      } else {
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(TOKEN_KEY);
      }
    } catch (e) {}
  }

  // Sync JS-readable cookie → storage on boot
  (function syncFromCookie() {
    var c = readCookie(TOKEN_KEY);
    if (c) setToken(c);
  })();

  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("/api/") === -1) return origFetch(input, init);
    var next = Object.assign({ credentials: "include" }, init || {});
    var headers = new Headers((init && init.headers) || {});
    var tok = getToken();
    if (tok && !headers.has("Authorization")) {
      headers.set("Authorization", "Bearer " + tok);
    }
    next.headers = headers;
    return origFetch(input, next);
  };

  function showQueryError() {
    try {
      var q = new URLSearchParams(window.location.search);
      var err = q.get("auth_error");
      if (err && msg) {
        msg.textContent = err;
        // Clean URL without losing path
        if (window.history && window.history.replaceState) {
          window.history.replaceState({}, "", window.location.pathname);
        }
      }
    } catch (e) {}
  }

  if (!gate || !app) {
    window.NoetiSiteAuth = {
      getUser: function () { return null; },
      isLoggedIn: function () { return !!getToken(); },
      getToken: getToken,
      openLogin: function () {},
      logout: function () { setToken(""); }
    };
    return;
  }

  function showApp(on) {
    gate.hidden = !!on;
    gate.style.display = on ? "none" : "grid";
    if (on) {
      app.hidden = false;
      app.removeAttribute("hidden");
      app.style.display = "";
    } else {
      app.hidden = true;
      app.setAttribute("hidden", "");
    }
    document.body.classList.toggle("auth-unlocked", !!on);
  }

  function unlocked(username) {
    currentUser = username || "admin";
    showApp(true);
    try {
      document.dispatchEvent(new CustomEvent("noeti:auth", { detail: { username: currentUser } }));
    } catch (e) {}
  }

  function apiMe() {
    var headers = { Accept: "application/json" };
    var tok = getToken();
    if (tok) headers.Authorization = "Bearer " + tok;
    return origFetch("/api/auth/me", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: headers
    }).then(function (res) {
      return res.json().then(function (data) {
        return { res: res, data: data };
      }).catch(function () {
        return { res: res, data: {} };
      });
    });
  }

  function refreshMe() {
    return apiMe().then(function (out) {
      if (out.res.ok && out.data && out.data.ok && out.data.username) {
        var tok = getToken() || readCookie(TOKEN_KEY);
        if (tok) setToken(tok);
        unlocked(out.data.username);
        return out.data.username;
      }
      currentUser = null;
      showApp(false);
      return null;
    }).catch(function () {
      currentUser = null;
      showApp(false);
      return null;
    });
  }

  // Native form POST to /login — do not intercept. Just show status if JS submit used.
  var form = document.getElementById("authForm");
  if (form) {
    form.addEventListener("submit", function () {
      if (msg) msg.textContent = "Signing in…";
    });
  }

  var logoutBtn = document.getElementById("btnAuthLogout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", function () {
      var tok = getToken();
      var headers = { "Content-Type": "application/json" };
      if (tok) headers.Authorization = "Bearer " + tok;
      origFetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: headers,
        body: "{}"
      }).catch(function () {}).finally(function () {
        setToken("");
        currentUser = null;
        showApp(false);
        window.location.href = window.location.pathname;
      });
    });
  }

  window.NoetiSiteAuth = {
    getUser: function () { return currentUser; },
    isLoggedIn: function () { return !!currentUser; },
    getToken: getToken,
    openLogin: function () { showApp(false); },
    logout: function () {
      if (logoutBtn) logoutBtn.click();
    },
    refresh: refreshMe
  };

  showQueryError();
  showApp(false);
  refreshMe();
})();
