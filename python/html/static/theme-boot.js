/**
 * Early theme boot — include in <head> before paint.
 * Shared key: noeti_theme (migrates noeti_editor_theme).
 */
(function () {
  try {
    var t = localStorage.getItem("noeti_theme") || localStorage.getItem("noeti_editor_theme") || "white";
    if (t !== "black") t = "white";
    document.documentElement.setAttribute("data-theme", t);
    if (document.body) document.body.setAttribute("data-theme", t);
  } catch (e) {}
})();
