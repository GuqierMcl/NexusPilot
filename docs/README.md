# NexusPilot Documentation

This directory is the public documentation and knowledge boundary for NexusPilot.

The current migration establishes only `guides/`, the publishable source consumed by the documentation site. The broader information architecture for design philosophy, architecture, contracts, ADRs, implementation guidance, and curated project records will be reconstructed in a separate documentation-focused change. Private internal documentation must not be copied or mechanically summarized into this repository.

## Published guides

`guides/` contains the Markdown and MDX rendered at <https://docs.nexuspilot.dev>. The renderer in `../sites/docs/` loads these files directly through Astro's Content Loader.

Do not place a second copy of documentation content under `sites/docs/`, and do not add generated or synchronized Markdown copies to Git.
