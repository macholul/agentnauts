/**
 * Screen space taken by the guide card, in pixels from the left and bottom
 * edges. The camera frames the world in what is left (see CameraRig).
 */
import { create } from 'zustand';

export interface ViewInsets {
  left: number;
  bottom: number;
}

export const useViewInsets = create<ViewInsets>()(() => ({ left: 0, bottom: 0 }));
