import { useMemo } from "react";

import { RECENTS_LIMIT, selectRecentFiles, selectSwitcherCandidates } from "@/lib/recent-files";
import { useStore } from "@/lib/store";

export const useRecentDrawings = (limit?: number) => {
  const entries = useStore((s) => s.entries);
  const recentFileIds = useStore((s) => s.recentFileIds);
  const showRecents = useStore((s) => s.settings.showRecents);

  const recentFiles = useMemo(
    () =>
      showRecents ? selectRecentFiles(recentFileIds, entries).slice(0, limit ?? RECENTS_LIMIT) : [],
    [showRecents, recentFileIds, entries, limit],
  );

  const totalDrawings = useMemo(
    () => entries.filter((entry) => entry.kind === "file").length,
    [entries],
  );

  return { recentFiles, totalDrawings };
};

export const useSwitcherCandidates = () => {
  const entries = useStore((s) => s.entries);
  const switcherFileIds = useStore((s) => s.switcherFileIds);

  return useMemo(
    () => selectSwitcherCandidates(switcherFileIds, entries),
    [switcherFileIds, entries],
  );
};
