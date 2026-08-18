use crate::auth::{AuthAccessTokenError, AuthManager, SecretString};

#[derive(Clone)]
pub(crate) struct CloudTokenBroker {
    auth_manager: AuthManager,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CloudTokenBrokerError {
    Unauthenticated,
    TemporarilyUnavailable,
    ReauthenticationRequired,
    SystemInternal,
}

impl CloudTokenBroker {
    pub(crate) fn new(auth_manager: AuthManager) -> Self {
        Self { auth_manager }
    }

    pub(crate) async fn access_token(&self) -> Result<SecretString, CloudTokenBrokerError> {
        self.auth_manager
            .usable_access_token()
            .await
            .map_err(CloudTokenBrokerError::from)
    }
}

impl From<AuthAccessTokenError> for CloudTokenBrokerError {
    fn from(error: AuthAccessTokenError) -> Self {
        match error {
            AuthAccessTokenError::Unauthenticated => Self::Unauthenticated,
            AuthAccessTokenError::TemporarilyUnavailable => Self::TemporarilyUnavailable,
            AuthAccessTokenError::ReauthenticationRequired => Self::ReauthenticationRequired,
            AuthAccessTokenError::SystemInternal => Self::SystemInternal,
        }
    }
}
