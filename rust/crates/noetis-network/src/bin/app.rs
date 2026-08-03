//! Noetis desktop app — terminal-style setup + chat/earn in one binary.
//! Auto-finds bundled `noetis-compute`, pulls Ollama models, switches User↔Compute.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::Parser;
use noetis_network::client_static::{asset_response, download_page_html, render_app_html};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

const APP_VERSION: &str = "0.5.35";
static RELAUNCH_SCHEDULED: AtomicBool = AtomicBool::new(false);

#[derive(Parser, Debug)]
#[command(name = "noetis-app", about = "Noeti — chat + earn in one app")]
struct Args {
    #[arg(long, env = "NOETIS_HUB", default_value = "https://noeticompute.com")]
    hub: String,
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 5056)]
    port: u16,
    #[arg(long)]
    no_open: bool,
    /// Empty → persistent id from data_home()/node_id.txt (pc-XXXXXXXX). Never default all machines to "desktop".
    #[arg(long, default_value = "")]
    node_id: String,
    #[arg(long, default_value = "qwen2.5:0.5b")]
    model: String,
    /// Private dual mode: chat + compute at the same time (NOETIS_DUAL_MODE=1)
    #[arg(long, env = "NOETIS_DUAL_MODE", default_value_t = false)]
    dual: bool,
}

struct AppState {
    hub: String,
    host: String,
    port: u16,
    node_id: String,
    mode: String,
    model: String,
    compute: Option<Child>,
    ollama: Option<Child>,
    last_error: Option<String>,
    last_log: Vec<String>,
    setup_busy: bool,
    setup_percent: u8,
    setup_phase: String,
    dual_mode: bool,
}

type Shared = Arc<Mutex<AppState>>;

fn push_log(state: &mut AppState, line: impl Into<String>) {
    state.last_log.push(line.into());
    if state.last_log.len() > 120 {
        let drain = state.last_log.len() - 120;
        state.last_log.drain(0..drain);
    }
}

fn set_progress(state: &mut AppState, percent: u8, phase: impl Into<String>) {
    state.setup_percent = percent.min(100);
    state.setup_phase = phase.into();
    push_log(
        state,
        format!("[{}%] {}", state.setup_percent, state.setup_phase),
    );
}

fn clear_progress(state: &mut AppState) {
    state.setup_percent = 0;
    state.setup_phase = String::new();
    state.setup_busy = false;
}

fn set_progress_shared(shared: &Shared, percent: u8, phase: impl Into<String>) {
    let mut g = shared.lock().unwrap();
    set_progress(&mut g, percent, phase);
}

fn find_sidecar(name: &str) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("NOETIS_BIN_DIR") {
        let p = PathBuf::from(&dir).join(sidecar_name(name));
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    // Prefer same folder as this binary (bundled inside Noetis.app/Contents/MacOS)
    if let Some(parent) = exe.parent() {
        let next_to_me = parent.join(sidecar_name(name));
        if next_to_me.is_file() {
            return Some(next_to_me.canonicalize().unwrap_or(next_to_me));
        }
        let resources = parent.join("../Resources/bin").join(sidecar_name(name));
        if resources.is_file() {
            return Some(resources.canonicalize().unwrap_or(resources));
        }
    }
    let mut dir = exe.parent()?.to_path_buf();
    // Walk up: MacOS → Contents → Noetis.app → Noetis → looking for bin/
    for _ in 0..8 {
        let candidates = [
            dir.join(sidecar_name(name)),
            dir.join("bin").join(sidecar_name(name)),
        ];
        for path in candidates {
            if path.is_file() {
                return Some(path.canonicalize().unwrap_or(path));
            }
        }
        if !dir.pop() {
            break;
        }
    }
    which_bin(name)
}

fn sidecar_name(name: &str) -> String {
    #[cfg(windows)]
    {
        format!("{name}.exe")
    }
    #[cfg(not(windows))]
    {
        name.to_string()
    }
}

fn which_bin(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let output = Command::new("where").arg(name).output().ok()?;
    #[cfg(not(windows))]
    let output = Command::new("which").arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout);
    let first = line.lines().next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(PathBuf::from(first))
    }
}

fn ollama_ok() -> bool {
    ureq::get("http://127.0.0.1:11434/api/tags")
        .timeout(Duration::from_secs(2))
        .call()
        .is_ok()
}

