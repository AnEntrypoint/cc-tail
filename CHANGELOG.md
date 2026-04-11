# Changelog

## 1.0.0 — 2026-04-11

- Initial release: `cc-tail` npm package
- `JsonlWatcher` class extending EventEmitter — watches `~/.claude/projects/` JSONL files
- `watch(projectsDir?)` factory — chainable, returns started watcher
- Events: `conversation_created`, `streaming_start`, `streaming_progress`, `streaming_complete`, `streaming_error`, `error`
- Dual ESM + CJS exports (`src/index.js` + `src/index.cjs`)
- Zero external dependencies, Node >= 18
- GitHub Actions: npm publish on `v*` tags, gh-pages deploy on every main push
- Landing page at https://anentrypoint.github.io/cc-tail/ (WebJSX + RippleUI, dark/light theme)
