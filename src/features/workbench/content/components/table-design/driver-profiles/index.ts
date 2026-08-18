import type { ColumnTypeDefinition, ColumnTypeDraft } from "../columns/column-type-model";
import { mysqlTableDesignProfile } from "./mysql-table-design-profile";
import { oracleTableDesignProfile } from "./oracle-table-design-profile";
import { postgresTableDesignProfile } from "./postgres-table-design-profile";

export interface ColumnOptionVisibility {
    charset: boolean;
    collation: boolean;
    generatedStorage: boolean;
    identityOptions: boolean;
    unsigned: boolean;
    charSemantics: boolean;
}

export interface ConstraintOptionVisibility {
    enforced: boolean;
    comments: boolean;
}

export interface TableOptionDefinition {
    id: "engine" | "charset" | "collation" | "comment";
    label: string;
}

export interface TableDesignDriverDefaults {
    columnType: ColumnTypeDraft;
    indexMethod: string;
    identityGeneration: "always" | "by_default";
}

export interface TableDesignDriverProfile {
    driver: "mysql" | "postgres" | "oracle" | "generic";
    displayName: string;
    typeCatalog: ColumnTypeDefinition[];
    indexMethods: string[];
    tableOptions: TableOptionDefinition[];
    columnOptions: ColumnOptionVisibility;
    constraintOptions: ConstraintOptionVisibility;
    defaults: TableDesignDriverDefaults;
}

export const genericTableDesignProfile: TableDesignDriverProfile = {
    driver: "generic",
    displayName: "Generic SQL",
    typeCatalog: [
        {
            family: "string",
            baseType: "varchar",
            label: "VARCHAR",
            supportsLength: true,
            defaultLength: "255",
        },
        { family: "string", baseType: "text", label: "TEXT" },
        { family: "number", baseType: "integer", label: "INTEGER" },
        { family: "number", baseType: "bigint", label: "BIGINT" },
        {
            family: "number",
            baseType: "decimal",
            label: "DECIMAL",
            supportsPrecisionScale: true,
            defaultPrecision: "10",
            defaultScale: "2",
        },
        { family: "datetime", baseType: "timestamp", label: "TIMESTAMP" },
        { family: "datetime", baseType: "date", label: "DATE" },
        { family: "boolean", baseType: "boolean", label: "BOOLEAN" },
        { family: "json", baseType: "json", label: "JSON" },
    ],
    indexMethods: ["btree"],
    tableOptions: [{ id: "comment", label: "Comment" }],
    columnOptions: {
        charset: false,
        collation: false,
        generatedStorage: true,
        identityOptions: true,
        unsigned: false,
        charSemantics: false,
    },
    constraintOptions: {
        enforced: true,
        comments: true,
    },
    defaults: {
        columnType: {
            mode: "structured",
            family: "string",
            baseType: "varchar",
            length: "255",
            precision: "",
            scale: "",
            timePrecision: "",
            unsigned: false,
            charSemantics: "",
            enumValues: [],
            rawTypeName: "",
        },
        indexMethod: "btree",
        identityGeneration: "by_default",
    },
};

export function tableDesignProfileForDriver(driver?: string | null): TableDesignDriverProfile {
    if (driver === "mysql") return mysqlTableDesignProfile;
    if (driver === "postgres") return postgresTableDesignProfile;
    if (driver === "oracle") return oracleTableDesignProfile;
    return genericTableDesignProfile;
}
