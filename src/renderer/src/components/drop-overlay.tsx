import { CircleCheckIcon, FileUpIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { toast } from "@/components/ui/toast";
import {
  canvasDropZone,
  dropDestinationLabel,
  resolveDropZone,
  type DropZone,
} from "@/lib/drop-destination";
import { MAX_DROP_FILES, isSceneFile } from "@/lib/drop-import";
import { getSidebarDropSurface } from "@/lib/drop-surface";
import { useStore, type ImportResult } from "@/lib/store";
import { buildEntriesById } from "@/lib/tree";
import { cn } from "@/lib/utils";

type Phase = "idle" | "hover" | "importing" | "done" | "failed";

const SETTLE_MS = 1_400;

const holdsFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many.replace("%n", String(count));

const summaryText = (result: ImportResult, destination: string | null = null) => {
  const { imported, failed } = result;
  const to = destination === null ? "" : ` to ${destination}`;
  if (imported.length === 0 && failed.length === 0) return "Nothing to import";
  if (imported.length === 0) return `${plural(failed.length, "1 file", "%n files")} skipped`;
  if (failed.length === 0)
    return `Added ${plural(imported.length, "1 drawing", "%n drawings")}${to}`;
  return `Added ${imported.length}${to}, skipped ${failed.length}`;
};

export const DropOverlay = () => {
  const importFileDrops = useStore((state) => state.importFileDrops);
  const entries = useStore((state) => state.entries);
  const [phase, setPhase] = useState<Phase>("idle");
  const [hovered, setHovered] = useState(0);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [zone, setZone] = useState<DropZone>(canvasDropZone);

  const phaseRef = useRef(phase);
  const depthRef = useRef(0);
  const settleRef = useRef<number | null>(null);
  const importRef = useRef(importFileDrops);
  const entriesById = useMemo(() => buildEntriesById(entries), [entries]);
  const entriesByIdRef = useRef(entriesById);

  useEffect(() => {
    entriesByIdRef.current = entriesById;
  }, [entriesById]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    importRef.current = importFileDrops;
  }, [importFileDrops]);

  useEffect(() => {
    const clearSettle = () => {
      if (settleRef.current === null) return;
      window.clearTimeout(settleRef.current);
      settleRef.current = null;
    };

    const reset = () => {
      depthRef.current = 0;
      clearSettle();
      getSidebarDropSurface()?.hover(null);
      setZone(canvasDropZone);
      setPhase("idle");
      setResult(null);
    };

    const syncZone = (clientX: number, clientY: number) => {
      const surface = getSidebarDropSurface();
      const hit = surface ? surface.hitTest(clientX, clientY) : null;
      surface?.hover(hit);

      const next = resolveDropZone(hit);
      setZone((current) =>
        current.kind === next.kind && current.parentId === next.parentId ? current : next,
      );
      return next;
    };

    const settle = () => {
      clearSettle();
      settleRef.current = window.setTimeout(() => {
        settleRef.current = null;
        setPhase("idle");
        setResult(null);
      }, SETTLE_MS);
    };

    const runImport = async (files: File[], dropZone: DropZone) => {
      setHovered(files.length);
      setPhase("importing");

      let imported: ImportResult;
      try {
        imported = await importRef.current(dropZone.parentId, files, {
          open: dropZone.kind === "canvas" ? "always" : "never",
        });
      } catch (error) {
        imported = {
          imported: [],
          failed: files.map((file) => ({
            name: file.name,
            reason: error instanceof Error ? error.message : "Import failed",
          })),
        };
      }

      setResult(imported);
      setPhase(imported.imported.length > 0 ? "done" : "failed");

      const destination =
        dropZone.kind === "sidebar"
          ? dropDestinationLabel(dropZone.parentId, entriesByIdRef.current)
          : null;

      if (imported.imported.length > 0) {
        toast.add({
          title: summaryText(imported, destination),
          description:
            imported.imported.length === 1
              ? imported.imported[0].name.replace(/\.excalidraw$/i, "")
              : undefined,
          type: "success",
        });
        if (dropZone.kind === "sidebar") getSidebarDropSurface()?.reveal(dropZone.parentId);
      }

      const [firstFailure] = imported.failed;
      if (firstFailure) {
        toast.add({
          title:
            imported.failed.length === 1
              ? `Couldn’t import ${firstFailure.name}`
              : `Couldn’t import ${imported.failed.length} files`,
          description: firstFailure.reason,
          type: "error",
        });
      }

      settle();
    };

    const handleDragEnter = (event: DragEvent) => {
      if (!holdsFiles(event)) return;
      event.preventDefault();
      depthRef.current += 1;
      if (settleRef.current !== null) {
        clearSettle();
        setResult(null);
      }
      syncZone(event.clientX, event.clientY);
      setHovered(Math.max(event.dataTransfer?.items.length ?? 1, 1));
      setPhase("hover");
    };

    const handleDragOver = (event: DragEvent) => {
      if (!holdsFiles(event)) return;
      event.preventDefault();
      if (phaseRef.current === "hover") syncZone(event.clientX, event.clientY);
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };

    const handleDragLeave = (event: DragEvent) => {
      if (!holdsFiles(event)) return;
      depthRef.current = Math.max(depthRef.current - 1, 0);
      if (depthRef.current > 0) return;
      if (phaseRef.current !== "hover") return;
      getSidebarDropSurface()?.hover(null);
      setPhase("idle");
      setResult(null);
    };

    const handleDrop = (event: DragEvent) => {
      if (!holdsFiles(event)) return;

      const files = [...(event.dataTransfer?.files ?? [])];
      const scenes = files.filter((file) => isSceneFile(file.name));

      if (scenes.length === 0) {
        // Image drops inside the Excalidraw canvas are handled by Excalidraw itself.
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".excalidraw")) return;

        event.preventDefault();
        event.stopPropagation();
        depthRef.current = 0;
        syncZone(event.clientX, event.clientY);
        getSidebarDropSurface()?.hover(null);
        setResult({
          imported: [],
          failed: files.map((file) => ({
            name: file.name,
            reason: "Only .excalidraw files are imported",
          })),
        });
        setPhase("failed");
        toast.add({
          title: "Nothing to import",
          description: "Only .excalidraw drawings can be dropped here.",
          type: "error",
        });
        settle();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      depthRef.current = 0;
      const dropZone = syncZone(event.clientX, event.clientY);
      getSidebarDropSurface()?.hover(null);
      void runImport(scenes.slice(0, MAX_DROP_FILES), dropZone);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") reset();
    };

    window.addEventListener("dragenter", handleDragEnter, true);
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("dragleave", handleDragLeave, true);
    window.addEventListener("drop", handleDrop, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", reset);

    return () => {
      clearSettle();
      window.removeEventListener("dragenter", handleDragEnter, true);
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("dragleave", handleDragLeave, true);
      window.removeEventListener("drop", handleDrop, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", reset);
    };
  }, []);

  if (phase === "idle") return null;
  if (zone.kind === "sidebar") return null;

  const importing = phase === "importing";
  const done = phase === "done";
  const failed = phase === "failed";

  const title = importing
    ? "Importing drawings…"
    : phase === "hover"
      ? "Drop to import drawings"
      : result
        ? summaryText(result)
        : "Import failed";

  const description = importing
    ? `Adding ${plural(Math.min(hovered, MAX_DROP_FILES), "1 drawing", "%n drawings")} to your library`
    : phase === "hover"
      ? "Release to add them to your library."
      : failed
        ? (result?.failed[0]?.reason ?? "Only .excalidraw drawings can be imported.")
        : "They’re in your library now.";

  return (
    <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center p-8">
      <div className="bg-background/70 animate-in fade-in-0 absolute inset-0 duration-150" />

      <div
        role="status"
        aria-live="polite"
        className="bg-popover text-popover-foreground border-border-float animate-in fade-in-0 zoom-in-95 relative flex w-full max-w-md flex-col gap-2 rounded-2xl border p-2 shadow-[var(--shadow-float)] duration-150"
      >
        <div
          className={cn(
            "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-8 py-10 text-center transition-colors duration-150",
            failed ? "border-destructive/40" : "border-border-strong/60",
            importing && "border-border-strong/40",
          )}
        >
          <span
            className={cn(
              "bg-accent text-muted-foreground flex size-11 items-center justify-center rounded-full",
              done && "text-foreground",
              failed && "text-destructive",
            )}
          >
            {importing ? (
              <Loader2Icon aria-hidden="true" className="size-5 animate-spin" />
            ) : done ? (
              <CircleCheckIcon aria-hidden="true" className="size-5" />
            ) : failed ? (
              <TriangleAlertIcon aria-hidden="true" className="size-5" />
            ) : (
              <FileUpIcon aria-hidden="true" className="size-5" />
            )}
          </span>

          <div className="flex flex-col gap-1">
            <p className="text-foreground text-sm font-medium">{title}</p>
            <p className="text-muted-foreground max-w-xs text-xs leading-relaxed">{description}</p>
          </div>
        </div>

        <p className="text-muted-foreground pb-2 text-center text-[11px]">
          {phase === "hover" ? "Esc to cancel" : "Only .excalidraw files are imported"}
        </p>
      </div>
    </div>
  );
};
