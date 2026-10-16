import { useHotkey } from "@tanstack/react-hotkeys";
import { useEffect, useRef, useState } from "react";

import { isCloseHandshakeActive, onCloseHandshakeStart } from "@/lib/close-handshake";
import { selectSwitcherCandidates } from "@/lib/recent-files";
import { useStore } from "@/lib/store";
import { createSwitcherController, type SwitcherState } from "@/lib/switcher-controller";

type UseSwitcherOptions = {
  paletteOpen?: boolean;
};

export const useSwitcher = ({ paletteOpen = false }: UseSwitcherOptions = {}) => {
  const [state, setState] = useState<SwitcherState>({ phase: "idle" });
  const heldKeysRef = useRef<Set<string>>(new Set());
  const detachReleaseRef = useRef<(() => void) | null>(null);
  const [controller] = useState(() =>
    createSwitcherController({
      getCandidates: () =>
        selectSwitcherCandidates(
          useStore.getState().switcherFileIds,
          useStore.getState().entries,
        ).map((entry) => entry.id),
      canSwitchNow: () => {
        if (isCloseHandshakeActive()) return false;
        const { externalConflict, settingsDialogOpen, searchOpen } = useStore.getState();
        return !externalConflict && !settingsDialogOpen && !searchOpen;
      },
      commit: (fileId) => {
        void useStore.getState().setOpenFileId(fileId);
      },
      onChange: setState,
    }),
  );

  useEffect(() => () => controller.cancel(), [controller]);

  useEffect(() => onCloseHandshakeStart(() => controller.cancel()), [controller]);

  const beginReleaseTracking = () => {
    detachReleaseRef.current?.();
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key;
      if (key !== "Control" && key !== "Meta" && key !== "Tab") return;
      heldKeysRef.current.delete(key);
      controller.setAutoCommitBlocked(heldKeysRef.current.size > 0);
      if (heldKeysRef.current.size === 0) {
        detachReleaseRef.current?.();
        detachReleaseRef.current = null;
        controller.commit();
      }
    };
    window.addEventListener("keyup", onKeyUp, true);
    detachReleaseRef.current = () => window.removeEventListener("keyup", onKeyUp, true);
  };

  const cycle = (direction: 1 | -1) => {
    const wasCycling = controller.getState().phase === "cycling";
    controller.start(direction);
    if (!wasCycling && controller.getState().phase === "cycling") {
      heldKeysRef.current = new Set(["Control", "Tab"]);
      controller.setAutoCommitBlocked(true);
      beginReleaseTracking();
    }
  };

  useHotkey("Control+Tab", () => cycle(1), { preventDefault: false, enabled: !paletteOpen });
  useHotkey("Control+Shift+Tab", () => cycle(-1), { preventDefault: false, enabled: !paletteOpen });

  useEffect(() => {
    if (state.phase !== "cycling") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta" || event.key === "Tab") {
        heldKeysRef.current.add(event.key);
        controller.setAutoCommitBlocked(true);
      }
    };

    const onBlur = () => controller.cancel();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      detachReleaseRef.current?.();
      detachReleaseRef.current = null;
      heldKeysRef.current = new Set();
      controller.setAutoCommitBlocked(false);
    };
  }, [state.phase, controller]);

  return {
    state,
    commitAt: (index: number) => controller.commitAt(index),
    cancel: () => controller.cancel(),
  };
};
