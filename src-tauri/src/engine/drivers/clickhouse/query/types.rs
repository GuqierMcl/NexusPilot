use std::fmt;

use crate::engine::types::ColumnDataCategory;

#[allow(dead_code)]
#[allow(private_interfaces)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::engine::drivers::clickhouse) enum ClickHouseType {
    Int {
        signed: bool,
        bits: u16,
    },
    Float {
        bits: u16,
    },
    Decimal {
        storage_bits: u16,
        precision: u16,
        scale: u16,
    },
    Bool,
    String,
    FixedString {
        length: usize,
    },
    Date,
    Date32,
    DateTime {
        timezone: Option<String>,
    },
    DateTime64 {
        scale: u8,
        timezone: Option<String>,
    },
    Uuid,
    Ipv4,
    Ipv6,
    Enum {
        bits: u8,
        variants: Vec<(String, i16)>,
    },
    Nullable(Box<Self>),
    LowCardinality(Box<Self>),
    Array(Box<Self>),
    Map(Box<Self>, Box<Self>),
    Tuple(Vec<TupleField>),
    Nested(Vec<TupleField>),
    JsonOrObject {
        raw: String,
    },
    Variant(Vec<Self>),
    Unknown {
        raw: String,
    },
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TupleField {
    pub name: Option<String>,
    pub ty: ClickHouseType,
}

#[allow(dead_code)]
impl ClickHouseType {
    pub(super) fn is_nullable(&self) -> bool {
        match self {
            Self::Nullable(_) => true,
            Self::LowCardinality(inner) => inner.is_nullable(),
            _ => false,
        }
    }

    pub(super) fn unwrap_low_cardinality(&self) -> &Self {
        match self {
            Self::LowCardinality(inner) => inner,
            _ => self,
        }
    }

