# Third-Party Notices

NexusPilot is licensed under the Apache License, Version 2.0. Third-party
software and assets included in or used to build NexusPilot remain subject to
their own licenses and notices.

This document records the license review performed against `bun.lock`,
`website/bun.lock`, and `src-tauri/Cargo.lock` at NexusPilot `0.10.1`. The lock
files are the authoritative source for exact dependency versions. SPDX license
identifiers below link to their canonical license text.

## Software, fonts, and data requiring specific attention

The dependency graph is predominantly MIT, Apache-2.0, ISC, and BSD licensed.
The following components have file-level copyleft, attribution, font, data, or
metadata considerations that are easy to miss during redistribution.

| Component | License | Distribution note |
| --- | --- | --- |
| `lightningcss` and its platform packages | [MPL-2.0](https://spdx.org/licenses/MPL-2.0.html) | Build-time tooling. Modified MPL-covered files, if any, must remain available under MPL-2.0. |
| `colored`, `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, and `selectors` Rust crates | [MPL-2.0](https://spdx.org/licenses/MPL-2.0.html) | Linked as unmodified dependencies. MPL-2.0 applies at file level and permits distribution as part of a larger work. |
| Geist / `@fontsource-variable/geist` | [OFL-1.1](https://spdx.org/licenses/OFL-1.1.html) | The font is embedded in the desktop frontend and loaded by the website. Retain the OFL notice with redistributed font files. |
| JetBrains Mono | [OFL-1.1](https://spdx.org/licenses/OFL-1.1.html) | Loaded by the website through Google Fonts. |
| `caniuse-lite` | [CC-BY-4.0](https://spdx.org/licenses/CC-BY-4.0.html) | Browser-compatibility data used by the website toolchain; attribution: Browserslist contributors, <https://github.com/browserslist/caniuse-lite>. |
| ICU4X data crates and `unicode-ident` Unicode data | [Unicode-3.0](https://spdx.org/licenses/Unicode-3.0.html) | Unicode data and software license applies to the corresponding data/code. |
| `webpki-root-certs` and `webpki-roots` | [CDLA-Permissive-2.0](https://spdx.org/licenses/CDLA-Permissive-2.0.html) | Mozilla root-certificate data packaged by rustls. |
| `@img/sharp-*` / libvips | Apache-2.0 and [LGPL-3.0-or-later](https://spdx.org/licenses/LGPL-3.0-or-later.html) | Native website build dependency. It is not part of the generated static website. If a libvips binary is redistributed separately, its LGPL terms and source offer must accompany it. |
| `satteri` and `@bruits/satteri-*` | [MIT](https://spdx.org/licenses/MIT.html) | Some platform packages omit a `license` field; they are release artifacts of the MIT-licensed parent project. Copyright 2026 Bruits. |
| `pagefind` and its platform packages | [MIT](https://spdx.org/licenses/MIT.html) | Website search build tooling. Package metadata and the upstream project identify MIT even where a platform package omits a standalone license file. |

Where a dependency offers multiple licenses, NexusPilot relies on the
permissive option: Apache-2.0 for DOMPurify; BSD-3-Clause for `json-schema`; and
MIT or Apache-2.0 for `r-efi`. `BSL-1.0` entries in the Rust graph mean the
permissive Boost Software License 1.0, not the Business Source License.

No production dependency reviewed in these lock files was exclusively licensed
under GPL, AGPL, SSPL, the Elastic License, Commons Clause, or another known
source-available/commercial-restriction license. This is a compatibility
review, not legal advice and not a substitute for retaining license text in a
binary distribution.

## Database brand icons

Database icons under `src/components/icons/database/generated/` and
`website/public/icons/databases/` were generated from the
[`@thesvg/icons`](https://github.com/glincker/thesvg) registry. The generated
files are used only to identify compatible database products.

The following source and license metadata was verified against
`@thesvg/icons` 3.3.1:

| Product | Registry license | Registry source |
| --- | --- | --- |
| MySQL | CC0-1.0 | <https://www.mysql.com> |
| PostgreSQL | CC0-1.0 | <https://www.postgresql.org/> |
| Redis | CC0-1.0 | <https://redis.io/> |
| SQLite | CC0-1.0 | <https://www.sqlite.org/> |
| ClickHouse | CC0-1.0 | <https://github.com/ClickHouse/ClickHouse/blob/12bd453a43819176d25ecf247033f6cb1af54beb/website/images/logo-clickhouse.svg> |
| Microsoft SQL Server | MIT | <https://www.microsoft.com/en-us/sql-server/> |
| MongoDB | CC0-1.0 | <https://www.mongodb.com> |
| Pinecone | CC0-1.0 | <https://www.pinecone.io> |
| Milvus | CC0-1.0 | <https://github.com/milvus-io/artwork/blob/e30bffa2b0632b0d4cefcdd4e1a2c09fee5b0d28/icon/black/milvus-icon-black.svg> |
| Weaviate | Apache-2.0 | <https://weaviate.io> |
| Qdrant | MIT | <https://qdrant.tech/> |
| Chroma | Apache-2.0 | <https://www.trychroma.com> |
| Neo4j | CC0-1.0 | <https://neo4j.com/brand/#logo> |
| Oracle Database | Fair use / nominative trademark use | <https://www.oracle.com> |
| Amazon Neptune | CC-BY-ND-2.0 | <https://aws.amazon.com/neptune/> |
| ArangoDB | CC0-1.0 | <https://www.arangodb.com/resources/logos> |
| Elasticsearch | CC0-1.0 | <https://www.elastic.co/brand> |

The Oracle Database logo is used solely to identify NexusPilot's implemented
Oracle Database interoperability. This is a nominative reference to Oracle's
product, not a claim that Oracle licensed the logo under Apache-2.0 or sponsors
NexusPilot.

The Amazon Neptune artwork is attributed to Amazon Web Services under the
registry's CC-BY-ND-2.0 designation. The generated TSX copy contains only the
technical XML-to-React attribute and component-wrapper changes required to
render the same unaltered visual artwork; the website copy retains the SVG
artwork. Amazon Neptune remains clearly identified as a planned integration.

Copyright licenses for icon artwork do not grant trademark rights. All product
names and logos remain trademarks or registered trademarks of their respective
owners. Their use does not imply affiliation, sponsorship, or endorsement.

## NexusPilot brand assets

The NexusPilot application icon, logo, wordmark, NIEEX wordmark, favicons, and
derived Tauri icon sizes are project brand assets, not third-party assets. They
are covered by the trademark statement in `NOTICE`; Apache-2.0 does not grant
general permission to use project trademarks.

## Binary distribution requirement

Before publishing desktop installers or other binary bundles, the release
process must generate and package an exhaustive license bundle from the exact
locked dependencies used for that build. That bundle must include applicable
copyright notices and complete license texts, including MPL-2.0 and OFL-1.1,
and must travel with the binary. This source-level summary does not replace
that release artifact.
