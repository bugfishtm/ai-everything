// The viewport of the 3D editor: shows the .glb the engine built, lets the user pick objects and move
// them with a gizmo. Geometry is never made here — an edit goes into the text and the engine builds
// again; the stage only moves what exists (so a drag feels immediate) until the new build arrives.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { composeMatrix, round } from './sceneDoc';
import type { MatSummary, Tool, Transform, Vec3 } from './types';

export interface Attach {
  id: string;
  /** the object's transform in the text now */
  transform: Transform;
  /** its transform in the text the shown model was built from (null: not in that build) */
  built: Transform | null;
  /** the object whose node is the parent (a group, a boolean); null = the scene */
  parentId: string | null;
  /** scattered and not a group: the copies sit around the position */
  scatter: boolean;
  /** local box, shown when the object has no node of its own (part of a boolean, hidden, failed) */
  bounds?: [Vec3, Vec3] | null;
}

export interface StageEvents {
  onPick: (id: string | null, additive: boolean) => void;
  onTransform: (id: string, t: Transform, done: boolean) => void;
  onContext?: (id: string | null, x: number, y: number) => void;
}

const ACCENT = 0x22d3ee;
const ACCENT_2 = 0xa78bfa;

function disposeTree(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh && !(o as THREE.LineSegments).isLineSegments) return;
    m.geometry?.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      if (!mat) continue;
      const s = mat as THREE.MeshStandardMaterial;
      for (const t of [s.map, s.normalMap, s.roughnessMap, s.metalnessMap, s.emissiveMap, s.aoMap]) t?.dispose();
      mat.dispose();
    }
  });
}

