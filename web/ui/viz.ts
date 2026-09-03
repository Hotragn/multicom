import type { RoomRole } from "../../shared/tools";
import type { RoomPhase } from "../../shared/ws-messages";
import { element, prefersReducedMotion } from "./dom";

export interface VizParticipant {
  id: string;
  name: string;
  role: RoomRole;
  active: boolean;
}

export interface VizInput {
  participants: VizParticipant[];
  phase: RoomPhase;
  /** 0–1. Drives how agitated the field looks. */
  errorRate: number;
}

export interface VizHandle {
  update(input: VizInput): void;
  /** Flash one participant, for a join, a vote, or an applied action. */
  pulse(participantId: string): void;
  destroy(): void;
}

interface Renderer {
  /**
   * Each renderer owns its own canvas. A canvas that has handed out a 2D
   * context can never hand out a WebGL one — asking anyway logs
   * "Canvas has an existing context of a different type" and the 3D layer
   * silently never starts, which is exactly what happened the first time.
   */
  readonly canvas: HTMLCanvasElement;
  draw(now: number): void;
  resize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}

const PHASE_COLORS: Record<RoomPhase, number> = {
  triage: 0xff7878,
  diagnosing: 0xe6b86a,
  mitigating: 0x8fb3e8,
  resolved: 0x62c99d,
};

const MAX_NODES = 6;

const hex = (value: number): string => `#${value.toString(16).padStart(6, "0")}`;

/**
 * Where each participant sits, and how bright it is right now.
 *
 * Layout is computed here rather than in either renderer so the Three.js scene
 * and the 2D fallback show the same graph. Positions are deterministic in the
 * participant's index, so a node does not jump when somebody else joins.
 */
class Field {
  participants: VizParticipant[] = [];
  phase: RoomPhase = "triage";
  errorRate = 0;
  private readonly pulses = new Map<string, number>();

  pulse(id: string, at: number): void {
    this.pulses.set(id, at);
  }

  pulseStrength(id: string, now: number): number {
    const at = this.pulses.get(id);
    if (at === undefined) return 0;
    const age = now - at;
    if (age > 1_200) {
      this.pulses.delete(id);
      return 0;
    }
    return 1 - age / 1_200;
  }

  color(): number {
    return PHASE_COLORS[this.phase];
  }

  /** Angle and radius for the node at `index`, as a unit-circle position. */
  position(index: number, count: number): { x: number; y: number } {
    const slots = Math.max(count, 3);
    const angle = (index / slots) * Math.PI * 2 - Math.PI / 2;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  }
}

function createCanvasRenderer(field: Field): Renderer | null {
  const canvas = element("canvas", "mc-viz__canvas");
  canvas.setAttribute("aria-hidden", "true");
  const context = canvas.getContext("2d");
  if (!context) return null;
  let width = canvas.width;
  let height = canvas.height;
  let ratio = 1;

  return {
    canvas,
    resize(nextWidth, nextHeight, pixelRatio) {
      width = nextWidth;
      height = nextHeight;
      ratio = pixelRatio;
      canvas.width = Math.max(1, Math.round(nextWidth * pixelRatio));
      canvas.height = Math.max(1, Math.round(nextHeight * pixelRatio));
    },
    draw(now) {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) * 0.34;
      const accent = hex(field.color());
      const agitation = prefersReducedMotion() ? 0 : Math.min(1, field.errorRate * 3);
      const breathe = prefersReducedMotion() ? 0 : Math.sin(now / 900) * 0.5 + 0.5;

      // Service core.
      const coreRadius = radius * (0.32 + breathe * 0.04 * (0.4 + agitation));
      context.beginPath();
      context.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
      context.strokeStyle = accent;
      context.globalAlpha = 0.85;
      context.lineWidth = 2;
      context.stroke();
      context.globalAlpha = 0.12;
      context.fillStyle = accent;
      context.fill();

      const nodes = field.participants.slice(0, MAX_NODES);
      nodes.forEach((participant, index) => {
        const unit = field.position(index, nodes.length);
        const wobble = prefersReducedMotion()
          ? 0
          : Math.sin(now / 1_100 + index) * radius * 0.04 * (0.3 + agitation);
        const x = centerX + unit.x * (radius + wobble);
        const y = centerY + unit.y * (radius + wobble);
        const strength = field.pulseStrength(participant.id, now);

        context.beginPath();
        context.moveTo(centerX + unit.x * coreRadius, centerY + unit.y * coreRadius);
        context.lineTo(x, y);
        context.strokeStyle = accent;
        context.globalAlpha = participant.active ? 0.3 + strength * 0.5 : 0.12;
        context.lineWidth = 1 + strength * 2;
        context.stroke();

        context.beginPath();
        const nodeRadius = radius * (participant.role === "commander" ? 0.11 : 0.085);
        context.arc(x, y, nodeRadius * (1 + strength * 0.5), 0, Math.PI * 2);
        context.globalAlpha = participant.active ? 0.75 + strength * 0.25 : 0.25;
        context.fillStyle = accent;
        context.fill();
        if (participant.role === "commander") {
          context.globalAlpha = 0.9;
          context.strokeStyle = "#f3f6fa";
          context.lineWidth = 1.5;
          context.stroke();
        }
      });
      context.globalAlpha = 1;
    },
    dispose() {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      canvas.remove();
    },
  };
}

