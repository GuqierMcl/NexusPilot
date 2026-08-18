use std::sync::Arc;

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use super::{
    error::{AuthError, AuthErrorKind},
    secret::SecretString,
    session::{AuthUser, PendingLogin, PersistedAuthSession, StoredAuthState},
};

#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "NexusPilot.Auth.v1";
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "NexusPilot.Auth.dev.v1";
const REFRESH_TOKEN_ACCOUNT: &str = "refresh-token";
const SESSION_METADATA_ACCOUNT: &str = "session-metadata";
const PENDING_LOGIN_ACCOUNT: &str = "pending-login";
const KEYCHAIN_SCHEMA_VERSION: u32 = 1;
const MAX_KEYCHAIN_ITEM_BYTES: usize = 2_048;

pub(crate) trait AuthCredentialStore: Send + Sync {
    fn load(&self) -> Result<StoredAuthState, AuthError>;
    fn write(&self, value: &StoredAuthState) -> Result<(), AuthError>;
    fn clear(&self) -> Result<(), AuthError>;
}

trait CredentialBackend: Send + Sync {
    fn read(&self, account: &'static str) -> Result<Option<Zeroizing<String>>, AuthError>;
    fn write(&self, account: &'static str, value: &str) -> Result<(), AuthError>;
    fn delete(&self, account: &'static str) -> Result<(), AuthError>;
}

#[derive(Clone)]
pub(crate) struct SystemAuthCredentialStore {
    backend: Arc<dyn CredentialBackend>,
}

impl SystemAuthCredentialStore {
    pub fn new() -> Self {
        Self {
            backend: Arc::new(KeyringCredentialBackend),
        }
    }

    fn load_session(&self) -> Result<Option<PersistedAuthSession>, AuthError> {
        let Some(refresh_payload) = self.backend.read(REFRESH_TOKEN_ACCOUNT)? else {
            return Ok(None);
        };
        let mut refresh: RefreshTokenRecordV1 = decode_record(&refresh_payload)?;
        if refresh.schema_version != KEYCHAIN_SCHEMA_VERSION {
            return Err(corrupted("keychain_refresh_schema_unsupported"));
        }
        if refresh.record_state == RecordState::SignedOut {
            return Ok(None);
        }

        let metadata_payload = self
            .backend
            .read(SESSION_METADATA_ACCOUNT)?
            .ok_or_else(|| corrupted("keychain_session_metadata_missing"))?;
        let metadata: SessionMetadataRecordV1 = decode_record(&metadata_payload)?;
        if metadata.schema_version != KEYCHAIN_SCHEMA_VERSION {
            return Err(corrupted("keychain_session_schema_unsupported"));
        }

        let refresh_token = refresh
            .refresh_token
            .take()
            .ok_or_else(|| corrupted("keychain_refresh_token_missing"))?;
        let generation_id = refresh
            .generation_id
            .take()
            .ok_or_else(|| corrupted("keychain_refresh_generation_missing"))?;
        let provider_fingerprint = refresh
            .provider_fingerprint
            .take()
            .ok_or_else(|| corrupted("keychain_refresh_fingerprint_missing"))?;
        let issuer = refresh
            .issuer
            .take()
            .ok_or_else(|| corrupted("keychain_refresh_issuer_missing"))?;
        let subject = refresh
            .subject
            .take()
            .ok_or_else(|| corrupted("keychain_refresh_subject_missing"))?;

        if metadata.generation_id != generation_id
            || metadata.provider_fingerprint != provider_fingerprint
            || metadata.user.issuer != issuer
            || metadata.user.subject != subject
        {
            return Err(corrupted("keychain_session_binding_mismatch"));
        }

        Ok(Some(PersistedAuthSession {
            generation_id,
            provider_fingerprint,
            user: metadata.user,
            refresh_token: SecretString::new(refresh_token),
            last_authenticated_at: metadata.last_authenticated_at,
            last_refreshed_at: metadata.last_refreshed_at,
        }))
    }

    fn save_session(&self, session: &PersistedAuthSession) -> Result<(), AuthError> {
        let metadata = SessionMetadataRecordV1 {
            schema_version: KEYCHAIN_SCHEMA_VERSION,
            generation_id: session.generation_id.clone(),
            provider_fingerprint: session.provider_fingerprint.clone(),
            user: session.user.clone(),
            last_authenticated_at: session.last_authenticated_at,
            last_refreshed_at: session.last_refreshed_at,
        };
        let refresh = RefreshTokenRecordV1 {
            schema_version: KEYCHAIN_SCHEMA_VERSION,
            record_state: RecordState::Active,
            generation_id: Some(session.generation_id.clone()),
            provider_fingerprint: Some(session.provider_fingerprint.clone()),
            issuer: Some(session.user.issuer.clone()),
            subject: Some(session.user.subject.clone()),
            refresh_token: Some(session.refresh_token.expose().to_string()),
        };

        let metadata_payload = encode_record(&metadata)?;
        let refresh_payload = encode_record(&refresh)?;
        self.write_verified(SESSION_METADATA_ACCOUNT, &metadata_payload)?;
        self.write_verified(REFRESH_TOKEN_ACCOUNT, &refresh_payload)?;
        let verified = self
            .load_session()?
            .ok_or_else(|| corrupted("keychain_session_commit_missing"))?;
        if verified.generation_id != session.generation_id
            || verified.provider_fingerprint != session.provider_fingerprint
            || verified.user != session.user
            || !verified
                .refresh_token
                .constant_time_eq(session.refresh_token.expose())
            || verified.last_authenticated_at != session.last_authenticated_at
            || verified.last_refreshed_at != session.last_refreshed_at
        {
            return Err(corrupted("keychain_session_commit_mismatch"));
        }
        Ok(())
    }

    fn clear_session(&self) -> Result<(), AuthError> {
        let tombstone = RefreshTokenRecordV1 {
            schema_version: KEYCHAIN_SCHEMA_VERSION,
            record_state: RecordState::SignedOut,
            generation_id: None,
            provider_fingerprint: None,
            issuer: None,
            subject: None,
            refresh_token: None,
        };
        let payload = encode_record(&tombstone)?;
        if let Err(tombstone_error) = self.write_verified(REFRESH_TOKEN_ACCOUNT, &payload) {
            return self.delete_verified_absent(REFRESH_TOKEN_ACCOUNT, tombstone_error);
        }

        if let Err(error) = self.backend.delete(REFRESH_TOKEN_ACCOUNT) {
            tauri_plugin_log::log::warn!(
                "Refresh-token tombstone is durable but physical Keychain cleanup was skipped: code={}",
                error.kind().code()
            );
        }
        if let Err(error) = self.backend.delete(SESSION_METADATA_ACCOUNT) {
            tauri_plugin_log::log::warn!(
                "Signed-out session metadata could not be physically removed from Keychain: code={}",
                error.kind().code()
            );
        }
        Ok(())
    }

    fn load_pending_login(&self) -> Result<Option<PendingLogin>, AuthError> {
        let Some(payload) = self.backend.read(PENDING_LOGIN_ACCOUNT)? else {
            return Ok(None);
        };
        let record: PendingLoginRecordV1 = decode_record(&payload)?;
        if record.schema_version != KEYCHAIN_SCHEMA_VERSION {
            return Err(corrupted("keychain_pending_schema_unsupported"));
        }
        if record.record_state != RecordState::Active {
            return Ok(None);
        }
        Ok(Some(record.into_domain()?))
    }

    fn save_pending_login(&self, pending: &PendingLogin) -> Result<(), AuthError> {
        let payload = encode_record(&PendingLoginRecordV1::from_domain(pending))?;
        self.write_verified(PENDING_LOGIN_ACCOUNT, &payload)
    }

    fn clear_pending_login(&self) -> Result<(), AuthError> {
        let tombstone = PendingLoginRecordV1::tombstone();
        let payload = encode_record(&tombstone)?;
        if let Err(tombstone_error) = self.write_verified(PENDING_LOGIN_ACCOUNT, &payload) {
            return self.delete_verified_absent(PENDING_LOGIN_ACCOUNT, tombstone_error);
        }
        if let Err(error) = self.backend.delete(PENDING_LOGIN_ACCOUNT) {
            tauri_plugin_log::log::warn!(
                "Pending-login tombstone is durable but physical Keychain cleanup was skipped: code={}",
                error.kind().code()
            );
        }
        Ok(())
    }

    fn delete_verified_absent(
        &self,
        account: &'static str,
        tombstone_error: AuthError,
    ) -> Result<(), AuthError> {
        let _ = self.backend.delete(account);
        match self.backend.read(account) {
            Ok(None) => Ok(()),
            Ok(Some(_)) | Err(_) => Err(tombstone_error),
        }
    }

    fn write_verified(&self, account: &'static str, value: &str) -> Result<(), AuthError> {
        if value.len() > MAX_KEYCHAIN_ITEM_BYTES {
            return Err(AuthError::new(
                AuthErrorKind::SecureStorageItemTooLarge,
                "keychain_item_too_large",
            ));
        }
        self.backend.write(account, value)?;
        let verified = self
            .backend
            .read(account)?
            .ok_or_else(|| corrupted("keychain_write_verification_missing"))?;
        if verified.as_str() != value {
            return Err(corrupted("keychain_write_verification_failed"));
        }
        Ok(())
    }
}

impl Default for SystemAuthCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthCredentialStore for SystemAuthCredentialStore {
    fn load(&self) -> Result<StoredAuthState, AuthError> {
        Ok(StoredAuthState {
            session: self.load_session()?,
            pending_login: self.load_pending_login()?,
        })
    }

    fn write(&self, value: &StoredAuthState) -> Result<(), AuthError> {
        match value.pending_login.as_ref() {
            Some(pending) => self.save_pending_login(pending)?,
            None => self.clear_pending_login()?,
        }
        match value.session.as_ref() {
            Some(session) => self.save_session(session)?,
            None => self.clear_session()?,
        }
        Ok(())
    }

    fn clear(&self) -> Result<(), AuthError> {
        self.clear_session()
            .and_then(|()| self.clear_pending_login())
            .map_err(|_| {
                AuthError::new(
                    AuthErrorKind::PersistentLogoutNotGuaranteed,
                    "persistent_logout_not_guaranteed",
                )
            })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RecordState {
    Active,
    Consumed,
    SignedOut,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RefreshTokenRecordV1 {
    schema_version: u32,
    record_state: RecordState,
    generation_id: Option<String>,
    provider_fingerprint: Option<String>,
    issuer: Option<String>,
    subject: Option<String>,
    refresh_token: Option<String>,
}

impl Drop for RefreshTokenRecordV1 {
    fn drop(&mut self) {
        self.generation_id.zeroize();
        self.provider_fingerprint.zeroize();
        self.issuer.zeroize();
        self.subject.zeroize();
        self.refresh_token.zeroize();
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionMetadataRecordV1 {
    schema_version: u32,
    generation_id: String,
    provider_fingerprint: String,
    user: AuthUser,
    last_authenticated_at: i64,
    last_refreshed_at: Option<i64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingLoginRecordV1 {
    schema_version: u32,
    record_state: RecordState,
    transaction_id: Option<String>,
    provider_fingerprint: Option<String>,
    state: Option<String>,
    nonce: Option<String>,
    pkce_verifier: Option<String>,
    authorization_url: Option<String>,
    created_at: Option<i64>,
    expires_at: Option<i64>,
}

impl Drop for PendingLoginRecordV1 {
    fn drop(&mut self) {
        self.transaction_id.zeroize();
        self.provider_fingerprint.zeroize();
        self.state.zeroize();
        self.nonce.zeroize();
        self.pkce_verifier.zeroize();
        self.authorization_url.zeroize();
    }
}

impl PendingLoginRecordV1 {
    fn from_domain(value: &PendingLogin) -> Self {
        Self {
            schema_version: KEYCHAIN_SCHEMA_VERSION,
            record_state: RecordState::Active,
            transaction_id: Some(value.transaction_id.clone()),
            provider_fingerprint: Some(value.provider_fingerprint.clone()),
            state: Some(value.state.expose().to_string()),
            nonce: Some(value.nonce.expose().to_string()),
            pkce_verifier: Some(value.pkce_verifier.expose().to_string()),
            authorization_url: Some(value.authorization_url.expose().to_string()),
            created_at: Some(value.created_at),
            expires_at: Some(value.expires_at),
        }
    }

    fn tombstone() -> Self {
        Self {
            schema_version: KEYCHAIN_SCHEMA_VERSION,
            record_state: RecordState::Consumed,
            transaction_id: None,
            provider_fingerprint: None,
            state: None,
            nonce: None,
            pkce_verifier: None,
            authorization_url: None,
            created_at: None,
            expires_at: None,
        }
    }

    fn into_domain(mut self) -> Result<PendingLogin, AuthError> {
        Ok(PendingLogin {
            transaction_id: required(
                self.transaction_id.take(),
                "keychain_pending_transaction_id_missing",
            )?,
            provider_fingerprint: required(
                self.provider_fingerprint.take(),
                "keychain_pending_fingerprint_missing",
            )?,
            state: SecretString::new(required(
                self.state.take(),
                "keychain_pending_state_missing",
            )?),
            nonce: SecretString::new(required(
                self.nonce.take(),
                "keychain_pending_nonce_missing",
            )?),
            pkce_verifier: SecretString::new(required(
                self.pkce_verifier.take(),
                "keychain_pending_pkce_missing",
            )?),
            authorization_url: SecretString::new(required(
                self.authorization_url.take(),
                "keychain_pending_authorization_url_missing",
            )?),
            created_at: required(self.created_at, "keychain_pending_created_at_missing")?,
            expires_at: required(self.expires_at, "keychain_pending_expires_at_missing")?,
        })
    }
}

fn required<T>(value: Option<T>, code: &'static str) -> Result<T, AuthError> {
    value.ok_or_else(|| corrupted(code))
}

#[derive(Clone, Copy)]
struct KeyringCredentialBackend;

impl CredentialBackend for KeyringCredentialBackend {
    fn read(&self, account: &'static str) -> Result<Option<Zeroizing<String>>, AuthError> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(map_keyring_error)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn write(&self, account: &'static str, value: &str) -> Result<(), AuthError> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(map_keyring_error)?;
        entry.set_password(value).map_err(map_keyring_error)
    }

    fn delete(&self, account: &'static str) -> Result<(), AuthError> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(map_keyring_error)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

fn encode_record<T: Serialize>(value: &T) -> Result<Zeroizing<String>, AuthError> {
    let payload = serde_json::to_string(value).map_err(|_| {
        AuthError::new(
            AuthErrorKind::SystemInternal,
            "keychain_record_encode_failed",
        )
    })?;
    if payload.len() > MAX_KEYCHAIN_ITEM_BYTES {
        return Err(AuthError::new(
            AuthErrorKind::SecureStorageItemTooLarge,
            "keychain_item_too_large",
        ));
    }
    Ok(Zeroizing::new(payload))
}

fn decode_record<T: for<'de> Deserialize<'de>>(value: &str) -> Result<T, AuthError> {
    serde_json::from_str(value).map_err(|_| corrupted("keychain_record_invalid"))
}

fn map_keyring_error(error: keyring::Error) -> AuthError {
    match error {
        keyring::Error::NoStorageAccess(_) => AuthError::new(
            AuthErrorKind::SecureStorageAccessDenied,
            "keychain_access_denied",
        ),
        keyring::Error::TooLong(_, _) => AuthError::new(
            AuthErrorKind::SecureStorageItemTooLarge,
            "keychain_platform_item_too_large",
        ),
        keyring::Error::BadEncoding(_)
        | keyring::Error::BadDataFormat(_, _)
        | keyring::Error::BadStoreFormat(_)
        | keyring::Error::Ambiguous(_) => corrupted("keychain_platform_data_invalid"),
        _ => AuthError::new(
            AuthErrorKind::SecureStorageUnavailable,
            "keychain_platform_unavailable",
        ),
    }
}

fn corrupted(code: &'static str) -> AuthError {
    AuthError::new(AuthErrorKind::SecureStorageCorrupted, code)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{HashMap, HashSet},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    use zeroize::Zeroizing;

    use super::{
        decode_record, encode_record, AuthCredentialStore, AuthError, AuthErrorKind, AuthUser,
        CredentialBackend, PendingLogin, PendingLoginRecordV1, PersistedAuthSession, RecordState,
        RefreshTokenRecordV1, SessionMetadataRecordV1, StoredAuthState, SystemAuthCredentialStore,
        KEYCHAIN_SCHEMA_VERSION, PENDING_LOGIN_ACCOUNT, REFRESH_TOKEN_ACCOUNT,
        SESSION_METADATA_ACCOUNT,
    };
    use crate::auth::secret::SecretString;

    #[derive(Default)]
    struct TestCredentialBackend {
        items: Mutex<HashMap<&'static str, String>>,
        failed_writes: Mutex<HashSet<&'static str>>,
        failed_deletes: Mutex<HashSet<&'static str>>,
    }

    impl TestCredentialBackend {
        fn fail_delete(&self, account: &'static str) {
            self.failed_deletes
                .lock()
                .expect("failed-delete lock")
                .insert(account);
        }

        fn fail_write(&self, account: &'static str) {
            self.failed_writes
                .lock()
                .expect("failed-write lock")
                .insert(account);
        }
    }

    impl CredentialBackend for TestCredentialBackend {
        fn read(&self, account: &'static str) -> Result<Option<Zeroizing<String>>, AuthError> {
            Ok(self
                .items
                .lock()
                .expect("test credential items lock")
                .get(account)
                .cloned()
                .map(Zeroizing::new))
        }

        fn write(&self, account: &'static str, value: &str) -> Result<(), AuthError> {
            if self
                .failed_writes
                .lock()
                .expect("failed-write lock")
                .contains(account)
            {
                return Err(AuthError::new(
                    AuthErrorKind::SecureStorageUnavailable,
                    "test_keychain_write_failed",
                ));
            }
            self.items
                .lock()
                .expect("test credential items lock")
                .insert(account, value.to_string());
            Ok(())
        }

        fn delete(&self, account: &'static str) -> Result<(), AuthError> {
            if self
                .failed_deletes
                .lock()
                .expect("failed-delete lock")
                .contains(account)
            {
                return Err(AuthError::new(
                    AuthErrorKind::SecureStorageUnavailable,
                    "test_keychain_delete_failed",
                ));
            }
            self.items
                .lock()
                .expect("test credential items lock")
                .remove(account);
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    pub(crate) struct InMemoryAuthCredentialStore {
        state: Arc<Mutex<StoredAuthState>>,
        unavailable: bool,
        corrupted: Arc<AtomicBool>,
        write_count: Arc<AtomicUsize>,
        fail_on_write: Arc<AtomicUsize>,
    }

    impl InMemoryAuthCredentialStore {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn unavailable() -> Self {
            Self {
                state: Arc::new(Mutex::new(StoredAuthState::default())),
                unavailable: true,
                corrupted: Arc::new(AtomicBool::new(false)),
                write_count: Arc::new(AtomicUsize::new(0)),
                fail_on_write: Arc::new(AtomicUsize::new(0)),
            }
        }

        pub fn corrupted() -> Self {
            Self {
                state: Arc::new(Mutex::new(StoredAuthState::default())),
                unavailable: false,
                corrupted: Arc::new(AtomicBool::new(true)),
                write_count: Arc::new(AtomicUsize::new(0)),
                fail_on_write: Arc::new(AtomicUsize::new(0)),
            }
        }

        pub fn fail_on_write(&self, write_number: usize) {
            self.fail_on_write.store(write_number, Ordering::SeqCst);
        }
    }

    impl AuthCredentialStore for InMemoryAuthCredentialStore {
        fn load(&self) -> Result<StoredAuthState, AuthError> {
            if self.unavailable {
                return Err(AuthError::new(
                    AuthErrorKind::SecureStorageUnavailable,
                    "test_keychain_unavailable",
                ));
            }
            if self.corrupted.load(Ordering::SeqCst) {
                return Err(AuthError::new(
                    AuthErrorKind::SecureStorageCorrupted,
                    "test_keychain_corrupted",
                ));
            }
            Ok(self.state.lock().expect("test keychain lock").clone())
        }

        fn write(&self, value: &StoredAuthState) -> Result<(), AuthError> {
            if self.unavailable {
                return Err(AuthError::new(
                    AuthErrorKind::SecureStorageUnavailable,
                    "test_keychain_unavailable",
                ));
            }
            let write_number = self.write_count.fetch_add(1, Ordering::SeqCst) + 1;
            if self.fail_on_write.load(Ordering::SeqCst) == write_number {
                return Err(AuthError::new(
                    AuthErrorKind::SecureStorageUnavailable,
                    "test_keychain_write_failed",
                ));
            }
            *self.state.lock().expect("test keychain lock") = value.clone();
            Ok(())
        }

        fn clear(&self) -> Result<(), AuthError> {
            self.corrupted.store(false, Ordering::SeqCst);
            self.write(&StoredAuthState::default())
        }
    }

    fn stored_state() -> StoredAuthState {
        let user = AuthUser {
            provider_id: "provider".to_string(),
            issuer: "https://issuer.test".to_string(),
            subject: "subject".to_string(),
            display_name: Some("Demo".to_string()),
            handle: Some("demo".to_string()),
            email: Some("demo@example.test".to_string()),
            email_verified: Some(true),
            avatar_revision: None,
        };
        StoredAuthState {
            session: Some(PersistedAuthSession {
                generation_id: "generation".to_string(),
                provider_fingerprint: "fingerprint".to_string(),
                user,
                refresh_token: SecretString::new("refresh-secret".to_string()),
                last_authenticated_at: 100,
                last_refreshed_at: Some(200),
            }),
            pending_login: Some(PendingLogin {
                transaction_id: "transaction".to_string(),
                provider_fingerprint: "fingerprint".to_string(),
                state: SecretString::new("state-secret".to_string()),
                nonce: SecretString::new("nonce-secret".to_string()),
                pkce_verifier: SecretString::new("pkce-secret".to_string()),
                authorization_url: SecretString::new("https://issuer.test/authorize".to_string()),
                created_at: 100,
                expires_at: 200,
            }),
        }
    }

    #[test]
    fn system_store_round_trips_separate_keychain_records() {
        let backend = Arc::new(TestCredentialBackend::default());
        let store = SystemAuthCredentialStore {
            backend: backend.clone(),
        };
        store
            .write(&stored_state())
            .expect("write keychain records");

        let loaded = store.load().expect("load keychain records");
        let session = loaded.session.expect("persisted session");
        let pending = loaded.pending_login.expect("persisted pending login");

        assert_eq!(session.generation_id, "generation");
        assert_eq!(session.refresh_token.expose(), "refresh-secret");
        assert_eq!(pending.pkce_verifier.expose(), "pkce-secret");
        assert_eq!(backend.items.lock().expect("items lock").len(), 3);
    }

    #[test]
    fn system_store_rejects_cross_generation_session_records() {
        let backend = Arc::new(TestCredentialBackend::default());
        let store = SystemAuthCredentialStore {
            backend: backend.clone(),
        };
        store
            .write(&stored_state())
            .expect("write keychain records");

        let refresh_payload = backend
            .read(REFRESH_TOKEN_ACCOUNT)
            .expect("read refresh record")
            .expect("refresh record");
        let mut refresh: RefreshTokenRecordV1 =
            decode_record(&refresh_payload).expect("decode refresh record");
        refresh.generation_id = Some("different-generation".to_string());
        let corrupted_payload = encode_record(&refresh).expect("encode mismatched record");
        backend
            .write(REFRESH_TOKEN_ACCOUNT, &corrupted_payload)
            .expect("replace refresh record");

        let error = match store.load() {
            Ok(_) => panic!("generation mismatch must fail closed"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), AuthErrorKind::SecureStorageCorrupted);
    }

    #[test]
    fn durable_tombstones_make_delete_failures_safe() {
        let backend = Arc::new(TestCredentialBackend::default());
        let store = SystemAuthCredentialStore {
            backend: backend.clone(),
        };
        store
            .write(&stored_state())
            .expect("write keychain records");
        for account in [
            REFRESH_TOKEN_ACCOUNT,
            SESSION_METADATA_ACCOUNT,
            PENDING_LOGIN_ACCOUNT,
        ] {
            backend.fail_delete(account);
        }

        store.clear().expect("tombstones guarantee local logout");
        let loaded = store.load().expect("load tombstoned records");

        assert!(loaded.session.is_none());
        assert!(loaded.pending_login.is_none());
        let items = backend.items.lock().expect("items lock");
        assert!(!items[REFRESH_TOKEN_ACCOUNT].contains("refresh-secret"));
        assert!(!items[PENDING_LOGIN_ACCOUNT].contains("pkce-secret"));
        assert!(items[REFRESH_TOKEN_ACCOUNT].contains("signedOut"));
        assert!(items[PENDING_LOGIN_ACCOUNT].contains("consumed"));
    }

    #[test]
    fn verified_delete_is_a_safe_fallback_when_tombstone_write_fails() {
        let backend = Arc::new(TestCredentialBackend::default());
        let store = SystemAuthCredentialStore {
            backend: backend.clone(),
        };
        store
            .write(&stored_state())
            .expect("write keychain records");
        backend.fail_write(REFRESH_TOKEN_ACCOUNT);
        backend.fail_write(PENDING_LOGIN_ACCOUNT);

        store
            .clear()
            .expect("verified deletion guarantees local logout");
        let loaded = store.load().expect("load cleared records");

        assert!(loaded.session.is_none());
        assert!(loaded.pending_login.is_none());
    }

    #[test]
    fn logout_fails_closed_when_neither_tombstone_nor_delete_is_verifiable() {
        let backend = Arc::new(TestCredentialBackend::default());
        let store = SystemAuthCredentialStore {
            backend: backend.clone(),
        };
        store
            .write(&stored_state())
            .expect("write keychain records");
        backend.fail_write(REFRESH_TOKEN_ACCOUNT);
        backend.fail_delete(REFRESH_TOKEN_ACCOUNT);

        let error = store
            .clear()
            .expect_err("logout guarantee must fail closed");

        assert_eq!(error.kind(), AuthErrorKind::PersistentLogoutNotGuaranteed);
        assert!(backend
            .read(REFRESH_TOKEN_ACCOUNT)
            .expect("read active refresh record")
            .is_some());
    }

    #[test]
    fn versioned_keychain_records_keep_secrets_in_separate_bounded_payloads() {
        let user = AuthUser {
            provider_id: "provider".to_string(),
            issuer: "https://issuer.test".to_string(),
            subject: "subject".to_string(),
            display_name: Some("Demo".to_string()),
            handle: Some("demo".to_string()),
            email: Some("demo@example.test".to_string()),
            email_verified: Some(true),
            avatar_revision: None,
        };
        let metadata = SessionMetadataRecordV1 {
            schema_version: KEYCHAIN_SCHEMA_VERSION,
            generation_id: "generation".to_string(),
            provider_fingerprint: "fingerprint".to_string(),
            user,
            last_authenticated_at: 100,
            last_refreshed_at: Some(200),
        };
        let refresh = RefreshTokenRecordV1 {
            schema_version: KEYCHAIN_SCHEMA_VERSION,
            record_state: RecordState::Active,
            generation_id: Some("generation".to_string()),
            provider_fingerprint: Some("fingerprint".to_string()),
            issuer: Some("https://issuer.test".to_string()),
            subject: Some("subject".to_string()),
            refresh_token: Some("refresh-secret".to_string()),
        };

        let metadata_payload = encode_record(&metadata).expect("metadata payload");
        let refresh_payload = encode_record(&refresh).expect("refresh payload");

        assert!(!metadata_payload.contains("refresh-secret"));
        assert!(refresh_payload.contains("refresh-secret"));
        assert!(!refresh_payload.contains("accessToken"));
    }

    #[test]
    fn active_pending_login_fails_closed_when_a_required_secret_is_missing() {
        let payload = serde_json::json!({
            "schemaVersion": KEYCHAIN_SCHEMA_VERSION,
            "recordState": "active",
            "transactionId": "transaction",
            "providerFingerprint": "fingerprint",
            "state": "state",
            "nonce": "nonce",
            "pkceVerifier": null,
            "authorizationUrl": "https://issuer.test/authorize",
            "createdAt": 100,
            "expiresAt": 200
        })
        .to_string();
        let record: PendingLoginRecordV1 = decode_record(&payload).expect("record envelope");
        let error = match record.into_domain() {
            Ok(_) => panic!("missing PKCE verifier must fail closed"),
            Err(error) => error,
        };

        assert_eq!(error.kind(), AuthErrorKind::SecureStorageCorrupted);
    }

    #[test]
    fn signed_out_refresh_record_contains_no_recoverable_token() {
        let record = RefreshTokenRecordV1 {
            schema_version: KEYCHAIN_SCHEMA_VERSION,
            record_state: RecordState::SignedOut,
            generation_id: None,
            provider_fingerprint: None,
            issuer: None,
            subject: None,
            refresh_token: None,
        };
        let payload = encode_record(&record).expect("tombstone payload");

        assert!(!payload.contains("refresh-secret"));
        assert!(payload.contains("signedOut"));
    }
}

#[cfg(test)]
pub(crate) use tests::InMemoryAuthCredentialStore;
