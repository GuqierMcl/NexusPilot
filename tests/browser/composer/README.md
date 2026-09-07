# Composer browser regression

This isolated Vite fixture mounts the production Thread, composer, AI SDK message adapter, and transport with an in-memory connection directory and mock streaming HTTP responses. It never calls a database or external model. It exercises both normal and virtualized threads.

Start Vite with `bun run dev -- --port 1431`, then run `node tests/browser/composer/check.cjs` in an environment with Playwright and Edge installed. `PLAYWRIGHT_MODULE_PATH` can point to an existing absolute Playwright package directory; `BROWSER_CHANNEL` selects a different installed Chromium channel, and `COMPOSER_TEST_URL` overrides the fixture URL. `COMPOSER_SCREENSHOT_DIR` optionally writes light/dark screenshots to an existing directory.

Coverage includes candidate keyboard/mouse selection, immediate send, atomic undo/redo, repeated references, commands, composition events, history editing and cancellation, deleted connections, attachment failure recovery, edits during pending attachment completion, plain-text clipboard, and textarea/mirror metrics at several zoom levels. Assertions use actual rendered input values and outgoing requests.

Command assertions cover short `/explain` highlights in drafts, sent messages and history edits, without exposing its prompt. A controlled operation adapter checks `/compact` selection versus submission, mixed-content rejection, independent operation dispatch, the busy send gate, and cancellation retaining a newly typed draft. Runtime HTTP, persistence, summary and cancellation behavior are separately tested in `ai-runtime/tests/manual-compaction.test.ts`.

Composition events exercise the browser event path; they do not replace a physical Windows IME check. The accessibility-hidden overlay and ARIA state are asserted, but spoken output must still be checked with a screen reader. This fixture does not validate native Tauri file dialogs or WebView-specific rendering.