fn ollama_models() -> Vec<String> {
    let Ok(resp) = ureq::get("http://127.0.0.1:11434/api/tags")
        .timeout(Duration::from_secs(5))
        .call()
    else {
        return vec![];
    };
    let Ok(value) = resp.into_json::<Value>() else {
        return vec![];
    };
    value
        .get("models")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("name").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn data_home() -> PathBuf {
    if let Ok(v) = std::env::var("NOETIS_DATA_DIR") {
        return PathBuf::from(v);
    }
    #[cfg(target_os = "macos")]
    {
        home().join("Library/Application Support/noetis")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(|p| PathBuf::from(p).join("Noetis"))
            .unwrap_or_else(|| home().join("Noetis"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        home().join(".local/share/noetis")
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Stable per-machine compute id (`pc-` + 8 hex chars), stored in data_home()/node_id.txt.
/// Returns `(id, migrated_from_desktop)` — the flag is true only when we just replaced a
/// legacy shared `"desktop"` file, so startup can leave that ghost slot once.
fn persistent_node_id() -> (String, bool) {
    let path = data_home().join("node_id.txt");
    let mut migrated_from_desktop = false;
    if let Ok(raw) = std::fs::read_to_string(&path) {
        let id = raw.trim().to_string();
        if !id.is_empty() && !id.eq_ignore_ascii_case("desktop") {
            return (id, false);
        }
        migrated_from_desktop = id.eq_ignore_ascii_case("desktop");
        // empty or "desktop" → regenerate below
    }
    use rand::RngCore;
    let mut bytes = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut bytes);
    let id = format!("pc-{}", hex::encode(bytes));
    let _ = std::fs::create_dir_all(data_home());
    let _ = std::fs::write(&path, format!("{id}\n"));
    (id, migrated_from_desktop)
}

/// Client may send empty or legacy `"desktop"` — never let that overwrite a unique pc- id.
fn accept_node_id_override(raw: Option<String>) -> Option<String> {
    raw.and_then(|s| {
        let t = s.trim();
        if t.is_empty() || t.eq_ignore_ascii_case("desktop") {
            None
        } else {
            Some(t.to_string())
        }
    })
}

fn stop_child(slot: &mut Option<Child>) {
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Tell the network this node is leaving BEFORE killing compute (Stop Earn).
fn leave_network(hub: &str, node_id: &str) {
    let hub = hub.trim_end_matches('/');
    let url = format!("{hub}/api/compute/unregister");
    let body = json!({ "node_id": node_id });
    let _ = ureq::post(&url)
        .timeout(Duration::from_secs(8))
        .set("Content-Type", "application/json")
        .send_json(&body);
}

fn ollama_install_dir() -> PathBuf {
    data_home().join("ollama")
}

fn resolve_ollama_bin() -> Option<PathBuf> {
    if let Some(p) = which_bin("ollama") {
        return Some(p);
    }
    let local = ollama_install_dir().join("bin").join(sidecar_name("ollama"));
    if local.is_file() {
        return Some(local);
    }
    let flat = ollama_install_dir().join(sidecar_name("ollama"));
    if flat.is_file() {
        return Some(flat);
    }
    // Common install locations (Ollama.app / winget / Linux)
    let candidates: Vec<PathBuf> = {
        #[cfg(target_os = "macos")]
        {
            vec![
                PathBuf::from("/usr/local/bin/ollama"),
                PathBuf::from("/opt/homebrew/bin/ollama"),
                PathBuf::from("/Applications/Ollama.app/Contents/Resources/ollama"),
                home().join("Applications/Ollama.app/Contents/Resources/ollama"),
            ]
        }
        #[cfg(target_os = "linux")]
        {
            vec![
                PathBuf::from("/usr/local/bin/ollama"),
                PathBuf::from("/usr/bin/ollama"),
                home().join(".local/bin/ollama"),
                PathBuf::from("/usr/local/lib/ollama/ollama"),
            ]
        }
        #[cfg(target_os = "windows")]
        {
            let mut v = vec![];
            if let Some(la) = std::env::var_os("LOCALAPPDATA") {
                v.push(PathBuf::from(la).join("Programs").join("Ollama").join("ollama.exe"));
            }
            if let Some(pf) = std::env::var_os("ProgramFiles") {
                v.push(PathBuf::from(pf).join("Ollama").join("ollama.exe"));
            }
            v
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            vec![]
        }
    };
    candidates.into_iter().find(|p| p.is_file())
}

fn model_already_present(model: &str) -> bool {
    let models = ollama_models();
    models
        .iter()
        .any(|m| m == model || m.starts_with(&format!("{model}:")) || model.starts_with(&format!("{m}:")))
}

/// Pull via Ollama HTTP API — works when the daemon is up even if `ollama` CLI isn't on PATH.
fn pull_model_http(shared: &Shared, model: &str) -> Result<(), String> {
    set_progress_shared(shared, 60, format!("pulling {model} over API…"));
    let resp = ureq::post("http://127.0.0.1:11434/api/pull")
        .timeout(Duration::from_secs(3600))
        .send_json(json!({ "name": model, "stream": true }))
        .map_err(|e| format!("ollama pull API failed: {e}"))?;

    let mut reader = std::io::BufReader::new(resp.into_reader());
    let mut line = String::new();
    let mut last_log_pct: u8 = 0;
    loop {
        line.clear();
        let n = std::io::BufRead::read_line(&mut reader, &mut line)
            .map_err(|e| format!("ollama pull read failed: {e}"))?;
        if n == 0 {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(err) = v.get("error").and_then(Value::as_str) {
            return Err(format!("ollama pull: {err}"));
        }
        let status = v.get("status").and_then(Value::as_str).unwrap_or("");
        let completed = v.get("completed").and_then(Value::as_u64).unwrap_or(0);
        let total = v.get("total").and_then(Value::as_u64).unwrap_or(0);
        let mut pct = 60u8;
        let phase = if total > 0 {
            let frac = (completed as f64 / total as f64).clamp(0.0, 1.0);
            pct = 60 + (frac * 28.0) as u8;
            let mb = completed as f64 / 1_000_000.0;
            let total_mb = total as f64 / 1_000_000.0;
            format!("downloading {model}… {mb:.0}/{total_mb:.0} MB")
        } else if status == "success" {
            pct = 90;
            format!("model ready: {model}")
        } else if !status.is_empty() {
            format!("{status}")
        } else {
            format!("pulling {model}…")
        };
        {
            let mut g = shared.lock().unwrap();
            g.setup_percent = pct.min(90);
            g.setup_phase = phase.clone();
            if pct >= last_log_pct + 8 || status == "success" {
                last_log_pct = pct;
                push_log(&mut g, phase);
            }
        }
        if status == "success" {
            break;
        }
    }

    if !model_already_present(model) {
        // Some older ollama versions don't emit final success — verify tags
        std::thread::sleep(Duration::from_millis(400));
        if !model_already_present(model) {
            return Err(format!("model {model} not listed after pull"));
        }
    }
    let mut g = shared.lock().unwrap();
    g.model = model.to_string();
    set_progress(&mut g, 90, format!("model ready: {model}"));
    Ok(())
}

fn pull_model(shared: &Shared, model: &str) -> Result<(), String> {
    try_start_ollama(shared)?;
    if model_already_present(model) {
        let mut g = shared.lock().unwrap();
        g.model = model.to_string();
        set_progress(&mut g, 90, format!("model already present: {model}"));
        return Ok(());
    }

    // Prefer HTTP when daemon is up (covers "Ollama online but CLI not on PATH")
    if ollama_ok() {
        match pull_model_http(shared, model) {
            Ok(()) => return Ok(()),
            Err(err) => {
                set_progress_shared(shared, 60, format!("API pull failed ({err}) — trying CLI…"));
            }
        }
    }

    let ollama = match resolve_ollama_bin() {
        Some(p) => p,
        None => {
            // Last resort: install CLI binary, then pull
            set_progress_shared(shared, 55, "installing Ollama CLI for model pull…");
            install_ollama(shared)?
        }
    };
    set_progress_shared(shared, 60, format!("pulling model {model}…"));

    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag = stop.clone();
    let ticker_shared = shared.clone();
    let ticker = std::thread::spawn(move || {
        let mut p = 60u8;
        while !stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
            std::thread::sleep(Duration::from_secs(2));
            if p < 88 {
                p += 1;
            }
            let mut g = ticker_shared.lock().unwrap();
            if g.setup_busy {
                g.setup_percent = p;
                g.setup_phase = format!("downloading model… {p}%");
            }
        }
    });

    let status = Command::new(&ollama)
        .args(["pull", model])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("ollama pull failed: {e}"))?;

    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = ticker.join();

    if !status.success() {
        return Err(format!("ollama pull {model} failed"));
    }
    {
        let mut g = shared.lock().unwrap();
        g.model = model.to_string();
        set_progress(&mut g, 90, format!("model ready: {model}"));
    }
    Ok(())
}

fn download_url_to(url: &str, dest: &FsPath, shared: Option<&Shared>, base_pct: u8) -> Result<(), String> {
    let resp = ureq::get(url)
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let total = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut file = std::fs::File::create(dest).map_err(|e| format!("write failed: {e}"))?;
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_pct: u8 = 0;
    loop {
        let n = std::io::Read::read(&mut reader, &mut buf).map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("write failed: {e}"))?;
        done += n as u64;
        if let Some(shared) = shared {
            let span = 35u8;
            let within = if total > 0 {
                ((done * span as u64) / total) as u8
            } else {
                last_pct.saturating_add(1).min(span)
            };
            if within >= last_pct + 2 || (total == 0 && within > last_pct) {
                last_pct = within.min(span);
                let mb = done as f64 / 1_000_000.0;
                let phase = if total > 0 {
                    let total_mb = total as f64 / 1_000_000.0;
                    format!("downloading Ollama… {mb:.1}/{total_mb:.1} MB")
                } else {
                    format!("downloading Ollama… {mb:.1} MB")
                };
                let mut g = shared.lock().unwrap();
                g.setup_percent = (base_pct + last_pct).min(99);
                g.setup_phase = phase.clone();
                if last_pct % 8 == 0 {
                    push_log(&mut g, phase);
                }
            }
        }
    }
    Ok(())
}

fn install_ollama(shared: &Shared) -> Result<PathBuf, String> {
    if let Some(existing) = resolve_ollama_bin() {
        return Ok(existing);
    }

    let dir = ollama_install_dir();
    let _ = std::fs::create_dir_all(dir.join("bin"));
    set_progress_shared(shared, 8, "Ollama not found — downloading…");

    #[cfg(target_os = "macos")]
    {
        let url = "https://github.com/ollama/ollama/releases/download/v0.11.6/ollama-darwin.tgz";
        let archive = dir.join("ollama.tgz");
        download_url_to(url, &archive, Some(shared), 10)?;
        set_progress_shared(shared, 48, "extracting Ollama…");
        let status = Command::new("tar")
            .args(["-xzf", archive.to_str().unwrap_or(""), "-C", dir.to_str().unwrap_or(".")])
            .status()
            .map_err(|e| format!("tar failed: {e}"))?;
        if !status.success() {
            return Err("failed to extract ollama archive".into());
        }
        for candidate in [
            dir.join("ollama"),
            dir.join("bin").join("ollama"),
            dir.join("usr").join("bin").join("ollama"),
        ] {
            if candidate.is_file() {
                let dest = dir.join("bin").join("ollama");
                let _ = std::fs::create_dir_all(dest.parent().unwrap());
                let _ = std::fs::copy(&candidate, &dest);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
                }
                set_progress_shared(shared, 52, format!("ollama installed → {}", dest.display()));
                return Ok(dest);
            }
        }
        if let Ok(walker) = std::fs::read_dir(&dir) {
            for entry in walker.flatten() {
                let p = entry.path();
                if p.file_name().and_then(|s| s.to_str()) == Some("ollama") && p.is_file() {
                    let dest = dir.join("bin").join("ollama");
                    let _ = std::fs::copy(&p, &dest);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
                    }
                    return Ok(dest);
                }
            }
        }
        return Err("ollama archive extracted but binary not found".into());
    }

    #[cfg(target_os = "linux")]
    {
        let arch = std::env::consts::ARCH;
        let asset = match arch {
            "x86_64" => "ollama-linux-amd64.tgz",
            "aarch64" => "ollama-linux-arm64.tgz",
            _ => return Err(format!("unsupported Linux arch: {arch}")),
        };
        let url = format!("https://github.com/ollama/ollama/releases/download/v0.11.6/{asset}");
        let archive = dir.join("ollama.tgz");
        download_url_to(&url, &archive, Some(shared), 10)?;
        set_progress_shared(shared, 48, "extracting Ollama…");
        let status = Command::new("tar")
            .args(["-xzf", archive.to_str().unwrap_or(""), "-C", dir.to_str().unwrap_or(".")])
            .status()
            .map_err(|e| format!("tar failed: {e}"))?;
        if !status.success() {
            return Err("failed to extract ollama".into());
        }
        for candidate in [dir.join("bin").join("ollama"), dir.join("ollama")] {
            if candidate.is_file() {
                let dest = dir.join("bin").join("ollama");
                if candidate != dest {
                    let _ = std::fs::copy(&candidate, &dest);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
                }
                set_progress_shared(shared, 52, format!("ollama installed → {}", dest.display()));
                return Ok(dest);
            }
        }
        return Err("ollama binary missing after extract".into());
    }

    #[cfg(target_os = "windows")]
    {
        set_progress_shared(shared, 10, "installing Ollama via winget…");
        if Command::new("winget")
            .args([
                "install",
                "-e",
                "--id",
                "Ollama.Ollama",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            set_progress_shared(shared, 50, "ollama installed via winget");
            if let Some(p) = which_bin("ollama") {
                return Ok(p);
            }
            let local_app = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
            if let Some(base) = local_app {
                let candidate = base.join("Programs").join("Ollama").join("ollama.exe");
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
        let url = "https://github.com/ollama/ollama/releases/download/v0.11.6/ollama-windows-amd64.zip";
        let archive = dir.join("ollama.zip");
        download_url_to(url, &archive, Some(shared), 10)?;
        set_progress_shared(shared, 48, "extracting Ollama…");
        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    archive.display(),
                    dir.display()
                ),
            ])
            .status()
            .map_err(|e| format!("unzip failed: {e}"))?;
        if !status.success() {
            return Err("failed to extract ollama zip".into());
        }
        for candidate in [dir.join("ollama.exe"), dir.join("bin").join("ollama.exe")] {
            if candidate.is_file() {
                let dest = dir.join("bin").join("ollama.exe");
                let _ = std::fs::create_dir_all(dest.parent().unwrap());
                let _ = std::fs::copy(&candidate, &dest);
                set_progress_shared(shared, 52, format!("ollama installed → {}", dest.display()));
                return Ok(dest);
            }
        }
        return Err("ollama.exe not found after extract".into());
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err("auto-install of Ollama is not supported on this OS — install from https://ollama.com".into())
    }
}

fn try_start_ollama(shared: &Shared) -> Result<(), String> {
    if ollama_ok() {
        set_progress_shared(shared, 54, "Ollama already online");
        return Ok(());
    }
    let ollama = install_ollama(shared)?;
    set_progress_shared(shared, 54, "starting ollama serve…");
    let child = Command::new(&ollama)
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start ollama: {e}"))?;
    {
        let mut g = shared.lock().unwrap();
        g.ollama = Some(child);
    }
    for i in 0..60 {
        std::thread::sleep(Duration::from_millis(250));
        if ollama_ok() {
            set_progress_shared(shared, 58, "ollama online");
            return Ok(());
        }
        if i % 8 == 0 {
            set_progress_shared(shared, 54 + (i / 8).min(3) as u8, "waiting for Ollama…");
        }
    }
    Err("Ollama is starting — wait a few seconds and retry setup".to_string())
}

fn start_compute(shared: &Shared) -> Result<(), String> {
    {
        let mut g = shared.lock().unwrap();
        if let Some(child) = g.compute.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                return Ok(());
            }
            g.compute = None;
        }
    }
    try_start_ollama(shared)?;
    let model = {
        let g = shared.lock().unwrap();
        g.model.clone()
    };
    let models = ollama_models();
    if !models
        .iter()
        .any(|m| m == &model || m.starts_with(&format!("{}:", model)))
    {
        pull_model(shared, &model)?;
    }
    let bin = find_sidecar("noetis-compute").ok_or_else(|| {
        "noetis-compute missing. Re-download the FULL ZIP for your OS from /download (includes bin/), then use START Noeti (.command / .sh / .bat)."
            .to_string()
    })?;
    set_progress_shared(shared, 94, format!("starting compute {}", bin.display()));
    let data = data_home();
    let _ = std::fs::create_dir_all(&data);
    let (hub, node_id, model) = {
        let g = shared.lock().unwrap();
        (g.hub.clone(), g.node_id.clone(), g.model.clone())
    };

    if let Ok(exe) = std::env::current_exe() {
        let s = exe.to_string_lossy();
        if s.contains("AppTranslocation") {
            set_progress_shared(
                shared,
                94,
                "WARNING: macOS App Translocation — use START Noeti.command from the unzipped folder",
            );
        }
    }

    let mut child = Command::new(&bin)
        .args(["--hub", &hub, "--id", &node_id, "--model", &model])
        .env("NOETIS_DATA_DIR", &data)
        .current_dir(&data)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start compute: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let log_shared_out = shared.clone();
    let log_shared_err = shared.clone();
    if let Some(out) = stdout {
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(out);
            for line in std::io::BufRead::lines(reader).flatten() {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                let mut g = log_shared_out.lock().unwrap();
                push_log(&mut g, format!("compute: {trimmed}"));
            }
        });
    }
    if let Some(err) = stderr {
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(err);
            for line in std::io::BufRead::lines(reader).flatten() {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                let mut g = log_shared_err.lock().unwrap();
                push_log(&mut g, format!("compute: {trimmed}"));
                if trimmed.contains("ERROR") {
                    g.last_error = Some(trimmed);
                }
            }
        });
    }

    // Don't claim online until process stays up AND preferably registers on hub
    for i in 0..40 {
        std::thread::sleep(Duration::from_millis(250));
        match child.try_wait() {
            Ok(Some(status)) => {
                // Let stderr thread flush a moment
                std::thread::sleep(Duration::from_millis(200));
                let mut g = shared.lock().unwrap();
                let last_detail = g
                    .last_error
                    .clone()
                    .unwrap_or_else(|| format!("Compute exited ({status})"));
                push_log(&mut g, format!("compute failed: {last_detail}"));
                return Err(last_detail);
            }
            Ok(None) => {
                if i == 8 {
                    set_progress_shared(shared, 96, "compute process up — registering on hub…");
                }
            }
            Err(e) => return Err(format!("compute wait failed: {e}")),
        }
    }

    // Poll hub /api/status for this node_id
    let status_url = format!("{}/api/status", hub.trim_end_matches('/'));
    let mut seen = false;
    for _ in 0..24 {
        if let Ok(Some(status)) = child.try_wait() {
            std::thread::sleep(Duration::from_millis(200));
            let mut g = shared.lock().unwrap();
            let detail = g
                .last_error
                .clone()
                .unwrap_or_else(|| format!("Compute exited before hub register ({status})"));
            return Err(detail);
        }
        if let Ok(resp) = ureq::get(&status_url)
            .timeout(Duration::from_secs(5))
            .call()
        {
            if let Ok(v) = resp.into_json::<Value>() {
                let listed = v
                    .get("nodes")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter().any(|n| {
                            n.get("node_id").and_then(Value::as_str) == Some(node_id.as_str())
                        })
                    })
                    .unwrap_or(false);
                if listed {
                    seen = true;
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    let mut g = shared.lock().unwrap();
    g.compute = Some(child);
    if seen {
        g.last_error = None;
        let msg = format!("compute online — visible on hub as {node_id}");
        // Earn toggle (not mid-setup): log only — never leave sticky 100% for poll loop.
        // Mid-setup: brief 100%; setup_route clears after it finishes.
        if g.setup_busy {
            set_progress(&mut g, 100, msg);
        } else {
            push_log(&mut g, msg);
            clear_progress(&mut g);
        }
    } else {
        let tip = "compute running but not on hub yet — check stake / faucet (see compute: lines above)";
        push_log(&mut g, tip);
        g.last_error = Some(tip.into());
        if g.setup_busy {
            set_progress(&mut g, 98, tip);
        } else {
            clear_progress(&mut g);
        }
    }
    Ok(())
}

fn compute_running(state: &mut AppState) -> bool {
    match state.compute.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                state.compute = None;
                state.last_error = Some(format!("Compute stopped ({status})"));
                false
            }
            Err(_) => {
                state.compute = None;
                false
            }
        },
        None => false,
    }
}

