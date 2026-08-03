//! Minimal blocking JSON HTTP client used by nodes and federation calls.

use serde_json::Value;
use std::time::Duration;

pub fn get_json(base: &str, path: &str, timeout_sec: u64) -> Result<Value, String> {
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(timeout_sec))
        .build();
    match agent.get(&url).call() {
        Ok(response) => response.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            Err(format!("Hub error {code}: {body}"))
        }
        Err(e) => Err(format!("Cannot reach {url}: {e}")),
    }
}

pub fn post_json(base: &str, path: &str, body: &Value, timeout_sec: u64) -> Result<Value, String> {
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(timeout_sec))
        .build();
    match agent.post(&url).send_json(body.clone()) {
        Ok(response) => response.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, response)) => {
            let text = response.into_string().unwrap_or_default();
            Err(format!("Hub error {code}: {text}"))
        }
        Err(e) => Err(format!("Cannot reach {url}: {e}")),
    }
}
