# NexusPilot Website

This directory contains the public NexusPilot website and documentation site.

## Layout

```text
website/
├─ astro.config.mjs
├─ public/
├─ src/
│  ├─ pages/
│  │  ├─ index.astro
│  │  └─ 404.astro
│  ├─ main-site/
│  │  ├─ components/
│  │  ├─ layouts/
│  │  └─ styles/
│  ├─ shared/
│  │  ├─ assets/
│  │  └─ config/
│  └─ content/
│     └─ docs/
│        ├─ README.txt
│        └─ docs/
```

## Main Site

The marketing homepage is implemented under `src/main-site/`.

- Route entry: `src/pages/index.astro`
- Components: `src/main-site/components/`
- Layout: `src/main-site/layouts/BaseLayout.astro`
- Styles: `src/main-site/styles/global.css`

## Documentation Site

The documentation site is powered by Starlight.

- Starlight configuration and sidebar: `astro.config.mjs`
- Public documentation content: `src/content/docs/docs/`
- Documentation URL prefix: `/docs/`

The double `docs/docs` path is intentional:

- `src/content/docs/` is the Starlight docs content collection.
- `src/content/docs/docs/` is the content folder that maps to the public `/docs/` route.

The local note is stored as `src/content/docs/README.txt` instead of Markdown so Astro does not treat it as a public documentation page.

## Shared Data

Shared product, release, navigation, and site metadata lives in `src/shared/config/`.
Shared importable assets live in `src/shared/assets/`.

Static files served directly by URL, such as `/logo.svg`, `/wordmark.svg`, and `/favicon.svg`, live in `public/`.

## Repository Boundary

`website/` is kept in the NexusPilot repository for now, but it is maintained as a split-ready public website package.

This package may depend on its own files, dependencies, and generated public product facts. It must not import or read implementation files from the desktop application, Tauri backend, or AI Runtime.

Allowed boundaries:

- Website code, content, config, and assets under `website/`.
- Static public assets under `website/public/`.
- Website-local product facts under `website/src/shared/config/`.
- Future generated public manifests copied into `website/` before build.

Disallowed boundaries:

- Direct imports from root `src/`, `src-tauri/`, or `ai-runtime/`.
- Direct imports or content ingestion from private design material outside `website/`.
- Reading root `package.json`, Tauri config, or release scripts at website build time.
- Depending on the root Bun workspace for website package resolution.

When the website is moved to a standalone repository, the expected migration unit is the full `website/` directory plus any deployment configuration added later. Product release facts should be synced through an explicit public manifest rather than by reading private implementation files.

## Commands

```powershell
bun install
bun run dev
bun run build
bun run preview
```
