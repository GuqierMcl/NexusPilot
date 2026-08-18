mod alter_diff;
mod alter_render;
mod alter_validate;
mod canonical;
mod change_execute;
mod change_runtime;
mod change_types;
mod create_execute;
mod create_render;
mod create_types;
mod create_validate;
mod describe;
mod drop;
mod parser;
mod projection_validate;
mod schema_compare;
mod skipping_index_validate;
mod sql_scan;
mod table_object_execute;
mod table_object_render;
mod types;
mod view;

use async_trait::async_trait;

use crate::engine::native_schema::{
    NativeSchemaChangePlan, NativeSchemaChangeResult, NativeSchemaChangeTarget,
    NativeSchemaCreateResult, NativeSchemaCreateTarget, NativeSchemaDescribeRequest,
    NativeSchemaDocument, NativeSchemaExecuteChangeRequest, NativeSchemaExecuteCreateRequest,
    NativeSchemaExtension, NativeSchemaMutationPreview, NativeSchemaSessionDocuments,
    NativeSchemaSessionListRequest, NativeSchemaSupportDocument, NativeSchemaSupportRequest,
};
use crate::engine::types::SchemaMutationOperation;
use crate::error::{IpcError, IpcResult};

use super::ClickHouseDriver;
use alter_render::{plan_alter_table, plan_column_clear, plan_column_materialize};
use change_execute::{execute_column_action, execute_table_alter};
use change_runtime::validate_native_schema_confirmation;
use create_execute::{execute_create_database, execute_create_table};
use create_render::{plan_create_database, plan_create_table};
use drop::{execute_database_drop, execute_table_drop, preview_database_drop, preview_table_drop};
use table_object_execute::{execute_projection_change, execute_skipping_index_change};
use table_object_render::{plan_projection_change, plan_skipping_index_change};
use view::{
    describe_persistent_view, describe_temporary_view, execute_cluster_view_change,
    execute_cluster_view_create, execute_view_change, execute_view_create,
    list_temporary_view_schemas, plan_view_change, plan_view_change_with_cluster, plan_view_create,
    probe_view_runtime_support, read_cluster_baseline, ClientViewSupportExecutor,
    DriverViewExecutionExecutor,
};

pub use change_types::*;
pub use create_types::*;
pub(crate) use describe::describe_table;
pub use types::*;
pub use view::*;

fn native_view_change_target(
    target: &NativeSchemaChangeTarget,
) -> Option<ClickHouseViewChangeTarget> {
    match target {
        NativeSchemaChangeTarget::ClickHouseViewAlter(target) => {
            Some(ClickHouseViewChangeTarget::Alter(target.clone()))
        }
        NativeSchemaChangeTarget::ClickHouseViewRename(target) => {
            Some(ClickHouseViewChangeTarget::Rename(target.clone()))
        }
        NativeSchemaChangeTarget::ClickHouseViewDrop(target) => {
            Some(ClickHouseViewChangeTarget::Drop(target.clone()))
        }
        _ => None,
    }
}

fn view_change_baseline(target: &ClickHouseViewChangeTarget) -> &ClickHouseViewSchema {
    match target {
        ClickHouseViewChangeTarget::Alter(target) => &target.baseline,
        ClickHouseViewChangeTarget::Rename(target) => &target.baseline,
        ClickHouseViewChangeTarget::Drop(target) => &target.baseline,
    }
}

async fn preview_view_create(
    driver: &ClickHouseDriver,
    target: &ClickHouseViewCreateTarget,
) -> IpcResult<NativeSchemaMutationPreview> {
    let support = probe_view_runtime_support(
        &ClientViewSupportExecutor::new(driver),
        target.desired.address.database.as_deref(),
    )
    .await?;
    match &target.desired.scope {
        ClickHouseViewScopeTarget::Local | ClickHouseViewScopeTarget::Temporary { .. } => {
            plan_view_create(target, &support, None)
        }
        ClickHouseViewScopeTarget::Cluster { cluster_name } => {
            let executor = DriverViewExecutionExecutor::new(driver);
            let baseline =
                read_cluster_baseline(&executor, cluster_name, &target.desired.address).await?;
            plan_view_create(target, &support, Some(&baseline))
        }
    }
}

async fn preview_view_change(
    driver: &ClickHouseDriver,
    target: &NativeSchemaChangeTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    let target = native_view_change_target(target).ok_or_else(|| {
        IpcError::validation_failed("ClickHouse View planner requires a View change target")
    })?;
    let baseline = view_change_baseline(&target);
    let support = probe_view_runtime_support(
        &ClientViewSupportExecutor::new(driver),
        baseline.identity.address.database.as_deref(),
    )
    .await?;
    match &baseline.scope {
        ClickHouseViewScope::Local | ClickHouseViewScope::Temporary { .. } => {
            plan_view_change(&target, &support)
        }
        ClickHouseViewScope::Cluster { cluster_name } => {
            let executor = DriverViewExecutionExecutor::new(driver);
            let cluster_baseline =
                read_cluster_baseline(&executor, cluster_name, &baseline.identity.address).await?;
            plan_view_change_with_cluster(&target, &support, Some(&cluster_baseline))
        }
    }
}

