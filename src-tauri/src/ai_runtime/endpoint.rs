use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AiRuntimeMode {
    Development,
    Production,
}

/// 通过 `get_ai_runtime_endpoint` IPC 命令返回给前端。
/// 前端所有 AI Runtime API 调用必须复用此结构体的 `base_url`，
/// 不得在组件或请求模块中写死 `localhost`、`127.0.0.1`、`8787`。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRuntimeEndpoint {
    pub base_url: String,
    pub host: String,
    pub port: u16,
    pub mode: AiRuntimeMode,
    pub access_token: Option<String>,
}

impl AiRuntimeEndpoint {
    pub fn new(
        host: impl Into<String>,
        port: u16,
        mode: AiRuntimeMode,
        access_token: Option<String>,
    ) -> Self {
        let host = host.into();

        Self {
            base_url: format!("http://{host}:{port}"),
            host,
            port,
            mode,
            access_token,
        }
    }
}

pub fn generate_access_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;

    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::generate_access_token;

    #[test]
    fn generates_distinct_256_bit_hex_tokens() {
        let first = generate_access_token().expect("token generation should succeed");
        let second = generate_access_token().expect("token generation should succeed");

        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
