export type SidebarDropHit = {
  parentId: string | null;
  rowId: string | null;
};

export type SidebarDropSurface = {
  hitTest: (clientX: number, clientY: number) => SidebarDropHit | null;
  hover: (hit: SidebarDropHit | null) => void;
  reveal: (parentId: string | null) => void;
};

let registered: SidebarDropSurface | null = null;

export const registerSidebarDropSurface = (surface: SidebarDropSurface | null) => {
  registered = surface;
};

export const getSidebarDropSurface = () => registered;
