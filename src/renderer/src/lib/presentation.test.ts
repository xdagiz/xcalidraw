import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
} from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vite-plus/test";

import { applyStep, nextSlidePosition, slideRect, slidesOf, stepForKey } from "./presentation";

const frame = (id: string, x: number, extra: Partial<ExcalidrawFrameElement> = {}) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the fields read here
  ({ id, type: "frame", x, y: 10, width: 100, height: 50, ...extra }) as ExcalidrawFrameElement;

describe("slides", () => {
  it("are the live frames in canvas order", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a non-frame element
    const box = { id: "box", type: "rectangle" } as ExcalidrawElement;
    const slides = slidesOf([
      frame("b", 0),
      box,
      frame("gone", 0, { isDeleted: true }),
      frame("a", 0),
    ]);
    expect(slides.map((slide) => slide.id)).toEqual(["b", "a"]);
  });

  it("are added right of the last slide, or of the drawing", () => {
    expect(nextSlidePosition([frame("a", 0), frame("b", 300)], null)).toEqual({ x: 520, y: 10 });
    expect(nextSlidePosition([], [-50, -20, 200, 90])).toEqual({ x: 320, y: -20 });
    expect(nextSlidePosition([], null)).toEqual({ x: 0, y: 0 });
  });
});

describe("presenting", () => {
  it("maps keys to steps and stays within the deck", () => {
    expect(stepForKey("ArrowRight")).toBe("next");
    expect(stepForKey(" ")).toBe("next");
    expect(stepForKey("ArrowLeft")).toBe("previous");
    expect(stepForKey("Escape")).toBe("exit");
    expect(stepForKey("a")).toBeNull();
    expect(applyStep(2, "next", 3)).toBe(2);
    expect(applyStep(0, "previous", 3)).toBe(0);
    expect(applyStep(1, "last", 3)).toBe(2);
  });

  it("finds a slide on screen from the viewport", () => {
    expect(slideRect(frame("a", 0), { scrollX: 10, scrollY: -10, zoom: 2 })).toEqual({
      left: 20,
      top: 0,
      width: 200,
      height: 100,
    });
  });
});
