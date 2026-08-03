//! User-facing client (chat + wallet). Prefer on-disk `client/` (updatable) over compile-time embed.

use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use rust_embed::Embed;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Embed)]
#[folder = "client/"]
#[exclude = ".*"]
pub struct ClientAssets;

static CLIENT_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Directory that holds `app.html` + `static/` — can be refreshed by Check for updates.
pub fn client_root() -> Option<&'static Path> {
    CLIENT_ROOT
        .get_or_init(|| resolve_client_root())
        .as_deref()
}

/// Call after an update copies a new `client/` tree so the next request sees it.
pub fn refresh_client_root_cache() {
    // OnceLock can't reset; resolution is cheap and we re-check mtime via fs::read each request.
    // Keep for API clarity — disk paths are re-read every request when root is set.
    let _ = client_root();
}

fn resolve_client_root() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("NOETIS_CLIENT_DIR") {
        let p = PathBuf::from(dir);
        if p.join("app.html").is_file() {
            return Some(p);
        }
    }
    if let Ok(bin) = std::env::var("NOETIS_BIN_DIR") {
        let sibling = PathBuf::from(&bin).join("../client");
        if let Ok(c) = sibling.canonicalize() {
            if c.join("app.html").is_file() {
                return Some(c);
            }
        }
        // Also accept bin/client
        let nested = PathBuf::from(&bin).join("client");
        if nested.join("app.html").is_file() {
            return Some(nested);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // …/Noetis/bin/noetis-app → …/Noetis/client
            if let Some(pkg) = parent.parent() {
                let c = pkg.join("client");
                if c.join("app.html").is_file() {
                    return Some(c);
                }
            }
            // …/Contents/MacOS → …/Noetis/client (zip layout) or Resources/client
            let resources = parent.join("../Resources/client");
            if let Ok(c) = resources.canonicalize() {
                if c.join("app.html").is_file() {
                    return Some(c);
                }
            }
            let next = parent.join("client");
            if next.join("app.html").is_file() {
                return Some(next);
            }
        }
    }
    None
}

fn read_disk_asset(key: &str) -> Option<Vec<u8>> {
    let root = resolve_client_root()?; // fresh each time so updates apply without restart
    let path = root.join(key);
    // Prevent path escape
    let canon_root = root.canonicalize().ok()?;
    let canon_file = path.canonicalize().ok()?;
    if !canon_file.starts_with(&canon_root) {
        return None;
    }
    std::fs::read(canon_file).ok()
}

pub fn asset_response(path: &str) -> Response {
    let clean = path.trim_start_matches('/');
    let key = if clean.is_empty() || clean == "app" || clean == "mobile" {
        "app.html"
    } else {
        clean
    };

    let mut body = if let Some(bytes) = read_disk_asset(key) {
        bytes
    } else {
        match ClientAssets::get(key) {
            Some(file) => file.data.into_owned(),
            None => return (StatusCode::NOT_FOUND, "not found").into_response(),
        }
    };

    if key.ends_with(".html") {
        if let Ok(text) = String::from_utf8(body.clone()) {
            body = text.replace("{{HUB_URL}}", "").into_bytes();
        }
    }
    let mime = mime_guess::from_path(key)
        .first_or_octet_stream()
        .to_string();
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CACHE_CONTROL,
                "no-store, no-cache, must-revalidate".into(),
            ),
        ],
        body,
    )
        .into_response()
}

pub fn render_app_html(hub_url: &str) -> Html<String> {
    let raw = read_disk_asset("app.html")
        .and_then(|b| String::from_utf8(b).ok())
        .or_else(|| {
            ClientAssets::get("app.html")
                .map(|f| String::from_utf8_lossy(&f.data).into_owned())
        })
        .unwrap_or_else(|| "<h1>client missing</h1>".into());
    Html(raw.replace("{{HUB_URL}}", hub_url.trim_end_matches('/')))
}

pub fn download_page_html(release_base: &str) -> Html<String> {
    let base = release_base.trim_end_matches('/');
    Html(format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Download Noetis</title>
<style>
  :root {{ --bg:#030806; --text:#c8ffd8; --accent:#00ff88; --muted:#5a8f6a; --mono:"IBM Plex Mono",ui-monospace,monospace; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; font-family:var(--mono); background:radial-gradient(ellipse 70% 50% at 50% -10%,rgba(0,255,136,.08),transparent),var(--bg); color:var(--text); min-height:100vh; }}
  main {{ max-width:860px; margin:0 auto; padding:56px 24px 80px; }}
  h1 {{ font-size:clamp(1.7rem,4vw,2.4rem); font-weight:500; margin:0 0 10px; }}
  p.lead {{ color:var(--muted); line-height:1.55; margin:0 0 32px; max-width:36rem; }}
  .grid {{ display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }}
  a.card {{ display:block; padding:16px; border:1px solid rgba(0,255,136,.22); background:rgba(0,255,136,.03); color:inherit; text-decoration:none; }}
  a.card:hover {{ border-color:var(--accent); background:rgba(0,255,136,.08); }}
  a.card strong {{ display:block; color:var(--accent); margin-bottom:6px; }}
  a.card span {{ color:var(--muted); font-size:.82rem; line-height:1.4; }}
  code {{ color:var(--accent); font-size:.82rem; }}
  .note {{ margin-top:32px; padding:14px; border-left:2px solid var(--accent); color:var(--muted); line-height:1.55; }}
</style>
</head>
<body>
<main>
  <h1>Download</h1>
  <p class="lead">Unzip → START for your OS → pick Chat or Earn. Updates refresh the UI too.</p>
  <div class="grid">
    <a class="card" href="{base}/noetis-macos-aarch64.zip"><strong>macOS · Apple Silicon</strong><span>START Noetis.command</span></a>
    <a class="card" href="{base}/noetis-macos-x86_64.zip"><strong>macOS · Intel</strong><span>START Noetis.command</span></a>
    <a class="card" href="{base}/noetis-windows-x86_64.zip"><strong>Windows</strong><span>START Noetis.bat</span></a>
    <a class="card" href="{base}/noetis-linux-x86_64.zip"><strong>Linux · x86_64</strong><span>START Noetis.sh</span></a>
    <a class="card" href="{base}/noetis-linux-aarch64.zip"><strong>Linux · ARM64</strong><span>START Noetis.sh</span></a>
    <a class="card" href="/mobile/"><strong>Phone</strong><span>Add to Home Screen</span></a>
  </div>
  <div class="note">
    <code>curl -sSL https://noeticompute.com/install.sh | bash</code>
  </div>
</main>
</body>
</html>"##
    ))
}
