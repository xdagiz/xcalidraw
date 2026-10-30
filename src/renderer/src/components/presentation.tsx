import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToCanvas,
  getCommonBounds,
  hashElementsVersion,
  newElementWith,
} from "@excalidraw/excalidraw";
import type { ExcalidrawFrameElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  PlayIcon,
  Maximize2Icon,
  Minimize2Icon,
  MoonIcon,
  PlusIcon,
  SunIcon,
  WandIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";
import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  applyStep,
  nextSlidePosition,
  slideName,
  slideRect,
  slidesOf,
  stepForKey,
} from "@/lib/presentation";
import { useStore } from "@/lib/store";

export const PRESENTATION_TAB = "presentation";
const THUMBNAIL_SIZE = 320;
const THUMBNAIL_DELAY_MS = 400;

// ponytail: re-renders every thumbnail after each edit; render only changed slides if decks get big.
const useSlides = (api: ExcalidrawImperativeAPI) => {
  const [slides, setSlides] = useState(() => slidesOf(api.getSceneElements()));
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let version = -1;

    const refresh = async () => {
      const elements = api.getSceneElements();
      const frames = slidesOf(elements);
      setSlides(frames);
      const appState = api.getAppState();
      const rendered = await Promise.all(
        frames.map(async (frame) => {
          const canvas = await exportToCanvas({
            elements,
            files: api.getFiles(),
            exportingFrame: frame,
            maxWidthOrHeight: THUMBNAIL_SIZE,
            appState: {
              exportBackground: true,
              viewBackgroundColor: appState.viewBackgroundColor,
              exportWithDarkMode: appState.theme === "dark",
            },
          });
          return [frame.id, canvas.toDataURL()] as const;
        }),
      );
      if (!cancelled) setThumbnails(Object.fromEntries(rendered));
    };

    const unsubscribe = api.onChange((elements) => {
      const next = hashElementsVersion(elements);
      if (next === version) return;
      version = next;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), THUMBNAIL_DELAY_MS);
    });
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [api]);

  return { slides, thumbnails };
};

const showSlide = (api: ExcalidrawImperativeAPI, slide: ExcalidrawFrameElement) =>
  api.scrollToContent(slide, { fitToViewport: true, viewportZoomFactor: 0.9, animate: true });

