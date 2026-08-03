use noetis_protocol::{ProcessingMode, VerificationLevel};
use rand::Rng;
use serde_json::Value;

#[derive(Clone)]
pub struct SchedulableNode {
    pub node_id: String,
    pub wallet_address: String,
    pub public_key: String,
    pub box_public_key: Option<String>,
    pub models: Value,
    pub cpu: String,
    pub gpu: Option<String>,
    pub ram_gb: f64,
    pub price_per_input_token: f64,
    pub price_per_output_token: f64,
    pub maximum_parallel_tasks: i32,
    pub reputation: f64,
    pub status: String,
    pub accepts_redundant: bool,
    pub current_tasks: i32,
    pub avg_latency_ms: f64,
    pub success_rate: f64,
}

fn normalize(value: f64, min: f64, max: f64) -> f64 {
    if (max - min).abs() < f64::EPSILON {
        return 1.0;
    }
    ((value - min) / (max - min)).clamp(0.0, 1.0)
}

fn score_node(node: &SchedulableNode, all: &[SchedulableNode], max_price: f64) -> f64 {
    let reputations: Vec<f64> = all.iter().map(|n| n.reputation).collect();
    let latencies: Vec<f64> = all.iter().map(|n| n.avg_latency_ms).collect();
    let prices: Vec<f64> = all
        .iter()
        .map(|n| n.price_per_input_token + n.price_per_output_token)
        .collect();

    let rep_min = reputations.iter().cloned().fold(0.0f64, f64::min);
    let rep_max = reputations.iter().cloned().fold(100.0f64, f64::max);
    let lat_min = latencies.iter().cloned().fold(1000.0f64, f64::min);
    let lat_max = latencies.iter().cloned().fold(1000.0f64, f64::max);
    let price_min = prices.iter().cloned().fold(0.0f64, f64::min);
    let price_max = prices.iter().cloned().fold(max_price, f64::max);

    let reputation_score = normalize(node.reputation, rep_min, rep_max);
    let load_ratio = node.current_tasks as f64 / node.maximum_parallel_tasks.max(1) as f64;
    let availability_score = 1.0 - load_ratio;
    let performance_score = normalize(node.success_rate, 0.0, 1.0);
    let node_price = node.price_per_input_token + node.price_per_output_token;
    let price_score = 1.0 - normalize(node_price, price_min, price_max);
    let latency_score = 1.0 - normalize(node.avg_latency_ms, lat_min, lat_max);

    0.3 * reputation_score
        + 0.25 * availability_score
        + 0.2 * performance_score
        + 0.15 * price_score
        + 0.1 * latency_score
}

fn filter_compatible(
    nodes: &[SchedulableNode],
    model: &str,
    max_price: f64,
    mode: &ProcessingMode,
) -> Vec<SchedulableNode> {
    nodes
        .iter()
        .filter(|node| {
            if node.status != "available" {
                return false;
            }
            if node.current_tasks >= node.maximum_parallel_tasks {
                return false;
            }
            let has_model = node
                .models
                .as_array()
                .map(|arr| {
                    arr.iter().any(|m| {
                        let name = m.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        name == model || name.starts_with(model)
                    })
                })
                .unwrap_or(false);
            if !has_model {
                return false;
            }
            let est_price = node.price_per_input_token * 1000.0 + node.price_per_output_token * 512.0;
            if est_price > max_price {
                return false;
            }
            if matches!(mode, ProcessingMode::Redundant) && !node.accepts_redundant {
                return false;
            }
            true
        })
        .cloned()
        .collect()
}

pub fn select_nodes(
    nodes: &[SchedulableNode],
    model: &str,
    max_price: f64,
    processing_mode: &ProcessingMode,
    verification_level: &VerificationLevel,
) -> Vec<SchedulableNode> {
    let compatible = filter_compatible(nodes, model, max_price, processing_mode);
    if compatible.is_empty() {
        return vec![];
    }

    let mut scored: Vec<(SchedulableNode, f64)> = compatible
        .iter()
        .map(|n| (n.clone(), score_node(n, &compatible, max_price)))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let count = match (processing_mode, verification_level) {
        (ProcessingMode::Redundant, _) | (_, VerificationLevel::High) => scored.len().min(3),
        (_, VerificationLevel::Medium) => scored.len().min(2),
        _ => 1,
    };

    let mut selected = Vec::new();
    let mut pool: Vec<(SchedulableNode, f64)> = scored;
    let mut rng = rand::thread_rng();

    while selected.len() < count && !pool.is_empty() {
        let weights: Vec<f64> = (0..pool.len()).map(|i| 1.0 / (i as f64 + 1.0)).collect();
        let total: f64 = weights.iter().sum();
        let mut r: f64 = rng.gen::<f64>() * total;
        let mut idx = 0;
        for (i, w) in weights.iter().enumerate() {
            r -= w;
            if r <= 0.0 {
                idx = i;
                break;
            }
        }
        selected.push(pool[idx].0.clone());
        pool.remove(idx);
    }
    selected
}

pub fn decompose_subtasks(prompt: &str) -> Vec<String> {
    let lines: Vec<&str> = prompt.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() >= 3 {
        return lines
            .iter()
            .take(5)
            .enumerate()
            .map(|(i, l)| format!("Subtask {}: {}", i + 1, l.trim()))
            .collect();
    }
    let chunks = (prompt.len() as f64 / 500.0).ceil() as usize;
    let chunks = chunks.clamp(2, 4);
    let size = (prompt.len() + chunks - 1) / chunks;
    let mut subtasks = Vec::new();
    for i in 0..chunks {
        let start = i * size;
        let end = ((i + 1) * size).min(prompt.len());
        subtasks.push(format!(
            "Subtask {}: Process this section:\n{}",
            i + 1,
            &prompt[start..end]
        ));
    }
    subtasks.push(format!(
        "Subtask {}: Aggregate prior subtask results into a cohesive final answer for: {}",
        subtasks.len() + 1,
        &prompt[..prompt.len().min(200)]
    ));
    subtasks
}
