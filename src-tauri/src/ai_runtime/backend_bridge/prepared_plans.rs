use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use uuid::Uuid;

use super::frames::GatewayExecutionContext;

pub const DEFAULT_PREPARED_PLAN_TTL_MS: u64 = 5 * 60 * 1000;

#[derive(Clone, Default)]
pub struct PreparedPlanRegistry {
    inner: Arc<Mutex<HashMap<String, PreparedPlanEntry>>>,
}

#[derive(Clone, Debug)]
pub struct PreparedPlanSpec {
    pub context: GatewayExecutionContext,
    pub profile_id: String,
    pub execute_operation: &'static str,
    pub exact_payload: Value,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedPlanHandle {
    pub plan_id: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConsumedPreparedPlan {
    pub profile_id: String,
    pub exact_payload: Value,
}

#[derive(Clone, Debug)]
struct PreparedPlanEntry {
    spec: PreparedPlanSpec,
    consumed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreparedPlanError {
    NotFound,
    Expired,
    AlreadyConsumed,
    Mismatch,
    RegistryUnavailable,
}

impl PreparedPlanError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFound => "PLAN_NOT_FOUND",
            Self::Expired => "PLAN_EXPIRED",
            Self::AlreadyConsumed => "PLAN_ALREADY_CONSUMED",
            Self::Mismatch => "PLAN_MISMATCH",
            Self::RegistryUnavailable => "SYSTEM_INTERNAL",
        }
    }
}

impl PreparedPlanRegistry {
    pub fn prepare(&self, spec: PreparedPlanSpec) -> Result<PreparedPlanHandle, PreparedPlanError> {
        let plan_id = format!("plan_{}", Uuid::new_v4().simple());
        let expires_at_ms = spec.expires_at_ms;
        self.inner
            .lock()
            .map_err(|_| PreparedPlanError::RegistryUnavailable)?
            .insert(
                plan_id.clone(),
                PreparedPlanEntry {
                    spec,
                    consumed: false,
                },
            );
        Ok(PreparedPlanHandle {
            plan_id,
            expires_at_ms,
        })
    }

    pub fn consume(
        &self,
        plan_id: &str,
        context: &GatewayExecutionContext,
        execute_operation: &str,
        now_ms: u64,
    ) -> Result<ConsumedPreparedPlan, PreparedPlanError> {
        let mut plans = self
            .inner
            .lock()
            .map_err(|_| PreparedPlanError::RegistryUnavailable)?;
        let Some(entry) = plans.get_mut(plan_id) else {
            return Err(PreparedPlanError::NotFound);
        };
        if entry.consumed {
            return Err(PreparedPlanError::AlreadyConsumed);
        }
        if entry.spec.expires_at_ms <= now_ms {
            plans.remove(plan_id);
            return Err(PreparedPlanError::Expired);
        }
        if entry.spec.execute_operation != execute_operation || entry.spec.context != *context {
            return Err(PreparedPlanError::Mismatch);
        }
        entry.consumed = true;
        Ok(ConsumedPreparedPlan {
            profile_id: entry.spec.profile_id.clone(),
            exact_payload: entry.spec.exact_payload.clone(),
        })
    }

    pub fn clear_run(&self, run_id: &str) -> usize {
        self.retain(|entry| entry.spec.context.run_id != run_id)
    }

    pub fn clear_profile(&self, profile_id: &str) -> usize {
        self.retain(|entry| entry.spec.profile_id != profile_id)
    }

    pub fn clear_expired(&self, now_ms: u64) -> usize {
        self.retain(|entry| entry.spec.expires_at_ms > now_ms)
    }

    pub fn clear_all(&self) -> usize {
        let Ok(mut plans) = self.inner.lock() else {
            return 0;
        };
        let removed = plans.len();
        plans.clear();
        removed
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .map(|plans| plans.len())
            .unwrap_or_default()
    }

    fn retain(&self, keep: impl Fn(&PreparedPlanEntry) -> bool) -> usize {
        let Ok(mut plans) = self.inner.lock() else {
            return 0;
        };
        let before = plans.len();
        plans.retain(|_, entry| keep(entry));
        before - plans.len()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{PreparedPlanError, PreparedPlanRegistry, PreparedPlanSpec};
    use crate::ai_runtime::backend_bridge::frames::GatewayExecutionContext;

    fn context(tool_call_id: &str) -> GatewayExecutionContext {
        GatewayExecutionContext {
            conversation_id: "conv_1".to_string(),
            run_id: "run_1".to_string(),
            message_id: "msg_1".to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_id: "sql.execute".to_string(),
        }
    }

    #[test]
    fn consumes_an_exact_plan_only_once() {
        let registry = PreparedPlanRegistry::default();
        let handle = registry
            .prepare(PreparedPlanSpec {
                context: context("tool_1"),
                profile_id: "profile_1".to_string(),
                execute_operation: "sql.execute",
                exact_payload: json!({ "sql": "DELETE FROM users" }),
                expires_at_ms: 200,
            })
            .expect("plan should prepare");

        let consumed = registry
            .consume(&handle.plan_id, &context("tool_1"), "sql.execute", 100)
            .expect("exact plan should consume");
        assert_eq!(consumed.profile_id, "profile_1");
        assert_eq!(consumed.exact_payload["sql"], "DELETE FROM users");
        assert_eq!(
            registry.consume(&handle.plan_id, &context("tool_1"), "sql.execute", 100),
            Err(PreparedPlanError::AlreadyConsumed)
        );
    }

    #[test]
    fn rejects_expired_and_mismatched_plans_and_cleans_scopes() {
        let registry = PreparedPlanRegistry::default();
        let mismatch = registry
            .prepare(PreparedPlanSpec {
                context: context("tool_1"),
                profile_id: "profile_1".to_string(),
                execute_operation: "sql.execute",
                exact_payload: json!({ "sql": "UPDATE users SET active = 0" }),
                expires_at_ms: 200,
            })
            .expect("plan should prepare");
        assert_eq!(
            registry.consume(&mismatch.plan_id, &context("tool_2"), "sql.execute", 100),
            Err(PreparedPlanError::Mismatch)
        );

        let expired = registry
            .prepare(PreparedPlanSpec {
                context: context("tool_3"),
                profile_id: "profile_2".to_string(),
                execute_operation: "sql.execute",
                exact_payload: json!({ "sql": "SELECT 1" }),
                expires_at_ms: 50,
            })
            .expect("plan should prepare");
        assert_eq!(
            registry.consume(&expired.plan_id, &context("tool_3"), "sql.execute", 50),
            Err(PreparedPlanError::Expired)
        );
        assert_eq!(registry.clear_profile("profile_1"), 1);
        assert_eq!(registry.len(), 0);
        assert_eq!(PreparedPlanError::NotFound.code(), "PLAN_NOT_FOUND");
        assert_eq!(PreparedPlanError::Expired.code(), "PLAN_EXPIRED");
        assert_eq!(
            PreparedPlanError::AlreadyConsumed.code(),
            "PLAN_ALREADY_CONSUMED"
        );
        assert_eq!(PreparedPlanError::Mismatch.code(), "PLAN_MISMATCH");
    }
}
