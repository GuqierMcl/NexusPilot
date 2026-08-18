mod ai_runtime;
mod auth;
mod cloud;
mod commands;
mod db;
mod deep_link;
mod engine;
mod error;
mod installation;
#[cfg(test)]
mod real_db_tests;
mod repository;
mod single_instance;
mod workbench;

use ai_runtime::state::AiRuntimeState;
use ai_runtime::{backend_bridge::PreparedPlanRegistry, AI_RUNTIME_LOG_TARGET};
use commands::ai_runtime_commands::{get_ai_runtime_endpoint, shutdown_ai_runtime_sidecar};
use commands::app_config_commands::get_release_public_base_url;
use commands::auth_commands::{
    cancel_auth_sign_in, get_auth_avatar, get_auth_snapshot, retry_auth_session,
    sign_out_auth_session, start_auth_sign_in,
};
use commands::cloud_commands::{
    approve_device_authorization, begin_device_authorization, begin_sync_setup,
    bootstrap_cloud_account, cancel_device_authorization, cancel_sync_setup,
    claim_device_authorization, complete_cloud_sync_local_dependency, copy_recovery_key,
    copy_rotated_recovery_key, delete_cloud_sync_data, finalize_sync_setup,
    get_cached_sync_setup_context, get_cloud_desktop_state, get_cloud_sync_runtime_status,
    get_cloud_sync_status, get_pending_device_authorization, get_sync_setup_context,
    list_cloud_devices, list_cloud_sync_conflicts, list_cloud_sync_local_dependencies,
    list_pending_device_authorizations, recover_cloud_device_with_recovery_key,
    refresh_cloud_desktop_state, reject_device_authorization, resolve_cloud_sync_conflict,
    revoke_local_sync_device, rotate_cloud_recovery_key, save_recovery_key,
    save_rotated_recovery_key, set_local_sync_paused, sync_cloud_now,
};
use commands::connection_commands::{
    create_connection, delete_connection, get_connection, list_connections,
    reorder_connection_tree, update_connection,
};
use commands::connection_folder_commands::{
    create_connection_folder, delete_connection_folder, get_connection_folder,
    list_connection_folders, update_connection_folder,
};
use commands::engine_commands::{
    alter_clickhouse_table, begin_tab_transaction, browse_key_tree, browse_table_data,
    cancel_sql_execution, close_tab_runtime, commit_tab_transaction, commit_table_change_set,
    connect_profile, create_clickhouse_database, create_clickhouse_table, create_clickhouse_view,
    create_database, create_key_value, create_table, delete_key, delete_key_prefix,
    delete_table_rows, describe_clickhouse_table_schema, describe_clickhouse_view_schema,
    describe_table, disconnect_profile, drop_clickhouse_database, drop_clickhouse_table,
    drop_database, drop_table, execute_clickhouse_column_action,
    execute_clickhouse_projection_change, execute_clickhouse_skipping_index_change,
    execute_clickhouse_view_change, execute_sql, get_clickhouse_view_runtime_support,
    get_connection_capabilities, get_connection_runtime_health, get_key_value,
    get_mysql_database_character_set, get_sql_execution_snapshot, get_tab_transaction_state,
    get_table_page_stats, list_clickhouse_temporary_views, list_connection_runtime_snapshots,
    list_containers, list_mysql_character_sets, open_tab_runtime, preview_alter_clickhouse_table,
    preview_change_clickhouse_view, preview_clickhouse_column_action,
    preview_clickhouse_projection_change, preview_clickhouse_skipping_index_change,
    preview_create_clickhouse_database, preview_create_clickhouse_table,
    preview_create_clickhouse_view, preview_create_database, preview_create_table,
    preview_drop_clickhouse_database, preview_drop_clickhouse_table, preview_drop_database,
    preview_drop_table, preview_table_change_set, preview_update_database, preview_update_table,
    release_sql_execution, rename_key, rollback_tab_transaction, save_sql_execution_artifact,
    scan_key_values, set_key_ttl, set_key_value, start_sql_execution, test_connection,
    test_connection_config, update_database, update_table, update_table_row,
};
use commands::installation_commands::get_installation_identity;
use commands::release_notes_commands::get_current_release_notes;
use commands::saved_query_commands::{
    create_saved_query, delete_saved_query, get_saved_query, list_saved_queries, update_saved_query,
};
use engine::manager::ConnectionRuntimeManager;
use installation::{ensure_installation_identity, InstallationIdentityState};
use tauri::Manager;
use tauri_plugin_log::{FileOpenStrategy, RotationStrategy, Target, TargetKind};