function noRaycast(o: THREE.Object3D): void {
  o.raycast = () => {};
  o.userData.helper = true;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.01, 2000);
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  private world = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private nodes = new Map<string, THREE.Object3D[]>();
  private handle = new THREE.Object3D();
  private handleBox: THREE.Object3D | null = null;
  private attached: Attach | null = null;
  private rel: THREE.Matrix4[] = [];
  private boxes: THREE.Object3D[] = [];
  private selection: string[] = [];
  private loadToken = 0;
  private framed = false;
  private disposed = false;
  private raf = 0;
  private ro: ResizeObserver;
  private loader = new GLTFLoader();
  private envTex: THREE.Texture;
  private pmrem: THREE.PMREMGenerator;
  private down: { x: number; y: number; button: number } | null = null;
  private dragging = false;
  private moved = false;
  private wire = false;
  private tool: Tool = 'select';
  private cleanup: (() => void)[] = [];
  /** false while the ids of the shown model do not fit the text (objects were added / removed since) */
  pickable = true;

  constructor(
    private host: HTMLElement,
    private events: StageEvents,
  ) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping; // colors look like the values in the file (the preview uses the same)
    host.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envTex = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.5; // a flat surface then shows the color written in the file
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(4, 8, 6);
    this.scene.add(sun);
    this.grid = new THREE.GridHelper(20, 20, 0x4a556b, 0x232a37);
    noRaycast(this.grid);
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(1);
    this.axes.position.y = 0.002;
    noRaycast(this.axes);
    this.scene.add(this.axes);
    this.scene.add(this.world);

    this.camera.position.set(6, 4.5, 8);
    this.orbit = new OrbitControls(this.camera, renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.target.set(0, 0.8, 0);

    this.gizmo = new TransformControls(this.camera, renderer.domElement);
    this.gizmo.setSize(0.85);
    this.gizmo.setSpace('local');
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const on = !!(e as unknown as { value: boolean }).value;
      this.orbit.enabled = !on;
      this.dragging = on;
      if (!on && this.attached && this.moved) {
        this.moved = false;
        this.events.onTransform(this.attached.id, this.readHandle(), true);
      }
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (!this.attached) return;
      this.moved = true;
      this.follow();
      this.events.onTransform(this.attached.id, this.readHandle(), false);
    });
    this.scene.add(this.gizmo.getHelper());

    const dom = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      this.down = { x: e.clientX, y: e.clientY, button: e.button };
    };
    const onUp = (e: PointerEvent) => {
      const d = this.down;
      this.down = null;
      if (!d || d.button !== 0 || e.button !== 0 || this.dragging || this.gizmo.axis) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      if (!this.pickable) return;
      this.events.onPick(this.pick(e.clientX, e.clientY), e.shiftKey || e.ctrlKey || e.metaKey);
    };
    const onMenu = (e: MouseEvent) => {
      e.preventDefault();
      const d = this.down;
      this.down = null;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      this.events.onContext?.(this.pickable ? this.pick(e.clientX, e.clientY) : null, e.clientX, e.clientY);
    };
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('contextmenu', onMenu);
    this.cleanup.push(() => {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('contextmenu', onMenu);
    });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (!host.clientWidth || document.hidden) return;
      this.orbit.update();
      renderer.render(this.scene, this.camera);
    };
    loop();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.cleanup.forEach((f) => f());
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.clearModel();
    this.envTex.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---- the model -------------------------------------------------------------------------
  private clearModel(): void {
    this.gizmo.detach();
    this.handle.removeFromParent();
    this.clearBoxes();
    this.attached = null;
    this.rel = [];
    this.nodes.clear();
    if (this.model) {
      this.world.remove(this.model);
      disposeTree(this.model);
      this.model = null;
    }
  }

  /** Show a built model (null: an empty scene). Resolves false when a newer load replaced this one. */
  async load(url: string | null): Promise<boolean> {
    const token = ++this.loadToken;
    if (!url) {
      this.clearModel();
      return true;
    }
    const gltf = await this.loader.loadAsync(url);
    if (token !== this.loadToken || this.disposed) {
      disposeTree(gltf.scene);
      return false;
    }
    this.clearModel();
    this.model = gltf.scene;
    this.world.add(gltf.scene);
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const sid = o.userData?.sid;
      if (typeof sid !== 'string') return;
      o.userData.m0 = o.matrix.clone();
      const list = this.nodes.get(sid);
      if (list) list.push(o);
      else this.nodes.set(sid, [o]);
    });
    for (const list of this.nodes.values()) list.sort((a, b) => (a.userData.inst ?? 0) - (b.userData.inst ?? 0));
    if (this.wire) this.setWire(true);
    this.fitGrid();
    this.setSelection(this.selection);
    if (!this.framed) {
      this.framed = true;
      this.frame();
    }
    return true;
  }

  get hasModel(): boolean {
    return !!this.model;
  }

  hasNode(id: string): boolean {
    return (this.nodes.get(id)?.length ?? 0) > 0;
  }

  private bounds(objs: THREE.Object3D[]): THREE.Box3 {
    const box = new THREE.Box3();
    for (const o of objs) {
      o.updateWorldMatrix(true, true);
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh || !m.geometry || c.userData.helper) return;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
      });
    }
    return box;
  }

  private fitGrid(): void {
    const box = this.model ? this.bounds([this.model]) : new THREE.Box3();
    const size = box.isEmpty() ? 10 : Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * 2;
    const cells = Math.min(200, Math.max(20, Math.ceil((size * 1.3) / 10) * 10));
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.grid = new THREE.GridHelper(cells, cells, 0x4a556b, 0x232a37);
    noRaycast(this.grid);
    this.grid.visible = this.gridVisible;
    this.scene.add(this.grid);
    const dim = box.isEmpty() ? 10 : Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1);
    this.camera.near = Math.max(0.005, dim / 2000);
    this.camera.far = Math.max(500, dim * 100);
    this.camera.updateProjectionMatrix();
    this.axes.scale.setScalar(Math.max(1, dim / 12));
  }

  private gridVisible = true;
  setGrid(on: boolean): void {
    this.gridVisible = on;
    this.grid.visible = on;
    this.axes.visible = on;
  }

  setWire(on: boolean): void {
    this.wire = on;
    this.model?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) (mat as THREE.MeshStandardMaterial).wireframe = on;
    });
  }

  // ---- camera ---------------------------------------------------------------------------------
  /** Look at the whole scene, or at some objects. */
  frame(ids?: string[]): void {
    const objs = ids?.length ? ids.flatMap((id) => this.nodes.get(id) ?? []) : this.model ? [this.model] : [];
    const box = this.bounds(objs);
    if (box.isEmpty()) {
      if (ids?.length && this.attached && ids.includes(this.attached.id)) {
        const p = this.handle.getWorldPosition(new THREE.Vector3());
        box.setFromCenterAndSize(p, new THREE.Vector3(1, 1, 1));
      } else return;
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const dim = Math.max(size.x, size.y, size.z, 0.05);
    const dist = (dim / (2 * Math.tan((this.camera.fov * Math.PI) / 360))) * 1.5;
    const dir = this.camera.position.clone().sub(this.orbit.target);
    if (dir.lengthSq() < 1e-9) dir.set(0.6, 0.45, 0.8);
    dir.normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.orbit.target.copy(center);
    this.orbit.update();
  }

  /** Look along a direction (front, side, top …) keeping the distance. */
  view(dir: Vec3): void {
    const dist = this.camera.position.distanceTo(this.orbit.target);
    this.camera.position.copy(this.orbit.target).addScaledVector(new THREE.Vector3(...dir).normalize(), dist);
    this.orbit.update();
  }

  cameraState(): { position: Vec3; target: Vec3 } {
    const p = this.camera.position;
    const t = this.orbit.target;
    return { position: [round(p.x, 2), round(p.y, 2), round(p.z, 2)], target: [round(t.x, 2), round(t.y, 2), round(t.z, 2)] };
  }

  setCamera(position?: Vec3, target?: Vec3): void {
    if (target) this.orbit.target.set(...target);
    if (position) this.camera.position.set(...position);
    this.framed = true;
    this.orbit.update();
  }

  // ---- picking and selection -----------------------------------------------------------------
  private pick(x: number, y: number): string | null {
    if (!this.model) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    for (const hit of ray.intersectObject(this.model, true)) {
      let visible = true;
      let sid: string | null = null;
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        if (!o.visible) visible = false;
        if (sid === null && typeof o.userData?.sid === 'string') sid = o.userData.sid;
      }
      if (visible && sid) return sid;
    }
    return null;
  }

  private clearBoxes(): void {
    for (const b of this.boxes) {
      b.removeFromParent();
      const l = b as THREE.LineSegments;
      l.geometry?.dispose();
      (l.material as THREE.Material | undefined)?.dispose();
    }
    this.boxes = [];
    if (this.handleBox) {
      this.handleBox.removeFromParent();
      this.handleBox = null;
    }
  }

  /** A box around every copy of the selected objects (in the copy's own space, so it turns with it). */
  setSelection(ids: string[]): void {
    this.selection = ids;
    this.clearBoxes();
    if (!this.model) return;
    this.model.updateMatrixWorld(true);
    ids.forEach((id, n) => {
      const primary = n === ids.length - 1;
      for (const node of (this.nodes.get(id) ?? []).slice(0, 80)) {
        const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
        const box = new THREE.Box3();
        node.traverse((c) => {
          const m = c as THREE.Mesh;
          if (!m.isMesh || !m.geometry || c.userData.helper) return;
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          box.union(m.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)));
        });
        if (box.isEmpty()) continue;
        const helper = new THREE.Box3Helper(box, primary ? ACCENT : ACCENT_2);
        (helper.material as THREE.LineBasicMaterial).depthTest = false;
        helper.renderOrder = 10;
        noRaycast(helper);
        node.add(helper);
        this.boxes.push(helper);
      }
    });
    this.showHandleBox();
  }

  private showHandleBox(): void {
    const a = this.attached;
    if (!a || this.hasNode(a.id) || !a.bounds) return;
    const box = new THREE.Box3(new THREE.Vector3(...a.bounds[0]), new THREE.Vector3(...a.bounds[1]));
    const helper = new THREE.Box3Helper(box, 0xfbbf24);
    (helper.material as THREE.LineBasicMaterial).depthTest = false;
    helper.renderOrder = 10;
    noRaycast(helper);
    this.handle.add(helper);
    this.handleBox = helper;
  }

  // ---- the gizmo ---------------------------------------------------------------------------------
  setTool(tool: Tool): void {
    this.tool = tool;
    if (tool === 'select') this.gizmo.detach();
    else {
      this.gizmo.setMode(tool);
      if (this.attached && this.handle.parent) this.gizmo.attach(this.handle);
    }
  }

  setSpace(space: 'local' | 'world'): void {
    this.gizmo.setSpace(space);
  }

  setSnap(on: boolean): void {
    this.gizmo.setTranslationSnap(on ? 0.25 : null);
    this.gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
    this.gizmo.setScaleSnap(on ? 0.1 : null);
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  private static trs(o: THREE.Object3D, t: Transform): void {
    composeMatrix(t).decompose(o.position, o.quaternion, o.scale);
    o.updateMatrix();
  }

  /** Put the gizmo on an object (null: none). Its copies follow the handle. */
  attach(a: Attach | null): void {
    if (this.dragging) return; // the user is moving it right now; the text catches up when they let go
    this.gizmo.detach();
    this.handle.removeFromParent();
    if (this.handleBox) {
      this.handleBox.removeFromParent();
      this.handleBox = null;
    }
    this.attached = null;
    this.rel = [];
    if (!a || !this.model) return;
    const inst = this.nodes.get(a.id) ?? [];
    const parent = inst[0]?.parent ?? (a.parentId ? this.nodes.get(a.parentId)?.[0] : undefined) ?? this.model;
    parent.add(this.handle);
    this.attached = a;
    // how every copy relates to the object's transform in the build that is shown
    if (a.built && inst.length) {
      const L = composeMatrix(a.built);
      if (Math.abs(L.determinant()) > 1e-12) {
        if (a.scatter) {
          const Pinv = new THREE.Matrix4().makeTranslation(-a.built.position[0], -a.built.position[1], -a.built.position[2]);
          const RSinv = new THREE.Matrix4().multiplyMatrices(Pinv, L).invert();
          this.rel = inst.map((n) => new THREE.Matrix4().multiplyMatrices(Pinv, n.userData.m0 as THREE.Matrix4).multiply(RSinv));
        } else {
          const Linv = L.clone().invert();
          this.rel = inst.map((n) => new THREE.Matrix4().multiplyMatrices(Linv, n.userData.m0 as THREE.Matrix4));
        }
      }
    }
    Stage.trs(this.handle, a.transform);
    this.follow();
    this.showHandleBox();
    if (this.tool !== 'select') {
      this.gizmo.setMode(this.tool);
      this.gizmo.attach(this.handle);
    }
  }

  /** The copies of the attached object take the handle's transform. */
  private follow(): void {
    const a = this.attached;
    if (!a || !this.rel.length) return;
    this.handle.updateMatrix();
    const L = this.handle.matrix;
    const inst = this.nodes.get(a.id) ?? [];
    let P: THREE.Matrix4 | null = null;
    let RS: THREE.Matrix4 | null = null;
    if (a.scatter) {
      P = new THREE.Matrix4().makeTranslation(this.handle.position.x, this.handle.position.y, this.handle.position.z);
      RS = new THREE.Matrix4().multiplyMatrices(P.clone().invert(), L);
    }
    inst.forEach((n, k) => {
      const rel = this.rel[k];
      if (!rel) return;
      const m = P && RS ? new THREE.Matrix4().multiplyMatrices(P, rel).multiply(RS) : new THREE.Matrix4().multiplyMatrices(L, rel);
      m.decompose(n.position, n.quaternion, n.scale);
    });
  }

  private readHandle(): Transform {
    const h = this.handle;
    const e = new THREE.Euler().setFromQuaternion(h.quaternion, 'ZYX');
    const deg = THREE.MathUtils.radToDeg;
    return {
      position: [round(h.position.x), round(h.position.y), round(h.position.z)],
      rotation: [round(deg(e.x), 2), round(deg(e.y), 2), round(deg(e.z), 2)],
      scale: [round(h.scale.x), round(h.scale.y), round(h.scale.z)],
    };
  }

  /** Where the ground is below an object: how far it must move (in its parent's space) to stand on y = 0. */
  dropOffset(id: string): Vec3 | null {
    const inst = this.nodes.get(id);
    if (!inst?.length) return null;
    const box = this.bounds([inst[0]]);
    if (box.isEmpty()) return null;
    const parent = inst[0].parent;
    const delta = new THREE.Vector3(0, -box.min.y, 0);
    if (parent) {
      // the same move seen from the parent (a group may be turned or scaled)
      parent.updateWorldMatrix(true, false);
      delta.applyMatrix3(new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().copy(parent.matrixWorld).invert()));
    }
    return [round(delta.x), round(delta.y), round(delta.z)];
  }

  // ---- immediate feedback before the engine has built again -------------------------------------
  applyMaterial(name: string, s: Partial<MatSummary>): void {
    this.model?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const sm = mat as THREE.MeshStandardMaterial;
        if (!sm || sm.name !== name) continue;
        if (s.color) sm.color.set(s.color);
        if (s.roughness !== undefined) sm.roughness = s.roughness;
        if (s.metallic !== undefined) sm.metalness = s.metallic;
        if (s.emissive !== undefined) sm.emissive.set(s.emissive || '#000000');
        if (s.opacity !== undefined) {
          sm.opacity = s.opacity;
          sm.transparent = s.opacity < 0.999;
        }
        sm.needsUpdate = true;
      }
    });
  }

  setHidden(id: string, hidden: boolean): void {
    for (const n of this.nodes.get(id) ?? []) n.visible = !hidden;
  }

  capture(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const helper = this.gizmo.getHelper();
      const was = [this.grid.visible, this.axes.visible, helper.visible];
      this.grid.visible = this.axes.visible = helper.visible = false;
      this.boxes.forEach((b) => (b.visible = false));
      this.renderer.render(this.scene, this.camera);
      this.renderer.domElement.toBlob((b) => {
        [this.grid.visible, this.axes.visible, helper.visible] = was;
        this.boxes.forEach((x) => (x.visible = true));
        resolve(b);
      }, 'image/png');
    });
  }
}
