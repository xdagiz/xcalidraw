import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type { FileDeleteMode, FileEntry } from "@shared/ipc";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import { ChevronRightIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { EmptyDrawings } from "@/components/empty-drawings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { TreeContainer, TreeRow, useFileTree, type FileTreeItem } from "@/components/ui/tree";
import { UpdateIndicator } from "@/components/update-indicator";
import { useExpandedFolders } from "@/hooks/use-expanded-folders";
import { toAppError, type AppError } from "@/lib/app-error";
import { remapId } from "@/lib/entry-tree";
import { formatRelativeTimeShort } from "@/lib/relative-time";
import { useStore } from "@/lib/store";
import {
  TYPEAHEAD_RESET_MS,
  ancestorIdsOf,
  buildEntriesById,
  buildSortedChildIndex,
  canReparent,
  dropParentAtOffset,
  findTypeaheadMatch,
  pasteParentId,
  remapExpandedIds,
} from "@/lib/tree";
import { stripExcalidraw } from "@/lib/utils";

const isTypeaheadChar = (event: React.KeyboardEvent<HTMLDivElement>) =>
  event.key !== " " && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;

const TREE_ROW_HEIGHT = 28;
const TREE_OVERSCAN = 10;
const DRAG_START_PX = 4;
const FOLDER_HOVER_EXPAND_MS = 550;

const stopDragClick = (clickEvent: MouseEvent) => {
  clickEvent.preventDefault();
  clickEvent.stopPropagation();
  window.removeEventListener("click", stopDragClick, true);
};

const clearDragClickBlocker = () => {
  window.removeEventListener("click", stopDragClick, true);
};

type DragPreview = {
  sourceId: string;
  label: string;
  isFolder: boolean;
  parentId: string | null;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  width: number;
  outside: boolean;
};

type TreeClipboard = { op: "copy" | "cut"; id: string; rootPath: string | null } | null;

export const AppSidebar = ({ onOpenSettings }: { onOpenSettings: () => void }) => {
  const { toggleSidebar } = useSidebar();

  const entries = useStore((s) => s.entries);
  const openFileId = useStore((s) => s.openFileId);
  const dirtyById = useStore((s) => s.dirtyById);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const openHome = useStore((s) => s.openHome);
  const renameEntry = useStore((s) => s.renameEntry);
  const moveEntry = useStore((s) => s.moveEntry);
  const copyEntry = useStore((s) => s.copyEntry);
  const createEntry = useStore((s) => s.createEntry);
  const deleteEntry = useStore((s) => s.deleteEntry);
  const settingsDialogOpen = useStore((s) => s.settingsDialogOpen);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const editorPaletteOpen = useStore((s) => s.editorPaletteOpen);
  const searchOpen = useStore((s) => s.searchOpen);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const isLoadingDrawings = useStore((s) => s.isLoadingDrawings);
  const drawingsPath = useStore((s) => s.drawings?.path ?? null);
  const showRecents = useStore((s) => s.settings.showRecents);
  const dialogsOpen = settingsDialogOpen || paletteOpen || editorPaletteOpen || searchOpen;

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<AppError | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
    mode: FileDeleteMode;
  } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const typeahead = useRef({ buffer: "", at: 0 });

  const contentRef = useRef<HTMLDivElement | null>(null);
  const [bottomFade, setBottomFade] = useState(false);
  const [scrollMetrics, setScrollMetrics] = useState({ top: 0, height: 0 });

  const updateScrollMetrics = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    setBottomFade(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    setScrollMetrics((current) =>
      current.top === el.scrollTop && current.height === el.clientHeight
        ? current
        : { top: el.scrollTop, height: el.clientHeight },
    );
  }, []);
  const entriesById = useMemo(() => buildEntriesById(entries), [entries]);
  const childIndex = useMemo(() => buildSortedChildIndex(entries), [entries]);
  const { expandedIds, expandIds, setExpandedItems } = useExpandedFolders();
  const expandedItems = useMemo(() => Array.from(expandedIds), [expandedIds]);
  const selectedItems = useMemo(() => (openFileId ? [openFileId] : []), [openFileId]);

  const handlePrimaryAction = useCallback(
    (item: FileTreeItem) => {
      const entry = item.getItemData();
      if (entry && entry.kind === "file") void setOpenFileId(entry.id);
    },
    [setOpenFileId],
  );

  const ignoreSelectionChange = useCallback(() => {}, []);

  const { tree, rows: treeItems } = useFileTree({
    childIndex,
    expandedItems,
    onExpandedItemsChange: setExpandedItems,
    selectedItems,
    onSelectedItemsChange: ignoreSelectionChange,
    onPrimaryAction: handlePrimaryAction,
  });

  useEffect(() => {
    if (!openFileId || entries.length === 0) return;
    expandIds(ancestorIdsOf(openFileId));
  }, [openFileId, expandIds, entries.length]);

  useEffect(() => {
    let innerFrame = 0;
    let outerFrame = 0;

    if (openFileId && entries.length > 0) {
      outerFrame = requestAnimationFrame(() => {
        innerFrame = requestAnimationFrame(() => {
          const index = treeItems.findIndex((row) => row.id === openFileId);
          const viewport = contentRef.current;
          if (index < 0 || !viewport) return;
          const top = index * TREE_ROW_HEIGHT;
          const bottom = top + TREE_ROW_HEIGHT;
          if (top < viewport.scrollTop) viewport.scrollTop = top;
          else if (bottom > viewport.scrollTop + viewport.clientHeight) {
            viewport.scrollTop = bottom - viewport.clientHeight;
          }
          updateScrollMetrics();
        });
      });
    }

    return () => {
      cancelAnimationFrame(outerFrame);
      cancelAnimationFrame(innerFrame);
    };
  }, [openFileId, treeItems, entries.length, updateScrollMetrics]);

  const performDelete = useCallback(
    async (target: { id: string; name: string; mode: FileDeleteMode }) => {
      try {
        const ok = await deleteEntry(target.id, target.mode);
        if (ok) toast.add({ title: `Deleted ${target.name}`, type: "success" });
      } catch (error) {
        toast.add({ title: toAppError(error, "delete").detail, type: "error" });
      }
    },
    [deleteEntry],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteOpen(false);
    await performDelete(target);
  }, [deleteTarget, performDelete]);

  const startRename = useCallback((fileId: string) => {
    setRenameError(null);
    setRenamingId(fileId);
  }, []);

  const [freshDrawingId, setFreshDrawingId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<TreeClipboard>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const renameValueRef = useRef<string>("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const treeItemsRef = useRef(treeItems);
  const dragPointerX = useRef<number | null>(null);
  const dragPointerY = useRef<number | null>(null);
  const pasting = useRef(false);
  const dragScrollFrame = useRef<number | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const expandTimer = useRef<number | null>(null);
  const expandHoverId = useRef<string | null>(null);
  const focusRequest = useRef<string | null>(null);

  if (clipboard !== null && clipboard.rootPath !== drawingsPath) setClipboard(null);

  const clearFreshMarker = useCallback((fileId: string) => {
    setFreshDrawingId((current) => (current === fileId ? null : current));
  }, []);

  const openDelete = useCallback((id: string, name: string, mode: FileDeleteMode) => {
    setDeleteTarget({ id, name, mode });
    setDeleteOpen(true);
  }, []);

  const scrollFocusedRowIntoView = useCallback(() => {
    const index = tree.getItems().findIndex((item) => item.isFocused());
    const viewport = contentRef.current;
    if (index < 0 || !viewport) return;

    const top = index * TREE_ROW_HEIGHT;
    const bottom = top + TREE_ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = bottom - viewport.clientHeight;
    }
    updateScrollMetrics();
  }, [tree, updateScrollMetrics]);

  const hitAtClientPoint = useCallback((clientX: number, clientY: number) => {
    const list = listRef.current;
    const viewport = contentRef.current;
    const rows = treeItemsRef.current;
    if (!list || !viewport) return { inside: false, parentId: null, row: null };

    const viewportRect = viewport.getBoundingClientRect();
    if (
      clientX < viewportRect.left ||
      clientX > viewportRect.right ||
      clientY < viewportRect.top ||
      clientY > viewportRect.bottom
    ) {
      return { inside: false, parentId: null, row: null };
    }

    const offset = clientY - list.getBoundingClientRect().top;
    const parentId = dropParentAtOffset(
      rows.map((row) => ({
        id: row.id,
        kind: row.entry.kind,
        parentId: row.entry.parentId,
      })),
      offset,
      TREE_ROW_HEIGHT,
    );

    if (offset < 0 || offset >= rows.length * TREE_ROW_HEIGHT) {
      return { inside: true, parentId, row: null };
    }

    const row = rows[Math.floor(offset / TREE_ROW_HEIGHT)];
    if (!row) return { inside: true, parentId, row: null };

    return {
      inside: true,
      parentId,
      row: {
        id: row.id,
        isFolder: row.isFolder,
        isExpanded: row.isExpanded,
      },
    };
  }, []);

  const stopDragScroll = useCallback(() => {
    dragPointerX.current = null;
    dragPointerY.current = null;
    if (dragScrollFrame.current !== null) {
      cancelAnimationFrame(dragScrollFrame.current);
      dragScrollFrame.current = null;
    }
  }, []);

  const performMove = useCallback(
    async (sourceId: string, destParentId: string | null) => {
      const check = canReparent(sourceId, destParentId, entries);
      if (!check.ok) {
        if (check.reason === "into-self") {
          toast.add({
            title: "Couldn’t move this item",
            description: "A folder cannot be moved into itself.",
            type: "error",
          });
        }
        return null;
      }

      try {
        const moved = await moveEntry(sourceId, destParentId);
        if (!moved) return null;
        if (moved.id !== sourceId) {
          setExpandedItems((current) => [...remapExpandedIds(current, sourceId, moved.id)]);
          setClipboard((current) =>
            current ? { ...current, id: remapId(current.id, sourceId, moved.id) } : current,
          );
        }
        expandIds(ancestorIdsOf(moved.id));
        focusRequest.current = moved.id;
        toast.add({ title: `Moved ${stripExcalidraw(moved.name)}`, type: "success" });
        return moved;
      } catch (error) {
        const appError = toAppError(error, "move");
        toast.add({ title: appError.title, description: appError.message, type: "error" });
        return null;
      }
    },
    [entries, expandIds, moveEntry, setExpandedItems],
  );

  const performMoveRef = useRef(performMove);

  useLayoutEffect(() => {
    treeItemsRef.current = treeItems;
    performMoveRef.current = performMove;
  }, [performMove, treeItems]);

  const focusedEntry = useCallback(() => {
    const focused = tree.getItems().find((item) => item.isFocused());
    return focused?.getItemData() ?? null;
  }, [tree]);

  const rememberClipboard = useCallback(
    (op: "copy" | "cut", entry: FileEntry) => {
      setClipboard({ op, id: entry.id, rootPath: drawingsPath });
      const verb = op === "copy" ? "Copied" : "Cut";
      toast.add({ title: `${verb} ${stripExcalidraw(entry.name)}`, type: "success" });
    },
    [drawingsPath],
  );

  const runPaste = useCallback(
    async (target: FileEntry | null) => {
      if (!clipboard) return;
      if (clipboard.rootPath !== drawingsPath) {
        setClipboard(null);
        return;
      }
      const source = entriesById.get(clipboard.id);
      if (!source) {
        toast.add({
          title: clipboard.op === "cut" ? "Couldn’t move this item" : "Couldn’t copy this item",
          description: "That item is no longer in the drawings folder.",
          type: "error",
        });
        if (clipboard.op === "cut") setClipboard(null);
        return;
      }

      const dest = pasteParentId(target);
      if (clipboard.op === "cut") {
        const reparent = canReparent(source.id, dest, entries);
        if (!reparent.ok && reparent.reason === "same-parent") {
          toast.add({ title: "Already in this folder", type: "info" });
          setClipboard(null);
          return;
        }

        const moved = await performMove(source.id, dest);
        if (moved) setClipboard(null);
        return;
      }

      try {
        const newId = await copyEntry(source.id, dest);
        if (!newId) return;
        expandIds(ancestorIdsOf(newId));
        focusRequest.current = newId;
        const leaf = newId.split("/").pop() ?? newId;
        toast.add({ title: `Pasted ${stripExcalidraw(leaf)}`, type: "success" });
      } catch (error) {
        const appError = toAppError(error, "copy");
        toast.add({ title: appError.title, description: appError.message, type: "error" });
      }
    },
    [clipboard, copyEntry, drawingsPath, entries, entriesById, expandIds, performMove],
  );

  const pasteAt = useCallback(
    async (target: FileEntry | null) => {
      if (pasting.current) return;
      pasting.current = true;
      await runPaste(target).finally(() => {
        pasting.current = false;
      });
    },
    [runPaste],
  );

  const handleRowPointerDown = useCallback(
    (sourceId: string, event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || renamingId !== null) return;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const rowEl = event.currentTarget;
      const rect = rowEl.getBoundingClientRect();
      const source = treeItemsRef.current.find((row) => row.id === sourceId);
      const lifted = {
        sourceId,
        label: source?.name ?? sourceId,
        isFolder: source?.isFolder ?? false,
        offsetX: startX - rect.left,
        offsetY: startY - rect.top,
        width: rect.width,
      };

      let active = false;
      let cancelled = false;
      let previousCursor = "";

      const clearExpandTimer = () => {
        if (expandTimer.current !== null) {
          window.clearTimeout(expandTimer.current);
          expandTimer.current = null;
        }
        expandHoverId.current = null;
      };

      const armExpand = (row: { id: string; isFolder: boolean; isExpanded: boolean } | null) => {
        const insideDrag =
          row !== null && (row.id === sourceId || row.id.startsWith(`${sourceId}/`));
        const nextId = row?.isFolder && !row.isExpanded && !insideDrag ? row.id : null;
        if (nextId === expandHoverId.current) return;
        if (expandTimer.current !== null) window.clearTimeout(expandTimer.current);

        expandHoverId.current = nextId;
        expandTimer.current = null;
        if (!nextId) return;

        expandTimer.current = window.setTimeout(() => {
          expandIds([nextId]);
          expandHoverId.current = null;
          expandTimer.current = null;
        }, FOLDER_HOVER_EXPAND_MS);
      };

      const follow = (clientX: number, clientY: number) => {
        const hit = hitAtClientPoint(clientX, clientY);
        armExpand(hit.row);
        const outside = !hit.inside;
        setDragPreview((current) => {
          if (!current) {
            return {
              ...lifted,
              parentId: hit.parentId,
              outside,
              x: clientX,
              y: clientY,
            };
          }

          if (
            current.parentId === hit.parentId &&
            current.outside === outside &&
            current.x === clientX &&
            current.y === clientY
          ) {
            return current;
          }

          return {
            ...current,
            parentId: hit.parentId,
            outside,
            x: clientX,
            y: clientY,
          };
        });
      };

      const tick = () => {
        const x = dragPointerX.current;
        const y = dragPointerY.current;
        const viewport = contentRef.current;
        if (x === null || y === null || !viewport || !active || cancelled) {
          dragScrollFrame.current = null;
          return;
        }

        const bounds = viewport.getBoundingClientRect();
        const edge = 24;
        const maxStep = 14;

        let delta = 0;
        if (y < bounds.top + edge) {
          delta = -Math.ceil(maxStep * Math.min(1, (bounds.top + edge - y) / edge));
        } else if (y > bounds.bottom - edge) {
          delta = Math.ceil(maxStep * Math.min(1, (y - (bounds.bottom - edge)) / edge));
        }

        if (delta !== 0) {
          viewport.scrollTop += delta;
          updateScrollMetrics();
        }

        const hit = hitAtClientPoint(x, y);
        armExpand(hit.row);
        setDragPreview((current) =>
          current && (current.parentId !== hit.parentId || current.outside === hit.inside)
            ? { ...current, parentId: hit.parentId, outside: !hit.inside }
            : current,
        );

        dragScrollFrame.current = requestAnimationFrame(tick);
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;

        if (!active) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return;

          active = true;
          previousCursor = document.body.style.cursor;
          document.body.style.cursor = "grabbing";
          window.addEventListener("click", stopDragClick, true);
          dragScrollFrame.current = requestAnimationFrame(tick);
        }

        if (cancelled) return;
        dragPointerX.current = ev.clientX;
        dragPointerY.current = ev.clientY;

        follow(ev.clientX, ev.clientY);
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("keydown", onKey);
        if (active) document.body.style.cursor = previousCursor;
        clearExpandTimer();
        if (dragCleanup.current === cleanup) dragCleanup.current = null;
      };

      const finish = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const wasActive = active;
        const wasCancelled = cancelled || ev.type === "pointercancel";
        const hit = hitAtClientPoint(ev.clientX, ev.clientY);
        cleanup();
        active = false;
        setDragPreview(null);
        stopDragScroll();
        if (wasCancelled) clearDragClickBlocker();
        else if (wasActive) {
          window.setTimeout(clearDragClickBlocker, 0);
        }
        if (!wasActive || wasCancelled || !hit.inside) return;
        void performMoveRef.current(sourceId, hit.parentId);
      };

      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !active) return;
        cancelled = true;
        document.body.style.cursor = previousCursor;
        setDragPreview(null);
        stopDragScroll();
        clearExpandTimer();
        ev.preventDefault();
      };

      dragCleanup.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("keydown", onKey);
    },
    [expandIds, hitAtClientPoint, renamingId, stopDragScroll, updateScrollMetrics],
  );

  useEffect(() => {
    const id = focusRequest.current;
    if (!id || !entriesById.has(id)) return;
    focusRequest.current = null;
    tree.getItemInstance(id).setFocused();
    tree.updateDomFocus();
    requestAnimationFrame(scrollFocusedRowIntoView);
  }, [entriesById, scrollFocusedRowIntoView, tree]);

  useEffect(
    () => () => {
      dragCleanup.current?.();
      clearDragClickBlocker();
      if (expandTimer.current !== null) window.clearTimeout(expandTimer.current);
    },
    [],
  );

  const handleContainerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLInputElement) return;
      requestAnimationFrame(scrollFocusedRowIntoView);

      const mod = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
      if (mod && !dialogsOpen && renamingId === null) {
        const key = event.key.toLowerCase();
        if (key === "v") {
          event.preventDefault();
          void pasteAt(focusedEntry());
          return;
        }

        if (key === "c" || key === "x") {
          const current = focusedEntry();
          if (!current) return;
          event.preventDefault();
          rememberClipboard(key === "c" ? "copy" : "cut", current);
          return;
        }
      }

      if (
        event.key === "Escape" &&
        clipboard?.op === "cut" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        setClipboard(null);
        return;
      }

      const items = tree.getItems();
      const focusedIndex = items.findIndex((item) => item.isFocused());
      if (focusedIndex === -1) return;

      const entry = items[focusedIndex].getItemData();
      if (!entry) return;

      if (event.key === "F2") {
        event.preventDefault();
        startRename(entry.id);
        return;
      }

      if (event.key === "Delete") {
        event.preventDefault();
        const mode: FileDeleteMode = event.shiftKey ? "permanent" : "trash";
        openDelete(entry.id, stripExcalidraw(entry.name), mode);
        return;
      }

      if (!isTypeaheadChar(event)) return;
      event.preventDefault();

      const now = Date.now();
      typeahead.current.buffer =
        now - typeahead.current.at > TYPEAHEAD_RESET_MS
          ? event.key
          : typeahead.current.buffer + event.key;
      typeahead.current.at = now;

      const names = items.map((item) => item.getItemName());
      const hit = findTypeaheadMatch(names, focusedIndex, typeahead.current.buffer);
      if (hit !== null) {
        items[hit].setFocused();
        tree.updateDomFocus();
      }
    },
    [
      clipboard,
      dialogsOpen,
      focusedEntry,
      openDelete,
      pasteAt,
      rememberClipboard,
      renamingId,
      scrollFocusedRowIntoView,
      startRename,
      tree,
    ],
  );

  const handleRename = useCallback(
    async (fileId: string, newName: string) => {
      const isFresh = freshDrawingId === fileId;
      const entry = entriesById.get(fileId);
      const changed = entry ? newName !== stripExcalidraw(entry.name) : true;
      let targetId = fileId;

      try {
        if (changed) {
          const renamed = await renameEntry(fileId, newName);
          if (renamed === null) {
            setRenameError(null);
            setRenamingId(null);
            return;
          }

          targetId = renamed.id;
          if (targetId !== fileId) {
            setExpandedItems((current) => [...remapExpandedIds(current, fileId, targetId)]);
            setClipboard((current) =>
              current ? { ...current, id: remapId(current.id, fileId, targetId) } : current,
            );
          }

          // Fresh drawings skip the toast; first rename is part of creation.
          if (!isFresh) toast.add({ title: "Drawing renamed", type: "success" });
        }

        setRenameError(null);
        setRenamingId(null);

        if (isFresh) {
          const opened = await setOpenFileId(targetId);
          if (opened) clearFreshMarker(fileId);
        }
      } catch (error) {
        setRenameError(toAppError(error, "rename"));
      }
    },
    [renameEntry, clearFreshMarker, setOpenFileId, entriesById, freshDrawingId, setExpandedItems],
  );

  const handleCreate = useCallback(
    async (parentId: string | null, kind: "file" | "directory") => {
      if (renamingId !== null) {
        const pendingId = renamingId;
        const pendingValue = renameValueRef.current.trim();
        setRenameError(null);
        setRenamingId(null);
        if (pendingValue) await handleRename(pendingId, pendingValue);
      }

      try {
        const newId = await createEntry(parentId, kind);
        if (!newId) return;
        if (kind === "file") setFreshDrawingId(newId);

        expandIds(ancestorIdsOf(newId));
        setRenameError(null);
        setRenamingId(newId);
      } catch (error) {
        const appError = toAppError(error, "create");
        toast.add({ title: appError.title, description: appError.message, type: "error" });
      }
    },
    [createEntry, expandIds, handleRename, renamingId],
  );

  const openRootMenu = useCallback(
    async (x: number, y: number) => {
      const id = await window.api.contextMenu.show(
        [
          { id: "new-drawing", label: "New drawing" },
          { id: "new-folder", label: "New folder" },
          ...(clipboard && clipboard.rootPath === drawingsPath
            ? [{ id: "paste", label: "Paste" }]
            : []),
        ],
        x,
        y,
      );
      if (id === "new-drawing") void handleCreate(null, "file");
      if (id === "new-folder") void handleCreate(null, "directory");
      if (id === "paste") void pasteAt(null);
    },
    [clipboard, drawingsPath, handleCreate, pasteAt],
  );

  useHotkey("Mod+B", () => toggleSidebar(), { enabled: !dialogsOpen });
  useHotkey("Mod+N", () => void handleCreate(null, "file"), { enabled: !dialogsOpen });
  useHotkey("Mod+Shift+N", () => void handleCreate(null, "directory"), {
    enabled: !dialogsOpen,
  });

  const menuAction = useCallback(
    async (action: string | null, entry: FileEntry) => {
      switch (action) {
        case "new-drawing":
          await handleCreate(entry.id, "file");
          break;
        case "new-folder":
          await handleCreate(entry.id, "directory");
          break;
        case "copy":
          rememberClipboard("copy", entry);
          break;
        case "cut":
          rememberClipboard("cut", entry);
          break;
        case "paste":
          await pasteAt(entry);
          break;
        case "rename":
          startRename(entry.id);
          break;
        case "delete": {
          const name = stripExcalidraw(entry.name);
          openDelete(entry.id, name, "trash");
          break;
        }
      }
    },
    [handleCreate, openDelete, pasteAt, rememberClipboard, startRename],
  );

  const openMenuFor = useCallback(
    async (fileId: string, x: number, y: number) => {
      const entry = entriesById.get(fileId);
      if (!entry) return;

      const editItems = [
        { id: "copy", label: "Copy" },
        { id: "cut", label: "Cut" },
        ...(clipboard && clipboard.rootPath === drawingsPath
          ? [{ id: "paste", label: "Paste" }]
          : []),
        { id: "rename", label: "Rename" },
        { id: "delete", label: "Delete" },
      ];

      const items =
        entry.kind === "directory"
          ? [
              { id: "new-drawing", label: "New drawing" },
              { id: "new-folder", label: "New folder" },
              ...editItems,
            ]
          : editItems;

      const action = await window.api.contextMenu.show(items, x, y);
      await menuAction(action, entry);
    },
    [clipboard, drawingsPath, entriesById, menuAction],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, fileId: string) => {
      event.preventDefault();
      void openMenuFor(fileId, event.clientX, event.clientY);
    },
    [openMenuFor],
  );

  const handleMenuClick = useCallback(
    (fileId: string, x: number, y: number) => {
      void openMenuFor(fileId, x, y);
    },
    [openMenuFor],
  );

  const handleContentScroll = useCallback(() => {
    updateScrollMetrics();
  }, [updateScrollMetrics]);

  useEffect(() => {
    updateScrollMetrics();
    const el = contentRef.current;
    if (!el) return () => {};
    const ro = new ResizeObserver(updateScrollMetrics);
    ro.observe(el);
    const mo = new MutationObserver(updateScrollMetrics);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [updateScrollMetrics]);

  const firstVisibleRow = Math.max(
    0,
    Math.floor(scrollMetrics.top / TREE_ROW_HEIGHT) - TREE_OVERSCAN,
  );
  const visibleRowCount = Math.ceil(scrollMetrics.height / TREE_ROW_HEIGHT) + TREE_OVERSCAN * 2;
  const focusedTreeRow = treeItems.findIndex((row) => row.isFocused);
  const virtualStart =
    focusedTreeRow < 0 ? firstVisibleRow : Math.min(firstVisibleRow, focusedTreeRow);
  const virtualEnd =
    focusedTreeRow < 0
      ? firstVisibleRow + visibleRowCount
      : Math.max(firstVisibleRow + visibleRowCount, focusedTreeRow + 1);
  const visibleTreeItems = treeItems.slice(virtualStart, virtualEnd);
  const hoveredParentId = dragPreview && !dragPreview.outside ? dragPreview.parentId : null;
  const dropAllowed =
    dragPreview !== null &&
    !dragPreview.outside &&
    canReparent(dragPreview.sourceId, hoveredParentId, entries).ok;
  const dropFolderId = dropAllowed ? hoveredParentId : null;
  let dropRegion: { top: number; height: number } | null = null;
  if (dropFolderId !== null) {
    const start = treeItems.findIndex((row) => row.id === dropFolderId);
    if (start !== -1) {
      const prefix = `${dropFolderId}/`;
      const next = treeItems.findIndex((row, index) => index > start && !row.id.startsWith(prefix));
      const end = next === -1 ? treeItems.length : next;
      dropRegion = { top: start * TREE_ROW_HEIGHT, height: (end - start) * TREE_ROW_HEIGHT };
    }
  }
  const dropRoot = dropAllowed && hoveredParentId === null;

  return (
    <>
      {dragPreview ? (
        <div
          className="bg-sidebar text-sidebar-foreground ring-sidebar-ring pointer-events-none fixed z-50 flex h-7 items-center gap-1.5 rounded-md px-2 text-sm shadow-lg"
          style={{
            width: dragPreview.width,
            left: dragPreview.x - dragPreview.offsetX,
            top: dragPreview.y - dragPreview.offsetY,
          }}
        >
          {dragPreview.isFolder ? (
            <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <span className="truncate">{stripExcalidraw(dragPreview.label)}</span>
        </div>
      ) : null}

      <Sidebar side="left" variant="floating">
        <SidebarHeader className="pb-0">
          <SidebarGroupLabel className="flex items-center justify-between">
            {showRecents ? (
              <button
                type="button"
                title="Show recent drawings"
                className="text-sidebar-foreground focus-visible:ring-sidebar-ring rounded outline-none focus-visible:ring-2"
                onClick={() => void openHome()}
              >
                Drawings
              </button>
            ) : (
              <span className="text-sidebar-foreground">Drawings</span>
            )}
            <div className="-mr-1 flex items-center gap-2">
              <button
                type="button"
                aria-label="Search drawings"
                title="Search drawings"
                className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors"
                onClick={() => setSearchOpen(true)}
              >
                <SearchIcon className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="New drawing or folder"
                title="New drawing or folder"
                disabled={isLoadingDrawings}
                className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors disabled:opacity-40"
                onClick={(e) => void openRootMenu(e.clientX, e.clientY)}
              >
                <PlusIcon className="size-3.5" />
              </button>
            </div>
          </SidebarGroupLabel>
        </SidebarHeader>

        <ScrollAreaPrimitive.Root
          data-slot="sidebar-scroll"
          className="relative flex min-h-0 flex-1 flex-col"
        >
          <ScrollAreaPrimitive.Viewport
            ref={contentRef}
            onScroll={handleContentScroll}
            data-slot="sidebar-scroll-viewport"
            className={
              bottomFade
                ? "min-h-0 w-full flex-1 [mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]"
                : "min-h-0 w-full flex-1"
            }
          >
            <SidebarGroup className="pt-0">
              <SidebarGroupContent>
                {isLoadingDrawings && entries.length === 0 ? (
                  <div className="flex flex-col gap-4 px-2 py-4" aria-label="Loading drawings">
                    {[0, 1, 2, 3].map((row) => (
                      <Skeleton key={row} className="h-4" style={{ width: `${80 - row * 6}%` }} />
                    ))}
                  </div>
                ) : entries.length === 0 ? (
                  <div className="flex justify-center py-2">
                    <EmptyDrawings
                      action={
                        <Button onClick={() => void handleCreate(null, "file")}>
                          Create drawing
                        </Button>
                      }
                    />
                  </div>
                ) : (
                  <TreeContainer
                    tree={tree}
                    dropRoot={dropRoot}
                    dragging={dragPreview !== null}
                    onKeyDown={handleContainerKeyDown}
                    onContextMenu={(e) => {
                      if (e.target === e.currentTarget) void openRootMenu(e.clientX, e.clientY);
                    }}
                  >
                    <div
                      ref={listRef}
                      style={{ height: treeItems.length * TREE_ROW_HEIGHT, position: "relative" }}
                    >
                      {dropRegion && (
                        <div
                          aria-hidden
                          className="bg-sidebar-accent/80 pointer-events-none absolute inset-x-0 rounded-md"
                          style={{ top: dropRegion.top, height: dropRegion.height }}
                        />
                      )}
                      <div
                        style={{
                          position: "absolute",
                          top: virtualStart * TREE_ROW_HEIGHT,
                          left: 0,
                          right: 0,
                        }}
                      >
                        {visibleTreeItems.map((row) => {
                          const entry = row.entry;
                          if (!entry || !entry.name) return null;

                          return (
                            <Fragment key={row.id}>
                              {renamingId === entry.id ? (
                                <div
                                  style={{
                                    paddingLeft: `${row.level * 16 + 16 + 6 - 11}px`,
                                  }}
                                  className="flex h-7 items-center pr-2"
                                >
                                  <RenameInput
                                    initial={stripExcalidraw(entry.name)}
                                    error={renameError}
                                    treatUnchangedAsCommit={freshDrawingId === entry.id}
                                    onValueChange={(v) => {
                                      renameValueRef.current = v;
                                    }}
                                    onCommit={(v) => handleRename(entry.id, v)}
                                    onCancel={() => {
                                      clearFreshMarker(entry.id);
                                      setRenameError(null);
                                      setRenamingId(null);
                                    }}
                                  />
                                </div>
                              ) : (
                                <TreeRow
                                  row={row}
                                  isActive={entry.id === openFileId}
                                  isDirty={dirtyById[entry.id] !== undefined}
                                  isCut={clipboard?.op === "cut" && clipboard.id === entry.id}
                                  isDragging={dragPreview?.sourceId === entry.id}
                                  onPointerDown={(event) => handleRowPointerDown(entry.id, event)}
                                  timeLabel={
                                    entry.kind === "file"
                                      ? formatRelativeTimeShort(entry.modifiedAt)
                                      : undefined
                                  }
                                  onMenuClick={(event) =>
                                    handleMenuClick(entry.id, event.clientX, event.clientY)
                                  }
                                  onContextMenu={(e) => handleContextMenu(e, entry.id)}
                                />
                              )}
                            </Fragment>
                          );
                        })}
                      </div>
                    </div>
                  </TreeContainer>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          </ScrollAreaPrimitive.Viewport>
          <ScrollAreaPrimitive.Scrollbar
            orientation="vertical"
            className="absolute top-2 right-1 bottom-2 flex w-1.5 touch-none rounded-full opacity-0 transition-opacity select-none group-hover/sidebar-wrapper:opacity-100"
          >
            <ScrollAreaPrimitive.Thumb className="bg-border-quiet hover:bg-border-strong flex-1 rounded-full" />
          </ScrollAreaPrimitive.Scrollbar>
        </ScrollAreaPrimitive.Root>

        <SidebarFooter>
          <SidebarMenu>
            <UpdateIndicator />
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onOpenSettings}>
                <SettingsIcon />
                Settings
                <KbdGroup className="ml-auto group-data-[collapsible=icon]:hidden">
                  {formatForDisplay("Mod+,")
                    .split(" ")
                    .map((token) => (
                      <Kbd key={token}>{token}</Kbd>
                    ))}
                </KbdGroup>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) setDeleteOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.mode === "permanent"
                ? `Permanently delete "${deleteTarget?.name}"?`
                : `Delete "${deleteTarget?.name}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.mode === "permanent"
                ? "This cannot be undone."
                : "The item will be moved to the system trash. You can restore it later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="outline">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleDeleteConfirm()}>
              {deleteTarget?.mode === "permanent" ? "Delete Forever" : "Move to Trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

const RenameInput = ({
  initial,
  error,
  treatUnchangedAsCommit = false,
  onCommit,
  onCancel,
  onValueChange,
}: {
  initial: string;
  error: AppError | null;
  treatUnchangedAsCommit?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
  onValueChange?: (value: string) => void;
}) => {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const lastCommitted = useRef<string | null>(null);
  const onValueChangeRef = useRef(onValueChange);

  useEffect(() => {
    onValueChangeRef.current = onValueChange;
  }, [onValueChange]);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    onValueChangeRef.current?.(initial);
  }, [initial]);

  useEffect(() => {
    if (!error) return;
    finished.current = false;
    ref.current?.focus();
  }, [error]);

  const finish = useCallback(
    (action: "commit" | "cancel") => {
      if (finished.current) return;
      finished.current = true;
      if (action === "commit") {
        const trimmed = value.trim();
        if (!trimmed || (trimmed === initial && !treatUnchangedAsCommit)) {
          onCancel();
        } else {
          lastCommitted.current = trimmed;
          onCommit(trimmed);
        }
      } else {
        onCancel();
      }
    },
    [value, initial, onCommit, onCancel, treatUnchangedAsCommit],
  );

  return (
    <Field data-invalid={error ? "true" : undefined} className="gap-1">
      <Input
        className="h-7 text-xs"
        ref={ref}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          onValueChange?.(e.target.value);
        }}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => {
          if (error && value.trim() === lastCommitted.current) finish("cancel");
          else finish("commit");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish("commit");
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish("cancel");
          }
        }}
      />
      <FieldError errors={error ? [{ message: error.message }] : undefined} className="text-xs" />
    </Field>
  );
};
