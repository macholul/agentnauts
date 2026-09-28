import { useEffect, useRef, type ComponentRef } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Spherical, Vector3, type PerspectiveCamera } from 'three';
import { CAMERA } from '../world/config';

/** Horizontal extent (world units) that should always fit on screen. */
const FIT_WIDTH = 34;

/** Camera distance needed to fit FIT_WIDTH horizontally at this aspect. */
function fitDistance(aspect: number, fovDeg: number): number {
  const halfV = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  return FIT_WIDTH / 2 / Math.tan(halfH);
}

/**
 * Fixed isometric-ish view with a little freedom: small orbit range, clamped
 * zoom, no panning. On narrow screens the camera backs off to keep the whole
 * base area visible.
 */
export function CameraRig() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);

  const fit = fitDistance(aspect, CAMERA.fov);
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

  return (
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
  );
}
