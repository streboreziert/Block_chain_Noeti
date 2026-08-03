//! Ollama HTTP client — deterministic decoding identical to the Python client
//! (temperature 0, seed 42, top_k 1, num_predict 1024).
//! num_predict must match Python (ollama_client.py) for consensus.

use crate::httpc;
use serde_json::{json, Value};

pub const DETERMINISTIC_SEED: i64 = 42;

pub const NOETI_SYSTEM_PREAMBLE: &str = concat!(
    "You are Noeti, a helpful, accurate AI assistant on the Noeti Compute Lab network. ",
    "When the user message includes a time context or web context section, treat those ",
    "lines as ground truth for dates, times, and facts — never invent or contradict them. ",
    "Be clear and complete. If unsure, say so."
);

pub struct OllamaClient {
    pub base_url: String,
    pub model: String,
}

pub struct InferenceResult {
    pub response: String,
    pub inference_ms: f64,
    pub model: String,
}

impl OllamaClient {
    pub fn new(model: &str) -> Self {
        OllamaClient {
            base_url: std::env::var("OLLAMA_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".into()),
            model: model.to_string(),
        }
    }

    pub fn is_available(&self) -> bool {
        httpc::get_json(&self.base_url, "/api/tags", 5).is_ok()
    }

    pub fn list_models(&self) -> Vec<String> {
        httpc::get_json(&self.base_url, "/api/tags", 10)
            .ok()
            .and_then(|data| data.get("models").and_then(Value::as_array).cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|item| item.get("name").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    pub fn resolve_model(&mut self, preferred: &[&str]) -> Result<String, String> {
        let available = self.list_models();
        if available.is_empty() {
            return Err("No Ollama models found. Install Ollama and run: ollama pull qwen2.5:0.5b".into());
        }
        for name in preferred {
            if available.iter().any(|m| m == name) {
                self.model = name.to_string();
                return Ok(self.model.clone());
            }
            let family = name.split(':').next().unwrap_or(name);
            if let Some(installed) = available.iter().find(|m| m.starts_with(family)) {
                self.model = installed.clone();
                return Ok(self.model.clone());
            }
        }
        self.model = available[0].clone();
        Ok(self.model.clone())
    }

    pub fn generate(&self, prompt: &str) -> Result<InferenceResult, String> {
        self.generate_with_options(prompt, None)
    }

    /// Optional `num_predict` override (clamped 128–2048) for per-task max tokens.
    /// Always sends the Noeti system preamble (matches Python `system=`).
    pub fn generate_with_options(
        &self,
        prompt: &str,
        num_predict: Option<i64>,
    ) -> Result<InferenceResult, String> {
        let mut n_predict = 1024_i64;
        if let Some(n) = num_predict {
            n_predict = n.clamp(128, 2048);
        }
        let mut payload = json!({
            "model": self.model,
            "prompt": prompt,
            "stream": false,
            "options": {
                "temperature": 0.0,
                "seed": DETERMINISTIC_SEED,
                "top_k": 1,
                "num_predict": n_predict,
            },
        });
        if let Some(obj) = payload.as_object_mut() {
            obj.insert(
                "system".into(),
                Value::String(NOETI_SYSTEM_PREAMBLE.to_string()),
            );
        }
        let started = std::time::Instant::now();
        let data = httpc::post_json(&self.base_url, "/api/generate", &payload, 120)?;
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        let response = data
            .get("response")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if response.is_empty() {
            return Err("Ollama returned an empty response".into());
        }
        Ok(InferenceResult {
            response,
            inference_ms: elapsed_ms,
            model: self.model.clone(),
        })
    }
}
