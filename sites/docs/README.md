# NexusPilot Documentation Site

This package renders and deploys the standalone NexusPilot documentation site at <https://docs.nexuspilot.dev>.

## Content boundary

Publishable Markdown and MDX live in the repository-level `../../docs/guides/` directory. `src/content.config.ts` loads that directory directly with Astro's `glob()` Content Loader, so edits are available to both production builds and the development server without copying or synchronizing files.

This package owns only rendering and deployment concerns:

- Astro and Starlight configuration;
- navigation, theme, and renderer-specific components;
- SEO, sitemap, search, and static assets;
- Cloudflare build and deployment configuration.

Do not create a second documentation source tree under this package. MDX files that require renderer-specific components should use the `@docs-site` alias configured in `astro.config.mjs`; package-specific imports such as Starlight components belong behind adapters in `src/components/` so external content files do not depend on the site package's `node_modules` location.

## Commands

```powershell
bun install
bun run dev
bun run build
bun run preview
```
