use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "cloud-local-sync-control-v1.json";

pub(crate) struct LocalSyncControlStore {
    path: Option<PathBuf>,
    lock: Mutex<()>,
}

impl LocalSyncControlStore {
    pub(crate) fn new(app_data_dir: Option<PathBuf>) -> Self {
        Self {
            path: app_data_dir.map(|path| path.join(FILE_NAME)),
            lock: Mutex::new(()),
        }
    }

    pub(crate) fn is_paused(&self, account_id: &str) -> bool {
        let Ok(_guard) = self.lock.lock() else {
            return false;
        };
        self.read().get(account_id).copied().unwrap_or(false)
    }

    pub(crate) fn set_paused(&self, account_id: &str, paused: bool) -> Result<(), ()> {
        let _guard = self.lock.lock().map_err(|_| ())?;
        let mut values = self.read();
        if paused {
            values.insert(account_id.to_string(), true);
        } else {
            values.remove(account_id);
        }
        self.write(&values)
    }

    pub(crate) fn clear_account(&self, account_id: &str) -> Result<(), ()> {
        self.set_paused(account_id, false)
    }

    fn read(&self) -> HashMap<String, bool> {
        let Some(path) = &self.path else {
            return HashMap::new();
        };
        let Ok(bytes) = fs::read(path) else {
            return HashMap::new();
        };
        serde_json::from_slice::<Record>(&bytes)
            .map(|record| record.accounts)
            .unwrap_or_default()
    }

    fn write(&self, accounts: &HashMap<String, bool>) -> Result<(), ()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| ())?;
        }
        let record = serde_json::to_vec(&Record {
            version: 1,
            accounts: accounts.clone(),
        })
        .map_err(|_| ())?;
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, record).map_err(|_| ())?;
        fs::rename(temporary, path).map_err(|_| ())
    }
}

#[derive(Deserialize, Serialize)]
struct Record {
    version: u8,
    accounts: HashMap<String, bool>,
}