#[async_trait]
impl NativeSchemaExtension for ClickHouseDriver {
    async fn support(
        &self,
        request: &NativeSchemaSupportRequest,
    ) -> IpcResult<NativeSchemaSupportDocument> {
        match request {
            NativeSchemaSupportRequest::ClickHouseView {
                database,
                cluster_name: _,
            } => probe_view_runtime_support(
                &ClientViewSupportExecutor::new(self),
                database.as_deref(),
            )
            .await
            .map(NativeSchemaSupportDocument::ClickHouseView),
        }
    }

    async fn list_session_documents(
        &self,
        request: &NativeSchemaSessionListRequest,
    ) -> IpcResult<NativeSchemaSessionDocuments> {
        let owner_tab_runtime_id = self.owner_tab_runtime_id().ok_or_else(|| {
            IpcError::resource_not_found(
                "ClickHouse Temporary Views require an active owner tab runtime",
            )
        })?;
        match request {
            NativeSchemaSessionListRequest::ClickHouseTemporaryViews => {
                list_temporary_view_schemas(self, owner_tab_runtime_id)
                    .await
                    .map(NativeSchemaSessionDocuments::ClickHouseViews)
            }
        }
    }

    async fn describe(
        &self,
        request: &NativeSchemaDescribeRequest,
    ) -> IpcResult<NativeSchemaDocument> {
        match request {
            NativeSchemaDescribeRequest::Table(container) => describe_table(self, container)
                .await
                .map(|schema| NativeSchemaDocument::ClickHouseTable(Box::new(schema))),
            NativeSchemaDescribeRequest::View(container) if container.database.is_none() => {
                let owner_tab_runtime_id = self.owner_tab_runtime_id().ok_or_else(|| {
                    IpcError::resource_not_found(
                        "ClickHouse Temporary View requires an active owner tab runtime",
                    )
                })?;
                describe_temporary_view(self, owner_tab_runtime_id, container)
                    .await
                    .map(|schema| NativeSchemaDocument::ClickHouseView(Box::new(schema)))
            }
            NativeSchemaDescribeRequest::View(container) => {
                describe_persistent_view(self, container)
                    .await
                    .map(|schema| NativeSchemaDocument::ClickHouseView(Box::new(schema)))
            }
        }
    }

    async fn preview_create(
        &self,
        target: &NativeSchemaCreateTarget,
    ) -> IpcResult<NativeSchemaMutationPreview> {
        match target {
            NativeSchemaCreateTarget::ClickHouseDatabase(target) => plan_create_database(target),
            NativeSchemaCreateTarget::ClickHouseTable(target) => plan_create_table(target),
            NativeSchemaCreateTarget::ClickHouseView(target) => {
                preview_view_create(self, target).await
            }
        }
    }

    async fn execute_create(
        &self,
        request: &NativeSchemaExecuteCreateRequest,
    ) -> IpcResult<NativeSchemaCreateResult> {
        let (preview, object_name) = match &request.target {
            NativeSchemaCreateTarget::ClickHouseDatabase(target) => {
                (plan_create_database(target)?, target.name.as_str())
            }
            NativeSchemaCreateTarget::ClickHouseTable(target) => {
                (plan_create_table(target)?, target.name.as_str())
            }
            NativeSchemaCreateTarget::ClickHouseView(target) => {
                let preview = preview_view_create(self, target).await?;
                let executor = DriverViewExecutionExecutor::new(self);
                let result = match (&target.desired.scope, request.baseline.as_ref()) {
                    (
                        ClickHouseViewScopeTarget::Cluster { .. },
                        Some(crate::engine::native_schema::NativeSchemaChangeBaseline::ClickHouseClusterView(baseline)),
                    ) => execute_cluster_view_create(&executor, request, baseline).await,
                    (ClickHouseViewScopeTarget::Cluster { .. }, _) => Err(IpcError::validation_failed(
                        "ClickHouse Cluster View create requires its preview baseline",
                    )),
                    (_, _) => execute_view_create(&executor, request).await,
                }?;
                debug_assert_eq!(preview.plan_hash, request.expected_plan_hash);
                return Ok(NativeSchemaCreateResult::ClickHouseView(Box::new(result)));
            }
        };
        validate_native_schema_confirmation(
            preview.required_confirmation,
            request.confirmation.as_ref(),
            object_name,
            None,
        )?;

        match &request.target {
            NativeSchemaCreateTarget::ClickHouseDatabase(target) => {
                execute_create_database(self, target, &request.expected_plan_hash)
                    .await
                    .map(NativeSchemaCreateResult::ClickHouseDatabase)
            }
            NativeSchemaCreateTarget::ClickHouseTable(target) => {
                execute_create_table(self, target, &request.expected_plan_hash)
                    .await
                    .map(|result| NativeSchemaCreateResult::ClickHouseTable(Box::new(result)))
            }
            NativeSchemaCreateTarget::ClickHouseView(_) => {
                unreachable!("View create returned above")
            }
        }
    }

