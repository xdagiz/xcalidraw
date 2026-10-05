import {
  hotkeysCoreFeature,
  selectionFeature,
  syncDataLoaderFeature,
  type ItemInstance,
  type TreeInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import type {
  KeyboardEventHandler,
  MouseEvent,
  MouseEventHandler,
  PointerEventHandler,
  ReactNode,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FileEntry } from "@shared/ipc";

import { flattenVisibleEntries } from "@/lib/tree";
import { cn, stripExcalidraw } from "@/lib/utils";

export type FileTreePayload = FileEntry | null;
export type FileTreeItem = ItemInstance<FileTreePayload>;
export type FileTreeInstance = TreeInstance<FileTreePayload>;

type TreeIdsUpdate = string[] | ((old: string[]) => string[]);

type UseFileTreeConfig = {
  childIndex: Map<string | null, FileEntry[]>;
  expandedItems: string[];
  onExpandedItemsChange: (items: TreeIdsUpdate) => void;
  selectedItems: string[];
  onSelectedItemsChange: (items: TreeIdsUpdate) => void;
  onPrimaryAction: (item: FileTreeItem) => void;
};

export type FileTreeRow = {
  id: string;
  entry: FileEntry;
  name: string;
  level: number;
  posInSet: number;
  setSize: number;
  isFolder: boolean;
  isExpanded: boolean;
  isFocused: boolean;
  item: FileTreeItem;
};

type UseFileTreeResult = {
  tree: FileTreeInstance;
  rows: FileTreeRow[];
};

export const useFileTree = ({
  childIndex,
  expandedItems,
  onExpandedItemsChange,
  selectedItems,
  onSelectedItemsChange,
  onPrimaryAction,
}: UseFileTreeConfig): UseFileTreeResult => {
  const entriesById = useMemo(() => {
    const map = new Map<string, FileEntry>();
    for (const children of childIndex.values()) {
      for (const entry of children) map.set(entry.id, entry);
    }
    return map;
  }, [childIndex]);

  const resolveEntry = useCallback(
    (itemId: string): FileEntry =>
      entriesById.get(itemId) ?? {
        id: itemId,
        name: "",
        kind: "file",
        parentId: null,
        modifiedAt: 0,
        size: 0,
        ino: "0",
        dev: "0",
      },
    [entriesById],
  );

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const tree = useTree<FileTreePayload>({
    rootItemId: "",
    getItemName: (item) => {
      const name = item.getItemData()?.name ?? "";
      return stripExcalidraw(name);
    },
    isItemFolder: (item) => item.getItemData()?.kind === "directory",
    dataLoader: {
      getItem: (itemId) => resolveEntry(itemId),
      getChildren: (itemId) =>
        (childIndex.get(itemId === "" ? null : itemId) ?? []).map((entry) => entry.id),
    },
    state: { expandedItems, selectedItems },
    setExpandedItems: onExpandedItemsChange,
    setSelectedItems: onSelectedItemsChange,
    onPrimaryAction,
    indent: 16,
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
    setState: (state) => {
      if (typeof state === "function") return;
      const id = state.focusedItem ?? null;
      setFocusedId((prev) => (prev === id ? prev : id));
    },
  });

  useEffect(() => {
    tree.rebuildTree();
  }, [tree, childIndex]);

  const rowsCache = useRef(new Map<string, FileTreeRow>());
  const rows = useMemo<FileTreeRow[]>(() => {
    const expandedSet = new Set(expandedItems);
    const prevCache = rowsCache.current;
    const nextCache = new Map<string, FileTreeRow>();
    const nextRows = flattenVisibleEntries(childIndex, expandedSet).map(
      ({ entry, level, posInSet, setSize, isExpanded }) => {
        const isFocused = focusedId === entry.id;
        const cached = prevCache.get(entry.id);
        if (
          cached &&
          cached.entry === entry &&
          cached.level === level &&
          cached.posInSet === posInSet &&
          cached.setSize === setSize &&
          cached.isExpanded === isExpanded &&
          cached.isFocused === isFocused
        ) {
          nextCache.set(entry.id, cached);
          return cached;
        }
        const row: FileTreeRow = {
          id: entry.id,
          entry,
          name: stripExcalidraw(entry.name),
          level,
          posInSet,
          setSize,
          isFolder: entry.kind === "directory",
          isExpanded,
          isFocused,
          item: tree.getItemInstance(entry.id),
        };
        nextCache.set(entry.id, row);
        return row;
      },
    );
    rowsCache.current = nextCache;
    return nextRows;
  }, [childIndex, expandedItems, focusedId, tree]);

  return { tree, rows };
};

export const TreeContainer = ({
  tree,
  className,
  dropRoot,
  onKeyDown,
  onContextMenu,
  children,
}: {
  tree: FileTreeInstance;
  className?: string;
  dropRoot?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  children: ReactNode;
}) => {
  const { onKeyDown: treeOnKeyDown, ...containerProps } = tree.getContainerProps("Drawings");

  return (
    <div
      {...containerProps}
      data-drop-root={dropRoot ? "true" : undefined}
      className={cn(className, dropRoot && "bg-sidebar-accent/40")}
      onKeyDown={(event) => {
        treeOnKeyDown?.(event);
        onKeyDown?.(event);
      }}
      onContextMenu={onContextMenu}
    >
      {children}
    </div>
  );
};

export const TreeRow = ({
  row,
  isActive,
  isDirty,
  isCut,
  isDropTarget,
  isDragging,
  indentPx = 16,
  timeLabel,
  onMenuClick,
  onContextMenu,
  onPointerDown,
}: {
  row: FileTreeRow;
  isActive?: boolean;
  isDirty?: boolean;
  isCut?: boolean;
  isDropTarget?: boolean;
  isDragging?: boolean;
  indentPx?: number;
  timeLabel?: string;
  onMenuClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: MouseEventHandler<HTMLElement>;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
}) => {
  const { item, level, isFolder, isExpanded: expanded, posInSet, setSize, name: label } = row;
  const isLastSibling = posInSet === setSize - 1;

  const guides: ReactNode[] = [];

  for (let depth = 0; depth < level; depth++) {
    const isParentColumn = depth === level - 1;
    guides.push(
      <span
        key={depth}
        className={cn(
          "absolute border-l border-border-quiet",
          isParentColumn && isLastSibling ? "top-0 h-1/2" : "inset-y-0",
        )}
        style={{ left: depth * indentPx + indentPx / 2 - 1 }}
      />,
    );
  }

  const rowClassName =
    "group/row relative flex h-7 w-full items-center gap-1.5 rounded-md pr-2 transition-colors outline-hidden hover:bg-sidebar-accent/60 focus-within:z-10 has-[:focus-visible]:ring-1.5 has-[:focus-visible]:ring-sidebar-ring data-[active=true]:bg-sidebar-accent data-[cut=true]:opacity-50 data-[dragging=true]:opacity-0 data-[drop-target=true]:bg-sidebar-accent";

  if (isFolder) {
    return (
      <div
        data-active={isActive ? "true" : undefined}
        data-cut={isCut ? "true" : undefined}
        data-dragging={isDragging ? "true" : undefined}
        data-drop-target={isDropTarget ? "true" : undefined}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        className={rowClassName}
      >
        <button
          {...item.getProps()}
          type="button"
          title={label}
          style={{ paddingLeft: `${level * indentPx}px` }}
          className="relative flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-sm outline-hidden group-data-[active=true]/row:font-medium"
        >
          {level > 0 && (
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0">
              {guides}
              <span
                className="absolute top-1/2 border-t border-border-quiet"
                style={{
                  left: (level - 1) * indentPx + indentPx / 2 - 1,
                  width: indentPx - 6,
                }}
              />
            </span>
          )}
          <span
            aria-hidden
          className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground"
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
          />
        </span>
        <span className="truncate text-sidebar-foreground/90 transition-colors group-hover/row:text-sidebar-foreground group-data-[active=true]/row:text-sidebar-foreground">{label}</span>
        </button>
        {onMenuClick ? (
          <button
            type="button"
            aria-label={`Actions for ${label}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onMenuClick(event);
            }}
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:block group-hover/row:block group-focus-within/row:block"
          >
            <MoreHorizontalIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-active={isActive ? "true" : undefined}
      data-dirty={isDirty ? "true" : undefined}
      data-cut={isCut ? "true" : undefined}
      data-dragging={isDragging ? "true" : undefined}
      data-drop-target={isDropTarget ? "true" : undefined}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      className="group/row relative flex h-7 w-full items-center gap-1.5 rounded-md pr-2 outline-hidden focus-within:z-10 has-[:focus-visible]:ring-1.5 has-[:focus-visible]:ring-sidebar-ring data-[cut=true]:opacity-50 data-[dragging=true]:opacity-0 data-[drop-target=true]:bg-sidebar-accent"
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 rounded-md transition-colors",
          isActive ? "bg-sidebar-accent" : "group-hover/row:bg-sidebar-accent/60",
        )}
        style={{ left: level > 0 ? `calc(${(level - 1) * indentPx}px + 1.375rem)` : 0 }}
      />
      <button
        {...item.getProps()}
        type="button"
        title={label}
        style={{ paddingLeft: `${level * indentPx}px` }}
        className="relative flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-sm outline-hidden group-data-[active=true]/row:font-medium"
      >
        {level > 0 && (
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0">
              {guides}
              <span
                className="absolute top-1/2 border-t border-border-quiet"
                style={{
                  left: (level - 1) * indentPx + indentPx / 2 - 1,
                  width: indentPx - 6,
                }}
              />
            </span>
          )}
          <span
            aria-hidden
            className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground"
          />
        <span className="relative min-w-0 flex-1 truncate text-sidebar-foreground/90 transition-colors group-hover/row:text-sidebar-foreground group-data-[active=true]/row:text-sidebar-foreground">
          {label}
        </span>
      </button>
      {timeLabel || onMenuClick || isDirty ? (
        <div className="relative grid shrink-0 items-center justify-items-end">
          {timeLabel && !isDirty ? (
            <span
              data-testid="tree-row-time"
              className={cn(
                "col-start-1 row-start-1 font-mono text-[10.5px] text-muted-foreground/80",
                onMenuClick &&
                  "group-hover/row:invisible group-focus-within/row:invisible",
              )}
            >
              {timeLabel}
            </span>
          ) : null}

          {isDirty ? (
            <>
              <span
                aria-hidden
                className={cn(
                  "col-start-1 row-start-1 flex size-[18px] items-center justify-center",
                  onMenuClick &&
                    "group-hover/row:invisible group-focus-within/row:invisible",
                )}
              >
                <span className="size-1.5 rounded-full bg-primary" />
              </span>
              <span className="sr-only">(unsaved changes)</span>
            </>
          ) : null}

          {onMenuClick ? (
            <button
              type="button"
              aria-label={`Actions for ${label}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onMenuClick(event);
              }}
              className="pointer-events-none col-start-1 row-start-1 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100"
            >
              <MoreHorizontalIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
