import {
  CommandPalette,
  DEFAULT_CATEGORIES,
  type CommandPaletteItem,
} from "@excalidraw/excalidraw";
import { formatForDisplay } from "@tanstack/react-hotkeys";
import { SearchIcon } from "lucide-react";
import { createElement, useCallback, useMemo, useState } from "react";

import { CommandDeleteDialog, CommandRenameDialog } from "@/components/command-dialogs";
import { useSidebar } from "@/components/ui/sidebar";
import { buildCommands, type CommandDef, type CommandRenderState } from "@/lib/commands";
import { sessionOwner } from "@/lib/session-owner";
import { useStore } from "@/lib/store";

type PaletteItemState = CommandRenderState & {
  conflictActive: boolean;
};

const browseDrawingsCommand: CommandDef = {
  id: "browse-drawings",
  title: "Browse drawings",
  icon: SearchIcon,
  group: "view",
  keywords: ["search", "find", "open"],
  perform: (ctx) => {
    ctx.store.setSearchOpen(true);
  },
};

const buildPaletteItems = (commands: CommandDef[], state: PaletteItemState): CommandPaletteItem[] =>
  [...commands, browseDrawingsCommand].map((command) => ({
    label: `${command.title}${command.titleSuffix?.(state) ?? ""}`,
    shortcut: command.shortcut
      ? formatForDisplay(command.shortcut, { separatorToken: "+" })
      : undefined,
    keywords: command.keywords,
    icon: createElement(command.icon, { size: 16 }),
    category: DEFAULT_CATEGORIES.app,
    predicate: () =>
      !(state.conflictActive && command.gatedOnConflict) && command.enabled?.(state) !== false,
    perform: () => {
      void (async () => {
        try {
          await command.perform({
            store: useStore.getState(),
            session: sessionOwner.getSession(),
          });
        } catch (error) {
          console.error(`Palette command "${command.id}" failed:`, error);
        }
      })();
    },
  }));

export const EditorCommandPalette = () => {
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const settingsDialogOpen = useStore((s) => s.settingsDialogOpen);
  const setSettingsDialogOpen = useStore((s) => s.setSettingsDialogOpen);
  const searchOpen = useStore((s) => s.searchOpen);
  const externalConflict = useStore((s) => s.externalConflict);
  const entries = useStore((s) => s.entries);
  const openFileId = useStore((s) => s.openFileId);
  const theme = useStore((s) => s.settings.theme);
  const drawings = useStore((s) => s.drawings);
  const isLoadingDrawings = useStore((s) => s.isLoadingDrawings);
  const { toggleSidebar } = useSidebar();

  const openSettings = useCallback(() => {
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen]);

  const openRenameDialog = useCallback(() => {
    setRenameOpen(true);
  }, []);

  const openDeleteDialog = useCallback(() => {
    setDeleteOpen(true);
  }, []);

  const commands = useMemo(
    () =>
      buildCommands({
        openSettings,
        openRenameDialog,
        openDeleteDialog,
        toggleSidebar,
      }),
    [openSettings, openRenameDialog, openDeleteDialog, toggleSidebar],
  );

  const items = useMemo(
    () =>
      buildPaletteItems(commands, {
        openFileId,
        theme,
        conflictActive: externalConflict !== null,
      }),
    [commands, openFileId, theme, externalConflict],
  );

  const folderMissing = drawings?.missing === true && entries.length === 0 && !isLoadingDrawings;
  const blocked = settingsDialogOpen || searchOpen || renameOpen || deleteOpen || folderMissing;

  return (
    <>
      {!blocked && <CommandPalette customCommandPaletteItems={items} />}
      <CommandRenameDialog
        key={`${renameOpen}-${openFileId ?? "none"}`}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <CommandDeleteDialog open={deleteOpen} onOpenChange={setDeleteOpen} />
    </>
  );
};