async function createThreeRenderer(field: Field): Promise<Renderer | null> {
  // Lazily imported so the 3D layer is its own chunk: a judge on a slow link
  // gets a usable page before it arrives, and a failed load is not fatal.
  const three = await import("three");
  const canvas = element("canvas", "mc-viz__canvas");
  canvas.setAttribute("aria-hidden", "true");
  // WebGLRenderer throws rather than returning null when there is no context,
  // so the caller's catch is what keeps the 2D field running.
  const renderer = new three.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new three.Scene();
  const camera = new three.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 7.4);

  const material = new three.MeshBasicMaterial({
    color: field.color(),
    wireframe: true,
    transparent: true,
    opacity: 0.55,
  });
  const core = new three.Mesh(new three.IcosahedronGeometry(1.15, 1), material);
  scene.add(core);

  const group = new three.Group();
  scene.add(group);
  const nodeGeometry = new three.IcosahedronGeometry(0.19, 1);
  const nodes = Array.from({ length: MAX_NODES }, () => {
    const nodeMaterial = new three.MeshBasicMaterial({
      color: field.color(),
      transparent: true,
      opacity: 0.85,
    });
    const mesh = new three.Mesh(nodeGeometry, nodeMaterial);
    mesh.visible = false;
    group.add(mesh);
    return { mesh, material: nodeMaterial };
  });

  const spokeMaterial = new three.LineBasicMaterial({
    color: field.color(),
    transparent: true,
    opacity: 0.28,
  });
  const spokeGeometry = new three.BufferGeometry();
  const spokePositions = new Float32Array(MAX_NODES * 6);
  spokeGeometry.setAttribute("position", new three.BufferAttribute(spokePositions, 3));
  const spokes = new three.LineSegments(spokeGeometry, spokeMaterial);
  scene.add(spokes);

  const tint = new three.Color();

  return {
    canvas,
    resize(width, height, pixelRatio) {
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    },
    draw(now) {
      const still = prefersReducedMotion();
      const agitation = still ? 0 : Math.min(1, field.errorRate * 3);
      tint.setHex(field.color());
      material.color.copy(tint);
      spokeMaterial.color.copy(tint);
      core.rotation.y = still ? 0.4 : now / 6_000;
      core.rotation.x = still ? 0.2 : Math.sin(now / 5_000) * 0.25;
      core.scale.setScalar(still ? 1 : 1 + Math.sin(now / 700) * 0.03 * (0.4 + agitation));

      const active = field.participants.slice(0, MAX_NODES);
      let spokeIndex = 0;
      nodes.forEach((node, index) => {
        const participant = active[index];
        node.mesh.visible = participant !== undefined;
        if (!participant) return;
        const unit = field.position(index, active.length);
        const strength = field.pulseStrength(participant.id, now);
        const radius = 3 + (still ? 0 : Math.sin(now / 1_200 + index) * 0.12 * (0.3 + agitation));
        const x = unit.x * radius;
        const y = unit.y * radius * 0.62;
        const z = still ? 0 : Math.cos(now / 1_500 + index) * 0.4;
        node.mesh.position.set(x, y, z);
        node.mesh.scale.setScalar(
          (participant.role === "commander" ? 1.35 : 1) * (1 + strength * 0.6),
        );
        node.material.color.copy(tint);
        node.material.opacity = participant.active ? 0.75 + strength * 0.25 : 0.22;
        node.mesh.rotation.y = still ? 0 : now / 2_400 + index;

        spokePositions[spokeIndex] = 0;
        spokePositions[spokeIndex + 1] = 0;
        spokePositions[spokeIndex + 2] = 0;
        spokePositions[spokeIndex + 3] = x;
        spokePositions[spokeIndex + 4] = y;
        spokePositions[spokeIndex + 5] = z;
        spokeIndex += 6;
      });
      for (let index = spokeIndex; index < spokePositions.length; index += 1) {
        spokePositions[index] = 0;
      }
      spokeGeometry.attributes.position!.needsUpdate = true;
      spokeGeometry.setDrawRange(0, active.length * 2);
      renderer.render(scene, camera);
    },
    dispose() {
      nodeGeometry.dispose();
      spokeGeometry.dispose();
      spokeMaterial.dispose();
      material.dispose();
      for (const node of nodes) node.material.dispose();
      core.geometry.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}

/**
 * The incident graph behind the hero: the failing service at the centre, one
 * node per participant, pulsing when somebody acts.
 *
 * Three.js is attempted first and the 2D canvas is the fallback, so a browser
 * without WebGL, a blocked chunk, or a reduced-motion preference all still get
 * the same picture. Nothing here is load-bearing for using the room.
 */
export function mountViz(container: HTMLElement): VizHandle {
  const field = new Field();
  let renderer: Renderer | null = createCanvasRenderer(field);
  if (renderer) container.append(renderer.canvas);
  let frame = 0;
  let destroyed = false;
  let lastWidth = 0;
  let lastHeight = 0;

  const measure = (): void => {
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    renderer?.resize(width, height, Math.min(2, globalThis.devicePixelRatio || 1));
  };

  const paint = (now: number): void => {
    if (destroyed || !renderer) return;
    measure();
    try {
      renderer.draw(now);
    } catch {
      // A renderer that fails mid-frame must not take the room with it.
      renderer.dispose();
      renderer = null;
      container.dataset.viz = "off";
      return;
    }
    if (prefersReducedMotion()) return;
    frame = requestAnimationFrame(paint);
  };

  const restart = (): void => {
    if (destroyed) return;
    cancelAnimationFrame(frame);
    lastWidth = 0;
    lastHeight = 0;
    frame = requestAnimationFrame(paint);
  };

  container.dataset.viz = "canvas";
  restart();

  void createThreeRenderer(field)
    .then((upgraded) => {
      if (destroyed || !upgraded) {
        upgraded?.dispose();
        return;
      }
      renderer?.dispose();
      renderer = upgraded;
      container.append(upgraded.canvas);
      container.dataset.viz = "webgl";
      restart();
    })
    .catch(() => {
      // No WebGL, or the chunk did not load. The 2D field is already running.
    });

  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => restart()) : null;
  observer?.observe(container);

  return {
    update(input) {
      field.participants = input.participants;
      field.phase = input.phase;
      field.errorRate = Number.isFinite(input.errorRate) ? input.errorRate : 0;
      // Reduced motion draws on demand rather than every frame.
      if (prefersReducedMotion()) restart();
    },
    pulse(participantId) {
      field.pulse(participantId, performance.now());
      if (prefersReducedMotion()) restart();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      renderer?.dispose();
      renderer = null;
    },
  };
}
