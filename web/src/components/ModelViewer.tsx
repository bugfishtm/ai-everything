import { Grid3x3, Maximize, Orbit, Pencil, Plus, Shapes } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { api, errMsg } from '../api';
import { basename, ext } from '../util';
import { Spinner, useUi } from './ui';

export interface ModelViewerHandle {
  capture: () => Promise<Blob | null>;
}

interface Ctx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  grid: THREE.GridHelper;
  model: THREE.Object3D | null;
  frame: () => void;
}

function forEachMaterial(obj: THREE.Object3D, fn: (m: THREE.Material) => void): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => m && fn(m));
  });
}

interface Props {
  url: string;
  fileName: string;
  /** in a project: a model built by studio-3d can be opened as its scene, any model can be put into a new scene */
  projectId?: number;
  onOpenFile?: (path: string) => void;
}

export const ModelViewer = forwardRef<ModelViewerHandle, Props>(function ModelViewer({ url, fileName, projectId, onOpenFile }, ref) {
  const ui = useUi();
  const host = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const ctx = useRef<Ctx | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [stats, setStats] = useState<{ tris: number; meshes: number; size: string } | null>(null);
  const [wire, setWire] = useState(false);
  const [spin, setSpin] = useState(false);
  const [grid, setGrid] = useState(true);

  useEffect(() => {
    const el = host.current!;
    setState('loading');
    setStats(null);
    setSource(null);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = 0.5; // a flat surface then shows the color it was given
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 6, 4);
    scene.add(sun);
    const gridHelper = new THREE.GridHelper(10, 20, 0x3a4457, 0x1f2633);
    scene.add(gridHelper);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    camera.position.set(3, 2, 4);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotateSpeed = 1.5;

    let disposed = false;
    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    const frameObject = (obj: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      gridHelper.position.set(center.x, box.min.y, center.z);
      gridHelper.scale.setScalar(Math.max(maxDim * 0.3, 0.001));
      const dist = (maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.5;
      camera.position.copy(center).add(new THREE.Vector3(dist * 0.6, dist * 0.45, dist * 0.8));
      camera.near = maxDim / 500;
      camera.far = maxDim * 200;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
    };

    const c: Ctx = { renderer, scene, camera, controls, grid: gridHelper, model: null, frame: () => c.model && frameObject(c.model) };
    ctx.current = c;

    const onLoaded = (obj: THREE.Object3D) => {
      if (disposed) return;
      scene.add(obj);
      c.model = obj;
      frameObject(obj);
      let tris = 0;
      let meshes = 0;
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) {
          meshes++;
          const g = m.geometry;
          tris += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
        }
      });
      const s = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
      setStats({ tris: Math.round(tris), meshes, size: `${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)}` });
      setState('ready');
    };
    const onError = (err: unknown) => {
      if (disposed) return;
      setError((err as Error)?.message || String(err));
      setState('error');
    };
    const defaultMaterial = () => new THREE.MeshStandardMaterial({ color: 0xb8c0d0, roughness: 0.55, metalness: 0.05 });

    const e = ext(fileName);
    try {
      if (e === 'glb' || e === 'gltf') {
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        loader.load(
          url,
          (g) => {
            onLoaded(g.scene);
            // studio-3d writes the scene file a model was built from into the .glb
            const src = (g.asset as { extras?: { studio_source?: unknown } } | undefined)?.extras?.studio_source;
            if (typeof src === 'string' && projectId && !disposed) {
              api(`/projects/${projectId}/file?path=${encodeURIComponent(src)}`)
                .then(() => !disposed && setSource(src))
                .catch(() => {});
            }
          },
          undefined,
          onError,
        );
      } else if (e === 'obj') {
        new OBJLoader().load(url, onLoaded, undefined, onError);
      } else if (e === 'stl') {
        new STLLoader().load(url, (geo) => {
          geo.computeVertexNormals();
          onLoaded(new THREE.Mesh(geo, defaultMaterial()));
        }, undefined, onError);
      } else if (e === 'ply') {
        new PLYLoader().load(url, (geo) => {
          geo.computeVertexNormals();
          const m = defaultMaterial();
          if (geo.getAttribute('color')) m.vertexColors = true;
          onLoaded(new THREE.Mesh(geo, m));
        }, undefined, onError);
      } else if (e === 'fbx') {
        new FBXLoader().load(url, onLoaded, undefined, onError);
      } else {
        onError(new Error(`.${e} files cannot be previewed`));
      }
    } catch (err) {
      onError(err);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => mat?.dispose());
        }
      });
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      ctx.current = null;
    };
  }, [url, fileName, projectId]);

  /** A new scene file with this model in it: arrange it, give it materials and textures, add shapes around it. */
  const useInScene = async () => {
    if (!projectId || !onOpenFile) return;
    const stem = basename(fileName).split('.')[0].replace(/[^\w.-]+/g, '-') || 'model';
    const exists = async (rel: string) => {
      try {
        await api(`/projects/${projectId}/file?path=${encodeURIComponent(rel)}`);
        return true;
      } catch {
        return false;
      }
    };
    try {
      let target = `src/${stem}.scene.yaml`;
      for (let i = 2; await exists(target); i++) target = `src/${stem}-${i}.scene.yaml`;
      const title = stem.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const content = `# ${title} — a scene around ${fileName} (open it in the 3D editor; reference: studio-3d docs)\nscene:\n  name: ${title}\n\nobjects:\n  - { name: ${stem}, model: ${/^[\w./-]+$/.test(fileName) ? fileName : JSON.stringify(fileName)} }\n`;
      await api(`/projects/${projectId}/file`, { method: 'PUT', body: { path: target, content } });
      onOpenFile(target);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  useEffect(() => {
    if (ctx.current?.model) forEachMaterial(ctx.current.model, (m) => ((m as THREE.MeshStandardMaterial).wireframe = wire));
  }, [wire, state]);
  useEffect(() => {
    if (ctx.current) ctx.current.controls.autoRotate = spin;
  }, [spin, state]);
  useEffect(() => {
    if (ctx.current) ctx.current.grid.visible = grid;
  }, [grid, state]);

  useImperativeHandle(
    ref,
    () => ({
      capture: () =>
        new Promise<Blob | null>((resolve) => {
          const c = ctx.current;
          if (!c) return resolve(null);
          c.grid.visible = false;
          c.renderer.render(c.scene, c.camera);
          c.renderer.domElement.toBlob((b) => {
            c.grid.visible = grid;
            resolve(b);
          }, 'image/png');
        }),
    }),
    [grid],
  );

  return (
    <div className="model-view" ref={host}>
      {state === 'loading' && (
        <div className="center" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <Spinner size={22} />
        </div>
      )}
      {state === 'error' && (
        <div className="center" style={{ position: 'absolute', inset: 0, padding: 24, textAlign: 'center' }}>
          <div className="notice error">Could not load the model: {error}</div>
        </div>
      )}
      {state === 'ready' && (
        <>
          <div className="model-hud">
            <button className={`btn sm ${spin ? 'primary' : ''}`} onClick={() => setSpin(!spin)} title="Auto rotate">
              <Orbit size={14} /> Rotate
            </button>
            <button className={`btn sm ${wire ? 'primary' : ''}`} onClick={() => setWire(!wire)} title="Wireframe">
              <Shapes size={14} /> Wire
            </button>
            <button className={`btn sm ${grid ? 'primary' : ''}`} onClick={() => setGrid(!grid)} title="Grid">
              <Grid3x3 size={14} />
            </button>
            <button className="btn sm" onClick={() => ctx.current?.frame()} title="Frame model">
              <Maximize size={14} />
            </button>
            {source && onOpenFile && (
              <button className="btn sm primary" onClick={() => onOpenFile(source)} title={`Built from ${source} — open that scene in the 3D editor, change it and build again`}>
                <Pencil size={14} /> Edit scene
              </button>
            )}
            {!source && projectId && onOpenFile && /^(glb|gltf|obj|stl|ply)$/.test(ext(fileName)) && (
              <button className="btn sm" onClick={() => void useInScene()} title="Make a scene that contains this model: arrange it, give it materials and textures, add shapes">
                <Plus size={14} /> Use in a scene
              </button>
            )}
          </div>
          {stats && (
            <div className="model-stats">
              {stats.tris.toLocaleString()} triangles · {stats.meshes} mesh{stats.meshes === 1 ? '' : 'es'}
              <br />
              {stats.size} units
            </div>
          )}
        </>
      )}
    </div>
  );
});