fn package_version_path(bin_dir: &FsPath) -> PathBuf {
    bin_dir.parent().unwrap_or(bin_dir).join("VERSION")
}

fn resolve_bin_dir() -> Option<PathBuf> {
    std::env::var_os("NOETIS_BIN_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok().as_ref().and_then(|e| discover_package_bin(e)))
}

/// Move `bin/.pending/*` into `bin/` so updates load without a START script.
/// Safe to call at process start (before binding the port) and from relaunch sleepers.
fn apply_pending_bins(bin_dir: &FsPath) {
    let pending = bin_dir.join(".pending");
    if !pending.is_dir() {
        return;
    }
    let Ok(rd) = std::fs::read_dir(&pending) else {
        return;
    };
    for entry in rd.flatten() {
        let src = entry.path();
        if !src.is_file() {
            continue;
        }
        let Some(name) = src.file_name() else {
            continue;
        };
        let dest = bin_dir.join(name);
        if std::fs::rename(&src, &dest).is_err() {
            match std::fs::copy(&src, &dest) {
                Ok(_) => {
                    let _ = std::fs::remove_file(&src);
                }
                Err(_) => continue,
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
        }
    }
    let _ = std::fs::remove_dir_all(&pending);
}

fn read_package_version(bin_dir: &Option<PathBuf>) -> Option<String> {
    let bin_dir = bin_dir.as_ref()?;
    let path = package_version_path(bin_dir);
    let raw = std::fs::read_to_string(&path).ok()?;
    let ver = raw.trim().to_string();
    if ver.is_empty() {
        None
    } else {
        Some(ver)
    }
}

fn write_package_version(bin_dir: &FsPath, ver: &str) {
    let path = package_version_path(bin_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, format!("{}\n", ver.trim()));
}

fn pending_update_exists(bin_dir: &Option<PathBuf>) -> bool {
    bin_dir
        .as_ref()
        .map(|d| d.join(".pending").exists())
        .unwrap_or(false)
}

fn status_json(state: &mut AppState) -> Value {
    let running = compute_running(state);
    let has_bin = find_sidecar("noetis-compute").is_some();
    let models = if ollama_ok() {
        ollama_models()
    } else {
        vec![]
    };
    let message = if state.dual_mode && running {
        format!("CHAT+EARN · model={} · earning", state.model)
    } else if state.mode == "compute" && running {
        format!("COMPUTE · model={} · earning", state.model)
    } else if let Some(err) = &state.last_error {
        err.clone()
    } else if state.mode == "compute" {
        "Compute not running — tap Earn".into()
    } else {
        format!("CHAT · model={}", state.model)
    };
    let bin_dir = resolve_bin_dir();
    let package_version = read_package_version(&bin_dir)
        .unwrap_or_else(|| APP_VERSION.to_string());
    let relaunch_required =
        package_version != APP_VERSION || pending_update_exists(&bin_dir);
    json!({
        "mode": state.mode,
        "hub": state.hub,
        "node_id": state.node_id,
        "model": state.model,
        "models": models,
        "suggested_models": [
            {"id": "qwen2.5:0.5b", "label": "Tiny", "size": "~0.4 GB", "note": "fastest, weak machine"},
            {"id": "llama3.2:1b", "label": "Small", "size": "~1.3 GB", "note": "good laptop default"},
            {"id": "gemma2:2b", "label": "Medium", "size": "~1.6 GB", "note": "better answers"},
            {"id": "llama3.2:3b", "label": "Large", "size": "~2.0 GB", "note": "stronger quality"},
            {"id": "qwen2.5:7b", "label": "XL", "size": "~4.7 GB", "note": "best quality, needs RAM"}
        ],
        "compute_running": running,
        "ollama_ok": ollama_ok(),
        "ollama_path": resolve_ollama_bin().map(|p| p.display().to_string()),
        "compute_binary": has_bin,
        "compute_path": find_sidecar("noetis-compute").map(|p| p.display().to_string()),
        "can_earn": has_bin,
        "desktop": true,
        "dual_mode": state.dual_mode,
        "last_error": state.last_error,
        "log": state.last_log,
        "message": message,
        "setup_busy": state.setup_busy,
        "setup_percent": state.setup_percent,
        "setup_phase": state.setup_phase,
        "needs_onboarding": needs_onboarding(),
        "app_version": APP_VERSION,
        "package_version": package_version,
        "relaunch_required": relaunch_required,
        "help": [
            "help",
            "status",
            "setup [user|compute|both] [model]",
            "model list",
            "model use <name>",
            "model pull <name>",
            "mode user | mode compute | mode both",
            "models (sizes): qwen2.5:0.5b | llama3.2:1b | gemma2:2b | llama3.2:3b | qwen2.5:7b"
        ]
    })
}

#[derive(Deserialize)]
struct ModeBody {
    mode: String,
    #[serde(default)]
    node_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    /// When dual mode: explicitly stop the compute worker
    #[serde(default)]
    stop_compute: Option<bool>,
}

#[derive(Deserialize)]
struct ModelBody {
    model: String,
}

#[derive(Deserialize)]
struct SetupBody {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    node_id: Option<String>,
}

async fn local_status(State(shared): State<Shared>) -> Json<Value> {
    let mut g = shared.lock().unwrap();
    Json(status_json(&mut g))
}

async fn set_mode(
    State(shared): State<Shared>,
    Json(body): Json<ModeBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mode = body.mode.trim().to_lowercase();
    if mode != "user" && mode != "compute" && mode != "both" && mode != "stop" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "mode must be user, compute, both, or stop"})),
        ));
    }
    let dual = {
        let mut g = shared.lock().unwrap();
        if let Some(id) = accept_node_id_override(body.node_id) {
            g.node_id = id;
        }
        if let Some(model) = body.model.filter(|s| !s.trim().is_empty()) {
            g.model = model.trim().to_string();
        }
        let dual = g.dual_mode;
        if body.stop_compute.unwrap_or(false) || mode == "stop" {
            let hub = g.hub.clone();
            let node_id = g.node_id.clone();
            // Leave mesh first so status drops immediately (don't wait for TTL)
            drop(g);
            leave_network(&hub, &node_id);
            let mut g = shared.lock().unwrap();
            stop_child(&mut g.compute);
            g.mode = "user".into();
            g.last_error = None;
            push_log(&mut g, "earn stopped — left network");
            return Ok(Json(json!({"ok": true, "status": status_json(&mut g)})));
        }
        if mode == "both" && !dual {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "dual mode not enabled on this build"})),
            ));
        }
        g.mode = if mode == "both" { "both".into() } else { mode.clone() };
        if mode == "user" && !dual {
            let hub = g.hub.clone();
            let node_id = g.node_id.clone();
            drop(g);
            leave_network(&hub, &node_id);
            let mut g = shared.lock().unwrap();
            stop_child(&mut g.compute);
            g.last_error = None;
            push_log(&mut g, "mode → chat — left network");
            return Ok(Json(json!({"ok": true, "status": status_json(&mut g)})));
        }
        if mode == "user" && dual {
            g.last_error = None;
            push_log(&mut g, "mode → chat (earn stays if running)");
            return Ok(Json(json!({"ok": true, "status": status_json(&mut g)})));
        }
        if g.setup_busy {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error": "setup already running"})),
            ));
        }
        dual
    };
    if let Err(err) = start_compute(&shared) {
        let mut g = shared.lock().unwrap();
        g.last_error = Some(err.clone());
        push_log(&mut g, format!("error: {err}"));
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": err, "status": status_json(&mut g)})),
        ));
    }
    let mut g = shared.lock().unwrap();
    if dual && (mode == "both" || mode == "compute") {
        g.mode = "both".into();
        push_log(&mut g, "mode → chat+earn");
    }
    Ok(Json(json!({"ok": true, "status": status_json(&mut g)})))
}

