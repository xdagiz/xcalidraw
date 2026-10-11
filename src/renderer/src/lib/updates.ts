import type { UpdateStatus } from "@shared/ipc";
import { create } from "zustand";

type UpdatesState = {
  status: UpdateStatus;
  applyStatus: (status: UpdateStatus) => void;
};

export const useUpdatesStore = create<UpdatesState>((set) => ({
  status: { state: "idle" },
  applyStatus: (status) => set({ status }),
}));

export const subscribeToUpdateStatus = (onStatus: (status: UpdateStatus) => void) => {
  let received = false;
  let cancelled = false;

  const unsubscribe = window.api.updates.onStatus((status) => {
    received = true;
    onStatus(status);
  });

  window.api.updates
    .getStatus()
    .then((status) => {
      if (cancelled || received) return;
      onStatus(status);
    })
    .catch((error) => console.error("failed to read update status", error));

  return () => {
    cancelled = true;
    unsubscribe();
  };
};
