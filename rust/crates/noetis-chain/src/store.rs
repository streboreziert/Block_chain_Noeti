//! SQLite block store — same schema as the Python `chain_store` module, so a
//! Rust node can open a Python hub's `chain.db` directly.

use rusqlite::Connection;
use serde_json::Value;
use std::path::Path;

fn connection(data_dir: &Path) -> Option<Connection> {
    let db_path = data_dir.join("chain.db");
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(db_path).ok()?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS blocks (\
         idx INTEGER PRIMARY KEY,\
         hash TEXT NOT NULL,\
         payload TEXT NOT NULL)",
        [],
    )
    .ok()?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    Some(conn)
}

pub fn load_blocks(data_dir: &Path) -> Vec<Value> {
    let Some(conn) = connection(data_dir) else { return vec![] };
    let Ok(mut stmt) = conn.prepare("SELECT payload FROM blocks ORDER BY idx") else {
        return vec![];
    };
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map(|iter| iter.flatten().collect::<Vec<String>>())
        .unwrap_or_default();
    rows.iter().filter_map(|raw| serde_json::from_str(raw).ok()).collect()
}

pub fn append_block(data_dir: &Path, block: &Value) {
    let Some(conn) = connection(data_dir) else { return };
    let index = block.get("index").and_then(Value::as_i64).unwrap_or(0);
    let hash = block.get("hash").and_then(Value::as_str).unwrap_or("");
    let _ = conn.execute(
        "INSERT OR REPLACE INTO blocks (idx, hash, payload) VALUES (?1, ?2, ?3)",
        rusqlite::params![index, hash, serde_json::to_string(block).unwrap_or_default()],
    );
}

pub fn replace_all(data_dir: &Path, blocks: &[Value]) {
    let Some(mut conn) = connection(data_dir) else { return };
    let Ok(tx) = conn.transaction() else { return };
    let _ = tx.execute("DELETE FROM blocks", []);
    for block in blocks {
        let index = block.get("index").and_then(Value::as_i64).unwrap_or(0);
        let hash = block.get("hash").and_then(Value::as_str).unwrap_or("");
        let _ = tx.execute(
            "INSERT INTO blocks (idx, hash, payload) VALUES (?1, ?2, ?3)",
            rusqlite::params![index, hash, serde_json::to_string(block).unwrap_or_default()],
        );
    }
    let _ = tx.commit();
}