async fn pull_model_route(
    State(shared): State<Shared>,
    Json(body): Json<ModelBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let model = body.model.trim().to_string();
    if model.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "model required"}))));
    }
    {
        let mut g = shared.lock().unwrap();
        if g.setup_busy {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error": "setup already running"})),
            ));
        }
        g.setup_busy = true;
        g.setup_percent = 0;
        g.setup_phase = format!("pulling {model}…");
    }
    let shared2 = shared.clone();
    let result = tokio::task::spawn_blocking(move || {
        let r = pull_model(&shared2, &model);
        let mut g = shared2.lock().unwrap();
        g.setup_busy = false;
        match r {
            Ok(()) => {
                push_log(&mut g, "model pull done");
                clear_progress(&mut g);
                Ok(status_json(&mut g))
            }
            Err(err) => {
                g.last_error = Some(err.clone());
                g.setup_phase = "failed".into();
                Err(err)
            }
        }
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()}))))?;

    match result {
        Ok(status) => Ok(Json(json!({"ok": true, "status": status}))),
        Err(err) => Err((StatusCode::BAD_REQUEST, Json(json!({"error": err})))),
    }
}

async fn setup_route(
    State(shared): State<Shared>,
    Json(body): Json<SetupBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    {
        let mut g = shared.lock().unwrap();
        if g.setup_busy {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error": "setup already running", "status": status_json(&mut g)})),
            ));
        }
        if let Some(id) = accept_node_id_override(body.node_id) {
            g.node_id = id;
        }
        if let Some(model) = body.model.filter(|s| !s.trim().is_empty()) {
            g.model = model.trim().to_string();
        }
        let mode = body
            .mode
            .as_deref()
            .unwrap_or("user")
            .trim()
            .to_lowercase();
        let dual = g.dual_mode;
        if mode == "both" && !dual {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "dual mode not enabled — use the personal build"})),
            ));
        }
        g.mode = mode;
        g.setup_busy = true;
        g.setup_percent = 1;
        g.setup_phase = "starting setup…".into();
        g.last_error = None;
        push_log(&mut g, "=== setup start ===");
    }

    let shared2 = shared.clone();
    tokio::task::spawn_blocking(move || {
        let (mode, dual) = {
            let g = shared2.lock().unwrap();
            (g.mode.clone(), g.dual_mode)
        };
        let result = (|| -> Result<(), String> {
            set_progress_shared(&shared2, 5, "checking Ollama…");
            try_start_ollama(&shared2)?;
            let model = {
                let g = shared2.lock().unwrap();
                g.model.clone()
            };
            pull_model(&shared2, &model)?;
            if mode == "compute" || mode == "both" {
                start_compute(&shared2)?;
                if dual || mode == "both" {
                    let mut g = shared2.lock().unwrap();
                    g.mode = "both".into();
                    set_progress(&mut g, 98, "chat+earn ready");
                }
            } else if !dual {
                let mut g = shared2.lock().unwrap();
                stop_child(&mut g.compute);
                set_progress(&mut g, 98, "chat ready — ask something");
            } else {
                let mut g = shared2.lock().unwrap();
                set_progress(&mut g, 98, "chat ready — turn on Earn anytime");
            }
            Ok(())
        })();

        let mut g = shared2.lock().unwrap();
        g.setup_busy = false;
        match result {
            Ok(()) => {
                mark_onboarding_done();
                push_log(&mut g, "setup complete");
                push_log(&mut g, "=== setup done ===");
                clear_progress(&mut g);
            }
            Err(err) => {
                g.last_error = Some(err.clone());
                g.setup_phase = format!("failed: {err}");
                push_log(&mut g, format!("error: {err}"));
                push_log(&mut g, "=== setup failed ===");
            }
        }
    });

    let mut g = shared.lock().unwrap();
    Ok(Json(json!({
        "ok": true,
        "started": true,
        "status": status_json(&mut g)
    })))
}

