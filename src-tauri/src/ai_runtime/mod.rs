// AI Runtime sidecar 的统一边界模块。
// 当前阶段：开发环境仅负责 endpoint 决策；生产环境同时启动并托管 sidecar。
// 后续阶段：可继续增强前端初始化等待和跨平台发布细节。
// 生命周期实现分别由 endpoint、port、process、state 和 backend_bridge 模块承载。

pub const AI_RUNTIME_LOG_TARGET: &str = "nexuspilot::ai_runtime";

pub mod backend_bridge;
pub mod endpoint;
pub mod health;
pub mod port;
pub mod process;
pub mod state;
