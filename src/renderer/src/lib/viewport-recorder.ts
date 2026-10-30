import type { Viewport } from "@shared/viewport";

import type { ViewportCache } from "./viewport-cache";
import type { ViewportPersistence } from "./viewport-persistence";

export const createViewportRecorder =
  (cache: Pick<ViewportCache, "set">, persistence: Pick<ViewportPersistence, "set">) =>
  async (rootPath: string | null, fileId: string, viewport: Viewport): Promise<void> => {
    cache.set(rootPath, fileId, viewport);
    if (rootPath === null) return;
    await persistence.set(rootPath, fileId, viewport);
  };