fn platform_package_name() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "noetis-macos-aarch64.zip"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "noetis-macos-x86_64.zip"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "noetis-linux-x86_64.zip"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "noetis-linux-aarch64.zip"
    }
    #[cfg(target_os = "windows")]
    {
        "noetis-windows-x86_64.zip"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        target_os = "windows"
    )))]
    {
        "noetis-macos-aarch64.zip"
    }
}

fn apply_package_update(hub: &str) -> Result<(String, String), String> {
    let hub = hub.trim_end_matches('/');
    let meta: Value = ureq::get(&format!("{hub}/api/version"))
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|e| format!("version check failed: {e}"))?
        .into_json()
        .map_err(|e| format!("version parse failed: {e}"))?;
    let remote = meta
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if remote.is_empty() {
        return Err("remote version missing".into());
    }

    let bin_dir_opt = resolve_bin_dir();
    let package_version =
        read_package_version(&bin_dir_opt).unwrap_or_else(|| APP_VERSION.to_string());

    // Already running the remote build and VERSION file matches.
    if remote == APP_VERSION && package_version == remote {
        return Ok((format!("up to date · v{APP_VERSION}"), remote));
    }

    // Package already staged at remote version with bins present — skip re-download.
    // Only force re-download if package_version != remote OR bins missing.
    if package_version == remote && APP_VERSION != remote {
        if let Some(ref bin_dir) = bin_dir_opt {
            let app_name = sidecar_name("noetis-app");
            let has_bin = bin_dir.join(&app_name).is_file()
                || bin_dir.join(".pending").join(&app_name).is_file();
            if has_bin {
                return Ok((
                    format!("already staged — restarting to load v{remote}"),
                    remote,
                ));
            }
        }
    }

    let pkg = platform_package_name();
    let url = format!("{hub}/downloads/{pkg}");
    let staging = data_home().join("updates");
    let _ = std::fs::create_dir_all(&staging);
    let archive = staging.join(pkg);
    download_url_to(&url, &archive, None, 0)?;

    let extract = staging.join("extract");
    let _ = std::fs::remove_dir_all(&extract);
    let _ = std::fs::create_dir_all(&extract);

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    archive.display(),
                    extract.display()
                ),
            ])
            .status()
            .map_err(|e| format!("unzip failed: {e}"))?;
        if !status.success() {
            return Err("failed to extract update zip".into());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Prefer unzip; fall back to tar (many Linux images lack unzip)
        let unzip_ok = Command::new("unzip")
            .args([
                "-o",
                archive.to_str().unwrap_or(""),
                "-d",
                extract.to_str().unwrap_or("."),
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !unzip_ok {
            let status = Command::new("tar")
                .args([
                    "-xf",
                    archive.to_str().unwrap_or(""),
                    "-C",
                    extract.to_str().unwrap_or("."),
                ])
                .status()
                .map_err(|e| format!("extract failed (need unzip or tar): {e}"))?;
            if !status.success() {
                return Err("failed to extract update (install unzip or use tar.gz pack)".into());
            }
        }
    }

    let bin_dir = bin_dir_opt
        .ok_or_else(|| "cannot locate package bin/ for update".to_string())?;
    let _ = std::fs::create_dir_all(&bin_dir);

    let mut copied = 0usize;
    let mut pending = 0usize;
    let walker = walkdir_bins(&extract);
    for src in walker {
        let name = src.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if !(name.starts_with("noetis-") || name == "noetis-app" || name == "noetis-app.exe") {
            continue;
        }
        let dest = bin_dir.join(&name);

        // Prefer in-place copy; fall back to bin/.pending when the running binary
        // is locked (Windows) or ETXTBSY (Linux) — relaunch / next start applies pending.
        match std::fs::copy(&src, &dest) {
            Ok(_) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
                }
                // Also refresh MacOS bundle copy when present
                if let Ok(exe) = std::env::current_exe() {
                    if let Some(macos) = exe.parent() {
                        if macos.ends_with("MacOS") {
                            let bundle_dest = macos.join(&name);
                            let _ = std::fs::copy(&src, &bundle_dest);
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::PermissionsExt;
                                let _ = std::fs::set_permissions(
                                    &bundle_dest,
                                    std::fs::Permissions::from_mode(0o755),
                                );
                            }
                        }
                    }
                }
                copied += 1;
            }
            Err(_) => {
                let pending_dir = bin_dir.join(".pending");
                let _ = std::fs::create_dir_all(&pending_dir);
                let pending_path = pending_dir.join(&name);
                std::fs::copy(&src, &pending_path)
                    .map_err(|e| format!("stage {name} failed: {e}"))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(
                        &pending_path,
                        std::fs::Permissions::from_mode(0o755),
                    );
                }
                pending += 1;
            }
        }
    }
    if copied == 0 && pending == 0 {
        // still try UI client copy below
    }

    // Refresh updatable UI (HTML/CSS/JS) so Check for updates changes the interface too
    let mut ui_files = 0usize;
    if let Some(src_client) = find_extracted_client(&extract) {
        let dest_client = bin_dir
            .parent()
            .map(|p| p.join("client"))
            .unwrap_or_else(|| bin_dir.join("client"));
        ui_files = copy_dir_recursive(&src_client, &dest_client)
            .map_err(|e| format!("UI client update failed: {e}"))?;
        // Ensure next requests prefer this folder
        std::env::set_var("NOETIS_CLIENT_DIR", &dest_client);
        noetis_network::client_static::refresh_client_root_cache();
    }

    if copied == 0 && pending == 0 && ui_files == 0 {
        return Err("update zip extracted but no noetis binaries or UI found".into());
    }

    // Prefer VERSION shipped inside the pack (matches the binaries just copied).
    // Fall back to hub /api/version only when the pack has no VERSION file.
    let installed_ver = find_extracted_package_version(&extract).unwrap_or_else(|| remote.clone());
    write_package_version(&bin_dir, &installed_ver);

    // Best-effort clear Gatekeeper quarantine so the new binary can launch.
    #[cfg(target_os = "macos")]
    {
        let pack_root = bin_dir.parent().unwrap_or(bin_dir.as_path());
        let target = pack_root.to_str().unwrap_or(".");
        let _ = Command::new("xattr")
            .args(["-cr", target])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = Command::new("xattr")
            .args(["-cr", bin_dir.to_str().unwrap_or(".")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    if pending > 0 {
        return Ok((
            format!(
                "update staged to v{installed_ver} ({copied} bins, {pending} pending, {ui_files} UI files) — restarting…"
            ),
            installed_ver,
        ));
    }
    Ok((
        format!(
            "updated to v{installed_ver} ({copied} bins, {ui_files} UI files) — restarting…"
        ),
        installed_ver,
    ))
}


fn find_extracted_package_version(extract: &FsPath) -> Option<String> {
    for p in walkdir_bins(extract) {
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name == "VERSION" {
            let raw = std::fs::read_to_string(&p).ok()?;
            let ver = raw.trim().to_string();
            if !ver.is_empty() {
                return Some(ver);
            }
        }
    }
    None
}

fn find_extracted_client(extract: &FsPath) -> Option<PathBuf> {
    for p in walkdir_bins(extract) {
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name == "app.html" {
            if let Some(parent) = p.parent() {
                if parent.file_name().and_then(|s| s.to_str()) == Some("client")
                    || parent.join("static").is_dir()
                {
                    return Some(parent.to_path_buf());
                }
            }
        }
    }
    // direct Noetis/client
    let direct = extract.join("Noetis").join("client");
    if direct.join("app.html").is_file() {
        return Some(direct);
    }
    let nested = extract.join("client");
    if nested.join("app.html").is_file() {
        return Some(nested);
    }
    None
}

fn copy_dir_recursive(src: &FsPath, dest: &FsPath) -> Result<usize, String> {
    let _ = std::fs::create_dir_all(dest);
    let mut n = 0usize;
    let mut stack = vec![src.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = std::fs::read_dir(&dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
        for entry in rd.flatten() {
            let p = entry.path();
            let rel = p.strip_prefix(src).unwrap_or(&p);
            let target = dest.join(rel);
            if p.is_dir() {
                let _ = std::fs::create_dir_all(&target);
                stack.push(p);
            } else if p.is_file() {
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::copy(&p, &target).map_err(|e| format!("copy {} failed: {e}", p.display()))?;
                n += 1;
            }
        }
    }
    Ok(n)
}

fn walkdir_bins(root: &FsPath) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                out.push(p);
            }
        }
    }
    out
}

