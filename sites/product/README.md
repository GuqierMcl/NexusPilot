# NexusPilot Product Site

This package contains the product website deployed to <https://nexuspilot.dev>.

## Responsibilities

- product positioning, brand presentation, and feature overview;
- supported-database presentation;
- open-source repository discovery and community entry points;
- screenshots, downloads, and release history;
- product-site SEO, static assets, and Cloudflare configuration.

Public documentation is maintained by the independent package at `../docs/` and published at <https://docs.nexuspilot.dev>. This package links to that public URL and must not import documentation-site source files.

## Layout

```text
sites/product/
├─ public/
├─ src/
│  ├─ components/
│  ├─ layouts/
│  ├─ pages/
│  ├─ shared/
│  └─ styles/
├─ astro.config.mjs
├─ package.json
└─ wrangler.jsonc
```

## Commands

```powershell
bun install
bun run dev
bun run build
bun run preview
```
