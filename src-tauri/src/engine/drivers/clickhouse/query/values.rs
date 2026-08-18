use std::collections::HashSet;

use serde_json::{Map, Number, Value};

use super::types::{ClickHouseType, TupleField};
use crate::error::{ErrorCode, IpcError, IpcResult, RuntimeErrorImpact};

const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub(super) struct ValueBudget {
    pub max_serialized_bytes: usize,
    pub max_depth: usize,
    pub max_nodes: usize,
}

impl Default for ValueBudget {
    fn default() -> Self {
        Self {
            max_serialized_bytes: 4 * 1024 * 1024,
            max_depth: 64,
            max_nodes: 100_000,
        }
    }
}

struct BudgetState {
    budget: ValueBudget,
    nodes: usize,
}

impl BudgetState {
    fn enter(&mut self, depth: usize, ty: &ClickHouseType) -> IpcResult<()> {
        if depth > self.budget.max_depth {
            return Err(limit_error(ty, "depth", depth, self.budget.max_depth));
        }
        self.nodes = self.nodes.saturating_add(1);
        if self.nodes > self.budget.max_nodes {
            return Err(limit_error(ty, "nodes", self.nodes, self.budget.max_nodes));
        }
        Ok(())
    }
}

#[allow(dead_code)]
pub(super) fn normalize_value(
    ty: &ClickHouseType,
    value: Value,
    budget: ValueBudget,
) -> IpcResult<Value> {
    let mut state = BudgetState { budget, nodes: 0 };
    let normalized = normalize_inner(ty, value, 0, &mut state)?;
    let serialized_bytes = serde_json::to_vec(&normalized).map_err(|error| {
        IpcError::system_internal(
            "ClickHouse value serialization failed",
            format!("type={ty:?}; error={error}"),
        )
    })?;
    if serialized_bytes.len() > budget.max_serialized_bytes {
        return Err(limit_error(
            ty,
            "serialized_bytes",
            serialized_bytes.len(),
            budget.max_serialized_bytes,
        ));
    }
    Ok(normalized)
}

fn normalize_inner(
    ty: &ClickHouseType,
    value: Value,
    depth: usize,
    state: &mut BudgetState,
) -> IpcResult<Value> {
    state.enter(depth, ty)?;
    match ty {
        ClickHouseType::Nullable(inner) => {
            if value.is_null() {
                Ok(Value::Null)
            } else {
                normalize_inner(inner, value, depth + 1, state)
            }
        }
        ClickHouseType::LowCardinality(inner) => normalize_inner(inner, value, depth + 1, state),
        ClickHouseType::Int { signed, bits } => normalize_integer(value, *signed, *bits, ty),
        ClickHouseType::Float { .. } => normalize_float(value, ty),
        ClickHouseType::Decimal { .. } => normalize_decimal(value, ty),
        ClickHouseType::Bool => match value {
            Value::Bool(_) => Ok(value),
            _ => Err(value_error(ty, "expected boolean")),
        },
        ClickHouseType::String
        | ClickHouseType::FixedString { .. }
        | ClickHouseType::Date
        | ClickHouseType::Date32
        | ClickHouseType::DateTime { .. }
        | ClickHouseType::DateTime64 { .. }
        | ClickHouseType::Uuid
        | ClickHouseType::Ipv4
        | ClickHouseType::Ipv6
        | ClickHouseType::Enum { .. } => match value {
            Value::String(_) => Ok(value),
            _ => Err(value_error(ty, "expected string")),
        },
        ClickHouseType::Array(inner) => {
            let Value::Array(values) = value else {
                return Err(value_error(ty, "expected array"));
            };
            values
                .into_iter()
                .map(|value| normalize_inner(inner, value, depth + 1, state))
                .collect::<IpcResult<Vec<_>>>()
                .map(Value::Array)
        }
        ClickHouseType::Map(key_type, value_type) => {
            normalize_map(key_type, value_type, value, depth, state, ty)
        }
        ClickHouseType::Tuple(fields) => normalize_tuple(fields, value, depth, state, ty),
        ClickHouseType::Nested(fields) => normalize_nested(fields, value, depth, state, ty),
        ClickHouseType::JsonOrObject { .. }
        | ClickHouseType::Variant(_)
        | ClickHouseType::Unknown { .. } => normalize_untyped(value, depth, state, ty),
    }
}

