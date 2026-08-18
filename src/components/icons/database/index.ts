import type { ComponentType, SVGProps } from "react";

import ArangoDbIcon from "@/components/icons/database/generated/default/arangodb";
import AwsAmazonNeptuneIcon from "@/components/icons/database/generated/default/aws-amazon-neptune";
import ChromaIcon from "@/components/icons/database/generated/default/chroma";
import ClickHouseIcon from "@/components/icons/database/generated/default/clickhouse";
import ElasticsearchIcon from "@/components/icons/database/generated/default/elasticsearch";
import MicrosoftSqlServerIcon from "@/components/icons/database/generated/default/microsoft-sql-server";
import MilvusIcon from "@/components/icons/database/generated/default/milvus";
import MongodbIcon from "@/components/icons/database/generated/default/mongodb";
import Neo4jIcon from "@/components/icons/database/generated/default/neo4j";
import OracleIcon from "@/components/icons/database/generated/default/oracle";
import PineconeIcon from "@/components/icons/database/generated/default/pinecone";
import PostgresqlIcon from "@/components/icons/database/generated/default/postgresql";
import QdrantIcon from "@/components/icons/database/generated/default/qdrant";
import RedisIcon from "@/components/icons/database/generated/default/redis";
import SqliteIcon from "@/components/icons/database/generated/default/sqlite";
import WeaviateIcon from "@/components/icons/database/generated/default/weaviate";
import { MysqlIcon } from "@/components/icons/database/mysql-icon";

export type DatabaseIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const DATABASE_ICONS = {
    arangodb: ArangoDbIcon,
    "aws-amazon-neptune": AwsAmazonNeptuneIcon,
    chroma: ChromaIcon,
    clickhouse: ClickHouseIcon,
    elasticsearch: ElasticsearchIcon,
    "microsoft-sql-server": MicrosoftSqlServerIcon,
    milvus: MilvusIcon,
    mongodb: MongodbIcon,
    mysql: MysqlIcon,
    neo4j: Neo4jIcon,
    oracle: OracleIcon,
    pinecone: PineconeIcon,
    postgresql: PostgresqlIcon,
    qdrant: QdrantIcon,
    redis: RedisIcon,
    sqlite: SqliteIcon,
    weaviate: WeaviateIcon,
} satisfies Record<string, DatabaseIconComponent>;

export type DatabaseIconKey = keyof typeof DATABASE_ICONS;

export function getDatabaseIcon(
    iconKey: DatabaseIconKey | null | undefined,
): DatabaseIconComponent | null {
    return iconKey ? DATABASE_ICONS[iconKey] ?? null : null;
}

export {
    ArangoDbIcon,
    AwsAmazonNeptuneIcon,
    ChromaIcon,
    ClickHouseIcon,
    ElasticsearchIcon,
    MicrosoftSqlServerIcon,
    MilvusIcon,
    MongodbIcon,
    MysqlIcon,
    Neo4jIcon,
    OracleIcon,
    PineconeIcon,
    PostgresqlIcon as PostgresIcon,
    QdrantIcon,
    RedisIcon,
    SqliteIcon,
    WeaviateIcon,
};
