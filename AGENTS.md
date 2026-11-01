# AGENTS.md

This project uses **Vite+** - the `vp` CLI is the only command surface. Use `vp` for everything (install, deps, scripts, checks, tests); **never run `npm`/`npx`/`pnpm` directly**. Note `vp <name>` runs built-ins while `vp run <name>` runs `package.json` scripts.

Full usage docs are local at `node_modules/vite-plus/docs/` (start with `guide/run.md`, `guide/install.md`, `guide/check.md`), or online at https://viteplus.dev/guide/.

Do not annotate function return types that TypeScript can infer from the body. Annotate only when inference cannot produce the type (type predicates like `value is T`) or when the annotation is the intended contract.

Always run `vp fmt` after making a change.
