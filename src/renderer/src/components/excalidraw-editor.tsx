import {
  CaptureUpdateAction,
  Excalidraw,
  WelcomeScreen,
  restoreAppState,
  restoreElements,
  useHandleLibrary,
} from "@excalidraw/excalidraw";

import "@excalidraw/excalidraw/index.css";
import type { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { MAX_DRAWING_CONTENT_BYTES, validateDrawingRecord } from "@shared/ipc";
import { useHotkey } from "@tanstack/react-hotkeys";
import {
  ArrowLeftIcon,
  FilePlus2Icon,
  FolderOpen,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { EditorCommandPalette } from "@/components/editor-command-palette";
import { ErrorBoundary } from "@/components/error-boundary";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useSidebar } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/toast";
import { useRecentDrawings } from "@/hooks/use-recent-drawings";
import { useTheme } from "@/hooks/use-theme";
import { libraryErrorToastId, saveErrorToastId, toAppError, type AppError } from "@/lib/app-error";
import { createDrawingSession, drawingSignature } from "@/lib/drawing-session";
import { createLibraryPersistenceAdapter, defaultLibraryStorage } from "@/lib/library-persistence";
import { setMcpCanvas } from "@/lib/mcp-bridge";
import { createSceneSwitchController } from "@/lib/scene-switching";
import { createScratchController } from "@/lib/scratch-session";
import { sessionOwner } from "@/lib/session-owner";
import { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";
import { applyViewport, viewportCache, viewportOf } from "@/lib/viewport-cache";
import { viewportPersistence } from "@/lib/viewport-persistence";
import { createViewportRecorder } from "@/lib/viewport-recorder";

type DrawingData = {
  elements?: ExcalidrawElement[];
  appState?: Partial<AppState> | null;
  files?: ExcalidrawInitialDataState["files"];
};

type LoadedDrawing = {
  drawing: {
    elements: OrderedExcalidrawElement[];
    appState: RestoredDataState["appState"];
    files?: ExcalidrawInitialDataState["files"];
  };
  baseline: string | null;
};

const recordViewport = createViewportRecorder(viewportCache, viewportPersistence);

const loadDrawing = async (
  fileId: string,
  rootPath: string | null,
  sessionContent?: string | null,
): Promise<LoadedDrawing> => {
  const content = sessionContent ?? (await window.api.files.read(fileId));
  const parsed: DrawingData = JSON.parse(content);
  const rawElements = Array.isArray(parsed.elements) ? parsed.elements : [];
  const files = parsed.files ?? undefined;

  const restored = restoreAppState(parsed.appState ?? null, null);
  const cachedViewport = viewportCache.get(rootPath, fileId);
  const persistedViewport = await viewportPersistence.get(rootPath, fileId);
  const appState = applyViewport(restored, cachedViewport ?? persistedViewport);
  const viewport = viewportOf(appState);
  viewportCache.set(rootPath, fileId, viewport);
  if (rootPath !== null && persistedViewport === undefined) {
    void viewportPersistence.set(rootPath, fileId, viewport).catch((error: unknown) => {
      console.error("Failed to save initial viewport preference:", error);
    });
  }
  const elements = restoreElements(rawElements, null, {
    repairBindings: true,
  });

  return {
    drawing: { elements, appState, files },
    baseline: sessionContent == null ? drawingSignature(elements, appState, files) : null,
  };
};

type Props = {
  fileId: string | null;
};

const invert = (c: number) => Math.round(c * 0.07 + (255 - c) * 0.93);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const toHex = (c: number) => {
  const clamped = Number.isFinite(c) ? Math.max(0, Math.min(255, Math.round(c))) : 0;
  return clamped.toString(16).padStart(2, "0");
};

// Excalidraw renders the canvas background via `invert(0.93) hue-rotate(180deg)` in
// dark mode but stores the original color, so we replicate it to match the cushion.
const applyExcalidrawDarkModeFilter = (color: string) => {
  if (typeof color !== "string") return color;
  if (color.toLowerCase() === "transparent") return color;
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) return color;

  const hex = color.slice(1);
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);

  const ir = invert(r);
  const ig = invert(g);
  const ib = invert(b);

  const rn = ir / 255;
  const gn = ig / 255;
  const bn = ib / 255;

  const m = [-0.574, 1.43, 0.144, 0.426, 0.43, 0.144, 0.426, 1.43, -0.856];
  const nr = Math.round(clamp01(rn * m[0] + gn * m[1] + bn * m[2]) * 255);
  const ng = Math.round(clamp01(rn * m[3] + gn * m[4] + bn * m[5]) * 255);
  const nb = Math.round(clamp01(rn * m[6] + gn * m[7] + bn * m[8]) * 255);

  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
};