const PRODUCTION_LOG_MAX_FILE_SIZE: u128 = 2 * 1024 * 1024;
const PRODUCTION_LOG_HISTORY_COUNT: usize = 7;
const MAIN_PROCESS_LOG_FILE_NAME: &str = "nexuspilot";
const AI_RUNTIME_LOG_FILE_NAME: &str = "ai-runtime";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            single_instance::handle_single_instance(app, args, cwd);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(if cfg!(debug_assertions) {
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Debug)
                .with_colors(tauri_plugin_log::fern::colors::ColoredLevelConfig::new())
                .clear_targets()
                .target(Target::new(TargetKind::Stdout))
                .build()
        } else {
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .file_open_strategy(FileOpenStrategy::Append)
                .max_file_size(PRODUCTION_LOG_MAX_FILE_SIZE)
                .rotation_strategy(RotationStrategy::KeepSome(PRODUCTION_LOG_HISTORY_COUNT))
                .clear_targets()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some(MAIN_PROCESS_LOG_FILE_NAME.into()),
                    })
                    .filter(|metadata| metadata.target() != AI_RUNTIME_LOG_TARGET),
                    Target::new(TargetKind::LogDir {
                        file_name: Some(AI_RUNTIME_LOG_FILE_NAME.into()),
                    })
                    .filter(|metadata| metadata.target() == AI_RUNTIME_LOG_TARGET),
                ])
                .build()
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                if let Some(scheduler) =
                    window.app_handle().try_state::<cloud::CloudSyncScheduler>()
                {
                    scheduler.on_window_focus_changed(*focused);
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(cloud_service) = window
                    .app_handle()
                    .try_state::<cloud::CloudAccountService>()
                {
                    cloud_service.clear_pending_sync_setups();
                }
                if let Some(scheduler) =
                    window.app_handle().try_state::<cloud::CloudSyncScheduler>()
                {
                    scheduler.shutdown();
                }
                if let Some(ai_runtime_state) = window.app_handle().try_state::<AiRuntimeState>() {
                    ai_runtime_state.shutdown_sidecar();
                }
                if let Some(runtime_manager) =
                    window.app_handle().try_state::<ConnectionRuntimeManager>()
                {
                    if let Err(error) = runtime_manager.shutdown_sql_execution_state() {
                        tauri_plugin_log::log::debug!(
                            "SQL execution teardown failed: code={:?}",
                            error.code
                        );
                    }
                }
            }
        })
        .setup(|app| {
            // ── 桌面 Deep Link（通用 Rust Router；认证回调不暴露给 WebView）──
            #[cfg(desktop)]
            {
                let deep_link_router =
                    deep_link::DesktopDeepLinkRouter::new(deep_link::APP_DEEP_LINK_SCHEME);
                auth::setup(app, &deep_link_router);
                cloud::setup(app);
                deep_link::setup(app, deep_link_router);
            }

            // ── 匿名安装标识（更新时保留，供后续请求/诊断只读使用）──
            let installation_identity = ensure_installation_identity(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })?;
            app.manage(InstallationIdentityState::new(installation_identity));

            // ── 本地存储 SQLite（已有模块，未改动） ──
            let database_state = tauri::async_runtime::block_on(db::init_database(app.handle()))
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })?;
            app.manage(database_state.clone());
            cloud::start_sync_scheduler(app.handle());

            // ── 连接引擎（物理数据库连接池） ──
            let runtime_manager = ConnectionRuntimeManager::new();
            app.manage(runtime_manager.clone());

            // ── AI Runtime endpoint / sidecar（生产环境由 Tauri 接管）──
            let prepared_plans = PreparedPlanRegistry::default();
            app.manage(prepared_plans.clone());
            let ai_runtime_state = AiRuntimeState::initialize(
                app.handle(),
                database_state,
                runtime_manager,
                prepared_plans,
            )?;
            app.manage(ai_runtime_state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ── App config / release IPC ──
            get_release_public_base_url,
            get_installation_identity,
            get_current_release_notes,
            // ── Optional account authentication IPC ──
            get_auth_snapshot,
            get_auth_avatar,
            start_auth_sign_in,
            cancel_auth_sign_in,
            retry_auth_session,
            sign_out_auth_session,
            // ── Authenticated NexusPilot Cloud IPC ──
            bootstrap_cloud_account,
            get_sync_setup_context,
            get_cached_sync_setup_context,
            get_cloud_desktop_state,
            refresh_cloud_desktop_state,
            get_cloud_sync_status,
            sync_cloud_now,
            get_cloud_sync_runtime_status,
            list_cloud_sync_local_dependencies,
            complete_cloud_sync_local_dependency,
            list_cloud_sync_conflicts,
            resolve_cloud_sync_conflict,
            rotate_cloud_recovery_key,
            copy_rotated_recovery_key,
            save_rotated_recovery_key,
            delete_cloud_sync_data,
            list_cloud_devices,
            begin_sync_setup,
            begin_device_authorization,
            get_pending_device_authorization,
            list_pending_device_authorizations,
            approve_device_authorization,
            reject_device_authorization,
            cancel_device_authorization,
            claim_device_authorization,
            set_local_sync_paused,
            revoke_local_sync_device,
            recover_cloud_device_with_recovery_key,
            copy_recovery_key,
            save_recovery_key,
            finalize_sync_setup,
            cancel_sync_setup,
            // ── AI Runtime endpoint IPC ──
            get_ai_runtime_endpoint,
            shutdown_ai_runtime_sidecar,
            // ── Local storage CRUD (unchanged) ──
            list_connection_folders,
            get_connection_folder,
            create_connection_folder,
            update_connection_folder,
            delete_connection_folder,
            list_connections,
            get_connection,
            create_connection,
            update_connection,
            delete_connection,
            reorder_connection_tree,
            list_saved_queries,
            get_saved_query,
            create_saved_query,
            update_saved_query,
            delete_saved_query,
            // ── Connection engine IPC ──
            connect_profile,
            disconnect_profile,
            test_connection,
            test_connection_config,
            get_connection_capabilities,
            get_connection_runtime_health,
            list_connection_runtime_snapshots,
            open_tab_runtime,
            close_tab_runtime,
            list_containers,
            describe_table,
            describe_clickhouse_table_schema,
            get_clickhouse_view_runtime_support,
            describe_clickhouse_view_schema,
            preview_create_clickhouse_view,
            create_clickhouse_view,
            preview_change_clickhouse_view,
            execute_clickhouse_view_change,
            list_clickhouse_temporary_views,
            preview_create_clickhouse_database,
            create_clickhouse_database,
            preview_create_clickhouse_table,
            create_clickhouse_table,
            preview_alter_clickhouse_table,
            alter_clickhouse_table,
            preview_clickhouse_column_action,
            execute_clickhouse_column_action,
            preview_clickhouse_projection_change,
            execute_clickhouse_projection_change,
            preview_clickhouse_skipping_index_change,
            execute_clickhouse_skipping_index_change,
            preview_drop_clickhouse_table,
            drop_clickhouse_table,
            preview_drop_clickhouse_database,
            drop_clickhouse_database,
            preview_create_database,
            create_database,
            preview_update_database,
            update_database,
            preview_drop_database,
            drop_database,
            list_mysql_character_sets,
            get_mysql_database_character_set,
            preview_create_table,
            create_table,
            preview_update_table,
            update_table,
            preview_drop_table,
            drop_table,
            browse_table_data,
            get_table_page_stats,
            update_table_row,
            delete_table_rows,
            preview_table_change_set,
            commit_table_change_set,
            begin_tab_transaction,
            commit_tab_transaction,
            rollback_tab_transaction,
            get_tab_transaction_state,
            execute_sql,
            start_sql_execution,
            get_sql_execution_snapshot,
            cancel_sql_execution,
            release_sql_execution,
            save_sql_execution_artifact,
            scan_key_values,
            browse_key_tree,
            get_key_value,
            set_key_value,
            create_key_value,
            delete_key,
            delete_key_prefix,
            rename_key,
            set_key_ttl,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod ai_runtime_contract_tests {
    use crate::ai_runtime::endpoint::{AiRuntimeEndpoint, AiRuntimeMode};

    #[test]
    fn ai_runtime_endpoint_serializes_for_frontend_discovery() {
        let endpoint = AiRuntimeEndpoint::new(
            "127.0.0.1",
            8787,
            AiRuntimeMode::Production,
            Some("test-token".to_string()),
        );
        let value = serde_json::to_value(endpoint).expect("endpoint should serialize");

        assert_eq!(value["baseUrl"], "http://127.0.0.1:8787");
        assert_eq!(value["host"], "127.0.0.1");
        assert_eq!(value["port"], 8787);
        assert_eq!(value["mode"], "production");
        assert_eq!(value["accessToken"], "test-token");
    }
}