#[derive(Deserialize)]
struct WalletImportBody {
    #[serde(default)]
    name: Option<String>,
    address: String,
    public_key: String,
    private_key_hex: String,
    #[serde(default)]
    node_id: Option<String>,
}

async fn import_wallet_route(
    State(shared): State<Shared>,
    Json(body): Json<WalletImportBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let address = body.address.trim().to_string();
    let public_key = body.public_key.trim().to_string();
    let private_key_hex = body.private_key_hex.trim().to_string();
    if address.is_empty() || public_key.is_empty() || private_key_hex.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "address, public_key, private_key_hex required"})),
        ));
    }
    if private_key_hex.len() != 64 || public_key.len() != 64 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid key lengths"})),
        ));
    }
    let node_id = {
        let g = shared.lock().unwrap();
        accept_node_id_override(body.node_id).unwrap_or_else(|| g.node_id.clone())
    };
    let name = body
        .name
        .unwrap_or_else(|| format!("compute-{node_id}"))
        .trim()
        .to_string();
    let dir = data_home().join("wallets");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("{name}.json"));
    let payload = json!({
        "name": name,
        "address": address,
        "public_key": public_key,
        "private_key_hex": private_key_hex,
    });
    let text = serde_json::to_string_pretty(&payload).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
    })?;
    std::fs::write(&path, text).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("write wallet failed: {e}")})),
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    let mut g = shared.lock().unwrap();
    push_log(
        &mut g,
        format!("earn wallet synced → {name} ({})", &address[..address.len().min(18)]),
    );
    Ok(Json(json!({
        "ok": true,
        "path": path.display().to_string(),
        "address": address,
        "status": status_json(&mut g)
    })))
}

#[derive(Deserialize)]
struct SyncBody {}

async fn local_infer(
    State(shared): State<Shared>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let text = body.get("text").and_then(Value::as_str).unwrap_or("").trim();
    let prompt = body.get("prompt").and_then(Value::as_str).unwrap_or("").trim();
    if text.is_empty() && prompt.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "text or prompt required"})),
        ));
    }
    let hub = {
        let g = shared.lock().unwrap();
        g.hub.trim_end_matches('/').to_string()
    };
    let url = format!("{hub}/api/infer");
    let result = tokio::task::spawn_blocking(move || {
        ureq::post(&url)
            .timeout(Duration::from_secs(30))
            .send_json(body)
            .map_err(|e| format!("hub infer failed: {e}"))
            .and_then(|resp| {
                resp.into_json::<Value>()
                    .map_err(|e| format!("hub infer parse failed: {e}"))
            })
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
    })?;
    match result {
        Ok(v) => {
            if v.get("task_id").and_then(Value::as_str).unwrap_or("").is_empty() {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"error": "hub response missing task_id", "body": v})),
                ));
            }
            Ok(Json(v))
        }
        Err(err) => Err((StatusCode::BAD_GATEWAY, Json(json!({"error": err})))),
    }
}

