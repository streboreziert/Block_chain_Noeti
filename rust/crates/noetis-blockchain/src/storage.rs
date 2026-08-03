use crate::BlockchainState;
use noetis_protocol::{Block, Transaction};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainStoreData {
    pub chain: Vec<Block>,
    pub validator_ids: Vec<String>,
    pub mempool: Vec<Transaction>,
}

pub struct ChainStore {
    file_path: PathBuf,
}

impl ChainStore {
    pub fn new(file_path: impl AsRef<Path>) -> Self {
        Self {
            file_path: file_path.as_ref().to_path_buf(),
        }
    }

    pub fn load(&self) -> Option<ChainStoreData> {
        if !self.file_path.exists() {
            return None;
        }
        let raw = fs::read_to_string(&self.file_path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn save(&self, data: &ChainStoreData) -> std::io::Result<()> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(data)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(&self.file_path, json)
    }

    pub fn save_state(
        &self,
        state: &BlockchainState,
        mempool: &[Transaction],
    ) -> std::io::Result<()> {
        self.save(&ChainStoreData {
            chain: state.chain.clone(),
            validator_ids: state.validators.iter().map(|v| v.id.clone()).collect(),
            mempool: mempool.to_vec(),
        })
    }
}

pub fn pick_longest_chain(chains: &[Vec<Block>]) -> Vec<Block> {
    chains
        .iter()
        .max_by_key(|c| c.len())
        .cloned()
        .unwrap_or_default()
}
