# NexusPilot Sites

The public web applications are maintained as two independent packages:

- `product/` — the product website deployed to <https://nexuspilot.dev>;
- `docs/` — the documentation renderer deployed to <https://docs.nexuspilot.dev>.

Each package owns its Astro configuration, dependencies, static assets, build output, and Cloudflare configuration. The two applications link to one another by their public URLs and must not import each other's source files.

The documentation application reads its publishable Markdown and MDX directly from `../docs/guides/`. Do not add a second content tree under `sites/docs/`.
