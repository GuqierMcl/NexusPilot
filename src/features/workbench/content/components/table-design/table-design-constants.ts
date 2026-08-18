import type { TableConstraintDraft } from "@/types/table-design";

export const CONSTRAINT_KIND_OPTIONS: TableConstraintDraft["kind"][] = [
    "primary_key",
    "unique",
    "foreign_key",
    "check",
];

export const MYSQL_COLUMN_TYPE_OPTIONS = [
    "varchar(255)",
    "text",
    "int",
    "bigint",
    "decimal(10,2)",
    "datetime",
    "timestamp",
    "date",
    "boolean",
    "json",
    "char(36)",
    "blob",
];

export const POSTGRES_COLUMN_TYPE_OPTIONS = [
    "varchar(255)",
    "text",
    "integer",
    "bigint",
    "numeric(10,2)",
    "timestamp",
    "timestamptz",
    "date",
    "boolean",
    "jsonb",
    "uuid",
    "bytea",
];

export const ORACLE_COLUMN_TYPE_OPTIONS = [
    "NUMBER(10,0)",
    "NUMBER(18,0)",
    "NUMBER(12,2)",
    "VARCHAR2(255)",
    "NVARCHAR2(255)",
    "CHAR(1)",
    "DATE",
    "TIMESTAMP(6)",
    "CLOB",
    "BLOB",
];

export const GENERIC_COLUMN_TYPE_OPTIONS = [
    "varchar(255)",
    "text",
    "integer",
    "bigint",
    "decimal(10,2)",
    "timestamp",
    "date",
    "boolean",
    "json",
];
