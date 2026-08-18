use std::{error::Error, fmt::Display};

use serde::Serialize;

use super::session::{epoch_seconds_to_string, now_epoch_seconds};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AuthErrorKind {
    ConfigInvalid,
    SecureStorageUnavailable,
    SecureStorageAccessDenied,
    SecureStorageCorrupted,
    SecureStorageItemTooLarge,
    PersistentLogoutNotGuaranteed,
    ProviderUnavailable,
    ProviderUnsupported,
    BrowserOpenFailed,
    SignInCanceled,
    SignInExpired,
    CallbackInvalid,
    TokenExchangeFailed,
    TokenValidationFailed,
    RefreshRejected,
    ProviderChanged,
    ReauthenticationRequired,
    SystemInternal,
}

impl AuthErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::ConfigInvalid => "AUTH_CONFIG_INVALID",
            Self::SecureStorageUnavailable => "AUTH_SECURE_STORAGE_UNAVAILABLE",
            Self::SecureStorageAccessDenied => "AUTH_SECURE_STORAGE_ACCESS_DENIED",
            Self::SecureStorageCorrupted => "AUTH_SECURE_STORAGE_CORRUPTED",
            Self::SecureStorageItemTooLarge => "AUTH_SECURE_STORAGE_ITEM_TOO_LARGE",
            Self::PersistentLogoutNotGuaranteed => "AUTH_PERSISTENT_LOGOUT_NOT_GUARANTEED",
            Self::ProviderUnavailable => "AUTH_PROVIDER_UNAVAILABLE",
            Self::ProviderUnsupported => "AUTH_PROVIDER_UNSUPPORTED",
            Self::BrowserOpenFailed => "AUTH_BROWSER_OPEN_FAILED",
            Self::SignInCanceled => "AUTH_SIGN_IN_CANCELED",
            Self::SignInExpired => "AUTH_SIGN_IN_EXPIRED",
            Self::CallbackInvalid => "AUTH_CALLBACK_INVALID",
            Self::TokenExchangeFailed => "AUTH_TOKEN_EXCHANGE_FAILED",
            Self::TokenValidationFailed => "AUTH_TOKEN_VALIDATION_FAILED",
            Self::RefreshRejected => "AUTH_REFRESH_REJECTED",
            Self::ProviderChanged => "AUTH_PROVIDER_CHANGED",
            Self::ReauthenticationRequired => "AUTH_REAUTHENTICATION_REQUIRED",
            Self::SystemInternal => "AUTH_SYSTEM_INTERNAL",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::ConfigInvalid => "账号服务配置不可用，本地工作台仍可正常使用。",
            Self::SecureStorageUnavailable => {
                "无法访问系统安全凭据存储，账号和云同步暂不可用；本地工作台仍可使用。"
            }
            Self::SecureStorageAccessDenied => {
                "NexusPilot 未获得系统安全凭据访问权限，请允许后重试。"
            }
            Self::SecureStorageCorrupted => "系统中的登录信息无法验证，需要重新登录。",
            Self::SecureStorageItemTooLarge => "账号服务返回的凭据无法安全保存，请联系支持。",
            Self::PersistentLogoutNotGuaranteed => "已清除当前会话，但无法确认重启后的持久退出。",
            Self::ProviderUnavailable => "暂时无法连接账号服务，请稍后重试。",
            Self::ProviderUnsupported => "当前账号服务缺少桌面安全登录所需能力。",
            Self::BrowserOpenFailed => "无法打开系统浏览器，请重试。",
            Self::SignInCanceled => "登录已取消。",
            Self::SignInExpired => "本次登录请求已过期，请重新登录。",
            Self::CallbackInvalid => "收到的登录回调无效，请重新登录。",
            Self::TokenExchangeFailed => "账号服务未能完成登录，请重试。",
            Self::TokenValidationFailed => "账号服务返回的身份信息未通过安全校验。",
            Self::RefreshRejected => "登录会话已经失效，请重新登录。",
            Self::ProviderChanged => "账号服务配置已更新，请重新登录；本地数据不受影响。",
            Self::ReauthenticationRequired => "需要重新登录以继续使用账号能力。",
            Self::SystemInternal => "账号功能发生内部错误，本地工作台仍可正常使用。",
        }
    }

    fn retryable(self) -> bool {
        matches!(
            self,
            Self::SecureStorageUnavailable
                | Self::SecureStorageAccessDenied
                | Self::ProviderUnavailable
                | Self::BrowserOpenFailed
                | Self::TokenExchangeFailed
                | Self::SystemInternal
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPublicError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub occurred_at: String,
}

impl AuthPublicError {
    pub(crate) fn from_kind(kind: AuthErrorKind) -> Self {
        Self {
            code: kind.code().to_string(),
            message: kind.message().to_string(),
            retryable: kind.retryable(),
            occurred_at: epoch_seconds_to_string(now_epoch_seconds())
                .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string()),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AuthError {
    kind: AuthErrorKind,
    diagnostic_code: &'static str,
}

impl AuthError {
    pub const fn new(kind: AuthErrorKind, diagnostic_code: &'static str) -> Self {
        Self {
            kind,
            diagnostic_code,
        }
    }

    pub fn kind(self) -> AuthErrorKind {
        self.kind
    }

    pub fn public(self) -> AuthPublicError {
        AuthPublicError::from_kind(self.kind)
    }
}

impl Display for AuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.diagnostic_code)
    }
}

impl Error for AuthError {}
