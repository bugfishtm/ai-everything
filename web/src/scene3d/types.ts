// What the studio-3d engine tells the 3D editor (see tools/studio-3d/studio3d/editor.py).

export type Vec3 = [number, number, number];

export interface Transform {
  position: Vec3;
  rotation: Vec3; // degrees, x y z
  scale: Vec3;
}

/** What was built for one object of the text (id = its YAML path, e.g. "objects.2.group.0"). */
export interface ObjRecord {
  kind?: string;
  nodes?: string[];
  instances?: number;
  triangles?: number;
  bounds?: [Vec3, Vec3] | null;
  error?: string;
  hidden?: boolean;
  operand?: boolean;
}

export interface MatSummary {
  color: string;
  roughness?: number;
  metallic?: number;
  opacity?: number;
  emissive?: string;
  maps: string[];
  defined?: boolean;
  error?: boolean;
}

export interface SceneStats {
  triangles: number;
  vertices: number;
  meshes: number;
  nodes: number;
  materials: string[];
  textures: number;
  bounds: { min: Vec3; max: Vec3; size: Vec3 } | null;
}

export interface PluginError {
  file: string;
  error: string;
}

export interface SceneModel {
  ok: true;
  name: string;
  glb: string | null;
  bytes: number;
  objects: Record<string, ObjRecord>;
  errors: { id: string | null; where: string; error: string }[];
  materials: Record<string, MatSummary>;
  stats: SceneStats;
  counts: { objects: number; instances: number };
  camera: { position?: Vec3; target?: Vec3 } | null;
  warnings: string[];
  pluginErrors: PluginError[];
  seconds: number;
}

export interface ModelError {
  ok: false;
  error?: string;
  superseded?: boolean;
  pluginErrors?: PluginError[];
}

export interface UiHint {
  min?: number;
  max?: number;
  step?: number;
  int?: boolean;
  choices?: (string | number)[];
  optional?: boolean;
}

export interface CatalogEntry {
  name: string;
  doc: string;
  help?: string;
  params: Record<string, unknown>;
  ui: Record<string, UiHint>;
  source: string;
  group: string;
  starter?: Record<string, unknown> | null;
}

export interface PackObject {
  use: string;
  name: string;
  pack: string;
  tags: string[];
  kind: 'model' | 'prefab' | 'plugin';
  params?: Record<string, unknown> | null;
  locked?: boolean;
}

export interface PackMaterial extends Partial<MatSummary> {
  use: string;
  name: string;
  pack: string;
  tags: string[];
}

export interface ProcTexture {
  name: string;
  doc: string;
  params: Record<string, unknown>;
  source: string;
}

export interface Catalog {
  ok: boolean;
  version: string;
  shapes: CatalogEntry[];
  modifiers: CatalogEntry[];
  presets: Record<string, MatSummary & { spec: Record<string, unknown> }>;
  packs: { objects: PackObject[]; materials: PackMaterial[]; textures: { use: string; name: string; pack: string; kind: string }[] };
  textures: ProcTexture[];
  projections: Record<string, string>;
  maps: Record<string, string>;
  materialKeys: string[];
  objectKeys: string[];
  shading: string[];
  templates: string[];
  pluginErrors: PluginError[];
}

export interface TexturePreview {
  ok: boolean;
  file?: string;
  size?: [number, number];
  full?: [number, number];
  kind?: string;
  warnings?: string[];
  error?: string;
}

export interface ProjectPicture {
  path: string;
  kind: 'file' | 'picture';
}

export interface ExportReport {
  ok: boolean;
  files: Record<string, string>;
  name: string;
  objects: number;
  instances: number;
  stats: SceneStats;
  bytes: number;
  warnings: string[];
  build_seconds: number;
}

export type Tool = 'select' | 'translate' | 'rotate' | 'scale';
