import { Suspense, lazy } from "react";

import { Home } from "@/components/home";
import { useRecentDrawings } from "@/hooks/use-recent-drawings";
import { useStore } from "@/lib/store";

const ExcalidrawEditor = lazy(() =>
  import("./excalidraw-editor").then((module) => ({ default: module.ExcalidrawEditor })),
);

export const EditorView = () => {
  const openFileId = useStore((s) => s.openFileId);
  const pendingCanvasAction = useStore((s) => s.pendingCanvasAction);
  const isLoadingDrawings = useStore((s) => s.isLoadingDrawings);
  const showRecents = useStore((s) => s.settings.showRecents);
  const drawings = useStore((s) => s.drawings);
  const { recentFiles } = useRecentDrawings();

  if (isLoadingDrawings) {
    return <CanvasLoading />;
  }

  if (
    openFileId === null &&
    showRecents &&
    drawings?.configured &&
    !drawings.missing &&
    recentFiles.length > 0 &&
    !pendingCanvasAction
  ) {
    return <Home />;
  }

  return (
    <Suspense fallback={<CanvasLoading />}>
      <ExcalidrawEditor key="canvas" fileId={openFileId} />
    </Suspense>
  );
};

const CanvasLoading = () => {
  return (
    <div
      className="flex h-full min-h-0 w-full items-center justify-center bg-[var(--excalidraw-canvas-bg,var(--background))] text-sm"
      aria-busy="true"
      aria-label="Loading canvas"
    >
      <span>Loading canvas...</span>
    </div>
  );
};
