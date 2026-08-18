use serde::de::DeserializeOwned;
use serde_json::Value;

use super::types::{parse_type, ClickHouseType};
use super::values::{normalize_value, ValueBudget};
use crate::engine::types::ColumnMeta;
use crate::error::{ErrorCode, IpcError, IpcResult, RuntimeErrorImpact};

#[allow(dead_code)]
pub(super) const RESULT_FORMAT: &str = "JSONCompactEachRowWithNamesAndTypes";

#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub(super) struct QueryLimits {
    pub max_response_bytes: usize,
    pub max_row_bytes: usize,
    pub value_budget: ValueBudget,
}

impl Default for QueryLimits {
    fn default() -> Self {
        Self {
            max_response_bytes: 32 * 1024 * 1024,
            max_row_bytes: 8 * 1024 * 1024,
            value_budget: ValueBudget::default(),
        }
    }
}

#[derive(Debug)]
enum DecoderState {
    Names,
    Types {
        names: Vec<String>,
    },
    Rows {
        columns: Vec<ColumnMeta>,
        parsed_types: Vec<ClickHouseType>,
    },
}

#[allow(dead_code)]
#[derive(Debug)]
pub(super) struct DecodedWindow {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    pub is_status_only: bool,
}

#[allow(dead_code)]
pub(super) struct FormatDecoder {
    limits: QueryLimits,
    state: DecoderState,
    pending_frame: Vec<u8>,
    rows: Vec<Vec<Value>>,
    response_bytes: usize,
    saw_frame: bool,
}

#[allow(dead_code)]
impl FormatDecoder {
    pub(super) fn new(limits: QueryLimits) -> Self {
        Self {
            limits,
            state: DecoderState::Names,
            pending_frame: Vec::new(),
            rows: Vec::new(),
            response_bytes: 0,
            saw_frame: false,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) -> IpcResult<()> {
        let mut decoded_rows = Vec::new();
        self.push_with_rows(bytes, |row| {
            decoded_rows.push(row);
            false
        })?;
        self.rows.extend(decoded_rows);
        Ok(())
    }

    pub(super) fn push_with_rows<F>(&mut self, bytes: &[u8], mut on_row: F) -> IpcResult<bool>
    where
        F: FnMut(Vec<Value>) -> bool,
    {
        self.response_bytes = self
            .response_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| response_limit_error(usize::MAX, self.limits.max_response_bytes))?;
        if self.response_bytes > self.limits.max_response_bytes {
            return Err(response_limit_error(
                self.response_bytes,
                self.limits.max_response_bytes,
            ));
        }

        self.pending_frame.extend_from_slice(bytes);
        let mut consumed = 0;
        let mut stopped = false;
        while let Some(relative_newline) = self.pending_frame[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let newline = consumed + relative_newline;
            let mut frame = self.pending_frame[consumed..newline].to_vec();
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            consumed = newline + 1;
            if frame.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            self.saw_frame = true;
            if let Some(row) = self.process_frame(&frame)? {
                if on_row(row) {
                    stopped = true;
                    break;
                }
            }
        }
        if consumed > 0 {
            self.pending_frame.drain(..consumed);
        }
        Ok(stopped)
    }

    pub(super) fn columns(&self) -> Option<&[ColumnMeta]> {
        match &self.state {
            DecoderState::Rows { columns, .. } => Some(columns),
            _ => None,
        }
    }

    pub(super) fn finish(self) -> IpcResult<DecodedWindow> {
        if self
            .pending_frame
            .iter()
            .any(|byte| !byte.is_ascii_whitespace())
        {
            return Err(decode_error(
                "incomplete_frame",
                "response ended before the current JSON frame was complete",
            ));
        }

        match self.state {
            DecoderState::Names if !self.saw_frame => Ok(DecodedWindow {
                columns: Vec::new(),
                rows: Vec::new(),
                is_status_only: true,
            }),
            DecoderState::Names => Err(decode_error(
                "missing_names",
                "response did not contain a names header",
            )),
            DecoderState::Types { .. } => Err(decode_error(
                "missing_types",
                "response ended before the types header",
            )),
            DecoderState::Rows { columns, .. } => Ok(DecodedWindow {
                columns,
                rows: self.rows,
                is_status_only: false,
            }),
        }
    }

