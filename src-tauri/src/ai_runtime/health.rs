// `/health` 是 Frontend 查询 AI Runtime 状态的接口，Rust 不通过它发现或恢复 Backend Bridge。
// 当前文件仅保留模块位置；后续 Bridge ready、heartbeat 与重连应在独立 Bridge client 中实现。