const SIDEBAR_TOGGLE_ICONS = {
  open: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-panel-left-close-icon lucide-panel-left-close"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/></svg>',
  closed:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-panel-left-open-icon lucide-panel-left-open"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg>',
} as const;

export const ExcalidrawEditor = ({ fileId }: Props) => {
  const theme = useTheme();
  const { toggleSidebar, open } = useSidebar();
  const createAndOpenEntry = useStore((s) => s.createAndOpenEntry);
  const pickAndSwitchFolder = useStore((s) => s.pickAndSwitchFolder);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const drawings = useStore((s) => s.drawings);
  const entries = useStore((s) => s.entries);
  const homeReturnFileId = useStore((s) => s.homeReturnFileId);
  const pendingCanvasAction = useStore((s) => s.pendingCanvasAction);
  const isLoadingDrawings = useStore((s) => s.isLoadingDrawings);
  const editorGeneration = useStore((s) => s.editorGeneration);
  const autosave = useStore((s) => s.settings.autosave);
  const showRecents = useStore((s) => s.settings.showRecents);
  const settingsDialogOpen = useStore((s) => s.settingsDialogOpen);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const editorPaletteOpen = useStore((s) => s.editorPaletteOpen);
  const searchOpen = useStore((s) => s.searchOpen);

  const { recentFiles } = useRecentDrawings();
  const hasConfiguredDrawingsFolder = drawings?.configured && !drawings.missing;
  const showEmptyRecentsWelcome =
    showRecents && hasConfiguredDrawingsFolder && recentFiles.length === 0;
  const homeReturnEntry = useMemo(
    () =>
      homeReturnFileId === null
        ? undefined
        : entries.find((entry) => entry.id === homeReturnFileId && entry.kind === "file"),
    [homeReturnFileId, entries],
  );
  const drawingsPath = useStore((s) => s.drawings?.path ?? null);
  const fileName = useStore((s) =>
    fileId ? (s.entries.find((e) => e.id === fileId)?.name ?? fileId) : "",
  );

  const editorRef = useRef<HTMLDivElement | null>(null);
  const sceneLoadingRef = useRef(false);
  const sceneLoadCancelRef = useRef<(() => void) | null>(null);
  const loadedFileIdRef = useRef<string | null | undefined>(undefined);
  const loadedGenerationRef = useRef(editorGeneration);
  const seededSceneApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [sceneSwitcher] = useState(createSceneSwitchController);
  const [scratch] = useState(() =>
    createScratchController({
      createEntry: () => useStore.getState().createEntry(null, "file"),
      readFile: (id) => window.api.files.read(id),
      deleteFile: (id) => {
        const rootPath = useStore.getState().drawings?.path ?? null;
        viewportCache.deleteSubtree(rootPath, id);
        void viewportPersistence.deleteSubtree(rootPath, id).catch((error: unknown) => {
          console.error("Failed to remove viewport preference:", error);
        });
        void window.api.files.delete(id, "permanent").catch(() => undefined);
      },
      deleteViewport: (id) => {
        const rootPath = useStore.getState().drawings?.path ?? null;
        viewportCache.deleteSubtree(rootPath, id);
      },
      acquireSession: (scratchFileId, diskBaseline) =>
        sessionOwner.acquire(
          scratchFileId,
          createDrawingSession({
            fileId: scratchFileId,
            hasExternalConflict: () => useStore.getState().externalConflict !== null,
            save: (sid, content, origin) => useStore.getState().saveFile(sid, content, origin),
            onDirtyChange: (sid, dirty) => useStore.getState().setFileDirty(sid, dirty),
            onRawDirtyChange: (sid, dirty) => useStore.getState().setRawDirty(sid, dirty),
            initialAutosave: useStore.getState().settings.autosave,
            initialBaseline: diskBaseline,
            onSaveGaveUp: (failedId) => {
              toast.add({
                id: saveErrorToastId(failedId),
                title: "Autosave stopped",
                description: "Couldn't save after several attempts. Press Ctrl+S to retry.",
                type: "error",
                timeout: 0,
              });
            },
          }),
        ),
      releaseIfOwned: (session) => {
        if (sessionOwner.getSession() !== session) return;
        const activeId = sessionOwner.getActiveFileId();
        sessionOwner.releaseActive();
        if (activeId) useStore.getState().clearFileMarkers(activeId);
      },
      isOpenFileId: () => useStore.getState().openFileId,
      openReservedFile: (id) => useStore.getState().openReservedFile(id),
      clearFileMarkers: (id) => useStore.getState().clearFileMarkers(id),
      setPendingCanvasAction: (pending) => useStore.getState().setPendingCanvasAction(pending),
      setScratchUnsaved: (unsaved) => useStore.getState().setScratchUnsaved(unsaved),
      notifyError: (error) => {
        const appError = toAppError(error, "create");
        toast.add({
          id: "scratch-create",
          title: appError.title,
          description: appError.detail,
          type: "error",
        });
      },
      computeDiskBaseline: (raw) => {
        const parsed: DrawingData = JSON.parse(raw);
        const rawElements: ExcalidrawElement[] = Array.isArray(parsed.elements)
          ? parsed.elements
          : [];
        const restored = restoreElements(rawElements, null, { repairBindings: true });
        return drawingSignature(
          restored,
          restoreAppState(parsed.appState ?? null, null),
          parsed.files ?? undefined,
        );
      },
      seedSession: (session, scene) => {
        if (!scene) return;
        session.onChange([], scene.appState, scene.files);
        session.onChange(scene.elements, scene.appState, scene.files);
      },
    }),
  );

  const [loadError, setLoadError] = useState<{ fileId: string; error: AppError } | null>(null);
  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawImperativeAPI | null>(null);

  const libraryAdapter = useMemo(
    () =>
      createLibraryPersistenceAdapter(defaultLibraryStorage(), {
        onSaveError: () => {
          toast.add({
            id: libraryErrorToastId,
            title: "Couldn’t save library",
            description: "New library items couldn’t be persisted and may be lost on restart.",
            type: "error",
          });
        },
        onSaveSuccess: () => {
          toast.close(libraryErrorToastId);
        },
      }),
    [],
  );

  useHandleLibrary({ excalidrawAPI: excalidrawApi, adapter: libraryAdapter });

  const handleExcalidrawApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      if (fileId !== null && scratch.isCanvasSeeded(fileId) && seededSceneApiRef.current !== api) {
        sceneLoadingRef.current = true;
      }
      setExcalidrawApi(api);
    },
    [fileId, scratch],
  );

  useEffect(() => {
    return () => setExcalidrawApi(null);
  }, []);

  useEffect(() => {
    if (!excalidrawApi) return undefined;
    setMcpCanvas({
      api: excalidrawApi,
      fileId,
      isReady: () => !sceneLoadingRef.current && !excalidrawApi.getAppState().isLoading,
    });
    return () => setMcpCanvas(null);
  }, [excalidrawApi, fileId]);

  const editorReady = excalidrawApi !== null && (loadError === null || loadError.fileId !== fileId);

  useEffect(() => {
    useStore.getState().setEditorMounted(editorReady);
    if (!editorReady) useStore.getState().setEditorPaletteOpen(false);
  }, [editorReady]);

  useEffect(
    () => () => {
      useStore.getState().setEditorMounted(false);
      useStore.getState().setEditorPaletteOpen(false);
    },
    [],
  );

  useLayoutEffect(() => {
    if (excalidrawApi) return undefined;
    document.documentElement.style.setProperty(
      "--excalidraw-canvas-bg",
      theme === "dark" ? "#121212" : "#ffffff",
    );
    return () => {
      document.documentElement.style.removeProperty("--excalidraw-canvas-bg");
    };
  }, [excalidrawApi, theme]);

  useLayoutEffect(() => {
    if (!excalidrawApi) return undefined;

    const applyCanvasBackground = () => {
      const canvasBackground = excalidrawApi.getAppState().viewBackgroundColor;
      const effective =
        theme === "dark" ? applyExcalidrawDarkModeFilter(canvasBackground) : canvasBackground;
      document.documentElement.style.setProperty("--excalidraw-canvas-bg", effective);
    };

    applyCanvasBackground();
    const unsubscribe = excalidrawApi.onChange(applyCanvasBackground);

    return () => {
      unsubscribe();
      document.documentElement.style.removeProperty("--excalidraw-canvas-bg");
    };
  }, [excalidrawApi, theme]);

  useEffect(() => {
    return window.api.library.onReturned((event) => {
      if (!event.hash || window.location.hash === event.hash) return;
      window.location.hash = event.hash;
    });
  }, []);

  useEffect(() => {
    scratch.getSession()?.setAutosaveMode(autosave);
  }, [autosave, scratch]);

  useEffect(() => {
    const flushOnEdge = () => {
      void scratch.getSession()?.flush();
    };
    const flushOnHidden = () => {
      if (document.visibilityState === "hidden") flushOnEdge();
    };

    window.addEventListener("blur", flushOnEdge);
    document.addEventListener("visibilitychange", flushOnHidden);
    window.addEventListener("beforeunload", flushOnEdge);

    return () => {
      window.removeEventListener("blur", flushOnEdge);
      document.removeEventListener("visibilitychange", flushOnHidden);
      window.removeEventListener("beforeunload", flushOnEdge);
    };
  }, [scratch]);

  useEffect(() => {
    return () => scratch.invalidate();
  }, [scratch]);

  useEffect(() => {
    const bound = scratch.getState();
    if (bound.phase === "bound" && bound.fileId === fileId) return;
    if (bound.phase === "reserved" && fileId !== null && bound.fileId === fileId) {
      scratch.bindFile(fileId);
      return;
    }

    scratch.invalidate();
    if (fileId !== null) scratch.bindFile(fileId);
  }, [fileId, scratch]);

  const loadScene = useCallback(
    (force = false) => {
      sceneLoadCancelRef.current?.();
      sceneLoadCancelRef.current = null;

      if (!excalidrawApi) return undefined;

      sceneLoadingRef.current = true;
      setLoadError((current) => (current?.fileId === fileId ? null : current));

      if (fileId === null) {
        sceneSwitcher.invalidate();
        void excalidrawApi
          .replaceScene({
            elements: [],
            appState: { isLoading: false },
            files: {},
          })
          .catch((error: unknown) => console.error("Failed to clear drawing:", error));
        sceneLoadingRef.current = false;
        return undefined;
      }

      const canvasSeeded = scratch.isCanvasSeeded(fileId);
      if (!force && canvasSeeded && seededSceneApiRef.current === excalidrawApi) {
        // Keep the seeded scene only while this exact editor instance owns it.
        sceneLoadingRef.current = false;
        return undefined;
      }

      let cancelled = false;
      let cancelRequest: (() => void) | null = null;
      const cancel = () => {
        cancelled = true;
        cancelRequest?.();
      };
      sceneLoadCancelRef.current = cancel;

      void (async () => {
        await excalidrawApi
          .replaceScene({
            elements: [],
            appState: { isLoading: true },
            files: {},
          })
          .catch((error: unknown) => console.error("Failed to prepare drawing:", error));
        if (cancelled) return;

        cancelRequest = sceneSwitcher.start(
          () => {
            const content = canvasSeeded ? scratch.getSession()?.getSerializedContent() : null;
            return loadDrawing(fileId, drawingsPath, content);
          },
          async ({ drawing, baseline }, isCurrent) => {
            if (!isCurrent() || useStore.getState().openFileId !== fileId) return;

            const session = scratch.getSession();
            if (baseline !== null) session?.setInitialBaseline(baseline);
            await excalidrawApi.replaceScene({
              elements: drawing.elements,
              appState: { ...drawing.appState, isLoading: true },
              files: drawing.files ?? {},
            });
            if (!isCurrent() || useStore.getState().openFileId !== fileId) return;
            if (canvasSeeded) seededSceneApiRef.current = excalidrawApi;
            sceneLoadingRef.current = false;
            excalidrawApi.updateScene({
              appState: { isLoading: false },
              captureUpdate: CaptureUpdateAction.NEVER,
            });

            setLoadError(null);
          },
          (error) => {
            if (useStore.getState().openFileId !== fileId) return;

            console.error("Failed to load drawing:", error);
            scratch.getSession()?.invalidate();
            excalidrawApi.updateScene({
              appState: { isLoading: false },
              captureUpdate: CaptureUpdateAction.NEVER,
            });

            setLoadError({ fileId, error: toAppError(error, "read") });
          },
        );
        if (cancelled) cancelRequest();
      })();

      return cancel;
    },
    [fileId, drawingsPath, excalidrawApi, scratch, sceneSwitcher],
  );

  useLayoutEffect(() => {
    const bound = scratch.getState();
    if (
      fileId !== null &&
      bound.phase === "bound" &&
      bound.fileId !== fileId &&
      bound.session === sessionOwner.getSession(fileId) &&
      scratch.retargetFile(bound.fileId, fileId)
    ) {
      loadedGenerationRef.current = editorGeneration;
      loadedFileIdRef.current = fileId;
      return;
    }

    const generationChanged = loadedGenerationRef.current !== editorGeneration;
    loadedGenerationRef.current = editorGeneration;
    const fileChanged = loadedFileIdRef.current !== fileId;
    loadedFileIdRef.current = fileId;
    loadScene(generationChanged && !fileChanged);
    return () => {
      sceneLoadCancelRef.current?.();
      sceneLoadCancelRef.current = null;
    };
  }, [editorGeneration, fileId, loadScene]);

  useEffect(() => {
    if (!isLoadingDrawings) return;
    scratch.invalidate();
  }, [isLoadingDrawings, scratch]);

  useEffect(() => {
    const root = editorRef.current;

    const handleDrop = (event: DragEvent) => {
      const sceneFiles = [...(event.dataTransfer?.files ?? [])].filter((file) =>
        file.name.toLowerCase().endsWith(".excalidraw"),
      );
      if (sceneFiles.length === 0) return;

      event.preventDefault();
      event.stopPropagation();

      void (async () => {
        const opened: string[] = [];
        for (const file of sceneFiles) {
          try {
            const content = await file.text();
            if (new TextEncoder().encode(content).length > MAX_DRAWING_CONTENT_BYTES) {
              throw new Error("Drawing exceeds the size limit");
            }
            const parsed: unknown = JSON.parse(content);
            validateDrawingRecord(parsed);
            const imported = await useStore
              .getState()
              .createFileWithContent(null, stripExcalidraw(file.name), content);
            if (imported) opened.push(imported);
          } catch (error) {
            toast.add({
              title: `Couldn’t import ${file.name}`,
              description: toAppError(error, "create").detail,
              type: "error",
            });
          }
        }
        if (opened.length > 0) await useStore.getState().setOpenFileId(opened[0]);
      })();
    };

    root?.addEventListener("drop", handleDrop, true);
    return () => root?.removeEventListener("drop", handleDrop, true);
  }, []);

  const toggleSidebarRef = useRef(toggleSidebar);
  const openRef = useRef(open);
  const sidebarButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    toggleSidebarRef.current = toggleSidebar;
  }, [toggleSidebar]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useHotkey(
    "Mod+S",
    () => {
      void (async () => {
        const session = scratch.getSession();
        if (session) {
          const saved = await session.saveNow();
          if (saved === "saved") toast.add({ title: "Saved", type: "success" });
          return;
        }

        const scene = scratch.getScene();
        if (scene?.elements.some((element) => !element.isDeleted)) {
          scratch.start();
        }
      })();
    },
    { enabled: !settingsDialogOpen && !paletteOpen && !editorPaletteOpen && !searchOpen },
  );

  const handleCreate = useCallback(() => {
    if (useStore.getState().pendingCanvasAction) return;
    void (async () => {
      try {
        await createAndOpenEntry(null, "file");
      } catch (error) {
        const appError = toAppError(error, "create");
        toast.add({ title: appError.title, description: appError.detail, type: "error" });
      }
    })();
  }, [createAndOpenEntry]);

  const handleBack = useCallback(() => {
    void useStore.getState().openHome();
  }, []);

  const handleBrowseDrawings = useCallback(() => {
    setSearchOpen(true);
  }, [setSearchOpen]);

  const handleChooseFolder = useCallback(() => {
    if (useStore.getState().pendingCanvasAction) return;
    void pickAndSwitchFolder();
  }, [pickAndSwitchFolder]);

  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      useStore.getState().setEditorPaletteOpen(appState.openDialog?.name === "commandPalette");

      if (sceneLoadingRef.current) return;

      if (fileId !== null) {
        if (!appState.isLoading) {
          const rootPath = drawingsPath;
          const viewport = viewportOf(appState);
          void recordViewport(rootPath, fileId, viewport).catch((error: unknown) => {
            console.error("Failed to save viewport preference:", error);
          });
        }
        scratch.getSession()?.onChange(elements, appState, files);
        return;
      }

      if (appState.isLoading) return;
      if (excalidrawApi && elements.some((element) => !element.isDeleted)) {
        seededSceneApiRef.current = excalidrawApi;
      }

      const reserved = scratch.getState();
      if (reserved.phase === "reserved") {
        void recordViewport(drawingsPath, reserved.fileId, viewportOf(appState)).catch(
          (error: unknown) => {
            console.error("Failed to save viewport preference:", error);
          },
        );
      }
      scratch.capture(elements, appState, files);
    },
    [fileId, scratch, excalidrawApi, drawingsPath],
  );

  // TODO: update this with renderTopLeftUI when a new release includes it
  useEffect(() => {
    const root = editorRef.current;

    let anchor: HTMLElement | null = null;
    let observer: MutationObserver | null = null;

    const sync = () => {
      if (anchor && anchor.isConnected) return;

      const canvasActions = root?.querySelector<HTMLElement>(".App-menu_top__left > :first-child");
      if (!canvasActions) return;

      let host = canvasActions.querySelector<HTMLElement>(
        ":scope > [data-xcalidraw-sidebar-anchor]",
      );
      if (!host) {
        host = document.createElement("div");
        host.dataset.xcalidrawSidebarAnchor = "";
        host.style.position = "absolute";
        host.style.top = "0";
        host.style.left = "0";
        host.style.pointerEvents = "auto";

        const button = document.createElement("button");
        button.type = "button";
        button.className = "sidebar-toggle";
        button.setAttribute("aria-label", "Toggle sidebar");
        button.title = "Toggle sidebar";
        button.addEventListener("click", () => toggleSidebarRef.current());
        button.innerHTML = SIDEBAR_TOGGLE_ICONS[openRef.current ? "open" : "closed"];

        sidebarButtonRef.current = button;
        host.appendChild(button);
        canvasActions.prepend(host);
        canvasActions.style.paddingLeft = "calc(var(--lg-button-size, 2.25rem) + 0.5rem)";
        anchor = host;
      }
    };

    if (root) {
      sync();
      observer = new MutationObserver(sync);
      observer.observe(root, { childList: true, subtree: true });
    }

    return () => {
      observer?.disconnect();
      anchor?.parentElement?.style.removeProperty("padding-left");
      anchor?.remove();
      sidebarButtonRef.current = null;
    };
  }, [editorRef]);

  useEffect(() => {
    const button = sidebarButtonRef.current;
    if (button) button.innerHTML = SIDEBAR_TOGGLE_ICONS[open ? "open" : "closed"];
  }, [open]);

  return (
    <div ref={editorRef} className="relative h-full min-h-0 w-full overflow-hidden">
      <ErrorBoundary
        title="The drawing editor stopped working"
        description="Try again. Your saved drawings are still available from the sidebar."
        resetKeys={[fileId]}
        onError={() => {
          setExcalidrawApi(null);
          useStore.getState().setEditorMounted(false);
          useStore.getState().setEditorPaletteOpen(false);
        }}
        onReset={() => {
          sceneLoadingRef.current = true;
        }}
      >
        <Excalidraw
          theme={theme}
          excalidrawAPI={handleExcalidrawApi}
          initialData={null}
          onChange={handleChange}
          aiEnabled={false}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: false,
            },
          }}
        >
          {fileId === null ? (
            <WelcomeShared
              heading={
                showEmptyRecentsWelcome
                  ? "Nothing recent yet"
                  : "Start drawing, it stays on this device"
              }
            >
              {homeReturnEntry && (
                <WelcomeScreen.Center.MenuItem
                  onSelect={() => void setOpenFileId(homeReturnEntry.id)}
                  icon={<ArrowLeftIcon size={16} />}
                >
                  Back to {stripExcalidraw(homeReturnEntry.name)}
                </WelcomeScreen.Center.MenuItem>
              )}
              <WelcomeScreen.Center.MenuItem
                onSelect={handleCreate}
                icon={<FilePlus2Icon size={16} />}
                disabled={pendingCanvasAction}
              >
                New drawing
              </WelcomeScreen.Center.MenuItem>
              {hasConfiguredDrawingsFolder ? (
                <WelcomeScreen.Center.MenuItem
                  onSelect={handleBrowseDrawings}
                  icon={<SearchIcon size={16} />}
                  disabled={pendingCanvasAction}
                >
                  Browse drawings
                </WelcomeScreen.Center.MenuItem>
              ) : (
                <WelcomeScreen.Center.MenuItem
                  onSelect={handleChooseFolder}
                  icon={<FolderOpen size={16} />}
                  disabled={pendingCanvasAction}
                >
                  Choose folder
                </WelcomeScreen.Center.MenuItem>
              )}
            </WelcomeShared>
          ) : (
            <WelcomeShared heading="Start drawing.">
              <WelcomeScreen.Center.MenuItemHelp />
              {showRecents && (
                <WelcomeScreen.Center.MenuItem
                  onSelect={handleBack}
                  icon={<ArrowLeftIcon size={16} />}
                >
                  Back to recents
                </WelcomeScreen.Center.MenuItem>
              )}
            </WelcomeShared>
          )}
          {editorReady && <EditorCommandPalette />}
        </Excalidraw>
      </ErrorBoundary>
      {loadError && fileId !== null && loadError.fileId === fileId && (
        <div className="bg-background/95 absolute inset-0 z-50 flex items-center justify-center">
          <Empty className="bg-background h-full border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TriangleAlertIcon className="text-destructive" />
              </EmptyMedia>
              <EmptyTitle>{loadError.error.title}</EmptyTitle>
              <EmptyDescription>
                {loadError.error.message}
                <span className="mt-1 block font-mono text-xs break-all">{fileName}</span>
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row justify-center">
              <Button
                onClick={() => {
                  setLoadError(null);
                  loadScene(true);
                }}
              >
                <RefreshCwIcon />
                Retry
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      )}
    </div>
  );
};

const WelcomeShared = ({ heading, children }: { heading: string; children: ReactNode }) => {
  return (
    <WelcomeScreen>
      <WelcomeScreen.Hints.ToolbarHint />
      <WelcomeScreen.Hints.HelpHint />
      <WelcomeScreen.Hints.MenuHint />
      <WelcomeScreen.Center>
        <WelcomeScreen.Center.Logo>
          <span className="text-foreground">xcalidraw</span>
        </WelcomeScreen.Center.Logo>
        <WelcomeScreen.Center.Heading>{heading}</WelcomeScreen.Center.Heading>
        <WelcomeScreen.Center.Menu>{children}</WelcomeScreen.Center.Menu>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
};
