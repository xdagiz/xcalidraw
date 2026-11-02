# Patches

## `@excalidraw__excalidraw@0.18.1.patch`

This patch carries local fixes for `@excalidraw/excalidraw` 0.18.1.

### Text editing focus on window blur

Added so text editing survives Alt+Tab and switching windows. Excalidraw's `textWysiwyg` submitted and destroyed the editor on any textarea `blur`, including when the whole window lost focus. Both blur paths are now guarded with `document.activeElement !== editable`:

- `dist/dev/index.js`: `handleBlur` replaces `handleSubmit` for the textarea's `onblur`, the `temporarilyDisableSubmit` window `blur` fallback, and the matching cleanup.
- `dist/prod/index.js`: the minified equivalent, `__xcalidrawHandleBlur`.

Upstream issue: https://github.com/excalidraw/excalidraw/issues/9304
Upstream fixes: https://github.com/excalidraw/excalidraw/pull/11645 and https://github.com/excalidraw/excalidraw/pull/12426

When a release we depend on includes the fix, remove this part of the patch and this section. The rest of the patch (`replaceScene`, `CommandPalette` exports, the history-change event, and the image-cache guard) is unrelated and should stay.

Editing the patch changes its hash in `pnpm-lock.yaml` under `patchedDependencies`. The hash is the SHA-256 of the patch file (`sha256sum patches/@excalidraw__excalidraw@0.18.1.patch`). Run `vp install` afterwards so pnpm reapplies the patch to `node_modules`.
