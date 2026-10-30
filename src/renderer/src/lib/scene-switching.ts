export type SceneSwitchGuard = () => boolean;

export type RetargetedSceneState = {
  apiAvailable: boolean;
  sceneLoading: boolean;
  sceneFailed: boolean;
};

export const shouldKeepRetargetedScene = (state: RetargetedSceneState) =>
  state.apiAvailable && !state.sceneLoading && !state.sceneFailed;

export type SceneSwitchController = {
  start<T>(
    load: () => Promise<T>,
    apply: (scene: T, isCurrent: SceneSwitchGuard) => void | Promise<void>,
    fail: (error: unknown) => void,
  ): () => void;
  invalidate: () => void;
};

export const createSceneSwitchController = (): SceneSwitchController => {
  let generation = 0;

  const invalidate = () => {
    generation += 1;
  };

  return {
    start: (load, apply, fail) => {
      const request = ++generation;
      let active = true;
      const isCurrent = () => active && generation === request;

      void Promise.resolve()
        .then(load)
        .then(
          async (scene) => {
            if (!isCurrent()) return;
            try {
              await apply(scene, isCurrent);
            } catch (error) {
              if (isCurrent()) fail(error);
            }
          },
          (error: unknown) => {
            if (isCurrent()) fail(error);
          },
        );

      return () => {
        active = false;
        if (generation === request) generation += 1;
      };
    },
    invalidate,
  };
};