    fn process_frame(&mut self, frame: &[u8]) -> IpcResult<Option<Vec<Value>>> {
        let state = std::mem::replace(&mut self.state, DecoderState::Names);
        match state {
            DecoderState::Names => {
                let names = parse_json_frame::<Vec<String>>(frame, "names")?;
                self.state = DecoderState::Types { names };
                Ok(None)
            }
            DecoderState::Types { names } => {
                let type_names = parse_json_frame::<Vec<String>>(frame, "types")?;
                if type_names.len() != names.len() {
                    return Err(decode_error(
                        "header_width",
                        format!("names={}; types={}", names.len(), type_names.len()),
                    ));
                }
                let mut columns = Vec::with_capacity(names.len());
                let mut parsed_types = Vec::with_capacity(names.len());
                for (name, type_name) in names.into_iter().zip(type_names) {
                    let parsed_type = parse_type(&type_name).map_err(|error| {
                        decode_error("type_syntax", format!("type={type_name}; error={error}"))
                    })?;
                    columns.push(column_meta(name, type_name, &parsed_type));
                    parsed_types.push(parsed_type);
                }
                self.state = DecoderState::Rows {
                    columns,
                    parsed_types,
                };
                Ok(None)
            }
            DecoderState::Rows {
                columns,
                parsed_types,
            } => {
                if frame.len() > self.limits.max_row_bytes {
                    return Err(row_limit_error(frame.len(), self.limits.max_row_bytes));
                }
                let values = parse_json_frame::<Vec<Value>>(frame, "row")?;
                if values.len() != columns.len() {
                    return Err(decode_error(
                        "row_width",
                        format!("columns={}; values={}", columns.len(), values.len()),
                    ));
                }
                let row = parsed_types
                    .iter()
                    .zip(values)
                    .map(|(ty, value)| normalize_value(ty, value, self.limits.value_budget))
                    .collect::<IpcResult<Vec<_>>>()?;
                self.state = DecoderState::Rows {
                    columns,
                    parsed_types,
                };
                Ok(Some(row))
            }
        }
    }
}

fn column_meta(name: String, type_name: String, ty: &ClickHouseType) -> ColumnMeta {
    let mut column = ColumnMeta::readonly_query_column(name, type_name, ty.is_nullable());
    column.data_category = ty.data_category();
    match unwrap_metadata_type(ty) {
        ClickHouseType::Decimal {
            precision, scale, ..
        } => {
            column.numeric_precision = Some(i32::from(*precision));
            column.numeric_scale = Some(i32::from(*scale));
        }
        ClickHouseType::FixedString { length } => {
            column.max_length = i64::try_from(*length).ok();
        }
        ClickHouseType::Enum { variants, .. } => {
            column.enum_values = Some(variants.iter().map(|(label, _)| label.clone()).collect());
        }
        _ => {}
    }
    column
}

fn unwrap_metadata_type(mut ty: &ClickHouseType) -> &ClickHouseType {
    while let ClickHouseType::Nullable(inner) | ClickHouseType::LowCardinality(inner) = ty {
        ty = inner;
    }
    ty
}

fn parse_json_frame<T: DeserializeOwned>(frame: &[u8], frame_kind: &str) -> IpcResult<T> {
    serde_json::from_slice(frame).map_err(|error| {
        decode_error(
            "invalid_json",
            format!(
                "frame={frame_kind}; line={}; column={}; category={:?}",
                error.line(),
                error.column(),
                error.classify()
            ),
        )
    })
}

fn decode_error(kind: &str, details: impl Into<String>) -> IpcError {
    IpcError {
        code: ErrorCode::SystemInternal,
        runtime_impact: RuntimeErrorImpact::BusinessOnly,
        message: "ClickHouse returned an invalid query result".to_string(),
        details: Some(format!("kind={kind}; {}", details.into())),
    }
}

fn response_limit_error(actual: usize, maximum: usize) -> IpcError {
    limit_error("response_bytes", actual, maximum)
}

fn row_limit_error(actual: usize, maximum: usize) -> IpcError {
    limit_error("row_bytes", actual, maximum)
}

