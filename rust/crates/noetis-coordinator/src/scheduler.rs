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
