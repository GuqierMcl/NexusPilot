use clickhouse::query::Query;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExecutionPolicy {
    ReadOnlyGrid,
    DirectGrid,
    DirectRaw,
    Control,
}

#[allow(dead_code)]
impl ExecutionPolicy {
    pub(super) fn settings(self, timeout_ms: Option<u64>) -> Vec<(&'static str, String)> {
        let mut settings = Vec::new();
        if matches!(self, Self::ReadOnlyGrid) {
            settings.push(("readonly", "2".to_string()));
        }
        if !matches!(self, Self::DirectRaw) {
            settings.extend([
                ("output_format_json_quote_64bit_integers", "1".to_string()),
                ("output_format_json_quote_decimals", "1".to_string()),
                ("output_format_json_quote_denormals", "1".to_string()),
                ("output_format_json_validate_utf8", "1".to_string()),
            ]);
        }
        if let Some(timeout_ms) = timeout_ms {
            let seconds = timeout_ms.saturating_add(999) / 1_000;
            settings.push(("max_execution_time", seconds.max(1).to_string()));
        }
        settings
    }

    pub(super) fn apply(self, mut query: Query, timeout_ms: Option<u64>) -> Query {
        for (name, value) in self.settings(timeout_ms) {
            query = query.with_setting(name, value);
        }
        query
    }

    pub(super) fn command_settings(self, timeout_ms: Option<u64>) -> Vec<(&'static str, String)> {
        let mut settings = self.settings(timeout_ms);
        settings.push(("wait_end_of_query", "1".to_string()));
        settings
    }

    pub(super) fn apply_command(self, mut query: Query, timeout_ms: Option<u64>) -> Query {
        for (name, value) in self.command_settings(timeout_ms) {
            query = query.with_setting(name, value);
        }
        query
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_policy_applies_all_required_query_settings() {
        assert_eq!(
            ExecutionPolicy::ReadOnlyGrid.settings(Some(30_000)),
            vec![
                ("readonly", "2".to_string()),
                ("output_format_json_quote_64bit_integers", "1".to_string()),
                ("output_format_json_quote_decimals", "1".to_string()),
                ("output_format_json_quote_denormals", "1".to_string()),
                ("output_format_json_validate_utf8", "1".to_string()),
                ("max_execution_time", "30".to_string()),
            ]
        );
    }

    #[test]
    fn direct_command_settings_wait_for_completion_without_readonly() {
        let settings = ExecutionPolicy::DirectGrid.command_settings(Some(30_000));
        assert!(!settings.iter().any(|(name, _)| *name == "readonly"));
        assert!(settings.contains(&("wait_end_of_query", "1".to_string())));
        assert!(settings.contains(&("max_execution_time", "30".to_string())));
    }

    #[test]
    fn phase_four_policies_apply_timeout_without_changing_legacy_readonly() {
        let readonly = ExecutionPolicy::ReadOnlyGrid.settings(Some(30_001));
        assert!(readonly.contains(&("readonly", "2".to_string())));
        assert!(readonly.contains(&("max_execution_time", "31".to_string())));

        let direct = ExecutionPolicy::DirectGrid.settings(Some(30_000));
        assert!(!direct.iter().any(|(name, _)| *name == "readonly"));

        let raw = ExecutionPolicy::DirectRaw.settings(None);
        assert!(!raw.iter().any(|(name, _)| *name == "max_execution_time"));

        let control = ExecutionPolicy::Control.settings(Some(5_000));
        assert!(control.contains(&("max_execution_time", "5".to_string())));
    }

    #[test]
    fn direct_raw_only_applies_timeout_and_never_inherits_grid_or_command_settings() {
        assert_eq!(
            ExecutionPolicy::DirectRaw.settings(Some(30_001)),
            vec![("max_execution_time", "31".to_string())],
        );
        let settings = ExecutionPolicy::DirectRaw.settings(None);
        for forbidden in [
            "readonly",
            "output_format_json_quote_64bit_integers",
            "output_format_json_quote_decimals",
            "output_format_json_quote_denormals",
            "output_format_json_validate_utf8",
            "wait_end_of_query",
        ] {
            assert!(!settings.iter().any(|(name, _)| *name == forbidden));
        }
    }
}