fn normalize_integer(
    value: Value,
    signed: bool,
    bits: u16,
    ty: &ClickHouseType,
) -> IpcResult<Value> {
    let text = match value {
        Value::String(value) => value,
        Value::Number(value) if value.is_i64() || value.is_u64() => value.to_string(),
        _ => return Err(value_error(ty, "expected integer number or decimal text")),
    };
    let (negative, digits) = parse_integer_text(&text, signed, ty)?;
    validate_integer_range(negative, &digits, signed, bits, ty)?;

    let magnitude = digits.parse::<u64>().ok();
    if magnitude.is_some_and(|magnitude| magnitude <= JS_MAX_SAFE_INTEGER) {
        let magnitude = magnitude.expect("safe integer magnitude");
        if negative {
            let value = -(magnitude as i64);
            return Ok(Value::Number(Number::from(value)));
        }
        return Ok(Value::Number(Number::from(magnitude)));
    }

    let prefix = if negative { "-" } else { "" };
    Ok(Value::String(format!("{prefix}{digits}")))
}

fn parse_integer_text(value: &str, signed: bool, ty: &ClickHouseType) -> IpcResult<(bool, String)> {
    let (negative, digits) = if let Some(digits) = value.strip_prefix('-') {
        (true, digits)
    } else if let Some(digits) = value.strip_prefix('+') {
        (false, digits)
    } else {
        (false, value)
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(value_error(ty, "invalid decimal integer text"));
    }
    if negative && !signed {
        return Err(value_error(ty, "unsigned integer cannot be negative"));
    }
    let canonical = digits.trim_start_matches('0');
    let canonical = if canonical.is_empty() { "0" } else { canonical };
    Ok((negative && canonical != "0", canonical.to_string()))
}

fn validate_integer_range(
    negative: bool,
    digits: &str,
    signed: bool,
    bits: u16,
    ty: &ClickHouseType,
) -> IpcResult<()> {
    let max = if signed {
        if negative {
            decimal_power_of_two(bits - 1)
        } else {
            decimal_subtract_one(decimal_power_of_two(bits - 1))
        }
    } else {
        decimal_subtract_one(decimal_power_of_two(bits))
    };
    if decimal_magnitude_exceeds(digits, &max) {
        return Err(value_error(ty, "integer is out of range"));
    }
    Ok(())
}

fn normalize_float(value: Value, ty: &ClickHouseType) -> IpcResult<Value> {
    match value {
        Value::Number(_) => Ok(value),
        Value::String(value) => match value.to_ascii_lowercase().as_str() {
            "nan" => Ok(Value::String("NaN".to_string())),
            "inf" | "+inf" | "infinity" | "+infinity" => Ok(Value::String("Inf".to_string())),
            "-inf" | "-infinity" => Ok(Value::String("-Inf".to_string())),
            _ => {
                let parsed = value
                    .parse::<f64>()
                    .ok()
                    .and_then(Number::from_f64)
                    .ok_or_else(|| value_error(ty, "invalid floating-point text"))?;
                Ok(Value::Number(parsed))
            }
        },
        _ => Err(value_error(ty, "expected floating-point number")),
    }
}

fn normalize_decimal(value: Value, ty: &ClickHouseType) -> IpcResult<Value> {
    let ClickHouseType::Decimal { scale, .. } = ty else {
        return Err(value_error(ty, "expected Decimal type metadata"));
    };
    let text = match value {
        Value::String(value) => value,
        Value::Number(value) => value.to_string(),
        _ => return Err(value_error(ty, "expected decimal text")),
    };
    if !is_plain_decimal(&text) {
        return Err(value_error(ty, "invalid decimal text"));
    }
    let (sign, unsigned) = if let Some(value) = text.strip_prefix('-') {
        ("-", value)
    } else if let Some(value) = text.strip_prefix('+') {
        ("+", value)
    } else {
        ("", text.as_str())
    };
    let (whole, fractional) = unsigned
        .split_once('.')
        .map_or((unsigned, ""), |(whole, fractional)| (whole, fractional));
    let scale = usize::from(*scale);
    if fractional.len() > scale {
        return Err(value_error(
            ty,
            "decimal fraction exceeds its declared scale",
        ));
    }
    let normalized = if scale == 0 {
        format!("{sign}{whole}")
    } else {
        format!(
            "{sign}{whole}.{fractional}{}",
            "0".repeat(scale - fractional.len())
        )
    };
    Ok(Value::String(normalized))
}