    pub(super) fn data_category(&self) -> ColumnDataCategory {
        match self {
            Self::Nullable(inner) | Self::LowCardinality(inner) => inner.data_category(),
            Self::Int { .. } | Self::Float { .. } | Self::Decimal { .. } => {
                ColumnDataCategory::Number
            }
            Self::Bool => ColumnDataCategory::Boolean,
            Self::Date | Self::Date32 => ColumnDataCategory::Date,
            Self::DateTime { .. } | Self::DateTime64 { .. } => ColumnDataCategory::Datetime,
            Self::Uuid => ColumnDataCategory::Uuid,
            Self::Enum { .. } => ColumnDataCategory::Enum,
            Self::JsonOrObject { .. } => ColumnDataCategory::Json,
            Self::Array(_)
            | Self::Map(_, _)
            | Self::Tuple(_)
            | Self::Nested(_)
            | Self::Variant(_) => ColumnDataCategory::Structured,
            Self::String | Self::FixedString { .. } | Self::Ipv4 | Self::Ipv6 => {
                ColumnDataCategory::String
            }
            Self::Unknown { .. } => ColumnDataCategory::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::engine::drivers::clickhouse) struct TypeParseError {
    message: String,
}

impl TypeParseError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for TypeParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TypeParseError {}

#[allow(dead_code)]
pub(in crate::engine::drivers::clickhouse) fn parse_type(
    input: &str,
) -> Result<ClickHouseType, TypeParseError> {
    let source = input.trim();
    if source.is_empty() {
        return Err(TypeParseError::new("type name is empty"));
    }
    if source.starts_with('\'') || source.starts_with('"') || source.starts_with('`') {
        return Err(TypeParseError::new("unexpected trailing type syntax"));
    }
    validate_balanced_syntax(source)?;

    let mut parser = Parser::new(source);
    let parsed = parser.parse_type()?;
    parser.skip_whitespace();
    if !parser.is_eof() {
        return Err(TypeParseError::new("unexpected trailing type syntax"));
    }
    Ok(parsed)
}

struct Parser<'a> {
    source: &'a str,
    position: usize,
}

impl<'a> Parser<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            position: 0,
        }
    }

    fn parse_type(&mut self) -> Result<ClickHouseType, TypeParseError> {
        self.skip_whitespace();
        let start = self.position;
        let name = self.parse_identifier()?;
        self.skip_whitespace();

        match name.as_str() {
            "Bool" => Ok(ClickHouseType::Bool),
            "String" => Ok(ClickHouseType::String),
            "Date" => Ok(ClickHouseType::Date),
            "Date32" => Ok(ClickHouseType::Date32),
            "UUID" => Ok(ClickHouseType::Uuid),
            "IPv4" => Ok(ClickHouseType::Ipv4),
            "IPv6" => Ok(ClickHouseType::Ipv6),
            "Float32" => Ok(ClickHouseType::Float { bits: 32 }),
            "Float64" => Ok(ClickHouseType::Float { bits: 64 }),
            "FixedString" => self.parse_fixed_string(),
            "Decimal" => self.parse_decimal(),
            "Decimal32" => self.parse_decimal_alias(32, 9),
            "Decimal64" => self.parse_decimal_alias(64, 18),
            "Decimal128" => self.parse_decimal_alias(128, 38),
            "Decimal256" => self.parse_decimal_alias(256, 76),
            "DateTime" => self.parse_datetime(),
            "DateTime64" => self.parse_datetime64(),
            "Enum8" => self.parse_enum(8),
            "Enum16" => self.parse_enum(16),
            "Nullable" => self.parse_single_wrapper(ClickHouseType::Nullable),
            "LowCardinality" => self.parse_single_wrapper(ClickHouseType::LowCardinality),
            "Array" => self.parse_single_wrapper(ClickHouseType::Array),
            "Map" => self.parse_map(),
            "Tuple" => self.parse_tuple(false),
            "Nested" => self.parse_tuple(true),
            "Variant" => self.parse_variant(),
            "JSON" | "Object" => self.parse_json_or_object(start),
            _ => {
                if let Some((signed, bits)) = parse_integer_name(&name) {
                    Ok(ClickHouseType::Int { signed, bits })
                } else {
                    self.capture_unknown(start)
                }
            }
        }
    }

    fn parse_fixed_string(&mut self) -> Result<ClickHouseType, TypeParseError> {
        self.expect_char('(')?;
        let length = self.parse_unsigned::<usize>("FixedString length")?;
        if length == 0 {
            return Err(TypeParseError::new("FixedString length must be positive"));
        }
        self.expect_char(')')?;
        Ok(ClickHouseType::FixedString { length })
    }

    fn parse_decimal(&mut self) -> Result<ClickHouseType, TypeParseError> {
        self.expect_char('(')?;
        let precision = self.parse_unsigned::<u16>("Decimal precision")?;
        self.expect_char(',')?;
        let scale = self.parse_unsigned::<u16>("Decimal scale")?;
        self.expect_char(')')?;
        if precision == 0 || precision > 76 || scale > precision {
            return Err(TypeParseError::new(
                "Decimal precision or scale is out of range",
            ));
        }
        let storage_bits = decimal_storage_bits(precision);
        Ok(ClickHouseType::Decimal {
            storage_bits,
            precision,
            scale,
        })
    }

    fn parse_decimal_alias(
        &mut self,
        storage_bits: u16,
        precision: u16,
    ) -> Result<ClickHouseType, TypeParseError> {
        self.expect_char('(')?;
        let scale = self.parse_unsigned::<u16>("Decimal scale")?;
        self.expect_char(')')?;
        if scale > precision {
            return Err(TypeParseError::new("Decimal scale is out of range"));
        }
        Ok(ClickHouseType::Decimal {
            storage_bits,
            precision,
            scale,
        })
    }

    fn parse_datetime(&mut self) -> Result<ClickHouseType, TypeParseError> {
        let timezone = if self.consume_char('(') {
            let timezone = self.parse_quoted_string()?;
            self.expect_char(')')?;
            Some(timezone)
        } else {
            None
        };
        Ok(ClickHouseType::DateTime { timezone })
    }

    fn parse_datetime64(&mut self) -> Result<ClickHouseType, TypeParseError> {
        self.expect_char('(')?;
        let scale = self.parse_unsigned::<u8>("DateTime64 scale")?;
        if scale > 9 {
            return Err(TypeParseError::new("DateTime64 scale is out of range"));
        }
        let timezone = if self.consume_char(',') {
            Some(self.parse_quoted_string()?)
        } else {
            None
        };
        self.expect_char(')')?;
        Ok(ClickHouseType::DateTime64 { scale, timezone })
    }

    fn parse_enum(&mut self, bits: u8) -> Result<ClickHouseType, TypeParseError> {
        self.expect_char('(')?;
        let mut variants = Vec::new();
        loop {
            let label = self.parse_quoted_string()?;
            self.expect_char('=')?;
            let value = self.parse_signed_i16("Enum value")?;
            if (bits == 8 && !(-128..=127).contains(&value)) || variants.len() >= u16::MAX as usize
            {
                return Err(TypeParseError::new("Enum value is out of range"));
            }
            variants.push((label, value));
            if self.consume_char(',') {
                continue;
            }
            self.expect_char(')')?;
            break;
        }
        if variants.is_empty() {
            return Err(TypeParseError::new("Enum must declare at least one value"));
        }
        Ok(ClickHouseType::Enum { bits, variants })
    }

    fn parse_single_wrapper(
        &mut self,
        wrap: fn(Box<ClickHouseType>) -> ClickHouseType,
    ) -> Result<ClickHouseType, TypeParseError> {
        self.expect_char('(')?;
        let inner = self.parse_type()?;
        self.expect_char(')')?;
        Ok(wrap(Box::new(inner)))
    }

    fn parse_map(&mut self) -> Result<ClickHouseType, TypeParseError> {
        self.expect_char('(')?;
        let key = self.parse_type()?;
        self.expect_char(',')?;
        let value = self.parse_type()?;
        self.expect_char(')')?;
        Ok(ClickHouseType::Map(Box::new(key), Box::new(value)))
    }

    fn parse_tuple(&mut self, nested: bool) -> Result<ClickHouseType, TypeParseError> {
        self.expect_char('(')?;
        let mut fields = Vec::new();
        let mut named_mode = None;
        if self.consume_char(')') {
            return Err(TypeParseError::new("Tuple and Nested require fields"));
        }

        loop {
            let field = self.parse_tuple_field(nested)?;
            let is_named = field.name.is_some();
            if named_mode.is_some_and(|mode| mode != is_named) {
                return Err(TypeParseError::new(
                    "Tuple cannot mix named and unnamed fields",
                ));
            }
            named_mode = Some(is_named);
            fields.push(field);
            if self.consume_char(',') {
                continue;
            }
            self.expect_char(')')?;
            break;
        }

        if nested && named_mode != Some(true) {
            return Err(TypeParseError::new("Nested fields must be named"));
        }
        if nested {
            Ok(ClickHouseType::Nested(fields))
        } else {
            Ok(ClickHouseType::Tuple(fields))
        }
    }

    fn parse_tuple_field(&mut self, nested: bool) -> Result<TupleField, TypeParseError> {
        self.skip_whitespace();
        if matches!(self.peek_char(), Some('\'' | '"' | '`')) {
            let name = self.parse_quoted_identifier()?;
            let ty = self.parse_type()?;
            return Ok(TupleField {
                name: Some(name),
                ty,
            });
        }

        let start = self.position;
        let candidate = self.parse_identifier()?;
        let after_candidate = self.position;
        self.skip_whitespace();
        let next = self.peek_char();
        let is_name = nested
            || (!is_known_type_name(&candidate) && !matches!(next, Some(',' | ')' | '(') | None));
        if is_name {
            let ty = self.parse_type()?;
            Ok(TupleField {
                name: Some(candidate),
                ty,
            })
        } else {
            self.position = start;
            let ty = self.parse_type()?;
            if self.position == after_candidate && nested {
                return Err(TypeParseError::new("Nested fields must be named"));
            }
            Ok(TupleField { name: None, ty })
        }
    }

    fn parse_variant(&mut self) -> Result<ClickHouseType, TypeParseError> {
        self.expect_char('(')?;
        let mut alternatives = Vec::new();
        loop {
            alternatives.push(self.parse_type()?);
            if self.consume_char(',') {
                continue;
            }
            self.expect_char(')')?;
            break;
        }
        if alternatives.is_empty() {
            return Err(TypeParseError::new("Variant requires alternatives"));
        }
        Ok(ClickHouseType::Variant(alternatives))
    }

    fn parse_json_or_object(&mut self, start: usize) -> Result<ClickHouseType, TypeParseError> {
        if self.peek_char() == Some('(') {
            self.consume_balanced_parentheses()?;
        }
        Ok(ClickHouseType::JsonOrObject {
            raw: self.source[start..self.position].trim().to_string(),
        })
    }

    fn capture_unknown(&mut self, start: usize) -> Result<ClickHouseType, TypeParseError> {
        let mut depth = 0_usize;
        let mut quote = None;
        let mut escaped = false;
        while let Some(character) = self.peek_char() {
            if let Some(active_quote) = quote {
                self.advance_char();
                if escaped {
                    escaped = false;
                } else if character == '\\' {
                    escaped = true;
                } else if character == active_quote {
                    quote = None;
                }
                continue;
            }
            match character {
                '\'' | '"' | '`' => {
                    quote = Some(character);
                    self.advance_char();
                }
                '(' => {
                    depth += 1;
                    self.advance_char();
                }
                ')' if depth > 0 => {
                    depth -= 1;
                    self.advance_char();
                }
                ')' | ',' if depth == 0 => break,
                _ => self.advance_char(),
            }
        }
        let raw = self.source[start..self.position].trim();
        if raw.is_empty() {
            return Err(TypeParseError::new("unknown type name is empty"));
        }
        Ok(ClickHouseType::Unknown {
            raw: raw.to_string(),
        })
    }

    fn consume_balanced_parentheses(&mut self) -> Result<(), TypeParseError> {
        self.expect_char('(')?;
        let mut depth = 1_usize;
        let mut quote = None;
        let mut escaped = false;
        while let Some(character) = self.peek_char() {
            self.advance_char();
            if let Some(active_quote) = quote {
                if escaped {
                    escaped = false;
                } else if character == '\\' {
                    escaped = true;
                } else if character == active_quote {
                    quote = None;
                }
                continue;
            }
            match character {
                '\'' | '"' | '`' => quote = Some(character),
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(());
                    }
                }
                _ => {}
            }
        }
        Err(TypeParseError::new("unclosed type arguments"))
    }

    fn parse_identifier(&mut self) -> Result<String, TypeParseError> {
        self.skip_whitespace();
        let start = self.position;
        while self
            .peek_char()
            .is_some_and(|character| character == '_' || character.is_ascii_alphanumeric())
        {
            self.advance_char();
        }
        if self.position == start {
            return Err(TypeParseError::new("expected type name"));
        }
        Ok(self.source[start..self.position].to_string())
    }

    fn parse_quoted_identifier(&mut self) -> Result<String, TypeParseError> {
        self.parse_quoted_value("tuple field name")
    }

    fn parse_quoted_string(&mut self) -> Result<String, TypeParseError> {
        self.parse_quoted_value("quoted string")
    }

    fn parse_quoted_value(&mut self, label: &str) -> Result<String, TypeParseError> {
        self.skip_whitespace();
        let quote = self
            .peek_char()
            .filter(|character| matches!(character, '\'' | '"' | '`'))
            .ok_or_else(|| TypeParseError::new(format!("expected {label}")))?;
        self.advance_char();
        let mut value = String::new();
        while let Some(character) = self.peek_char() {
            self.advance_char();
            if character == '\\' {
                let escaped = self
                    .peek_char()
                    .ok_or_else(|| TypeParseError::new(format!("unclosed {label}")))?;
                self.advance_char();
                value.push(escaped);
                continue;
            }
            if character == quote {
                if self.peek_char() == Some(quote) {
                    self.advance_char();
                    value.push(quote);
                    continue;
                }
                return Ok(value);
            }
            value.push(character);
        }
        Err(TypeParseError::new(format!("unclosed {label}")))
    }

    fn parse_unsigned<T>(&mut self, label: &str) -> Result<T, TypeParseError>
    where
        T: std::str::FromStr,
    {
        self.skip_whitespace();
        let start = self.position;
        while self
            .peek_char()
            .is_some_and(|character| character.is_ascii_digit())
        {
            self.advance_char();
        }
        if self.position == start {
            return Err(TypeParseError::new(format!("expected {label}")));
        }
        self.source[start..self.position]
            .parse()
            .map_err(|_| TypeParseError::new(format!("invalid {label}")))
    }

    fn parse_signed_i16(&mut self, label: &str) -> Result<i16, TypeParseError> {
        self.skip_whitespace();
        let start = self.position;
        if matches!(self.peek_char(), Some('+' | '-')) {
            self.advance_char();
        }
        let digit_start = self.position;
        while self
            .peek_char()
            .is_some_and(|character| character.is_ascii_digit())
        {
            self.advance_char();
        }
        if self.position == digit_start {
            return Err(TypeParseError::new(format!("expected {label}")));
        }
        self.source[start..self.position]
            .parse()
            .map_err(|_| TypeParseError::new(format!("invalid {label}")))
    }

    fn expect_char(&mut self, expected: char) -> Result<(), TypeParseError> {
        if self.consume_char(expected) {
            Ok(())
        } else {
            Err(TypeParseError::new(format!("expected '{expected}'")))
        }
    }

    fn consume_char(&mut self, expected: char) -> bool {
        self.skip_whitespace();
        if self.peek_char() != Some(expected) {
            return false;
        }
        self.advance_char();
        true
    }

    fn skip_whitespace(&mut self) {
        while self.peek_char().is_some_and(char::is_whitespace) {
            self.advance_char();
        }
    }

    fn peek_char(&self) -> Option<char> {
        self.source[self.position..].chars().next()
    }

    fn advance_char(&mut self) {
        if let Some(character) = self.peek_char() {
            self.position += character.len_utf8();
        }
    }

    fn is_eof(&self) -> bool {
        self.position == self.source.len()
    }
}

