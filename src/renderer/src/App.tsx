import { useHotkey } from "@tanstack/react-hotkeys";
import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";

import { conflictKeyOf, fileNameOf } from "@/lib/conflicts";
import { useStore } from "@/lib/store";
import { subscribeToUpdateStatus, useUpdatesStore } from "@/lib/updates";
import { stripExcalidraw } from "@/lib/utils";

import { AppSidebar } from "./components/app-sidebar";
import { CommandPalette } from "./components/command-palette";
import { DrawingSearch } from "./components/drawing-search";
import { DrawingSwitcher } from "./components/drawing-switcher";
import { EditorView } from "./components/editor-view";
import { ErrorBoundary } from "./components/error-boundary";
import { SettingsDialog } from "./components/settings-dialog";
import { ThemeProvider } from "./components/theme-provider";
import { Button } from "./components/ui/button";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";
import { toast } from "./components/ui/toast";
import { useSwitcher } from "./hooks/use-switcher";

const App = () => {
  const error = useStore((s) => s.error);
  const reportError = useStore((s) => s.reportError);
  const externalConflict = useStore((s) => s.externalConflict);
  const loadSnapshot = useStore((s) => s.loadSnapshot);
  const initSettings = useStore((s) => s.initSettings);
  const applyEntries = useStore((s) => s.applyEntries);
  const resolveChangedConflict = useStore((s) => s.resolveChangedConflict);
  const resolveMissingConflict = useStore((s) => s.resolveMissingConflict);
  const overwriteOpenFileFromSession = useStore((s) => s.overwriteOpenFileFromSession);
  const themePreference = useStore((s) => s.settings.theme);
  const drawings = useStore((s) => s.drawings);
  const entries = useStore((s) => s.entries);
  const isLoadingDrawings = useStore((s) => s.isLoadingDrawings);
  const watcherDown = useStore((s) => s.watcherDown);
  const reportWatcherError = useStore((s) => s.reportWatcherError);
  const openFileId = useStore((s) => s.openFileId);
  const dirtyById = useStore((s) => s.dirtyById);
  const editorGeneration = useStore((s) => s.editorGeneration);
  const settingsDialogOpen = useStore((s) => s.settingsDialogOpen);
  const setSettingsDialogOpen = useStore((s) => s.setSettingsDialogOpen);
  const editorMounted = useStore((s) => s.editorMounted);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const editorPaletteOpen = useStore((s) => s.editorPaletteOpen);
  const searchOpen = useStore((s) => s.searchOpen);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const applyUpdateStatus = useUpdatesStore((s) => s.applyStatus);
  const setOpenFileId = useStore((s) => s.setOpenFileId);

  const conflictPromptRef = useRef<string | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);
  const switcher = useSwitcher({ paletteOpen, editorPaletteOpen });

  const folderMissing = drawings?.missing === true && entries.length === 0 && !isLoadingDrawings;

  const pickFolder = useCallback(async () => {
    setPickingFolder(true);
    try {
      await useStore.getState().pickAndSwitchFolder();
    } finally {
      setPickingFolder(false);
    }
  }, []);

  useHotkey("Mod+/", () => setPaletteOpen(!paletteOpen), {
    enabled: !editorMounted,
  });
  useHotkey("Mod+P", () => setSearchOpen(!searchOpen), {
    enabled: !paletteOpen && !editorPaletteOpen,
  });
  useHotkey("Mod+,", () => setSettingsDialogOpen(true), {
    enabled: !paletteOpen && !editorPaletteOpen,
    requireReset: true,
  });
  useHotkey("Mod+W", () => void setOpenFileId(null), {
    enabled: !settingsDialogOpen && !paletteOpen && !editorPaletteOpen && !searchOpen,
    requireReset: true,
  });

  useEffect(() => {
    if (!openFileId) {
      document.title = "xcalidraw";
      return;
    }

    const name = stripExcalidraw(fileNameOf(entries, openFileId));
    const marker = dirtyById[openFileId] ? "* " : "";
    document.title = `${marker}${name} - xcalidraw`;
  }, [openFileId, entries, dirtyById]);

  useEffect(() => {
    return window.api.files.onWatcherError((event) => reportWatcherError(event));
  }, [reportWatcherError]);

  useEffect(() => {
    if (!error) return;
    toast.add({
      id: error.id,
      title: error.title,
      description: error.detail,
      type: "error",
    });
  }, [error]);

  useEffect(() => {
    if (!watcherDown) return;
    toast.add({
      id: "watcher-down",
      title: "Changes on disk may not appear",
      description: watcherDown,
      type: "warning",
    });
  }, [watcherDown]);

  useEffect(() => {
    if (!folderMissing) return;
    toast.add({
      id: "folder-missing",
      title: "Drawings folder is unavailable",
      description: "The folder holding your drawings can’t be found. Choose the folder again.",
      type: "error",
    });
  }, [folderMissing]);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      await initSettings();
      if (cancelled) return;

      try {
        const snapshot = await window.api.drawings.load();
        if (cancelled) return;

        if (!cancelled) {
          loadSnapshot(snapshot);
        }
      } catch (err) {
        if (!cancelled) {
          reportError(err, "load");
        }
      }
    };

    void boot();

    return () => {
      cancelled = true;
    };
  }, [initSettings, loadSnapshot, reportError]);

  useEffect(() => {
    return window.api.files.onChanged((event) => applyEntries(event));
  }, [applyEntries]);

  useEffect(() => subscribeToUpdateStatus(applyUpdateStatus), [applyUpdateStatus]);

  useEffect(() => {
    if (!externalConflict) {
      conflictPromptRef.current = null;
      return;
    }

    const key = conflictKeyOf(externalConflict);

    if (conflictPromptRef.current === key) return;
    conflictPromptRef.current = key;

    void (async () => {
      if (externalConflict.type === "changed") {
        const choice = await resolveChangedConflict();
        if (choice === "cancel") return;
        if (choice === "overwrite") await overwriteOpenFileFromSession();
        return;
      }

      if (externalConflict.type === "missing") await resolveMissingConflict();
    })();
  }, [
    externalConflict,
    resolveChangedConflict,
    resolveMissingConflict,
    overwriteOpenFileFromSession,
  ]);

  return (
    <ThemeProvider preference={themePreference}>
      <SidebarProvider
        defaultOpen
        className="h-svh! min-h-svh overflow-hidden"
        // oxlint-disable typescript/no-unsafe-type-assertion
        style={
          {
            "--sidebar-width": "16rem",
          } as CSSProperties
        }
      >
        <AppSidebar onOpenSettings={() => setSettingsDialogOpen(true)} />
        <SidebarInset className="isolation-isolate min-h-0 min-w-0 overflow-hidden">
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <ErrorBoundary resetKeys={[openFileId, editorGeneration]}>
              <EditorView />
            </ErrorBoundary>
            {folderMissing && (
              <div className="bg-background/80 absolute inset-0 flex items-center justify-center p-4">
                <div className="bg-card flex flex-col items-center gap-3 rounded-lg border p-4 shadow-sm">
                  <p className="text-sm font-medium">Drawings folder is unavailable</p>
                  <p className="text-muted-foreground max-w-xs text-center text-sm">
                    Choose the folder again to keep working.
                  </p>
                  <Button size="sm" disabled={pickingFolder} onClick={() => void pickFolder()}>
                    {pickingFolder ? "Choosing..." : "Choose folder"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </SidebarInset>
        <SettingsDialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen} />
        {!editorMounted && <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />}
        <DrawingSearch open={searchOpen} onOpenChange={setSearchOpen} />
        {switcher.state.phase === "cycling" && (
          <DrawingSwitcher
            index={switcher.state.index}
            commitAt={switcher.commitAt}
            onCancel={switcher.cancel}
          />
        )}
      </SidebarProvider>
    </ThemeProvider>
  );
};

export default App;
