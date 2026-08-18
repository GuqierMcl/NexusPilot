# Database Icon Components

Database brand icons in this directory are generated from the latest `@thesvg/cli`
and exposed through `index.ts`.

Use the adapter exports instead of importing from `generated/` directly. The
adapter keeps variant choices, naming, and future source changes isolated from
feature code.

## Generate Icons

```bash
bunx @thesvg/cli add mysql --format jsx --variant light --dir ./src/components/icons/database/generated/mysql-light
bunx @thesvg/cli add mysql --format jsx --variant dark --dir ./src/components/icons/database/generated/mysql-dark
bunx @thesvg/cli add postgresql redis sqlite oracle clickhouse microsoft-sql-server mongodb pinecone milvus weaviate qdrant chroma neo4j aws-amazon-neptune arangodb elasticsearch --format jsx --dir ./src/components/icons/database/generated/default
```

After generation, ensure generated TSX components spread `SVGProps` onto the root
`svg` element and use React-compatible attribute names.

The registry contains icons under different copyright and trademark terms. Keep
visual artwork unchanged, use brand icons only to identify database products, and
record non-permissive or attribution-based terms in `THIRD_PARTY_NOTICES.md`.