fn parse_integer_name(name: &str) -> Option<(bool, u16)> {
    let (signed, bits) = if let Some(bits) = name.strip_prefix("UInt") {
        (false, bits)
    } else if let Some(bits) = name.strip_prefix("Int") {
        (true, bits)
    } else {
        return None;
    };
    let bits = bits.parse::<u16>().ok()?;
    [8, 16, 32, 64, 128, 256]
        .contains(&bits)
        .then_some((signed, bits))
}

fn decimal_storage_bits(precision: u16) -> u16 {
    match precision {
        1..=9 => 32,
        10..=18 => 64,
        19..=38 => 128,
        _ => 256,
    }
}

fn is_known_type_name(name: &str) -> bool {
    matches!(
        name,
        "Bool"
            | "String"
            | "Date"
            | "Date32"
            | "UUID"
            | "IPv4"
            | "IPv6"
            | "Float32"
            | "Float64"
            | "FixedString"
            | "Decimal"
            | "Decimal32"
            | "Decimal64"
            | "Decimal128"
            | "Decimal256"
            | "DateTime"
            | "DateTime64"
            | "Enum8"
            | "Enum16"
            | "Nullable"
            | "LowCardinality"
            | "Array"
            | "Map"
            | "Tuple"
            | "Nested"
            | "Variant"
            | "JSON"
            | "Object"
    ) || parse_integer_name(name).is_some()
}

