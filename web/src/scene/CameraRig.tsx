import { useEffect, useRef, type ComponentRef } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Spherical, Vector3, type PerspectiveCamera } from 'three';
import { CAMERA, PALETTE } from '../world/config';
import { useViewInsets } from './viewInsets';

/** Horizontal extent (world units) that should always fit on screen. */
const FIT_WIDTH = 34;
/** Vertical extent of the base as seen from the camera (world units), for when a card covers the bottom. */
const FIT_HEIGHT = 22;

/** Camera distance needed to fit FIT_WIDTH horizontally at this aspect. */
function fitDistance(aspect: number, fovDeg: number): number {
  const halfV = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  return FIT_WIDTH / 2 / Math.tan(halfH);
}

/** Camera distance at which FIT_HEIGHT takes up `fraction` of the screen's height. */
function fitHeightDistance(fraction: number, fovDeg: number): number {
  const halfV = (fovDeg * Math.PI) / 360;
  return FIT_HEIGHT / 2 / (Math.tan(halfV) * fraction);
}

/**
 * Fixed isometric-ish view with a little freedom: small orbit range, clamped
 * zoom, no panning. On narrow screens the camera backs off to keep the whole
 * base area visible. When the guide card covers part of the screen, the
 * world is framed in the rest.
 */
export function CameraRig() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => Math.max(1, s.size.height));
  const { left, bottom } = useViewInsets();
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);

  const freeWidth = Math.max(1, width - left);
  const freeHeight = Math.max(1, height - bottom);
  const fit = Math.max(
    fitDistance(freeWidth / height, CAMERA.fov),
    bottom > 0 ? fitHeightDistance(freeHeight / height, CAMERA.fov) : 0,
  );
  const distance = Math.max(CAMERA.distance, fit);
  const maxDistance = Math.max(CAMERA.maxDistance, fit * 1.25);

  useEffect(() => {
    const target = new Vector3(...CAMERA.target);
    const offset = new Vector3().setFromSpherical(new Spherical(distance, CAMERA.polar, CAMERA.azimuth));
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
    controls.current?.target.copy(target);
    controls.current?.update();
    // Only re-frame when the required distance changes meaningfully (resize).
  }, [camera, distance]);

  // Shift the picture into the free part of the screen, like a camera lens
  // shift: the view direction (and orbiting) stay the same.
  useEffect(() => {
    if (left > 0 || bottom > 0) camera.setViewOffset(width, height, -left / 2, bottom / 2, width, height);
    else camera.clearViewOffset();
  }, [camera, width, height, left, bottom]);

  return (
    <>
      {/* Haze starts a little behind the base wherever the camera is, so the
          base stays crisp when the camera backs off on narrow screens. */}
      <fog attach="fog" args={[PALETTE.haze, distance + 16, distance + 106]} />
      <OrbitControls
        ref={controls}
        makeDefault
        target={CAMERA.target}
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.45}
        zoomSpeed={0.6}
        minDistance={CAMERA.minDistance}
        maxDistance={maxDistance}
        minPolarAngle={CAMERA.minPolar}
        maxPolarAngle={CAMERA.maxPolar}
        minAzimuthAngle={CAMERA.azimuth - CAMERA.azimuthRange}
        maxAzimuthAngle={CAMERA.azimuth + CAMERA.azimuthRange}
      />
    </>
  );
}
