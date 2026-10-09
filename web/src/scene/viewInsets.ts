/**
 * Screen space covered by overlays (the guide card, the panel as a sheet on
 * phones), in pixels from the left and bottom edges. The camera frames the
 * world in what is left (see CameraRig).
 */
import { create } from 'zustand';

export interface ViewInsets {
  left: number;
  bottom: number;
}

export const useViewInsets = create<ViewInsets>()(() => ({ left: 0, bottom: 0 }));

const covers = new Map<string, ViewInsets>();

/** What overlay `id` covers now, or null when it covers nothing. The camera keeps clear of all of them. */
export function setCover(id: string, cover: ViewInsets | null): void {
  if (cover) covers.set(id, cover);
  else covers.delete(id);
  let left = 0;
  let bottom = 0;
  for (const c of covers.values()) {
    left = Math.max(left, c.left);
    bottom = Math.max(bottom, c.bottom);
  }
  const current = useViewInsets.getState();
  if (current.left !== left || current.bottom !== bottom) useViewInsets.setState({ left, bottom });
}
