/** Overlays tell the camera how much of the screen they cover. */
import { useLayoutEffect, type RefObject } from 'react';
import { setCover } from '../scene/viewInsets';

export interface CoverOptions {
  /** On wide screens: docked on the left (the world moves right of it), or anywhere else (the camera ignores it). */
  dock: 'left' | 'none';
  /** At this width and below, the overlay is a sheet along the bottom (as in its CSS). */
  sheetWidth: number;
  /** Covers nothing while false (e.g. folded away). */
  active?: boolean;
}

export function useCoveredSpace(id: string, element: RefObject<HTMLElement | null>, { dock, sheetWidth, active = true }: CoverOptions): void {
  useLayoutEffect(() => {
    const node = element.current;
    if (!active || !node) return;
    const sheet = window.matchMedia(`(max-width: ${sheetWidth}px)`);
    const update = () => {
      const rect = node.getBoundingClientRect();
      if (sheet.matches) setCover(id, { left: 0, bottom: Math.max(0, window.innerHeight - rect.top) });
      else setCover(id, dock === 'left' ? { left: rect.right + 16, bottom: 0 } : null);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    window.addEventListener('resize', update);
    sheet.addEventListener('change', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      sheet.removeEventListener('change', update);
      setCover(id, null);
    };
  }, [id, element, dock, sheetWidth, active]);
}
