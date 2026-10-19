import { describe, expect, it, vi } from "vite-plus/test";

import { createSceneSwitchController } from "./scene-switching";

const deferred = <T>() => {
  const resolvers: {
    resolve?: (value: T) => void;
    reject?: (error: unknown) => void;
  } = {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvers.resolve = resolve;
    resolvers.reject = reject;
  });
  return {
    promise,
    resolve: (value: T) => resolvers.resolve?.(value),
    reject: (error: unknown) => resolvers.reject?.(error),
  };
};

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("createSceneSwitchController", () => {
  it("only applies the latest completed scene request", async () => {
    const controller = createSceneSwitchController();
    const first = deferred<string>();
    const second = deferred<string>();
    const apply = vi.fn();
    const fail = vi.fn();

    controller.start(() => first.promise, apply, fail);
    controller.start(() => second.promise, apply, fail);

    second.resolve("second");
    await flushPromises();
    first.resolve("first");
    await flushPromises();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("second", expect.any(Function));
    expect(fail).not.toHaveBeenCalled();
  });

  it("ignores completion after cancellation or invalidation", async () => {
    const controller = createSceneSwitchController();
    const cancelled = deferred<string>();
    const invalidated = deferred<string>();
    const apply = vi.fn();
    const fail = vi.fn();
    const cancel = controller.start(() => cancelled.promise, apply, fail);

    cancel();
    controller.start(() => invalidated.promise, apply, fail);
    controller.invalidate();

    cancelled.resolve("cancelled");
    invalidated.reject(new Error("stale"));
    await flushPromises();

    expect(apply).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("lets asynchronous application stop when a newer request takes over", async () => {
    const controller = createSceneSwitchController();
    const application = deferred<void>();
    const gate: { resolve?: () => void } = {};
    const started = new Promise<void>((resolve) => {
      gate.resolve = resolve;
    });
    const apply = vi.fn(async (_scene: string, isCurrent: () => boolean) => {
      gate.resolve?.();
      await application.promise;
      if (isCurrent()) return;
      throw new Error("stale application");
    });
    const fail = vi.fn();

    controller.start(async () => "scene", apply, fail);
    await started;
    controller.invalidate();
    application.resolve(undefined);
    await flushPromises();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
  });
});