    async fn preview_change(
        &self,
        target: &NativeSchemaChangeTarget,
    ) -> IpcResult<NativeSchemaChangePlan> {
        match target {
            NativeSchemaChangeTarget::ClickHouseTableAlter(target) => plan_alter_table(target),
            NativeSchemaChangeTarget::ClickHouseTableDrop(target) => {
                preview_table_drop(self, target).await
            }
            NativeSchemaChangeTarget::ClickHouseDatabaseDrop(target) => {
                preview_database_drop(self, target).await
            }
            NativeSchemaChangeTarget::ClickHouseColumnClear(target) => plan_column_clear(target),
            NativeSchemaChangeTarget::ClickHouseColumnMaterialize(target) => {
                plan_column_materialize(target)
            }
            NativeSchemaChangeTarget::ClickHouseProjectionCreate(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionDrop(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionClear(_) => {
                plan_projection_change(target)
            }
            NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(_) => {
                plan_skipping_index_change(target)
            }
            NativeSchemaChangeTarget::ClickHouseViewAlter(_)
            | NativeSchemaChangeTarget::ClickHouseViewRename(_)
            | NativeSchemaChangeTarget::ClickHouseViewDrop(_) => {
                preview_view_change(self, target).await
            }
        }
    }

    async fn execute_change(
        &self,
        request: &NativeSchemaExecuteChangeRequest,
    ) -> IpcResult<NativeSchemaChangeResult> {
        match &request.target {
            NativeSchemaChangeTarget::ClickHouseTableAlter(_) => execute_table_alter(self, request)
                .await
                .map(|result| NativeSchemaChangeResult::ClickHouseTableAlter(Box::new(result))),
            NativeSchemaChangeTarget::ClickHouseTableDrop(_) => execute_table_drop(self, request)
                .await
                .map(NativeSchemaChangeResult::ClickHouseTableDrop),
            NativeSchemaChangeTarget::ClickHouseDatabaseDrop(_) => {
                execute_database_drop(self, request)
                    .await
                    .map(NativeSchemaChangeResult::ClickHouseDatabaseDrop)
            }
            NativeSchemaChangeTarget::ClickHouseColumnClear(_) => {
                execute_column_action(self, request, SchemaMutationOperation::Clear)
                    .await
                    .map(|result| {
                        NativeSchemaChangeResult::ClickHouseColumnAction(Box::new(result))
                    })
            }
            NativeSchemaChangeTarget::ClickHouseColumnMaterialize(_) => {
                execute_column_action(self, request, SchemaMutationOperation::Materialize)
                    .await
                    .map(|result| {
                        NativeSchemaChangeResult::ClickHouseColumnAction(Box::new(result))
                    })
            }
            NativeSchemaChangeTarget::ClickHouseProjectionCreate(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionDrop(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionClear(_) => {
                execute_projection_change(self, request)
                    .await
                    .map(|result| {
                        NativeSchemaChangeResult::ClickHouseProjectionChange(Box::new(result))
                    })
            }
            NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(_) => {
                execute_skipping_index_change(self, request)
                    .await
                    .map(|result| {
                        NativeSchemaChangeResult::ClickHouseSkippingIndexChange(Box::new(result))
                    })
            }
            NativeSchemaChangeTarget::ClickHouseViewAlter(_)
            | NativeSchemaChangeTarget::ClickHouseViewRename(_)
            | NativeSchemaChangeTarget::ClickHouseViewDrop(_) => {
                let typed = native_view_change_target(&request.target).ok_or_else(|| {
                    IpcError::validation_failed(
                        "ClickHouse View executor requires a View change target",
                    )
                })?;
                let executor = DriverViewExecutionExecutor::new(self);
                let result = match &view_change_baseline(&typed).scope {
                    ClickHouseViewScope::Cluster { .. } => {
                        let crate::engine::native_schema::NativeSchemaChangeBaseline::ClickHouseClusterView(baseline) = &request.baseline else {
                            return Err(IpcError::validation_failed(
                                "ClickHouse Cluster View change requires its preview baseline",
                            ));
                        };
                        execute_cluster_view_change(&executor, request, baseline).await
                    }
                    ClickHouseViewScope::Local | ClickHouseViewScope::Temporary { .. } => {
                        execute_view_change(&executor, request).await
                    }
                }?;
                Ok(NativeSchemaChangeResult::ClickHouseViewChange(Box::new(
                    result,
                )))
            }
        }
    }
}