async fn local_task(
    State(shared): State<Shared>,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let task_id = task_id.trim().to_string();
    if task_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "task_id required"})),
        ));
    }
    let hub = {
        let g = shared.lock().unwrap();
        g.hub.trim_end_matches('/').to_string()
    };
    let url = format!("{hub}/api/task/{task_id}");
    let result = tokio::task::spawn_blocking(move || {
        ureq::get(&url)
            .timeout(Duration::from_secs(30))
            .call()
            .map_err(|e| format!("hub task failed: {e}"))
            .and_then(|resp| {
                resp.into_json::<Value>()
                    .map_err(|e| format!("hub task parse failed: {e}"))
            })
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
    })?;
    match result {
        Ok(v) => Ok(Json(v)),
        Err(err) => Err((StatusCode::BAD_GATEWAY, Json(json!({"error": err})))),
    }
}

async fn sync_route(
    State(shared): State<Shared>,
    Json(_body): Json<SyncBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let hub = {
        let g = shared.lock().unwrap();
        if g.setup_busy {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error": "setup already running"})),
            ));
        }
        g.hub.clone()
    };
    let shared2 = shared.clone();
    let result = tokio::task::spawn_blocking(move || {
        let (msg, updated_to) = apply_package_update(&hub)?;
        let mut g = shared2.lock().unwrap();
        push_log(&mut g, &msg);
        let status = status_json(&mut g);
        let relaunch_required = status
            .get("relaunch_required")
            .and_then(Value::as_bool)
            .unwrap_or(updated_to != APP_VERSION);
        Ok::<(String, String, bool, Value), String>((msg, updated_to, relaunch_required, status))
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()}))))?;

    match result {
        Ok((message, updated_to, relaunch_required, status)) => Ok(Json(json!({
            "ok": true,
            "updated_to": updated_to,
            "relaunch_required": relaunch_required,
            "message": message,
            "status": status
        }))),
        Err(err) => Err((StatusCode::BAD_REQUEST, Json(json!({"error": err})))),
    }
}

