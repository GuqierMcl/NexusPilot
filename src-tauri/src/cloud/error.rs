use serde::Serialize;
use time::OffsetDateTime;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum CloudErrorCode {
    #[serde(rename = "CLOUD_UNAUTHENTICATED")]
    Unauthenticated,
    #[serde(rename = "CLOUD_REAUTHENTICATION_REQUIRED")]
    ReauthenticationRequired,
    #[serde(rename = "CLOUD_AUTH_TEMPORARILY_UNAVAILABLE")]
    AuthTemporarilyUnavailable,
    #[serde(rename = "CLOUD_INSUFFICIENT_SCOPE")]
    InsufficientScope,
    #[serde(rename = "CLOUD_TEMPORARILY_UNAVAILABLE")]
    TemporarilyUnavailable,
    #[serde(rename = "CLOUD_PROTOCOL_ERROR")]
    ProtocolError,
    #[serde(rename = "CLOUD_ACCOUNT_NOT_INITIALIZED")]
    AccountNotInitialized,
    #[serde(rename = "CLOUD_CONNECTION_SYNC_NOT_ENTITLED")]
    ConnectionSyncNotEntitled,
    #[serde(rename = "CLOUD_CONNECTION_SYNC_RESTRICTED")]
    ConnectionSyncRestricted,
    #[serde(rename = "CLOUD_ACCOUNT_UNAVAILABLE")]
    AccountUnavailable,
    #[serde(rename = "CLOUD_SYNC_DEVICE_LIMIT_EXCEEDED")]
    SyncDeviceLimitExceeded,
    #[serde(rename = "CLOUD_SYNC_DEVICE_ALREADY_CONFIGURED")]
    SyncDeviceAlreadyConfigured,
    #[serde(rename = "CLOUD_SYNC_NOT_INITIALIZED")]
    SyncNotInitialized,
    #[serde(rename = "CLOUD_DEVICE_AUTHORIZATION_CONFLICT")]
    DeviceAuthorizationConflict,
    #[serde(rename = "CLOUD_DEVICE_AUTHORIZATION_INVALID")]
    DeviceAuthorizationInvalid,
    #[serde(rename = "CLOUD_DEVICE_AUTHORIZATION_PENDING_LIMIT_EXCEEDED")]
    DeviceAuthorizationPendingLimitExceeded,
    #[serde(rename = "CLOUD_DEVICE_AUTHORIZATION_NOT_FOUND")]
    DeviceAuthorizationNotFound,
    #[serde(rename = "CLOUD_DEVICE_AUTHORIZATION_NOT_PENDING")]
    DeviceAuthorizationNotPending,
    #[serde(rename = "CLOUD_SYNC_ALREADY_INITIALIZED")]
    SyncAlreadyInitialized,
    #[serde(rename = "CLOUD_SYNC_INITIALIZATION_MISMATCH")]
    SyncInitializationMismatch,
    #[serde(rename = "CLOUD_SYNC_DEVICE_NOT_AUTHORIZED")]
    SyncDeviceNotAuthorized,
    #[serde(rename = "CLOUD_SYNC_SETUP_INVALID")]
    SyncSetupInvalid,
    #[serde(rename = "CLOUD_SYNC_SETUP_EXPIRED")]
    SyncSetupExpired,
    #[serde(rename = "CLOUD_SECURE_STORAGE_UNAVAILABLE")]
    SecureStorageUnavailable,
    #[serde(rename = "CLOUD_RECOVERY_KEY_EXPORT_FAILED")]
    RecoveryKeyExportFailed,
    #[serde(rename = "CLOUD_RECOVERY_KEY_INVALID")]
    RecoveryKeyInvalid,
    #[serde(rename = "CLOUD_CONNECTION_SYNC_CONFLICT")]
    ConnectionSyncConflict,
    #[serde(rename = "CLOUD_CONNECTION_SYNC_QUOTA_EXCEEDED")]
    ConnectionSyncQuotaExceeded,
    #[serde(rename = "CLOUD_CONNECTION_SYNC_ASSET_TOO_LARGE")]
    ConnectionSyncAssetTooLarge,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPublicError {
    pub code: CloudErrorCode,
    pub message: String,
    pub retryable: bool,
    pub occurred_at: String,
}

impl CloudPublicError {
    pub(crate) fn from_code(code: CloudErrorCode) -> Self {
        let (message, retryable) = match code {
            CloudErrorCode::Unauthenticated => {
                ("请先登录 NIEEX Account 后再使用 NexusPilot Cloud。", false)
            }
            CloudErrorCode::ReauthenticationRequired => {
                ("登录会话无法用于 NexusPilot Cloud，请重新登录。", false)
            }
            CloudErrorCode::AuthTemporarilyUnavailable => (
                "暂时无法从 NIEEX Account 获取 Cloud 访问凭据，请稍后重试。",
                true,
            ),
            CloudErrorCode::InsufficientScope => (
                "当前 NIEEX Account 未获得 NexusPilot Cloud 访问权限，请联系支持。",
                false,
            ),
            CloudErrorCode::TemporarilyUnavailable => {
                ("NexusPilot Cloud 暂时不可用，请稍后重试。", true)
            }
            CloudErrorCode::ProtocolError => (
                "NexusPilot Cloud 返回了无法识别的响应，请更新应用或联系支持。",
                false,
            ),
            CloudErrorCode::AccountNotInitialized => (
                "NexusPilot Cloud 账户尚未初始化，请重新打开设置后重试。",
                false,
            ),
            CloudErrorCode::ConnectionSyncNotEntitled => (
                "当前订阅暂不包含加密连接同步。其他 Cloud 权益不受影响。",
                false,
            ),
            CloudErrorCode::ConnectionSyncRestricted => {
                ("当前订阅状态暂不允许新增同步设备。", false)
            }
            CloudErrorCode::AccountUnavailable => ("NexusPilot Cloud 账户当前不可用。", false),
            CloudErrorCode::SyncDeviceLimitExceeded => {
                ("已达到当前权益允许的同步设备数量上限。", false)
            }
            CloudErrorCode::SyncDeviceAlreadyConfigured => {
                ("本设备已经配置了 Cloud 同步，请直接查看同步状态。", false)
            }
            CloudErrorCode::SyncNotInitialized => {
                ("Cloud 尚未在其他设备上启用同步，请先完成首次启用。", false)
            }
            CloudErrorCode::DeviceAuthorizationConflict => (
                "当前设备存在未完成的授权请求，请先完成或取消后再试。",
                false,
            ),
            CloudErrorCode::DeviceAuthorizationInvalid => {
                ("无法创建设备授权请求，请稍后重试。", false)
            }
            CloudErrorCode::DeviceAuthorizationPendingLimitExceeded => {
                ("待授权设备数量已达到上限，请稍后重试。", false)
            }
            CloudErrorCode::DeviceAuthorizationNotFound => {
                ("待授权设备请求不存在或已过期。", false)
            }
            CloudErrorCode::DeviceAuthorizationNotPending => {
                ("该设备授权请求已经处理，无法重复执行当前操作。", false)
            }
            CloudErrorCode::SyncAlreadyInitialized => (
                "加密同步已经在其他设备上启用，请改用设备授权或恢复密钥。",
                false,
            ),
            CloudErrorCode::SyncInitializationMismatch => {
                ("本次启用请求与 Cloud 记录不一致，请取消后重新开始。", false)
            }
            CloudErrorCode::SyncDeviceNotAuthorized => {
                ("本设备当前未获得 Cloud 同步设备授权。", false)
            }
            CloudErrorCode::SyncSetupInvalid => {
                ("加密同步启用信息无效，请检查设备名称后重试。", false)
            }
            CloudErrorCode::SyncSetupExpired => ("本次加密同步启用会话已过期，请重新开始。", false),
            CloudErrorCode::SecureStorageUnavailable => (
                "无法将同步密钥安全写入系统凭据存储，请检查系统设置后重试。",
                true,
            ),
            CloudErrorCode::RecoveryKeyExportFailed => {
                ("恢复密钥未能复制或保存，请重试并确认后再启用同步。", true)
            }
            CloudErrorCode::RecoveryKeyInvalid => {
                ("恢复密钥无法解锁当前同步数据，请检查输入后重试。", false)
            }
            CloudErrorCode::ConnectionSyncConflict => (
                "存在待处理的同步冲突，请在设备与安全中选择要保留的版本。",
                false,
            ),
            CloudErrorCode::ConnectionSyncQuotaExceeded => (
                "同步存储空间已达到当前权益上限，请删除部分数据后重试。",
                false,
            ),
            CloudErrorCode::ConnectionSyncAssetTooLarge => {
                ("该同步项目超过了当前允许的大小。", false)
            }
        };
        Self {
            code,
            message: message.to_string(),
            retryable,
            occurred_at: now_string(),
        }
    }
}

fn now_string() -> String {
    let value = OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
    )
}
