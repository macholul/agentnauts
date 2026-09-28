import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Vector3, type Group } from 'three';
import { useAgentStore, type AgentRole, type Lifecycle } from '../../store/agentStore';
import { CAMERA, type Vec3 } from '../../world/config';
import { planPath } from '../../world/navigation';
import { groundHeight } from '../../world/terrain';
import { Astronaut } from './Astronaut';
import { WaitingBubble } from './WaitingBubble';
import { createPose } from './pose';

const WALK_SPEED: Record<AgentRole, number> = { commander: 2.4, crew: 2.9 };
const SCALE: Record<AgentRole, number> = { commander: 1.55, crew: 1.15 };
const ARRIVE_SECONDS = 1.8;
const LEAVE_SECONDS = 2.2;
const DROP_HEIGHT = 20;

function hash01(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/** Shortest signed difference between two angles. */
function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function dampAngle(current: number, target: number, lambda: number, delta: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * delta));
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInCubic = (t: number) => t * t * t;

interface NavState {
  initialized: boolean;
  pos: Vector3;
  yaw: number;
  speed: number;
  path: Vec3[];
  seq: number;
  /** Lifecycle phase seen last frame, to restart the animation clock on change. */
  lifecycle: Lifecycle | null;
  /** Lifecycle animation clock (seconds). */
  anim: number;
  from: Vector3;
  to: Vector3;
  lookTimer: number;
  removed: boolean;
}

/**
 * Behavior for one agent: reads its record from the store every frame,
 * walks along waypoints, turns smoothly, plays arrive/leave flights and
 * feeds the pose to the Astronaut visual.
 */
