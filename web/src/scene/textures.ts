/**
 * Small procedural textures drawn on a canvas at startup: stylized, soft and
 * painterly (no photos, no hard detail). Multiplied over vertex/material
 * colors, so they add texture without changing the palette.
 */
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas not available');
  return [canvas, ctx];
}

/** Deterministic random so textures look the same every load. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Draw a soft round blob, repeated across the edges so the texture tiles. */
function softBlob(ctx: CanvasRenderingContext2D, size: number, x: number, y: number, r: number, color: string, alpha: number) {
  for (const dx of [-size, 0, size]) {
    for (const dy of [-size, 0, size]) {
      const cx = x + dx;
      const cy = y + dy;
      if (cx + r < 0 || cy + r < 0 || cx - r > size || cy - r > size) continue;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, color.replace('A', String(alpha)));
      g.addColorStop(1, color.replace('A', '0'));
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
  }
}

function finish(canvas: HTMLCanvasElement, repeat: boolean): Texture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  if (repeat) texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

let ground: Texture | null = null;

/**
 * Ground: soft mottled patches (lighter sand, rosy/lavender shade) plus fine
 * rounded speckles, like a painted toy terrain.
 */
export function groundTexture(): Texture {
  if (ground) return ground;
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const rand = seeded(11);
  ctx.fillStyle = 'rgb(236,232,236)';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 40; i++) {
    softBlob(ctx, size, rand() * size, rand() * size, 40 + rand() * 90, 'rgba(255,250,244,A)', 0.55);
  }
  for (let i = 0; i < 34; i++) {
    softBlob(ctx, size, rand() * size, rand() * size, 30 + rand() * 70, 'rgba(196,160,190,A)', 0.28);
  }
  // Pebbly speckles: small soft dots, some light, some shaded.
  for (let i = 0; i < 900; i++) {
    const light = rand() < 0.45;
    softBlob(
      ctx,
      size,
      rand() * size,
      rand() * size,
      1.5 + rand() * 3.5,
      light ? 'rgba(255,252,248,A)' : 'rgba(170,130,165,A)',
      light ? 0.7 : 0.35,
    );
  }
  ground = finish(canvas, true);
  return ground;
}

let panel: Texture | null = null;

/** Machine panels: soft seams, a highlight bevel and little rivets in the corners. */
export function panelTexture(): Texture {
  if (panel) return panel;
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  // Gentle top-to-bottom shading.
  const shade = ctx.createLinearGradient(0, 0, 0, size);
  shade.addColorStop(0, 'rgba(255,255,255,0)');
  shade.addColorStop(1, 'rgba(210,195,215,0.25)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, size, size);
  // Inset panel outline with a soft highlight just inside.
  const inset = 22;
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(190,172,200,0.55)';
  ctx.beginPath();
  ctx.roundRect(inset, inset, size - inset * 2, size - inset * 2, 26);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.roundRect(inset + 4, inset + 4, size - (inset + 4) * 2, size - (inset + 4) * 2, 22);
  ctx.stroke();
  // Rivets.
  for (const [x, y] of [
    [inset - 8, inset - 8],
    [size - inset + 8, inset - 8],
    [inset - 8, size - inset + 8],
    [size - inset + 8, size - inset + 8],
  ] as const) {
    const g = ctx.createRadialGradient(x - 1.5, y - 1.5, 0, x, y, 6);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.6, 'rgba(200,185,210,0.9)');
    g.addColorStop(1, 'rgba(200,185,210,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 7, y - 7, 14, 14);
  }
  panel = finish(canvas, false);
  return panel;
}

let blob: Texture | null = null;

/** Soft round contact shadow for characters. */
export function blobShadowTexture(): Texture {
  if (blob) return blob;
  const size = 128;
  const [canvas, ctx] = makeCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(90,60,120,0.55)');
  g.addColorStop(0.55, 'rgba(90,60,120,0.25)');
  g.addColorStop(1, 'rgba(90,60,120,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  blob = finish(canvas, false);
  return blob;
}