fn is_plain_decimal(value: &str) -> bool {
    let value = value
        .strip_prefix('-')
        .or_else(|| value.strip_prefix('+'))
        .unwrap_or(value);
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or_default();
    let fractional = parts.next();
    whole.bytes().all(|byte| byte.is_ascii_digit())
        && !whole.is_empty()
        && fractional
            .is_none_or(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && parts.next().is_none()
}

fn normalize_map(
    key_type: &ClickHouseType,
    value_type: &ClickHouseType,
    value: Value,
    depth: usize,
    state: &mut BudgetState,
    ty: &ClickHouseType,
) -> IpcResult<Value> {
    let entries = match value {
        Value::Object(entries) => entries
            .into_iter()
            .map(|(key, value)| (Value::String(key), value))
            .collect::<Vec<_>>(),
        Value::Array(entries) => entries
            .into_iter()
            .map(|entry| match entry {
                Value::Array(mut pair) if pair.len() == 2 => {
                    let value = pair.pop().expect("map pair value");
                    let key = pair.pop().expect("map pair key");
                    Ok((key, value))
                }
                _ => Err(value_error(ty, "map entries must be key/value pairs")),
            })
            .collect::<IpcResult<Vec<_>>>()?,
        _ => return Err(value_error(ty, "expected map object or pair array")),
    };

    entries
        .into_iter()
        .map(|(key, value)| {
            Ok(Value::Array(vec![
                normalize_inner(key_type, key, depth + 1, state)?,
                normalize_inner(value_type, value, depth + 1, state)?,
            ]))
        })
        .collect::<IpcResult<Vec<_>>>()
        .map(Value::Array)
}

fn normalize_tuple(
    fields: &[TupleField],
    value: Value,
    depth: usize,
    state: &mut BudgetState,
    ty: &ClickHouseType,
) -> IpcResult<Value> {
    match value {
        Value::Array(values) => {
            if values.len() != fields.len() {
                return Err(value_error(ty, "tuple width does not match its type"));
            }
            let normalized = fields
                .iter()
                .zip(values)
                .map(|(field, value)| normalize_inner(&field.ty, value, depth + 1, state))
                .collect::<IpcResult<Vec<_>>>()?;
            tuple_output(fields, normalized)
        }
        Value::Object(mut values) if fields.iter().all(|field| field.name.is_some()) => {
            if values.len() != fields.len() {
                return Err(value_error(ty, "tuple width does not match its type"));
            }
            let mut normalized = Vec::with_capacity(fields.len());
            for field in fields {
                let name = field.name.as_deref().expect("named tuple field");
                let value = values
                    .remove(name)
                    .ok_or_else(|| value_error(ty, "tuple field is missing"))?;
                normalized.push(normalize_inner(&field.ty, value, depth + 1, state)?);
            }
            tuple_output(fields, normalized)
        }
        _ => Err(value_error(ty, "expected tuple array")),
    }
}

fn tuple_output(fields: &[TupleField], values: Vec<Value>) -> IpcResult<Value> {
    let names = fields
        .iter()
        .filter_map(|field| field.name.as_deref())
        .collect::<Vec<_>>();
    let unique_names = names.iter().copied().collect::<HashSet<_>>();
    if names.len() == fields.len() && unique_names.len() == fields.len() {
        let object = names
            .into_iter()
            .zip(values)
            .map(|(name, value)| (name.to_string(), value))
            .collect::<Map<_, _>>();
        Ok(Value::Object(object))
    } else {
        Ok(Value::Array(values))
    }
}

fn normalize_nested(
    fields: &[TupleField],
    value: Value,
    depth: usize,
    state: &mut BudgetState,
    ty: &ClickHouseType,
) -> IpcResult<Value> {
    match value {
        Value::Object(mut values) => {
            if values.len() != fields.len() {
                return Err(value_error(
                    ty,
                    "Nested field count does not match its type",
                ));
            }
            let mut normalized = Map::new();
            for field in fields {
                let name = field
                    .name
                    .as_deref()
                    .ok_or_else(|| value_error(ty, "Nested fields must be named"))?;
                let value = values
                    .remove(name)
                    .ok_or_else(|| value_error(ty, "Nested field is missing"))?;
                let array_type = ClickHouseType::Array(Box::new(field.ty.clone()));
                normalized.insert(
                    name.to_string(),
                    normalize_inner(&array_type, value, depth + 1, state)?,
                );
            }
            Ok(Value::Object(normalized))
        }
        Value::Array(values) => {
            let tuple_type = ClickHouseType::Tuple(fields.to_vec());
            values
                .into_iter()
                .map(|value| normalize_inner(&tuple_type, value, depth + 1, state))
                .collect::<IpcResult<Vec<_>>>()
                .map(Value::Array)
        }
        _ => Err(value_error(ty, "expected Nested object or tuple array")),
    }
}

fn normalize_untyped(
    value: Value,
    depth: usize,
    state: &mut BudgetState,
    ty: &ClickHouseType,
) -> IpcResult<Value> {
    match value {
        Value::Array(values) => values
            .into_iter()
            .map(|value| {
                state.enter(depth + 1, ty)?;
                normalize_untyped(value, depth + 1, state, ty)
            })
            .collect::<IpcResult<Vec<_>>>()
            .map(Value::Array),
        Value::Object(values) => values
            .into_iter()
            .map(|(key, value)| {
                state.enter(depth + 1, ty)?;
                normalize_untyped(value, depth + 1, state, ty).map(|value| (key, value))
            })
            .collect::<IpcResult<Map<_, _>>>()
            .map(Value::Object),
        _ => Ok(value),
    }
}

fn decimal_power_of_two(bits: u16) -> String {
    let mut digits = vec![1_u8];
    for _ in 0..bits {
        let mut carry = 0_u8;
        for digit in &mut digits {
            let doubled = *digit * 2 + carry;
            *digit = doubled % 10;
            carry = doubled / 10;
        }
        if carry > 0 {
            digits.push(carry);
        }
    }
    digits
        .into_iter()
        .rev()
        .map(|digit| char::from(b'0' + digit))
        .collect()
}

fn decimal_subtract_one(value: String) -> String {
    let mut bytes = value.as_bytes().to_vec();
    for digit in bytes.iter_mut().rev() {
        if *digit > b'0' {
            *digit -= 1;
            break;
        }
        *digit = b'9';
    }
    String::from_utf8(bytes).expect("decimal digits are valid UTF-8")
}

fn decimal_magnitude_exceeds(value: &str, max: &str) -> bool {
    value.len() > max.len() || (value.len() == max.len() && value > max)
}

fn value_error(ty: &ClickHouseType, reason: &str) -> IpcError {
    IpcError {
        code: ErrorCode::ValidationFailed,
        runtime_impact: RuntimeErrorImpact::BusinessOnly,
        message: "ClickHouse returned a value that does not match its type".to_string(),
        details: Some(format!("type={ty:?}; reason={reason}")),
    }
}

fn limit_error(ty: &ClickHouseType, limit: &str, actual: usize, maximum: usize) -> IpcError {
    IpcError {
        code: ErrorCode::ValidationFailed,
        runtime_impact: RuntimeErrorImpact::BusinessOnly,
        message: "ClickHouse value exceeds the safe display limit".to_string(),
        details: Some(format!(
            "type={ty:?}; limit={limit}; actual={actual}; maximum={maximum}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::engine::drivers::clickhouse::query::types::parse_type;
    use crate::error::{ErrorCode, RuntimeErrorImpact};

    fn budget() -> ValueBudget {
        ValueBudget {
            max_serialized_bytes: 4 * 1024 * 1024,
            max_depth: 64,
            max_nodes: 100_000,
        }
    }

    #[test]
    fn normalizes_exact_numbers_and_special_floats() {
        assert_eq!(
            normalize_value(
                &parse_type("UInt64").unwrap(),
                json!("9007199254740991"),
                budget(),
            )
            .unwrap(),
            json!(9_007_199_254_740_991_u64)
        );
        assert_eq!(
            normalize_value(
                &parse_type("UInt64").unwrap(),
                json!("9007199254740992"),
                budget(),
            )
            .unwrap(),
            json!("9007199254740992")
        );
        assert_eq!(
            normalize_value(
                &parse_type("Int256").unwrap(),
                json!("-1606938044258990275541962092341162602522202993782792835301376"),
                budget(),
            )
            .unwrap(),
            json!("-1606938044258990275541962092341162602522202993782792835301376")
        );
        assert_eq!(
            normalize_value(
                &parse_type("Decimal(38, 10)").unwrap(),
                json!("12.3400000000"),
                budget(),
            )
            .unwrap(),
            json!("12.3400000000")
        );
        assert_eq!(
            normalize_value(
                &parse_type("Decimal(38, 10)").unwrap(),
                json!("12.34"),
                budget(),
            )
            .unwrap(),
            json!("12.3400000000")
        );
        assert_eq!(
            normalize_value(&parse_type("Float64").unwrap(), json!("nan"), budget(),).unwrap(),
            json!("NaN")
        );
        assert_eq!(
            normalize_value(&parse_type("Float64").unwrap(), json!("-inf"), budget(),).unwrap(),
            json!("-Inf")
        );
    }

    #[test]
    fn normalizes_maps_tuples_null_and_unknown_values() {
        let map = parse_type("Map(UInt64, Decimal(20, 4))").unwrap();
        assert_eq!(
            normalize_value(&map, json!({"1": "2.5000"}), budget()).unwrap(),
            json!([[1, "2.5000"]])
        );

        let tuple = parse_type("Tuple(id UInt64, tags Array(String))").unwrap();
        assert_eq!(
            normalize_value(&tuple, json!([7, ["a"]]), budget()).unwrap(),
            json!({"id": 7, "tags": ["a"]})
        );
        assert_eq!(
            normalize_value(
                &parse_type("Nullable(UInt64)").unwrap(),
                Value::Null,
                budget(),
            )
            .unwrap(),
            Value::Null
        );
        assert_eq!(
            normalize_value(
                &parse_type("FutureType").unwrap(),
                json!({"x": [1, true]}),
                budget(),
            )
            .unwrap(),
            json!({"x": [1, true]})
        );
    }

    #[test]
    fn normalizes_nested_json_variant_and_text_values_recursively() {
        assert_eq!(
            normalize_value(
                &parse_type("Variant(UInt64, Array(String))").unwrap(),
                json!(["Nexus", "控制\n字符", "\u{fffd}"]),
                budget(),
            )
            .unwrap(),
            json!(["Nexus", "控制\n字符", "\u{fffd}"])
        );
        assert_eq!(
            normalize_value(
                &parse_type("Nested(code UInt64, label String)").unwrap(),
                json!({"code": [1, 2], "label": ["a", "b"]}),
                budget(),
            )
            .unwrap(),
            json!({"code": [1, 2], "label": ["a", "b"]})
        );
        assert_eq!(
            normalize_value(
                &parse_type("JSON").unwrap(),
                json!({"array": [1, {"ok": true}]}),
                budget(),
            )
            .unwrap(),
            json!({"array": [1, {"ok": true}]})
        );
    }

    #[test]
    fn rejects_out_of_range_or_shape_mismatched_values() {
        assert!(normalize_value(&parse_type("UInt8").unwrap(), json!("256"), budget(),).is_err());
        assert!(normalize_value(&parse_type("Int8").unwrap(), json!("-129"), budget(),).is_err());
        assert!(normalize_value(
            &parse_type("Tuple(UInt8, String)").unwrap(),
            json!([1]),
            budget(),
        )
        .is_err());
        assert!(normalize_value(
            &parse_type("Array(UInt8)").unwrap(),
            json!({"not": "an array"}),
            budget(),
        )
        .is_err());
    }

    #[test]
    fn rejects_cells_over_depth_node_and_size_limits_without_echoing_values() {
        let depth = normalize_value(
            &parse_type("Array(Array(UInt8))").unwrap(),
            json!([[1]]),
            ValueBudget {
                max_depth: 1,
                ..budget()
            },
        )
        .unwrap_err();
        let nodes = normalize_value(
            &parse_type("Array(UInt8)").unwrap(),
            json!([1, 2]),
            ValueBudget {
                max_nodes: 1,
                ..budget()
            },
        )
        .unwrap_err();
        let bytes = normalize_value(
            &parse_type("String").unwrap(),
            json!("do-not-echo"),
            ValueBudget {
                max_serialized_bytes: 4,
                ..budget()
            },
        )
        .unwrap_err();

        for error in [depth, nodes, bytes] {
            assert_eq!(error.code, ErrorCode::ValidationFailed);
            assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
            assert!(!error
                .details
                .as_deref()
                .unwrap_or_default()
                .contains("do-not-echo"));
        }
    }

    #[test]
    fn enforces_complexity_budget_for_untyped_values() {
        assert!(normalize_value(
            &parse_type("JSON").unwrap(),
            json!({"outer": {"inner": 1}}),
            ValueBudget {
                max_depth: 1,
                ..budget()
            },
        )
        .is_err());
        assert!(normalize_value(
            &parse_type("FutureType").unwrap(),
            json!([1, 2]),
            ValueBudget {
                max_nodes: 2,
                ..budget()
            },
        )
        .is_err());
    }
}