fn validate_balanced_syntax(source: &str) -> Result<(), TypeParseError> {
    let mut depth = 0_usize;
    let mut quote = None;
    let mut escaped = false;
    for character in source.chars() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == active_quote {
                quote = None;
            }
            continue;
        }
        match character {
            '\'' | '"' | '`' => quote = Some(character),
            '(' => depth += 1,
            ')' => {
                if depth == 0 {
                    return Err(TypeParseError::new("unexpected closing parenthesis"));
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    if quote.is_some() {
        return Err(TypeParseError::new("unclosed quoted type syntax"));
    }
    if depth != 0 {
        return Err(TypeParseError::new("unclosed type arguments"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::ColumnDataCategory;

    #[test]
    fn parses_clickhouse_scalar_wrappers_and_structured_types() {
        assert_eq!(
            parse_type("UInt256").unwrap(),
            ClickHouseType::Int {
                signed: false,
                bits: 256,
            }
        );
        assert_eq!(
            parse_type("Decimal(38, 10)").unwrap(),
            ClickHouseType::Decimal {
                storage_bits: 128,
                precision: 38,
                scale: 10,
            }
        );
        assert_eq!(
            parse_type("DateTime64(6, 'Asia/Hong_Kong')").unwrap(),
            ClickHouseType::DateTime64 {
                scale: 6,
                timezone: Some("Asia/Hong_Kong".into()),
            }
        );
        assert_eq!(
            parse_type("LowCardinality(Nullable(Array(Tuple(id UInt64, label String))))").unwrap(),
            ClickHouseType::LowCardinality(Box::new(ClickHouseType::Nullable(Box::new(
                ClickHouseType::Array(Box::new(ClickHouseType::Tuple(vec![
                    TupleField {
                        name: Some("id".into()),
                        ty: ClickHouseType::Int {
                            signed: false,
                            bits: 64,
                        },
                    },
                    TupleField {
                        name: Some("label".into()),
                        ty: ClickHouseType::String,
                    },
                ]))),
            ))))
        );
    }

    #[test]
    fn parses_all_numeric_widths_and_decimal_aliases() {
        for bits in [8_u16, 16, 32, 64, 128, 256] {
            assert_eq!(
                parse_type(&format!("Int{bits}")).unwrap(),
                ClickHouseType::Int { signed: true, bits }
            );
            assert_eq!(
                parse_type(&format!("UInt{bits}")).unwrap(),
                ClickHouseType::Int {
                    signed: false,
                    bits,
                }
            );
        }
        assert_eq!(
            parse_type("Float32").unwrap(),
            ClickHouseType::Float { bits: 32 }
        );
        assert_eq!(
            parse_type("Decimal64(4)").unwrap(),
            ClickHouseType::Decimal {
                storage_bits: 64,
                precision: 18,
                scale: 4,
            }
        );
        assert_eq!(
            parse_type("Decimal256(76)").unwrap(),
            ClickHouseType::Decimal {
                storage_bits: 256,
                precision: 76,
                scale: 76,
            }
        );
    }

    #[test]
    fn parses_scalar_and_structured_type_matrix() {
        assert_eq!(parse_type("Bool").unwrap(), ClickHouseType::Bool);
        assert_eq!(parse_type("String").unwrap(), ClickHouseType::String);
        assert_eq!(
            parse_type("FixedString(8)").unwrap(),
            ClickHouseType::FixedString { length: 8 }
        );
        assert_eq!(parse_type("Date").unwrap(), ClickHouseType::Date);
        assert_eq!(parse_type("Date32").unwrap(), ClickHouseType::Date32);
        assert_eq!(
            parse_type("DateTime('UTC')").unwrap(),
            ClickHouseType::DateTime {
                timezone: Some("UTC".into()),
            }
        );
        assert_eq!(parse_type("UUID").unwrap(), ClickHouseType::Uuid);
        assert_eq!(parse_type("IPv4").unwrap(), ClickHouseType::Ipv4);
        assert_eq!(parse_type("IPv6").unwrap(), ClickHouseType::Ipv6);
        assert_eq!(
            parse_type("Enum8('ready' = 1, 'failed' = -2)").unwrap(),
            ClickHouseType::Enum {
                bits: 8,
                variants: vec![("ready".into(), 1), ("failed".into(), -2)],
            }
        );
        assert_eq!(
            parse_type("Map(UInt64, Array(String))").unwrap(),
            ClickHouseType::Map(
                Box::new(ClickHouseType::Int {
                    signed: false,
                    bits: 64,
                }),
                Box::new(ClickHouseType::Array(Box::new(ClickHouseType::String))),
            )
        );
        assert_eq!(
            parse_type("Tuple(UInt64, String)").unwrap(),
            ClickHouseType::Tuple(vec![
                TupleField {
                    name: None,
                    ty: ClickHouseType::Int {
                        signed: false,
                        bits: 64,
                    },
                },
                TupleField {
                    name: None,
                    ty: ClickHouseType::String,
                },
            ])
        );
        assert!(matches!(
            parse_type("Nested(code UInt64, label String)").unwrap(),
            ClickHouseType::Nested(fields) if fields.len() == 2
        ));
        assert!(matches!(
            parse_type("JSON(max_dynamic_paths=10)").unwrap(),
            ClickHouseType::JsonOrObject { .. }
        ));
        assert!(matches!(
            parse_type("Object('json')").unwrap(),
            ClickHouseType::JsonOrObject { .. }
        ));
        assert_eq!(
            parse_type("Variant(UInt64, String)").unwrap(),
            ClickHouseType::Variant(vec![
                ClickHouseType::Int {
                    signed: false,
                    bits: 64,
                },
                ClickHouseType::String,
            ])
        );
    }

    #[test]
    fn preserves_unknown_types_but_rejects_broken_known_grammar() {
        assert_eq!(
            parse_type("FutureVector(Float32, 1536)").unwrap(),
            ClickHouseType::Unknown {
                raw: "FutureVector(Float32, 1536)".into(),
            }
        );
        assert!(parse_type("Array(UInt64").is_err());
        assert!(parse_type("Decimal(38)").is_err());
        assert!(parse_type("Decimal32(10)").is_err());
        assert!(parse_type("DateTime64(10)").is_err());
        assert!(parse_type("Map(String)").is_err());
    }

    #[test]
    fn handles_whitespace_quoted_tuple_fields_and_neutral_categories() {
        let parsed = parse_type(" Nullable ( Map ( UInt64 , Decimal(20, 4) ) ) ").unwrap();
        assert!(parsed.is_nullable());
        assert_eq!(parsed.data_category(), ColumnDataCategory::Structured);
        assert_eq!(
            parse_type("JSON").unwrap().data_category(),
            ColumnDataCategory::Json
        );
        assert_eq!(
            parse_type("'display name' String").unwrap_err().to_string(),
            "unexpected trailing type syntax"
        );
        assert!(matches!(
            parse_type("Tuple('display name' String)").unwrap(),
            ClickHouseType::Tuple(fields)
                if fields[0].name.as_deref() == Some("display name")
        ));
        assert_eq!(
            parse_type("LowCardinality(Nullable(String))")
                .unwrap()
                .unwrap_low_cardinality(),
            &ClickHouseType::Nullable(Box::new(ClickHouseType::String))
        );
    }
}