export function AgentActor({ id }: { id: string }) {
  // Static-ish fields: subscribing is fine, they rarely change.
  const color = useAgentStore((s) => s.agents[id]?.color ?? '#ffffff');
  const role = useAgentStore((s) => s.agents[id]?.role ?? 'commander');
  const name = useAgentStore((s) => s.agents[id]?.name ?? '');
  const waiting = useAgentStore((s) => s.agents[id]?.state === 'waiting');

  const root = useRef<Group>(null);
  const scaler = useRef<Group>(null);
  const pose = useRef(createPose());
  const seed = useRef(hash01(id)).current;
  const nav = useRef<NavState>({
    initialized: false,
    pos: new Vector3(),
    yaw: CAMERA.azimuth,
    speed: 0,
    path: [],
    seq: -1,
    lifecycle: null,
    anim: 0,
    from: new Vector3(),
    to: new Vector3(),
    lookTimer: 0,
    removed: false,
  });

  useFrame((_, rawDelta) => {
    const store = useAgentStore.getState();
    const agent = store.agents[id];
    const group = root.current;
    if (!agent || !group) return;
    const dt = Math.min(rawDelta, 0.1);
    const n = nav.current;
    const p = pose.current;
    const scale = SCALE[agent.role];

    if (!n.initialized) {
      n.initialized = true;
      if (agent.lifecycle === 'arriving') {
        const [lx, ly, lz] = agent.landingSpot;
        // Drop in from high up, off to one side.
        const angle = seed * Math.PI * 2;
        n.from.set(lx + Math.cos(angle) * 5, ly + DROP_HEIGHT, lz + Math.sin(angle) * 5);
        n.to.set(lx, ly, lz);
        n.pos.copy(n.from);
        n.yaw = Math.atan2(lx - n.from.x, lz - n.from.z);
      } else {
        n.pos.set(...agent.position);
      }
    }

    p.squash = Math.max(0, p.squash - dt * 4);

    if (agent.lifecycle !== n.lifecycle) {
      n.lifecycle = agent.lifecycle;
      n.anim = 0;
      if (agent.lifecycle === 'leaving') n.from.copy(n.pos);
    }

    if (agent.lifecycle === 'arriving') {
      n.anim += dt;
      const t = Math.min(1, n.anim / ARRIVE_SECONDS);
      const e = easeOutCubic(t);
      n.pos.lerpVectors(n.from, n.to, e);
      // Gentle sideways arc on the way down.
      n.pos.x += Math.sin(Math.PI * t) * 0.8 * Math.cos(seed * 9);
      n.pos.z += Math.sin(Math.PI * t) * 0.8 * Math.sin(seed * 9);
      n.yaw = dampAngle(n.yaw, CAMERA.azimuth, 2, dt);
      p.mode = 'fly';
      p.thrust = t < 0.6 ? 0.4 : 1;
      if (t >= 1) {
        p.squash = 1;
        p.thrust = 0;
        p.mode = 'idle';
        n.pos.copy(n.to);
        store.landed(id, [n.pos.x, n.pos.y, n.pos.z]);
      }
    } else if (agent.lifecycle === 'leaving') {
      n.anim += dt;
      const t = Math.min(1, n.anim / LEAVE_SECONDS);
      p.mode = 'fly';
      p.thrust = t < 0.2 ? t * 5 : 1;
      if (t < 0.2) {
        // Crouch and fire up the jetpack.
        p.squash = Math.max(p.squash, 0.6 * (t / 0.2));
      } else {
        // Blast off up and outward, away from the middle of the base.
        const k = easeInCubic((t - 0.2) / 0.8);
        const len = Math.hypot(n.from.x, n.from.z) || 1;
        n.pos.set(
          n.from.x + (n.from.x / len) * k * 6,
          n.from.y + k * DROP_HEIGHT,
          n.from.z + (n.from.z / len) * k * 6,
        );
      }
      if (scaler.current) scaler.current.scale.setScalar(scale * (t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1));
      if (t >= 1 && !n.removed) {
        n.removed = true;
        store.removeAgent(id);
      }
    } else {
      // Active: follow the store's destination.
      if (agent.moveSeq !== n.seq) {
        n.seq = agent.moveSeq;
        const here: Vec3 = [n.pos.x, n.pos.y, n.pos.z];
        n.path = agent.destination ? planPath(here, agent.destination) : [];
        if (!agent.destination) store.arrived(id, n.seq, here);
      }

      const maxSpeed = WALK_SPEED[agent.role];
      const next = n.path[0];
      if (next) {
        const dx = next[0] - n.pos.x;
        const dz = next[2] - n.pos.z;
        const dist = Math.hypot(dx, dz);
        const isLast = n.path.length === 1;
        const desiredYaw = Math.atan2(dx, dz);
        const turn = Math.abs(angleDelta(n.yaw, desiredYaw));
        // Slow down to turn sharply, and ease into the final stop.
        let desired = maxSpeed * Math.max(0.15, Math.cos(Math.min(turn, Math.PI / 2)));
        if (isLast) desired *= Math.min(1, dist / 0.7 + 0.3);
        n.speed += (desired - n.speed) * (1 - Math.exp(-6 * dt));
        const step = n.speed * dt;
        // Cut corners slightly at intermediate waypoints for smoother paths.
        const reach = isLast ? 0.02 : 0.35;
        if (dist <= Math.max(step, reach)) {
          if (isLast) n.pos.set(next[0], n.pos.y, next[2]);
          n.path.shift();
          if (n.path.length === 0) {
            n.speed = 0;
            store.arrived(id, n.seq, [n.pos.x, groundHeight(n.pos.x, n.pos.z), n.pos.z]);
          }
        } else {
          n.pos.x += (dx / dist) * step;
          n.pos.z += (dz / dist) * step;
        }
        n.yaw = dampAngle(n.yaw, desiredYaw, 9, dt);
        p.mode = 'walk';
        p.speed = n.speed / maxSpeed;
      } else {
        n.speed = 0;
        p.speed = 0;
        if (agent.facing !== null) n.yaw = dampAngle(n.yaw, agent.facing, 5, dt);
        p.station = agent.station;
        p.mode = agent.state === 'working' ? 'work' : agent.state === 'waiting' ? 'wait' : 'idle';
        if (p.mode === 'idle') {
          // Look around now and then.
          n.lookTimer -= dt;
          if (n.lookTimer <= 0) {
            n.lookTimer = 1.5 + Math.random() * 2.5;
            p.look = Math.random() < 0.3 ? 0 : (Math.random() - 0.5) * 1.6;
          }
        } else {
          p.look = 0;
        }
      }
      n.pos.y = groundHeight(n.pos.x, n.pos.z);
      p.thrust = 0;
    }

    group.position.copy(n.pos);
    group.rotation.y = n.yaw;
  });

  const scale = SCALE[role];
  return (
    <group ref={root}>
      <group ref={scaler} scale={scale}>
        <Astronaut color={color} role={role} pose={pose} seed={seed} />
        <WaitingBubble visible={waiting} />
      </group>
      <Html position={[0, 1.42 * scale, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
        <div className={`agent-label agent-label--${role}`}>
          <span className="agent-label__dot" style={{ background: color }} />
          {name}
        </div>
      </Html>
    </group>
  );
}