fn find_pack_start(bin_dir: &FsPath) -> Option<PathBuf> {
    let pack_root = bin_dir.parent().unwrap_or(bin_dir);
    #[cfg(target_os = "macos")]
    {
        for name in [
            "START Noeti.command",
            "START Noeti.sh",
            "START Noetis.command",
            "START Noetis.sh",
        ] {
            let p = pack_root.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for name in ["START Noeti.sh", "START Noetis.sh"] {
            let p = pack_root.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        for name in [
            "START Noeti.bat",
            "START Noeti.ps1",
            "START Noetis.bat",
            "START Noetis.ps1",
        ] {
            let p = pack_root.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = pack_root;
    }
    None
}

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn resolve_app_binary(bin_dir: &FsPath) -> Option<PathBuf> {
    let name = sidecar_name("noetis-app");
    let pending = bin_dir.join(".pending").join(&name);
    if pending.is_file() {
        return Some(pending);
    }
    let direct = bin_dir.join(&name);
    if direct.is_file() {
        return Some(direct);
    }
    None
}

async fn relaunch_route(
    State(shared): State<Shared>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if RELAUNCH_SCHEDULED.load(Ordering::SeqCst) {
        return Ok(Json(json!({
            "ok": true,
            "relaunching": true,
            "message": "Restarting…",
            "already_scheduled": true,
        })));
    }

    {
        let mut g = shared.lock().unwrap();
        let running = compute_running(&mut g);
        if running {
            let hub = g.hub.clone();
            let node_id = g.node_id.clone();
            drop(g);
            leave_network(&hub, &node_id);
            let mut g = shared.lock().unwrap();
            stop_child(&mut g.compute);
            g.mode = "user".into();
            push_log(&mut g, "relaunch: stopped earn · left network");
        }
    }

    let bin_dir = resolve_bin_dir().ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "cannot locate package bin/ for relaunch"})),
        )
    })?;

    let pack_root = bin_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| bin_dir.clone());

    let (hub, host, port, node_id, model, dual) = {
        let g = shared.lock().unwrap();
        (
            g.hub.clone(),
            g.host.clone(),
            g.port,
            g.node_id.clone(),
            g.model.clone(),
            g.dual_mode,
        )
    };

    let app_bin = resolve_app_binary(&bin_dir);
    let start_fallback = find_pack_start(&bin_dir);

    if app_bin.is_none() && start_fallback.is_none() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": "Couldn't auto-restart — close the app and open it again"
            })),
        ));
    }

    if RELAUNCH_SCHEDULED.swap(true, Ordering::SeqCst) {
        return Ok(Json(json!({
            "ok": true,
            "relaunching": true,
            "message": "Restarting…",
            "already_scheduled": true,
        })));
    }

    // Detached sleeper: sleep → apply pending → exec new binary (or START fallback).
    // Parent exits shortly after so the port is free before the child binds.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let bin_q = shell_single_quote(&bin_dir.to_string_lossy());
        let pack_q = shell_single_quote(&pack_root.to_string_lossy());
        let hub_q = shell_single_quote(&hub);
        let host_q = shell_single_quote(&host);
        let node_q = shell_single_quote(&node_id);
        let model_q = shell_single_quote(&model);
        let dual_flag = if dual { " --dual" } else { "" };
        let start_fallback_q = start_fallback
            .as_ref()
            .map(|p| shell_single_quote(&p.to_string_lossy()))
            .unwrap_or_default();

        let sleeper = format!(
            r#"sleep 1.5
BIN_DIR={bin_q}
PACK={pack_q}
if [ -d "$BIN_DIR/.pending" ]; then
  for f in "$BIN_DIR/.pending"/*; do
    [ -f "$f" ] || continue
    mv -f "$f" "$BIN_DIR/$(basename "$f")"
    chmod +x "$BIN_DIR/$(basename "$f")" 2>/dev/null || true
  done
  rm -rf "$BIN_DIR/.pending"
fi
command -v xattr >/dev/null 2>&1 && xattr -cr "$PACK" 2>/dev/null || true
export NOETIS_BIN_DIR="$BIN_DIR"
export NOETIS_CLIENT_DIR="$PACK/client"
export PATH="$BIN_DIR:$PATH"
APP="$BIN_DIR/noetis-app"
if [ -f "$APP" ]; then
  chmod +x "$APP" 2>/dev/null || true
  exec "$APP" --hub {hub_q} --host {host_q} --port {port} --node-id {node_q} --model {model_q}{dual_flag} --no-open
fi
START_FB={start_fallback_q}
if [ -n "$START_FB" ] && [ -f "$START_FB" ]; then
  chmod +x "$START_FB" 2>/dev/null || true
  exec "$START_FB"
fi
exit 1
"#
        );
        Command::new("sh")
            .args(["-c", &sleeper])
            .current_dir(&pack_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                RELAUNCH_SCHEDULED.store(false, Ordering::SeqCst);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "error": format!("Couldn't auto-restart ({e}) — close the app and open it again")
                    })),
                )
            })?;
    }
    #[cfg(target_os = "windows")]
    {
        let bin = bin_dir.display().to_string();
        let pack = pack_root.display().to_string();
        let app_name = sidecar_name("noetis-app");
        let dual_flag = if dual { " --dual" } else { "" };
        let start_cmd = if let Some(ref start) = start_fallback {
            let bat = start
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("START Noeti.bat");
            if bat.ends_with(".ps1") {
                format!(
                    "cd /d \"{pack}\" & powershell -NoProfile -ExecutionPolicy Bypass -File \"{bat}\""
                )
            } else {
                format!("cd /d \"{pack}\" & \"{bat}\"")
            }
        } else {
            String::new()
        };
        let inner = format!(
            r#"timeout /T 2 /NOBREAK >NUL
set "BIN_DIR={bin}"
set "PACK={pack}"
if exist "%BIN_DIR%\.pending" (
  for %%F in ("%BIN_DIR%\.pending\*") do (
    if exist "%%~fF" (
      move /Y "%%~fF" "%BIN_DIR%\%%~nxF" >NUL 2>&1
    )
  )
  rmdir /S /Q "%BIN_DIR%\.pending" >NUL 2>&1
)
set "NOETIS_BIN_DIR=%BIN_DIR%"
set "NOETIS_CLIENT_DIR=%PACK%\client"
set "PATH=%BIN_DIR%;%PATH%"
set "APP=%BIN_DIR%\{app_name}"
if exist "%APP%" (
  "%APP%" --hub "{hub}" --host "{host}" --port {port} --node-id "{node_id}" --model "{model}"{dual_flag} --no-open
  exit /B %ERRORLEVEL%
)
{start_cmd}
"#
        );
        Command::new("cmd")
            .args(["/C", "start", "", "/MIN", "cmd", "/C", &inner])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                RELAUNCH_SCHEDULED.store(false, Ordering::SeqCst);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "error": format!("Couldn't auto-restart ({e}) — close the app and open it again")
                    })),
                )
            })?;
        let _ = app_bin;
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (pack_root, app_bin, start_fallback, hub, host, port, node_id, model, dual);
        RELAUNCH_SCHEDULED.store(false, Ordering::SeqCst);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "Couldn't auto-restart — close the app and open it again"})),
        ));
    }

    std::thread::spawn(|| {
        // Let the HTTP response flush before we release the port.
        std::thread::sleep(Duration::from_millis(500));
        std::process::exit(0);
    });

    Ok(Json(json!({
        "ok": true,
        "relaunching": true,
        "message": "Restarting…"
    })))
}

#[tokio::main]
async fn main() {
    let mut args = Args::parse();
    let mut migrated_from_desktop = false;
    if args.node_id.trim().is_empty() || args.node_id.trim().eq_ignore_ascii_case("desktop") {
        let (id, migrated) = persistent_node_id();
        args.node_id = id;
        migrated_from_desktop = migrated;
    }
    let hub = args.hub.trim_end_matches('/').to_string();

    // If launched from Noetis.app, set BIN dir to sibling package bin/ when present
    if let Ok(exe) = std::env::current_exe() {
        if let Some(pkg_bin) = discover_package_bin(&exe) {
            std::env::set_var("NOETIS_BIN_DIR", &pkg_bin);
        }
    }
    // Apply staged binaries before binding the port (no START script required).
    if let Some(bin_dir) = resolve_bin_dir() {
        apply_pending_bins(&bin_dir);
    }

    // Dual mode: --dual or NOETIS_DUAL_MODE=1 (personal build only)
    let mut dual = args.dual;
    if let Ok(v) = std::env::var("NOETIS_DUAL_MODE") {
        dual = matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on");
    }

    let shared = Arc::new(Mutex::new(AppState {
        hub: hub.clone(),
        host: args.host.clone(),
        port: args.port,
        node_id: args.node_id.clone(),
        mode: "user".into(),
        model: args.model,
        compute: None,
        ollama: None,
        last_error: None,
        last_log: vec![
            "noeti ready".into(),
            if needs_onboarding() {
                "pick Chat or Earn below — we'll install everything".into()
            } else {
                "type help · or ask a question in chat".into()
            },
        ],
        setup_busy: false,
        setup_percent: 0,
        setup_phase: String::new(),
        dual_mode: dual,
    }));

    // Clear stale hub slots from a previous crash / SIGKILL (compute child is None at start).
    // Do NOT leave "desktop" on every start — that kicks other machines still on the legacy id.
    // Only leave desktop once if THIS machine just migrated off that shared slot.
    {
        let g = shared.lock().unwrap();
        if g.compute.is_none() {
            let hub_url = g.hub.clone();
            let node_id = g.node_id.clone();
            drop(g);
            leave_network(&hub_url, &node_id);
            if migrated_from_desktop {
                leave_network(&hub_url, "desktop");
            }
            let mut g = shared.lock().unwrap();
            if migrated_from_desktop {
                push_log(
                    &mut g,
                    format!("cleared hub leave for {node_id} (+ migrated legacy desktop)"),
                );
            } else {
                push_log(&mut g, format!("cleared hub leave for {node_id}"));
            }
        }
    }

    if dual {
        let mut g = shared.lock().unwrap();
        push_log(&mut g, "personal dual mode: chat + earn together");
    }

    let hub_a = hub.clone();
    let hub_b = hub.clone();
    let hub_c = hub.clone();

    let app = Router::new()
        .route(
            "/",
            get({
                let hub = hub_a;
                move || {
                    let hub = hub.clone();
                    async move { render_app_html(&hub) }
                }
            }),
        )
        .route(
            "/app",
            get({
                let hub = hub_b;
                move || {
                    let hub = hub.clone();
                    async move { render_app_html(&hub) }
                }
            }),
        )
        .route(
            "/mobile",
            get({
                let hub = hub_c;
                move || {
                    let hub = hub.clone();
                    async move { render_app_html(&hub) }
                }
            }),
        )
        .route(
            "/download",
            get(|| async { download_page_html("https://noeticompute.com/downloads") }),
        )
        .route("/api/local/status", get(local_status))
        .route("/api/local/mode", post(set_mode))
        .route("/api/local/models/pull", post(pull_model_route))
        .route("/api/local/setup", post(setup_route))
        .route("/api/local/sync", post(sync_route))
        .route("/api/local/relaunch", post(relaunch_route))
        .route("/api/local/wallet", post(import_wallet_route))
        .route("/api/local/infer", post(local_infer))
        .route("/api/local/task/{task_id}", get(local_task))
        .route("/manifest.json", get(|| async { asset_response("manifest.json") }))
        .route("/sw.js", get(|| async { asset_response("sw.js") }))
        .route(
            "/static/{*path}",
            get(|Path(path): Path<String>| async move {
                asset_response(&format!("static/{path}"))
            }),
        )
        .with_state(shared.clone());

    let addr: SocketAddr = format!("{}:{}", args.host, args.port)
        .parse()
        .expect("bind address");
    let mut listen_port = args.port;
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(_) => {
            // Port busy — try a few nearby ports (Windows/Linux/macOS)
            let mut found = None;
            for p in (args.port + 1)..=(args.port + 20) {
                let alt: SocketAddr = format!("{}:{}", args.host, p).parse().expect("addr");
                if let Ok(l) = tokio::net::TcpListener::bind(alt).await {
                    listen_port = p;
                    found = Some(l);
                    break;
                }
            }
            found.expect("bind app port — close other Noeti or free port 5056+")
        }
    };
    {
        let mut g = shared.lock().unwrap();
        g.port = listen_port;
    }
    let url = format!(
        "http://{}:{}",
        if args.host == "0.0.0.0" {
            "127.0.0.1"
        } else {
            &args.host
        },
        listen_port
    );

    println!();
    println!("  Noeti App v{APP_VERSION}");
    println!("  UI:   {url}");
    println!("  Hub:  {hub}");
    println!("  Node: {}", args.node_id);
    println!("  Setup: pick Chat or Earn in the browser (first launch)");
    if listen_port != args.port {
        println!("  Note: port {} busy — using {listen_port}", args.port);
    }
    println!();

    if !args.no_open {
        let _ = open::that(&url);
    }

    axum::serve(listener, app).await.expect("serve app");
}

fn discover_package_bin(exe: &FsPath) -> Option<PathBuf> {
    let parent = exe.parent()?.to_path_buf();
    // Bundled inside .app: Contents/MacOS/noetis-compute next to noetis-app
    if parent.join("noetis-compute").is_file() || parent.join("noetis-compute.exe").is_file() {
        return Some(parent);
    }
    let resources = parent.join("../Resources/bin");
    if resources.join("noetis-compute").is_file() || resources.join("noetis-compute.exe").is_file() {
        return Some(resources.canonicalize().unwrap_or(resources));
    }
    let mut dir = parent;
    for _ in 0..8 {
        let bin = dir.join("bin");
        if bin.is_dir()
            && (bin.join("noetis-compute").is_file() || bin.join("noetis-compute.exe").is_file())
        {
            return Some(bin);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn onboarding_marker() -> PathBuf {
    data_home().join("onboarding_done")
}

fn needs_onboarding() -> bool {
    !onboarding_marker().is_file()
}

fn mark_onboarding_done() {
    let _ = std::fs::create_dir_all(data_home());
    let _ = std::fs::write(onboarding_marker(), b"ok\n");
}
