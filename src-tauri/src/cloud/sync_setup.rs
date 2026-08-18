use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::sync_crypto::{prepare_initialization, PreparedSyncInitialization, SyncCryptoError};

const SETUP_LIFETIME: Duration = Duration::from_secs(30 * 60);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginSyncSetupResult {
    pub setup_id: String,
    pub recovery_key: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SyncSetupError {
    Invalid,
    Expired,
    Crypto,
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(crate) struct PendingSyncSetup {
    #[zeroize(skip)]
    pub created_at: Instant,
    pub setup_id: String,
    pub cloud_account_id: String,
    pub identity_binding_sha256: String,
    pub device_id: String,
    pub initialization_id: String,
    #[zeroize(skip)]
    pub prepared: PreparedSyncInitialization,
}

#[derive(Default)]
pub(crate) struct SyncSetupCoordinator {
    sessions: Mutex<HashMap<String, PendingSyncSetup>>,
}

impl SyncSetupCoordinator {
    pub(crate) fn begin(
        &self,
        cloud_account_id: &str,
        identity_binding_sha256: &str,
        device_name: &str,
    ) -> Result<BeginSyncSetupResult, SyncSetupError> {
        let setup_id = Uuid::new_v4().to_string();
        let device_id = Uuid::new_v4().to_string();
        let initialization_id = Uuid::new_v4().to_string();
        let prepared = prepare_initialization(
            cloud_account_id,
            &device_id,
            &initialization_id,
            device_name,
        )
        .map_err(map_crypto_error)?;
        let recovery_key = prepared.recovery_key.clone();
        let pending = PendingSyncSetup {
            created_at: Instant::now(),
            setup_id: setup_id.clone(),
            cloud_account_id: cloud_account_id.to_string(),
            identity_binding_sha256: identity_binding_sha256.to_string(),
            device_id,
            initialization_id,
            prepared,
        };

        let mut sessions = self.sessions.lock().map_err(|_| SyncSetupError::Invalid)?;
        remove_expired(&mut sessions);
        sessions.insert(setup_id.clone(), pending);
        Ok(BeginSyncSetupResult {
            setup_id,
            recovery_key,
        })
    }

    pub(crate) fn recovery_key(&self, setup_id: &str) -> Result<String, SyncSetupError> {
        let mut sessions = self.sessions.lock().map_err(|_| SyncSetupError::Invalid)?;
        remove_expired(&mut sessions);
        sessions
            .get(setup_id)
            .map(|pending| pending.prepared.recovery_key.clone())
            .ok_or(SyncSetupError::Expired)
    }

    pub(crate) fn take(&self, setup_id: &str) -> Result<PendingSyncSetup, SyncSetupError> {
        let mut sessions = self.sessions.lock().map_err(|_| SyncSetupError::Invalid)?;
        remove_expired(&mut sessions);
        sessions.remove(setup_id).ok_or(SyncSetupError::Expired)
    }

    pub(crate) fn put_back(&self, pending: PendingSyncSetup) {
        if let Ok(mut sessions) = self.sessions.lock() {
            remove_expired(&mut sessions);
            sessions.insert(pending.setup_id.clone(), pending);
        }
    }

    pub(crate) fn cancel(&self, setup_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(setup_id);
            remove_expired(&mut sessions);
        }
    }

    pub(crate) fn clear_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.clear();
        }
    }
}

fn remove_expired(sessions: &mut HashMap<String, PendingSyncSetup>) {
    sessions.retain(|_, pending| pending.created_at.elapsed() < SETUP_LIFETIME);
}

fn map_crypto_error(_error: SyncCryptoError) -> SyncSetupError {
    SyncSetupError::Crypto
}
