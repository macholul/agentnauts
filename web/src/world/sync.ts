/**
 * Shared, repeatable choices so every browser in a room shows the same world.
 *
 * Rooms only carry events; each browser animates on its own. So nothing that
 * people can compare (where an idle astronaut strolls, where it lands, which
 * way the radar points) may come from Math.random() or from how long the page
 * has been open. It comes from the agent's sync key and the wall clock
 * instead, which are the same everywhere.
 */

/** Fixed reference point for the world clock (any constant works). */
const WORLD_EPOCH_MS = Date.UTC(2026, 0, 1);

/** Seconds on the shared world clock. Use this, not the R3F clock, for animation. */
export function worldSeconds(now = Date.now()): number {
  return (now - WORLD_EPOCH_MS) / 1000;
}

export function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A repeatable random() for the given inputs (mulberry32). */
export function seededRandom(...parts: (string | number)[]): () => number {
  let state = hashString(parts.join('|'));
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The part of an agent id that is the same in every browser. Agents from a
 * room are stored as `room:<key>:<session>` (or `.../<subagent>` for crew),
 * while the owner's own browser stores the bare session id.
 */
export function syncKey(id: string): string {
  return id.replace(/^room:[^:]+:/, '');
}

/** Blend a slow and a fast oscillation by activity, without jumps when activity changes. */
export function oscillate(t: number, slowFreq: number, fastFreq: number, activity: number): number {
  return Math.sin(t * slowFreq) * (1 - activity) + Math.sin(t * fastFreq) * activity;
}