export function PresentationPanel({
  api,
  onStart,
}: {
  api: ExcalidrawImperativeAPI;
  onStart: () => void;
}) {
  const { slides, thumbnails } = useSlides(api);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const goTo = (slide: ExcalidrawFrameElement) => {
    setSelectedId(slide.id);
    showSlide(api, slide);
  };

  // "remove" drops the frame but keeps its content; "delete" drops both.
  const dropSlide = (id: string, mode: "remove" | "delete") => {
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((element) => {
        if (element.id === id) return newElementWith(element, { isDeleted: true });
        if (element.frameId !== id) return element;
        return mode === "delete"
          ? newElementWith(element, { isDeleted: true })
          : newElementWith(element, { frameId: null });
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  const openSlideMenu = async (event: React.MouseEvent, slide: ExcalidrawFrameElement) => {
    event.preventDefault();
    const action = await window.api.contextMenu.show(
      [
        { id: "rename", label: "Rename" },
        { id: "remove", label: "Remove slide (keep content)" },
        { id: "delete", label: "Delete slide" },
      ],
      event.clientX,
      event.clientY,
    );
    if (action === "rename") setEditingId(slide.id);
    if (action === "remove" || action === "delete") dropSlide(slide.id, action);
  };

  const renameSlide = (id: string, name: string) => {
    api.updateScene({
      elements: api
        .getSceneElementsIncludingDeleted()
        .map((element) =>
          element.id === id && element.type === "frame"
            ? newElementWith(element, { name: name.trim() || null })
            : element,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  const createSlide = () => {
    const elements = api.getSceneElements();
    const current = slidesOf(elements);
    const position = nextSlidePosition(
      current,
      elements.length > 0 ? getCommonBounds(elements) : null,
    );
    const [slide] = convertToExcalidrawElements([
      {
        type: "frame",
        children: [],
        name: `Slide ${current.length + 1}`,
        ...position,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
      },
    ]);
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), slide],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    setSelectedId(slide.id);
    api.scrollToContent(slide, { fitToViewport: true, viewportZoomFactor: 0.9, animate: true });
  };

  // Styled with Excalidraw's own tokens so the tab matches the library tab next to it.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 pb-3">
        <h2 className="text-lg font-bold text-(--color-primary)">Presentation</h2>
        <button
          type="button"
          onClick={createSlide}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-(--color-surface-mid)"
        >
          <PlusIcon size={16} />
          Create slide
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
        {slides.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm opacity-60">
            Each frame is a slide. Create one, then draw inside it.
          </p>
        ) : (
          slides.map((slide, index) => (
            <div
              key={slide.id}
              onContextMenu={(event) => void openSlideMenu(event, slide)}
              className={`shrink-0 overflow-hidden rounded-lg border hover:border-(--color-primary) ${
                selectedId === slide.id
                  ? "border-(--color-primary) ring-1 ring-(--color-primary)"
                  : "border-(--default-border-color)"
              }`}
            >
              <button
                type="button"
                aria-label={`Go to ${slideName(slide, index)}`}
                onClick={() => goTo(slide)}
                className="flex aspect-video w-full items-center justify-center bg-white outline-none"
              >
                {thumbnails[slide.id] && (
                  <img src={thumbnails[slide.id]} alt="" className="size-full object-contain" />
                )}
              </button>
              {editingId === slide.id ? (
                <input
                  ref={(input) => input?.select()}
                  defaultValue={slideName(slide, index)}
                  aria-label="Slide name"
                  onBlur={(event) => {
                    renameSlide(slide.id, event.currentTarget.value);
                    setEditingId(null);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") setEditingId(null);
                  }}
                  className="w-full bg-(--color-surface-low) px-3 py-2 text-sm outline-none"
                />
              ) : (
                <button
                  type="button"
                  title="Double-click to rename"
                  onClick={() => goTo(slide)}
                  onDoubleClick={() => setEditingId(slide.id)}
                  className="block w-full truncate bg-(--color-surface-low) px-3 py-2 text-left text-sm outline-none"
                >
                  {slideName(slide, index)}
                </button>
              )}
            </div>
          ))
        )}
      </div>
      <div className="shrink-0 px-3 pt-1">
        <button
          type="button"
          onClick={onStart}
          disabled={slides.length === 0}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-(--color-primary) text-sm font-medium text-white hover:bg-(--color-primary-darker) disabled:opacity-50"
        >
          <PlayIcon size={16} />
          Start presentation
        </button>
      </div>
    </div>
  );
}

type SavedView = Pick<
  AppState,
  "zenModeEnabled" | "frameRendering" | "openSidebar" | "scrollX" | "scrollY" | "zoom"
>;

const BAR_IDLE_MS = 2500;

export function Presenter({
  api,
  containerRef,
  onExit,
}: {
  api: ExcalidrawImperativeAPI;
  containerRef: RefObject<HTMLElement | null>;
  onExit: () => void;
}) {
  const [slides] = useState(() => slidesOf(api.getSceneElements()));
  const [index, setIndex] = useState(0);
  const [laser, setLaser] = useState(false);
  const [view, setView] = useState(() => {
    const { scrollX, scrollY, zoom } = api.getAppState();
    return { scrollX, scrollY, zoom: zoom.value };
  });
  const theme = useTheme();
  const slide = slides[index];
  const [fullscreen, setFullscreen] = useState(false);
  const [barHidden, setBarHidden] = useState(false);
  const [idle, setIdle] = useState(false);
  const leftFullscreenAt = useRef(0);
  const overBar = useRef(false);

  // No UI, frames clipped; everything goes back on exit.
  useEffect(() => {
    const { zenModeEnabled, frameRendering, openSidebar, scrollX, scrollY, zoom } =
      api.getAppState();
    const saved: SavedView = {
      zenModeEnabled,
      frameRendering,
      openSidebar,
      scrollX,
      scrollY,
      zoom,
    };
    // Not view mode: there every click pans, so the laser can't draw.
    api.updateScene({
      appState: {
        zenModeEnabled: true,
        openSidebar: null,
        frameRendering: { enabled: true, clip: true, name: false, outline: false },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    api.setActiveTool({ type: "hand" });
    const handleFullscreen = () => {
      setFullscreen(Boolean(document.fullscreenElement));
      if (!document.fullscreenElement) leftFullscreenAt.current = Date.now();
    };
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreen);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      api.updateScene({ appState: saved, captureUpdate: CaptureUpdateAction.NEVER });
      api.setActiveTool({ type: "selection" });
    };
  }, [api]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void containerRef.current?.requestFullscreen().catch(() => undefined);
  }, [containerRef]);

  // Double-click a slide (say after zooming out) to jump to it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const handleDoubleClick = (event: MouseEvent) => {
      const { scrollX, scrollY, zoom } = api.getAppState();
      const bounds = container.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / zoom.value - scrollX;
      const y = (event.clientY - bounds.top) / zoom.value - scrollY;
      const hit = slides.findIndex(
        (candidate) =>
          x >= candidate.x &&
          x <= candidate.x + candidate.width &&
          y >= candidate.y &&
          y <= candidate.y + candidate.height,
      );
      if (hit === -1) return;
      setIndex(hit);
      api.scrollToContent(slides[hit], {
        fitToViewport: true,
        viewportZoomFactor: 1,
        animate: true,
      });
    };
    container.addEventListener("dblclick", handleDoubleClick);
    return () => container.removeEventListener("dblclick", handleDoubleClick);
  }, [api, containerRef, slides]);

  // The bar fades out when the mouse rests, so it stays off projectors and recordings.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!overBar.current) setIdle(true);
      }, BAR_IDLE_MS);
    };
    wake();
    window.addEventListener("pointermove", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
    };
  }, []);

  const fit = useCallback(
    (animate: boolean) => {
      if (slide)
        api.scrollToContent(slide, { fitToViewport: true, viewportZoomFactor: 1, animate });
    },
    [api, slide],
  );

  useEffect(() => {
    fit(true);
    const handleResize = () =>
      requestAnimationFrame(() => {
        api.refresh();
        fit(false);
      });
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [api, fit]);

  useEffect(
    () =>
      api.onScrollChange((scrollX, scrollY, zoom) =>
        setView({ scrollX, scrollY, zoom: zoom.value }),
      ),
    [api],
  );

  useEffect(() => {
    // Swallow every key so Excalidraw's shortcuts can't switch tools or edit mid-talk.
    const handleKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "h" || event.key === "H") setBarHidden((hidden) => !hidden);
      if (event.key === "f" || event.key === "F") toggleFullscreen();
      const step = stepForKey(event.key);
      if (!step) return;
      event.preventDefault();
      if (step !== "exit") setIndex((current) => applyStep(current, step, slides.length));
      // Esc leaves fullscreen first; the browser may already have done that for this press.
      else if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else if (Date.now() - leftFullscreenAt.current > 300) onExit();
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onExit, slides.length, toggleFullscreen]);

  const showBar = !barHidden && !idle;

  const toggleLaser = () => {
    api.setActiveTool({ type: laser ? "hand" : "laser" });
    setLaser(!laser);
  };

  const toggleTheme = () =>
    void useStore.getState().updateSettings({ theme: theme === "dark" ? "light" : "dark" });

  // The canvas stays live underneath, so the laser pointer works while presenting.
  return (
    <div className="presenting pointer-events-none absolute inset-0 z-50 overflow-hidden">
      {/* Fade everything around the current slide, like Excalidraw+. */}
      {slide && (
        <div
          className={`absolute ${
            theme === "dark"
              ? "shadow-[0_0_0_200vmax_rgb(18_18_18/0.75)]"
              : "shadow-[0_0_0_200vmax_rgb(255_255_255/0.75)]"
          }`}
          style={slideRect(slide, view)}
        />
      )}
      <div
        className={`absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-4 transition-opacity duration-300 ${
          showBar ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <div
          onPointerEnter={() => {
            overBar.current = true;
          }}
          onPointerLeave={() => {
            overBar.current = false;
          }}
          className={`bg-background flex items-center gap-1 rounded-xl border p-1.5 shadow-md ${
            showBar ? "pointer-events-auto" : ""
          }`}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous slide"
            disabled={index === 0}
            onClick={() => setIndex((current) => applyStep(current, "previous", slides.length))}
          >
            <ArrowLeftIcon />
          </Button>
          <span className="min-w-20 text-center text-sm tabular-nums">
            Slide {index + 1}/{slides.length}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next slide"
            disabled={index === slides.length - 1}
            onClick={() => setIndex((current) => applyStep(current, "next", slides.length))}
          >
            <ArrowRightIcon />
          </Button>
          <div className="bg-border mx-1 h-5 w-px" />
          <Button
            variant={laser ? "secondary" : "ghost"}
            size="icon-sm"
            title="Laser pointer"
            aria-pressed={laser}
            onClick={toggleLaser}
          >
            <WandIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title={theme === "dark" ? "Light mode" : "Dark mode"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize2Icon /> : <Maximize2Icon />}
          </Button>
          <button
            type="button"
            onClick={onExit}
            className="ml-1 flex h-8 items-center gap-2 rounded-lg bg-[#ffe3e3] px-3 text-sm font-medium text-[#c92a2a] hover:bg-[#ffc9c9] dark:bg-[#c92a2a]/25 dark:text-[#ffa8a8]"
          >
            <span className="size-3.5 rounded-[3px] bg-current" />
            End presentation
          </button>
        </div>
      </div>
    </div>
  );
}
