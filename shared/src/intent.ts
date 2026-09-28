/**
 * Intent: what an agent's astronaut should be doing, derived from an event.
 * The scene turns intents into movement and animation; the mapping from
 * events to intents lives in mapEventToIntent.ts.
 */

export type StationId = 'fabricator' | 'scanner' | 'drill' | 'radar';

export const STATION_IDS: readonly StationId[] = ['fabricator', 'scanner', 'drill', 'radar'];

export type Intent =
  /** Walk to a station and work there. */
  | { kind: 'work'; station: StationId; activity: string }
  /** Walk to the landing pad and wait for the user. */
  | { kind: 'wait'; activity: string }
  /** Nothing to do: hang around, wander after a while. */
  | { kind: 'idle'; activity: string }
  /** Leave the chunk (session ended / subagent finished). */
  | { kind: 'leave'; activity: string };

export type IntentKind = Intent['kind'];
