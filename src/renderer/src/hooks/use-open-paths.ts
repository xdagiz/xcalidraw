import { useEffect } from "react";

import { toast } from "@/components/ui/toast";
import { useStore } from "@/lib/store";

export const useOpenPaths = () => {
  useEffect(() => {
    const off = window.api.app.onOpenPaths(({ outcomes }) => {
      for (const outcome of outcomes) {
        if (outcome.status === "error") {
          toast.add({
            id: `open-path-error:${outcome.name}`,
            title: `Couldn’t open “${outcome.name}”`,
            description: outcome.message,
            type: "error",
          });
        }
      }
      const opened = outcomes.find((outcome) => outcome.status === "open");
      if (opened?.status === "open") void useStore.getState().setOpenFileId(opened.id);
    });
    void window.api.app.flushOpenPaths().catch(() => undefined);
    return off;
  }, []);
};
