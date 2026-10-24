import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type { FileDeleteMode, FileEntry } from "@shared/ipc";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import { PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { formatRelativeTimeShort } from "@/lib/relative-time";
import { useStore } from "@/lib/store";
import {
  TYPEAHEAD_RESET_MS,
  ancestorIdsOf,
  buildEntriesById,
  buildSortedChildIndex,
  findTypeaheadMatch,
} from "@/lib/tree";
import { stripExcalidraw } from "@/lib/utils";

const isTypeaheadChar = (event: React.KeyboardEvent<HTMLDivElement>) =>
  event.key !== " " && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;

const TREE_ROW_HEIGHT = 28;
const TREE_OVERSCAN = 10;

export const AppSidebar = ({ onOpenSettings }: { onOpenSettings: () => void }) => {
  const { toggleSidebar } = useSidebar();

  const entries = useStore((s) => s.entries);
  const openFileId = useStore((s) => s.openFileId);
  const dirtyById = useStore((s) => s.dirtyById);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const openHome = useStore((s) => s.openHome);
  const renameEntry = useStore((s) => s.renameEntry);
  const createEntry = useStore((s) => s.createEntry);
  const deleteEntry = useStore((s) => s.deleteEntry);
  const settingsDialogOpen = useStore((s) => s.settingsDialogOpen);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const editorPaletteOpen = useStore((s) => s.editorPaletteOpen);
  const searchOpen = useStore((s) => s.searchOpen);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const isLoadingDrawings = useStore((s) => s.isLoadingDrawings);
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
  const renameValueRef = useRef<string>("");

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

  const handleContainerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLInputElement) return;
      requestAnimationFrame(scrollFocusedRowIntoView);

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
    [tree, startRename, openDelete, scrollFocusedRowIntoView],
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
    [renameEntry, clearFreshMarker, setOpenFileId, entriesById, freshDrawingId],
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
        ],
        x,
        y,
      );
      if (id === "new-drawing") void handleCreate(null, "file");
      if (id === "new-folder") void handleCreate(null, "directory");
    },
    [handleCreate],
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
    [handleCreate, startRename, openDelete],
  );

  const openMenuFor = useCallback(
    async (fileId: string, x: number, y: number) => {
      const entry = entriesById.get(fileId);
      if (!entry) return;

      const items =
        entry.kind === "directory"
          ? [
              { id: "new-drawing", label: "New drawing" },
              { id: "new-folder", label: "New folder" },
              { id: "rename", label: "Rename" },
              { id: "delete", label: "Delete" },
            ]
          : [
              { id: "rename", label: "Rename" },
              { id: "delete", label: "Delete" },
            ];

      const action = await window.api.contextMenu.show(items, x, y);
      await menuAction(action, entry);
    },
    [entriesById, menuAction],
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

  return (
    <>
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
                    onKeyDown={handleContainerKeyDown}
                    onContextMenu={(e) => {
                      if (e.target === e.currentTarget) void openRootMenu(e.clientX, e.clientY);
                    }}
                  >
                    <div
                      style={{ height: treeItems.length * TREE_ROW_HEIGHT, position: "relative" }}
                    >
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
