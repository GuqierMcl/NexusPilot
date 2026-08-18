use std::io;
use std::net::TcpListener;

/// AI Runtime 仅在本地回环地址监听，不暴露到外部网络。
pub const AI_RUNTIME_HOST: &str = "127.0.0.1";
/// AI Runtime 默认端口（开发环境固定使用，生产环境优先尝试）。
/// 与 ai-runtime/src/config.ts 中的默认 PORT 保持同步。
pub const AI_RUNTIME_DEFAULT_PORT: u16 = 8787;

/// 开发环境：直接返回默认端口 8787，不做端口探测。
/// 理由：开发时 AI Runtime 由外部脚本（concurrently）拉起，Rust 不负责启动。
pub fn resolve_development_port() -> u16 {
    AI_RUNTIME_DEFAULT_PORT
}

/// 生产环境：优先尝试默认端口，被占用则向 OS 申请空闲端口。
/// 注意：探测后 socket 会立即释放，在未来启动 sidecar 前存在短暂竞争风险。
pub fn resolve_production_port() -> io::Result<u16> {
    select_available_port(AI_RUNTIME_HOST, AI_RUNTIME_DEFAULT_PORT)
}

/// 端口选择策略：首选端口可用则返回，否则让 OS 分配一个空闲端口。
pub fn select_available_port(host: &str, preferred_port: u16) -> io::Result<u16> {
    if port_is_available(host, preferred_port) {
        return Ok(preferred_port);
    }

    // bind 到端口 0 让 OS 自动分配一个空闲端口
    let listener = TcpListener::bind((host, 0))?;
    listener.local_addr().map(|addr| addr.port())
}

/// 通过尝试 bind 判断端口是否可用。
fn port_is_available(host: &str, port: u16) -> bool {
    TcpListener::bind((host, port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reserve_available_port() -> io::Result<u16> {
        let listener = TcpListener::bind((AI_RUNTIME_HOST, 0))?;
        listener.local_addr().map(|addr| addr.port())
    }

    #[test]
    fn returns_preferred_port_when_available() -> io::Result<()> {
        let preferred_port = reserve_available_port()?;

        assert_eq!(
            preferred_port,
            select_available_port(AI_RUNTIME_HOST, preferred_port)?
        );

        Ok(())
    }

    #[test]
    fn returns_another_port_when_preferred_port_is_occupied() -> io::Result<()> {
        let listener = TcpListener::bind((AI_RUNTIME_HOST, 0))?;
        let occupied_port = listener.local_addr()?.port();

        let selected_port = select_available_port(AI_RUNTIME_HOST, occupied_port)?;

        assert_ne!(occupied_port, selected_port);
        assert!(selected_port > 0);

        Ok(())
    }
}
