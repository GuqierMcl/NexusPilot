// 9A 元数据仓储由后续同步引擎批次消费；先随本地 migration 建立稳定边界。
#[allow(dead_code)]
pub mod cloud_sync_repository;
pub mod connection_folder_repository;
pub mod connection_repository;
pub mod connection_tree_repository;
pub mod saved_query_repository;
