//! In-process sliding-window rate limiter (per key).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static HITS: Mutex<Option<HashMap<String, Vec<f64>>>> = Mutex::new(None);

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

pub fn check_rate_limit(key: &str, max_calls: usize, window_sec: f64) -> Result<(), String> {
    let mut guard = HITS.lock().unwrap();
    let store = guard.get_or_insert_with(HashMap::new);
    let current = now();
    let hits = store.entry(key.to_string()).or_default();
    hits.retain(|t| current - *t < window_sec);
    if hits.len() >= max_calls {
        let retry = (window_sec - (current - hits[0])).max(1.0) as i64;
        return Err(format!("Rate limit exceeded — retry in {retry}s"));
    }
    hits.push(current);
    Ok(())
}
