# Product site and documentation architecture

Status: **Current**

NexusPilot separates authoritative knowledge, publishable guides, and site programs:

```text
docs/              public authoritative knowledge base
docs/guides/       rewritten content published on the documentation site
sites/docs/        documentation renderer and deployment program
sites/product/     product website program
```

`sites/docs/` reads `docs/guides/**/*.{md,mdx}` directly through Astro's Content Loader. This allowlist is a security and governance boundary: the renderer must not scan all of `docs/` and try to hide architecture, contracts, ADRs, or contributor material through exclusions.

The product website is deployed to `https://nexuspilot.dev`; the documentation application is deployed independently to `https://docs.nexuspilot.dev`. They link to each other with complete public URLs and may share versioned public data contracts, but must not import each other's internal source files.

Ordinary Markdown content must not be duplicated under `sites/docs/`. Astro route files there are reserved for application routes, redirects, errors, and renderer behavior.

Changes to user behavior, public configuration, or workflows should update `docs/guides/`. Architecture and contract changes should update their authoritative non-published documents even when they do not appear on the documentation website.