fn limit_error(limit: &str, actual: usize, maximum: usize) -> IpcError {
    IpcError {
        code: ErrorCode::ValidationFailed,
        runtime_impact: RuntimeErrorImpact::BusinessOnly,
        message: "ClickHouse query result exceeds the safe display limit".to_string(),
        details: Some(format!("limit={limit}; actual={actual}; maximum={maximum}")),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::engine::drivers::clickhouse::query::values::ValueBudget;
    use crate::error::ErrorCode;
    use crate::error::IpcResult;

    fn limits() -> QueryLimits {
        QueryLimits::default()
    }

    fn decode_all(bytes: &[u8], limits: QueryLimits) -> IpcResult<DecodedWindow> {
        let mut decoder = FormatDecoder::new(limits);
        decoder.push(bytes)?;
        decoder.finish()
    }

    #[test]
    fn decodes_headers_and_rows_across_arbitrary_chunks() {
        let mut decoder = FormatDecoder::new(QueryLimits::default());
        decoder
            .push(
                br#"["id","tags"]
["UInt64","Array(String)"]
[1,["a"#,
            )
            .unwrap();
        decoder.push(b"\",\"b\"]]\n").unwrap();
        let result = decoder.finish().unwrap();
        assert_eq!(result.columns.len(), 2);
        assert_eq!(result.columns[0].name, "id");
        assert_eq!(result.columns[0].type_name, "UInt64");
        assert_eq!(
            result.columns[0].data_category,
            crate::engine::types::ColumnDataCategory::Number
        );
        assert!(!result.columns[0].nullable);
        assert!(!result.columns[0].is_writable);
        assert_eq!(
            result.columns[1].data_category,
            crate::engine::types::ColumnDataCategory::Structured
        );
        assert_eq!(result.rows, vec![vec![json!(1), json!(["a", "b"])]]);
        assert!(!result.is_status_only);
    }

    #[test]
    fn empty_select_keeps_columns_and_zero_byte_status_has_none() {
        let mut empty = FormatDecoder::new(QueryLimits::default());
        empty.push(b"[\"id\"]\n[\"UInt64\"]\n").unwrap();
        let empty = empty.finish().unwrap();
        assert_eq!(empty.columns.len(), 1);
        assert!(empty.rows.is_empty());
        assert!(!empty.is_status_only);

        let status = FormatDecoder::new(QueryLimits::default()).finish().unwrap();
        assert!(status.columns.is_empty());
        assert!(status.rows.is_empty());
        assert!(status.is_status_only);
    }

    #[test]
    fn handles_crlf_escaped_newline_duplicate_names_and_unknown_types() {
        let result = decode_all(
            b"[\"value\",\"value\"]\r\n[\"String\",\"FutureType\"]\r\n[\"line\\ntext\",{\"x\":1}]\r\n",
            limits(),
        )
        .unwrap();
        assert_eq!(
            result
                .columns
                .iter()
                .map(|column| column.name.as_str())
                .collect::<Vec<_>>(),
            vec!["value", "value"]
        );
        assert_eq!(result.rows[0][0], json!("line\ntext"));
        assert_eq!(result.rows[0][1], json!({"x": 1}));
    }

    #[test]
    fn derives_nullable_decimal_fixed_and_enum_metadata_from_the_type_ast() {
        let result = decode_all(
            b"[\"amount\",\"code\",\"state\"]\n[\"Nullable(Decimal(20, 4))\",\"FixedString(8)\",\"Enum8('ready' = 1)\"]\n[null,\"fixed\",\"ready\"]\n",
            limits(),
        )
        .unwrap();
        assert!(result.columns[0].nullable);
        assert_eq!(result.columns[0].numeric_precision, Some(20));
        assert_eq!(result.columns[0].numeric_scale, Some(4));
        assert_eq!(result.columns[1].max_length, Some(8));
        assert_eq!(
            result.columns[2].enum_values.as_deref(),
            Some(["ready".to_string()].as_slice())
        );
    }

    #[test]
    fn decodes_utf8_when_a_code_point_is_split_between_chunks() {
        let mut decoder = FormatDecoder::new(limits());
        decoder.push(b"[\"text\"]\n[\"String\"]\n").unwrap();
        let row = "[\"汉字\"]\n".as_bytes();
        let split = row
            .windows(3)
            .position(|window| window == "汉".as_bytes())
            .unwrap()
            + 1;
        decoder.push(&row[..split]).unwrap();
        decoder.push(&row[split..]).unwrap();
        assert_eq!(decoder.finish().unwrap().rows, vec![vec![json!("汉字")]]);
    }

    #[test]
    fn rejects_header_row_and_response_limit_violations() {
        assert!(decode_all(b"[\"a\"]\n[\"UInt8\",\"UInt8\"]\n", limits()).is_err());
        assert!(decode_all(b"[\"a\"]\n[\"UInt8\"]\n[1,2]\n", limits()).is_err());

        let response_error = decode_all(
            b"[\"a\"]\n[\"String\"]\n[\"oversize\"]\n",
            QueryLimits {
                max_response_bytes: 8,
                ..limits()
            },
        )
        .unwrap_err();
        assert_eq!(response_error.code, ErrorCode::ValidationFailed);

        let row_error = decode_all(
            b"[\"a\"]\n[\"String\"]\n[\"oversize\"]\n",
            QueryLimits {
                max_row_bytes: 4,
                ..limits()
            },
        )
        .unwrap_err();
        assert_eq!(row_error.code, ErrorCode::ValidationFailed);
    }

    #[test]
    fn rejects_malformed_json_incomplete_frames_and_oversized_cells() {
        assert!(decode_all(b"[\"a\"]\n[\"UInt8\"]\n[broken]\n", limits()).is_err());
        assert!(decode_all(b"[\"a\"]\n[\"UInt8\"]\n[1", limits()).is_err());

        let error = decode_all(
            b"[\"a\"]\n[\"String\"]\n[\"secret-value\"]\n",
            QueryLimits {
                value_budget: ValueBudget {
                    max_serialized_bytes: 4,
                    ..ValueBudget::default()
                },
                ..limits()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert!(!error
            .details
            .as_deref()
            .unwrap_or_default()
            .contains("secret-value"));
    }
}
