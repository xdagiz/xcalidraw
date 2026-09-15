import { formatForDisplay } from "@tanstack/react-hotkeys";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

import { CommandDeleteDialog, CommandRenameDialog } from "@/components/command-dialogs";
import { DrawingRowItem } from "@/components/drawing-search";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useSidebar } from "@/components/ui/sidebar";
import { useListBottomFade } from "@/hooks/use-list-bottom-fade";
import { buildCommands, type CommandDef } from "@/lib/commands";
import { buildDrawingSearchEntries, rankDrawingHits, type DrawingRow } from "@/lib/drawing-search";
import { rankEntries } from "@/lib/fuzzy-rank";
import { sessionOwner } from "@/lib/session-owner";
import { useStore } from "@/lib/store";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const MAX_HITS_PER_SOURCE = 8;

type CommandRow = {
  id: string;
  command: CommandDef;
  suffix: string;
};

const CommandRowItem = memo(function CommandRowItem({
  row,
  onRun,
}: {
  row: CommandRow;
  onRun: (command: CommandDef) => void;
}) {
  const { command } = row;
  return (
    <CommandItem
      value={`command:${command.id}`}
      onClick={() => {
        onRun(command);
      }}
    >
      <command.icon className="text-muted-foreground" />
      <span className="min-w-0 truncate">
        {command.title}
        {row.suffix}
      </span>
      {command.shortcut && (
        <CommandShortcut>
          <KbdGroup>
            {formatForDisplay(command.shortcut, { separatorToken: "+" })
              .split("+")
              .map((token) => (
                <Kbd key={token}>{token}</Kbd>
              ))}
          </KbdGroup>
        </CommandShortcut>
      )}
    </CommandItem>
  );
});

export const CommandPalette = ({ open, onOpenChange }: Props) => {
  const [query, setQuery] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const settingsDialogOpen = useStore((s) => s.settingsDialogOpen);
  const setSettingsDialogOpen = useStore((s) => s.setSettingsDialogOpen);
  const externalConflict = useStore((s) => s.externalConflict);
  const entries = useStore((s) => s.entries);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const openFileId = useStore((s) => s.openFileId);
  const themeForCommands = useStore((s) => s.settings.theme);
  const { toggleSidebar } = useSidebar();
  const { listRef, bottomFade, updateBottomFade } = useListBottomFade(open);

  useEffect(() => {
    if (open && settingsDialogOpen) setSettingsDialogOpen(false);
  }, [open, settingsDialogOpen, setSettingsDialogOpen]);

  const handlePaletteOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setQuery("");
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const commands = useMemo(
    () =>
      buildCommands({
        openSettings: () => setSettingsDialogOpen(true),
        openRenameDialog: () => setRenameOpen(true),
        openDeleteDialog: () => setDeleteOpen(true),
        toggleSidebar,
      }),
    [setSettingsDialogOpen, toggleSidebar],
  );

  const conflictActive = externalConflict !== null;
  const conflictFileId = externalConflict?.fileId ?? null;
  const deferredQuery = useDeferredValue(query);
  const trimmedQuery = deferredQuery.trim();

  const drawingSearchEntries = useMemo(() => buildDrawingSearchEntries(entries), [entries]);

  const renderState = useMemo(
    () => ({ openFileId, theme: themeForCommands }),
    [openFileId, themeForCommands],
  );

  const visibleCommands = useMemo(
    () =>
      commands.filter(
        (command) =>
          !(conflictActive && command.gatedOnConflict) && command.enabled?.(renderState) !== false,
      ),
    [commands, conflictActive, renderState],
  );

  const commandHits = useMemo<CommandRow[]>(() => {
    const hits =
      trimmedQuery.length === 0
        ? visibleCommands
        : rankEntries(
            trimmedQuery,
            visibleCommands,
            (command) => `${command.title} ${(command.keywords ?? []).join(" ")}`,
            () => 0,
          ).slice(0, MAX_HITS_PER_SOURCE);
    return hits.map((command) => ({
      id: command.id,
      command,
      suffix: command.titleSuffix?.(renderState) ?? "",
    }));
  }, [trimmedQuery, visibleCommands, renderState]);

  const drawingHits = useMemo(
    () =>
      rankDrawingHits({
        query: trimmedQuery,
        entries: drawingSearchEntries,
        conflictActive,
        conflictFileId,
        maxHits: MAX_HITS_PER_SOURCE,
      }),
    [trimmedQuery, drawingSearchEntries, conflictActive, conflictFileId],
  );

  const isEmpty = commandHits.length === 0 && drawingHits.length === 0;

  const runCommand = async (command: CommandDef) => {
    try {
      await command.perform({
        store: useStore.getState(),
        session: sessionOwner.getSession(),
      });
    } finally {
      onOpenChange(false);
    }
  };

  const chooseDrawing = async (fileId: string) => {
    try {
      await setOpenFileId(fileId);
    } finally {
      onOpenChange(false);
    }
  };

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={handlePaletteOpenChange}
        title="Command palette"
        description="Search drawings and commands"
        className="gap-0 sm:max-w-[40rem]"
      >
        <Command value={query} onValueChange={setQuery}>
          <CommandInput placeholder="Search drawings and commands..." />
          {conflictActive && (
            <p className="text-destructive px-4 pt-2 pb-1 text-xs font-medium">
              File commands are limited until the conflict is resolved in its dialog
            </p>
          )}
          <CommandPanel className="h-72 min-h-0">
            {isEmpty ? (
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="text-muted-foreground py-6 text-center text-sm"
              >
                No results found.
              </div>
            ) : (
              <CommandList
                ref={listRef}
                onScroll={updateBottomFade}
                className={`h-full min-h-0 px-1 ${
                  bottomFade
                    ? "[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]"
                    : ""
                }`}
              >
                {commandHits.length > 0 && (
                  <CommandGroup items={commandHits}>
                    <CommandGroupLabel>Actions</CommandGroupLabel>
                    <CommandCollection>
                      {(row: CommandRow) => (
                        <CommandRowItem key={row.id} row={row} onRun={runCommand} />
                      )}
                    </CommandCollection>
                  </CommandGroup>
                )}
                {commandHits.length > 0 && drawingHits.length > 0 && <CommandSeparator />}
                {drawingHits.length > 0 && (
                  <CommandGroup items={drawingHits}>
                    <CommandGroupLabel>Drawings</CommandGroupLabel>
                    <CommandCollection>
                      {(row: DrawingRow) => (
                        <DrawingRowItem key={row.id} row={row} onChoose={chooseDrawing} />
                      )}
                    </CommandCollection>
                  </CommandGroup>
                )}
              </CommandList>
            )}
          </CommandPanel>
          <CommandFooter>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>
                <ArrowUpIcon />
                <ArrowDownIcon />
              </Kbd>
              <span>Navigate</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>⏎</Kbd>
              <span>Select</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <span>Close</span>
            </KbdGroup>
          </CommandFooter>
        </Command>
      </CommandDialog>
      <CommandRenameDialog
        key={`${renameOpen}-${openFileId ?? "none"}`}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <CommandDeleteDialog open={deleteOpen} onOpenChange={setDeleteOpen} />
    </>
  );
};
