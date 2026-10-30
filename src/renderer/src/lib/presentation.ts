import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
} from "@excalidraw/excalidraw/element/types";

export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;
const SLIDE_GAP = 120;

// Slides are the drawing's frames, in canvas order.
export const slidesOf = (elements: readonly ExcalidrawElement[]) =>
  elements.filter(
    (element): element is ExcalidrawFrameElement => element.type === "frame" && !element.isDeleted,
  );

export const slideName = (slide: ExcalidrawFrameElement, index: number) =>
  slide.name?.trim() || `Slide ${index + 1}`;

// New slides go right of the last one, or right of the drawing when there are none.
export const nextSlidePosition = (
  slides: readonly ExcalidrawFrameElement[],
  sceneBounds: readonly [number, number, number, number] | null,
) => {
  const last = slides.at(-1);
  if (last) return { x: last.x + last.width + SLIDE_GAP, y: last.y };
  if (sceneBounds) return { x: sceneBounds[2] + SLIDE_GAP, y: sceneBounds[1] };
  return { x: 0, y: 0 };
};

export const isControlActivationKey = (key: string, hasInteractiveTarget: boolean) =>
  hasInteractiveTarget && (key === "Enter" || key === " ");

export const createPresentationExit = (restore: () => void) => {
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    restore();
  };
};

export const thumbnailRenderKey = (
  elementsVersion: number | string,
  theme: string,
  backgroundColor: string,
) => JSON.stringify([elementsVersion, theme, backgroundColor]);

export type SlideStep = "next" | "previous" | "first" | "last" | "exit";

export const stepForKey = (key: string): SlideStep | null => {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
    case "Enter":
      return "next";
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
    case "Backspace":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Escape":
      return "exit";
    default:
      return null;
  }
};

const STEPS: Record<Exclude<SlideStep, "exit">, (index: number, count: number) => number> = {
  next: (index, count) => Math.min(index + 1, count - 1),
  previous: (index) => Math.max(index - 1, 0),
  first: () => 0,
  last: (_, count) => count - 1,
};

export const applyStep = (index: number, step: Exclude<SlideStep, "exit">, count: number) =>
  STEPS[step](index, count);

// Where a slide sits on screen, relative to the canvas container.
export const slideRect = (
  slide: Pick<ExcalidrawFrameElement, "x" | "y" | "width" | "height">,
  view: { scrollX: number; scrollY: number; zoom: number },
) => ({
  left: (slide.x + view.scrollX) * view.zoom,
  top: (slide.y + view.scrollY) * view.zoom,
  width: slide.width * view.zoom,
  height: slide.height * view.zoom,
});
