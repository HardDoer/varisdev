/** Public browser-only contract for app theme scene modules. */
export const THEME_RENDERER_API_VERSION = 1 as const;

export type ThemeAppearance = 'default' | 'year1998';
export type BuiltinThemeScene = 'factory' | 'year1998';

/** The scene value in a package's theme JSON, before discovery resolves URLs. */
export type ThemeSceneRegistration =
  BuiltinThemeScene | {module: string; apiVersion: 1};

/** The resolved scene value delivered to the desktop renderer. */
export type ThemeSceneReference =
  BuiltinThemeScene | {moduleUrl: string; apiVersion: 1};

/** RGB components in the range 0–1. */
export type SceneColor = readonly [number, number, number];
export type ScenePalette = Readonly<Record<string, SceneColor>>;

/** Stable scene fields; additional snapshot data should be narrowed before use. */
export interface SceneSession {
  id: string;
  name?: string;
  status: string;
  activity?: string;
  [key: string]: unknown;
}
export interface SceneAgent {
  id: string;
  name?: string;
  task?: string;
  status: string;
  activity?: string;
  [key: string]: unknown;
}
export interface SceneSnapshot {
  session: SceneSession;
  agents: readonly SceneAgent[];
  [key: string]: unknown;
}
export interface SceneHubSnapshot {
  selectedSessionId?: string;
  sessions: readonly SceneSnapshot[];
  [key: string]: unknown;
}

/** Coordinates relative to the canvas, normalized to 0–1. */
export interface SceneAnchor {
  /** 'parent' for the current session; agent ID otherwise. */
  id: string;
  x: number;
  y: number;
  visible: boolean;
  away?: boolean;
  detail?: string;
}
/** Cane hit targets use viewport CSS pixels, including canvas position. */
export interface SceneCaneTarget {
  id: string;
  x: number;
  y: number;
  radius: number;
}

/** A contact in viewport CSS pixels. */
export interface SceneContact {
  x: number;
  y: number;
}
/** Faces are ordered front to back. Omit polygon for circular targeting. */
export interface SceneEnvironmentTarget extends SceneCaneTarget {
  polygon?: readonly SceneContact[];
}

export interface ThemeScene {
  update(snapshot: SceneSnapshot | null, selectedId: string): void;
  setPalette(palette: ScenePalette): void;
  setMotion(enabled: boolean): void;
  /** Release observers, listeners, animation frames, and graphics resources. */
  dispose(): void;
  updateHub?(hub: SceneHubSnapshot | null): void;
  /** These IDs are parent session IDs, rather than the 'parent' selection ID. */
  prompt?(sessionId: string): void;
  cancelPrompt?(sessionId: string): void;
  startle?(animate?: boolean): void;
  clearStartle?(): void;
  caneTargets?(): SceneCaneTarget[];
  hitWithCane?(id: string, direction?: number, strength?: number): boolean;
  /** Apply flame exposure in seconds; return whether the robot was hit. */
  burnRobot?(id: string, seconds: number): boolean;
  environmentTargets?(): SceneEnvironmentTarget[];
  hitEnvironment?(
    id: string,
    weapon: 'cane' | 'gun' | 'flame',
    amount: number,
    contact?: SceneContact,
  ): boolean;
}

export interface ParentMotionPose {
  mode: string;
  activity: string | null;
  elapsed: number;
  duration: number;
  x: number;
  z: number;
  yaw: number;
  ground: number;
  stride: number;
  jump: number;
  surprise: number;
}
export interface ParentMotion {
  update(session: SceneSession | null | undefined): void;
  prompt(): void;
  cancelPrompt(): void;
  tick(seconds: number): void;
  setAway(enabled: boolean): void;
  setMotion(enabled: boolean): void;
  stop(): void;
  pose(): ParentMotionPose;
  dispose(): void;
}
export interface FactoryVisitorPose {
  id: string;
  name: string;
  status: string;
  phase: string;
  x: number;
  z: number;
  yaw: number;
  stride: number;
  surprise: number;
  jump: number;
}
export interface FactoryVisitors {
  update(value: SceneHubSnapshot | SceneSnapshot | SceneSession | null): void;
  observeLocalPose(
    id: string,
    pose: {x: number; z: number; yaw?: number},
  ): void;
  prompt(id: string): boolean;
  tick(seconds: number, pausedIds?: readonly string[]): void;
  visitorsAt(factoryId: string): FactoryVisitorPose[];
  isAway(id: string): boolean;
  awayMessage(id: string): string;
  setMotion(enabled: boolean): void;
  dispose(): void;
}
export interface RobotDamagePose {
  burning: number;
  char: number;
  scream: number;
  panic: number;
  fireAge: number;
  damage: number;
  phase: string;
  phaseAge: number;
  surprise: number;
  flinch: number;
  offset: readonly number[];
  rotation: readonly number[];
  collapse: number;
  corpseOffset: readonly number[];
  cleanup: {
    phase: string;
    position: readonly number[];
    grip: number;
    travel: number;
    wheel: number;
  } | null;
  blast: number;
  door: number;
  lift: number;
  visible: boolean;
  generation: number;
}
export interface RobotDamage {
  hit(id: string, direction?: number, strength?: number): boolean;
  burn(id: string, seconds: number): boolean;
  tick(seconds: number): void;
  pose(id: string): RobotDamagePose;
  effects(): Array<{
    id: number;
    owner: string;
    kind: string;
    size: number[];
    position: number[];
    rotation: number[];
    life: number;
  }>;
  setMotion(enabled: boolean): void;
  retain(ids: Iterable<string>): void;
  reset(): void;
  dispose(): void;
}
export interface RobotWhip {
  update(
    sessionId: string,
    targets: readonly string[],
    interrupt?: boolean,
  ): void;
  tick(seconds: number): void;
  pose(): {target: string; age: number} | null;
  cancel(): void;
  setMotion(enabled: boolean): void;
  dispose(): void;
}
export interface FactoryIdentity {
  readonly token: string;
  readonly accentKey: string;
  readonly gantry: number;
  readonly roof: number;
  readonly utilities: number;
  readonly stripePhase: number;
}

/** Controllers schedule no animation: advance them with tick(seconds). */
export interface ThemeSceneHelpers {
  createParentMotion(): ParentMotion;
  createFactoryVisitors(): FactoryVisitors;
  visitorCaneId(sessionId: string): string;
  createRobotDamage(options?: {
    maxRobots?: number;
    maxEffects?: number;
  }): RobotDamage;
  createRobotWhip(random?: () => number): RobotWhip;
  factoryIdentity(sessionId: string): FactoryIdentity;
  factoryIdentityPalette(
    palette: ScenePalette,
    identity: FactoryIdentity,
  ): ScenePalette;
}
export interface ThemeSceneOptions {
  apiVersion: 1;
  onSelect(id: string): void;
  onLayout(anchors: SceneAnchor[]): void;
  helpers: ThemeSceneHelpers;
}

/** Export apiVersion = 1 and createScene from the browser ES module. */
export interface ThemeSceneModule {
  apiVersion: 1;
  /** Creation must be synchronous; import and initial state replay belong to the host. */
  createScene(
    canvas: HTMLCanvasElement,
    options: ThemeSceneOptions,
  ): ThemeScene;
}
