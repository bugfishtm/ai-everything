// The Studio 3D editor: a visual editor for *.scene.yaml files. The YAML stays the save format — every
// edit is written back into the text (only the touched part), the real studio-3d engine builds it
// (also shapes of plugins an AI wrote) and the view shows exactly what the export will be.
import {
  AlertTriangle,
  Box,
  Combine,
  Copy,
  Download,
  Eye,
  Grid3x3,
  Group,
  Layers,
  Magnet,
  Maximize,
  MousePointer2,
  Move3d,
  Palette,
  PanelLeft,
  PanelRight,
  Plus,
  Redo2,
  Rotate3d,
  Scale3d,
  Settings2,
  Shapes,
  Trash2,
  Undo2,
  Ungroup,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg, type TreeNode } from '../api';
import { ContextMenu, Spinner, useUi, type MenuItem } from '../components/ui';
import { AddMenu, ExportDialog, ScenePanel, type AddChoice } from './dialogs';
import { Inspector } from './Inspector';
import { MaterialsPanel } from './MaterialsPanel';
import { Outliner, type DropWhere } from './Outliner';
import type { EditorCtx } from './params';
import * as sd from './sceneDoc';
import { YamlDoc, type Edit, type ObjNode } from './sceneDoc';
import { Stage } from './stage';
import type { Catalog, MatSummary, ModelError, ProjectPicture, SceneModel, Tool, Transform, Vec3 } from './types';
import '../daw/daw.css';
import './scene3d.css';

export interface SceneEditorProps {
  projectId: number;
  path: string;
  text: string;
  onChange: (text: string) => void;
  onSave: () => void | Promise<void>;
  refreshKey: number;
  onOpenFile?: (path: string) => void;
}

type Tab = 'object' | 'materials' | 'scene';
interface Snap {
  text: string;
  sel: string[];
}

/** Of the two ways to write the same rotation, the one closest to what was there (so "turn a bit" stays readable). */
function nearestEuler(prev: Vec3, cand: Vec3): Vec3 {
  const wrap = (v: number, ref: number) => v - 360 * Math.round((v - ref) / 360);
  const options: Vec3[] = [cand, [cand[0] + 180, 180 - cand[1], cand[2] + 180]];
  let best = cand;
  let cost = Infinity;
  for (const o of options) {
    const w: Vec3 = [wrap(o[0], prev[0]), wrap(o[1], prev[1]), wrap(o[2], prev[2])];
    const c = Math.abs(w[0] - prev[0]) + Math.abs(w[1] - prev[1]) + Math.abs(w[2] - prev[2]);
    if (c < cost - 1e-6) {
      cost = c;
      best = w;
    }
  }
  return [sd.round(best[0], 2), sd.round(best[1], 2), sd.round(best[2], 2)];
}

const MODEL_EXT = /\.(glb|gltf|obj|stl|ply)$/i;

export default function SceneEditor({ projectId, path, text, onChange, onSave, refreshKey, onOpenFile }: SceneEditorProps) {
  const ui = useUi();
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const [model, setModelState] = useState<SceneModel | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [sel, setSelState] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>('translate');
  const [space, setSpace] = useState<'local' | 'world'>('local');
  const [snap, setSnap] = useState(false);
  const [grid, setGrid] = useState(true);
  const [wire, setWire] = useState(false);
  const [tab, setTab] = useState<Tab>('object');
  const [selMat, setSelMat] = useState<string | null>(null);
  const [live, setLive] = useState<{ id: string; t: Transform } | null>(null);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [built, setBuilt] = useState<{ sig: string; byId: Map<string, ObjNode> } | null>(null);
  const [pictures, setPictures] = useState<ProjectPicture[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [showLeft, setShowLeft] = useState(() => window.innerWidth >= 1100);
  const [showRight, setShowRight] = useState(true);
  const [showMessages, setShowMessages] = useState(false);
  /** false after the tab was hidden for a while: its view (a GPU context — browsers allow only a few) is given back */
  const [alive, setAlive] = useState(true);

  const textRef = useRef(text);
  textRef.current = text;
  const selRef = useRef(sel);
  selRef.current = sel;
  const modelRef = useRef<SceneModel | null>(null);
  const validated = useRef<string | null>(null);
  const shownGlb = useRef<string | null | undefined>(undefined);
  const lastCamera = useRef<{ position: Vec3; target: Vec3 } | null>(null);
  const undoStack = useRef<Snap[]>([]);
  const redoStack = useRef<Snap[]>([]);
  const lastEdit = useRef<{ key?: string; at: number }>({ at: 0 });

  const setSel = useCallback((ids: string[]) => {
    selRef.current = ids;
    setSelState(ids);
  }, []);

  const doc = useMemo(() => new YamlDoc(text), [text]);
  const yamlError = doc.errors[0] ?? null;
  const tree = useMemo(() => sd.readTree(doc), [doc]);
  const byId = useMemo(() => new Map(sd.flatten(tree).map((n) => [n.id, n])), [tree]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const sig = useMemo(() => sd.signature(tree), [tree]);
  /** the model on screen was built from a text with the same objects: its ids fit */
  const fresh = !!built && built.sig === sig;
  const selNodes = useMemo(() => sel.map((id) => byId.get(id)).filter((n): n is ObjNode => !!n), [sel, byId]);
  const primary = selNodes[selNodes.length - 1] ?? null;

  // ---- the stage -------------------------------------------------------------------------------
  const onPickRef = useRef<(id: string | null, additive: boolean) => void>(() => {});
  const onTransformRef = useRef<(id: string, t: Transform, done: boolean) => void>(() => {});
  const onContextRef = useRef<(id: string | null, x: number, y: number) => void>(() => {});
  useEffect(() => {
    if (!alive) return;
    const stage = new Stage(hostRef.current!, {
      onPick: (id, additive) => onPickRef.current(id, additive),
      onTransform: (id, t, done) => onTransformRef.current(id, t, done),
      onContext: (id, x, y) => onContextRef.current(id, x, y),
    });
    stageRef.current = stage;
    (hostRef.current as unknown as { __stage?: Stage }).__stage = stage; // for tests and debugging in the browser console
    validated.current = null; // a new stage is empty: build and show again
    const hadView = shownGlb.current !== undefined && shownGlb.current !== null;
    shownGlb.current = hadView ? null : undefined; // coming back from a hidden tab: keep where the user was looking
    if (hadView && lastCamera.current) stage.setCamera(lastCamera.current.position, lastCamera.current.target);
    return () => {
      lastCamera.current = stage.cameraState();
      stage.dispose();
      stageRef.current = null;
    };
  }, [alive]);

  // an editor in a hidden tab gives its view back after a while and makes a new one when it is shown again
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let timer: number | undefined;
    const check = () => {
      if (el.clientWidth > 0) {
        window.clearTimeout(timer);
        timer = undefined;
        setAlive(true);
      } else if (timer === undefined) {
        timer = window.setTimeout(() => {
          timer = undefined;
          if (el.clientWidth === 0) setAlive(false);
        }, 20_000);
      }
    };
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  // ---- engine: build the text (debounced), catalog, lists --------------------------------------
  const refresh = useCallback(
    async (t: string) => {
      setSyncing(true);
      try {
        const r = await api<SceneModel | ModelError>(`/projects/${projectId}/3d/model`, { body: { path, text: t } });
        if (t !== textRef.current) return; // the text moved on, a newer request follows
        if (!r.ok) {
          if (r.superseded) return;
          validated.current = t;
          setEngineError(r.error ?? 'the scene could not be built');
          return;
        }
        validated.current = t;
        const stage = stageRef.current;
        if (stage && r.glb !== shownGlb.current) {
          // the first look is through the scene's own camera (what the preview shows), when it has one
          const first = shownGlb.current === undefined && Array.isArray(r.camera?.position) && r.camera.position.length === 3;
          if (first) stage.setCamera(r.camera!.position, Array.isArray(r.camera!.target) && r.camera!.target.length === 3 ? r.camera!.target : [0, 0, 0]);
          const shown = await stage.load(r.glb ? `/api/projects/${projectId}/3d/cache/edit/${r.glb}` : null);
          if (!shown) return;
          shownGlb.current = r.glb;
        }
        const tr = sd.readTree(new YamlDoc(t));
        setBuilt({ sig: sd.signature(tr), byId: new Map(sd.flatten(tr).map((n) => [n.id, n])) });
        modelRef.current = r;
        setModelState(r);
        setEngineError(null);
      } catch (err) {
        if (t === textRef.current) setEngineError(errMsg(err));
      } finally {
        setSyncing(false);
      }
    },
    [projectId, path],
  );

  useEffect(() => {
    if (!alive || validated.current === text) return;
    const h = setTimeout(() => void refresh(text), modelRef.current ? 320 : 0);
    return () => clearTimeout(h);
  }, [text, refresh, alive]);

  const loadLists = useCallback(() => {
    api<Catalog>(`/projects/${projectId}/3d/catalog`)
      .then((c) => c.ok && setCatalog(c))
      .catch(() => {});
    api<{ ok: boolean; files?: ProjectPicture[] }>(`/projects/${projectId}/3d/texture`, { body: { list: true } })
      .then((r) => setPictures(r.files ?? []))
      .catch(() => {});
    api<{ tree: TreeNode }>(`/projects/${projectId}/tree`)
      .then((r) => {
        const out: string[] = [];
        const walk = (n?: TreeNode) => {
          for (const c of n?.children ?? []) {
            if (c.type === 'file' && MODEL_EXT.test(c.name)) out.push(c.path);
            else if (c.type === 'dir' && !c.lazy && !c.name.startsWith('.') && c.name !== 'node_modules') walk(c);
          }
        };
        walk(r.tree);
        setModels(out.slice(0, 300));
      })
      .catch(() => {});
  }, [projectId]);
  const reloadPictures = useCallback(() => {
    api<{ ok: boolean; files?: ProjectPicture[] }>(`/projects/${projectId}/3d/texture`, { body: { list: true } })
      .then((r) => setPictures(r.files ?? []))
      .catch(() => {});
  }, [projectId]);
  useEffect(() => loadLists(), [loadLists]);

  // project files changed (the AI wrote a plugin, a texture was rendered …): new shapes, a new build
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    loadLists();
    validated.current = null;
    void refresh(textRef.current);
  }, [refreshKey, loadLists, refresh]);

  // ---- edits --------------------------------------------------------------------------------------
  const edit = useCallback(
    (fn: (d: YamlDoc) => YamlDoc | Edit, coalesce?: string): boolean => {
      const cur = textRef.current;
      let next: YamlDoc;
      let select: string[] | undefined;
      try {
        const d = new YamlDoc(cur);
        if (d.errors.length) throw new Error(`The file has a YAML error — fix it in the Code view first: ${d.errors[0]}`);
        const r = fn(d);
        if (r instanceof YamlDoc) next = r;
        else {
          next = r.doc;
          select = r.select;
        }
      } catch (err) {
        ui.toast(errMsg(err), 'error');
        return false;
      }
      if (next.text !== cur) {
        const now = Date.now();
        if (!(coalesce && lastEdit.current.key === coalesce && now - lastEdit.current.at < 2000)) {
          undoStack.current.push({ text: cur, sel: selRef.current });
          if (undoStack.current.length > 300) undoStack.current.shift();
          redoStack.current = [];
        }
        lastEdit.current = { key: coalesce, at: now };
        textRef.current = next.text;
        setHist({ undo: undoStack.current.length, redo: 0 });
        onChange(next.text);
      }
      if (select) setSel(select);
      return true;
    },
    [onChange, setSel, ui],
  );

  const step = useCallback(
    (from: React.MutableRefObject<Snap[]>, to: React.MutableRefObject<Snap[]>) => {
      const e = from.current.pop();
      if (!e) return;
      to.current.push({ text: textRef.current, sel: selRef.current });
      textRef.current = e.text;
      lastEdit.current = { at: 0 };
      setHist({ undo: undoStack.current.length, redo: redoStack.current.length });
      setSel(e.sel);
      onChange(e.text);
    },
    [onChange, setSel],
  );
  const undo = useCallback(() => step(undoStack, redoStack), [step]);
  const redo = useCallback(() => step(redoStack, undoStack), [step]);

  // a selection that no longer exists (undo, edits in the Code view) goes away
  useEffect(() => {
    if (sel.some((id) => !byId.has(id))) setSel(sel.filter((id) => byId.has(id)));
  }, [sel, byId, setSel]);

  // ---- selection and gizmo follow the text ---------------------------------------------------------
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.pickable = fresh;
    stage.setSelection(fresh ? sel : []);
    const node = primary;
    if (!node || !fresh || !model) {
      stage.attach(null);
      return;
    }
    const was = built?.byId.get(node.id);
    stage.attach({
      id: node.id,
      transform: sd.transformOf(node.spec),
      built: was ? sd.transformOf(was.spec) : null,
      parentId: node.parent?.id ?? null,
      scatter: !!node.spec.scatter && node.kind !== 'group',
      bounds: model.objects[node.id]?.bounds ?? null,
    });
  }, [sel, primary, model, built, fresh, alive]);

  useEffect(() => stageRef.current?.setTool(tool), [tool, alive]);
  useEffect(() => stageRef.current?.setSpace(space), [space, alive]);
  useEffect(() => stageRef.current?.setSnap(snap), [snap, alive]);
  useEffect(() => stageRef.current?.setGrid(grid), [grid, alive]);
  useEffect(() => stageRef.current?.setWire(wire), [wire, model, alive]);

  // objects hidden in the text disappear at once (the next build leaves them out)
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !fresh) return;
    for (const n of byId.values()) stage.setHidden(n.id, n.spec.visible === false);
  }, [byId, fresh, model]);

  onPickRef.current = (id, additive) => {
    if (!id) {
      if (!additive) setSel([]);
      return;
    }
    const cur = selRef.current;
    setSel(additive ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]);
    setTab('object');
  };

  const toolRef = useRef(tool);
  toolRef.current = tool;
  onTransformRef.current = (id, t, done) => {
    const node = byIdRef.current.get(id);
    if (!node) return;
    const cur = sd.transformOf(node.spec);
    const next: Transform = { ...t, rotation: toolRef.current === 'rotate' ? nearestEuler(cur.rotation, t.rotation) : cur.rotation };
    if (!done) {
      setLive({ id, t: next });
      return;
    }
    setLive(null);
    // only what the tool changes is written, so the rest of the line stays as it was typed
    const part: Partial<Transform> = toolRef.current === 'translate' ? { position: next.position } : toolRef.current === 'rotate' ? { rotation: next.rotation, position: next.position } : { scale: next.scale };
    if (toolRef.current === 'rotate' && next.position.every((v, i) => Math.abs(v - cur.position[i]) < 1e-6)) delete part.position;
    edit((d) => sd.setTransform(d, node.path, part));
  };

  // ---- actions --------------------------------------------------------------------------------------
  const groupTarget = primary && primary.kind === 'group' ? primary : null;

  const add = (c: AddChoice) => {
    setAddOpen(false);
    const spec: Record<string, unknown> = { name: sd.uniqueName(tree, c.name), ...JSON.parse(JSON.stringify(c.spec)) };
    // a new object appears where you are looking (on the ground), not hidden inside what is at the origin
    const target = stageRef.current?.cameraState().target;
    if (!groupTarget && target && tree.length) {
      const x = Math.round(target[0] * 4) / 4;
      const z = Math.round(target[2] * 4) / 4;
      if (x || z) spec.position = [x, 0, z];
    }
    edit((d) => sd.addObject(d, tree, groupTarget, spec));
    setTab('object');
  };

  const removeSel = useCallback(() => {
    if (!selNodes.length) return;
    const blocked = selNodes.find((n) => n.operand && (n.parent?.children.length ?? 0) <= 2 && !selNodes.includes(n.parent!));
    if (blocked) return ui.toast('A boolean needs at least two parts — delete the boolean itself, or add another part first', 'info');
    edit((d) => sd.removeObjects(d, selNodes));
  }, [edit, selNodes, ui]);

  const duplicateSel = useCallback(() => {
    if (!primary) return;
    edit((d) => sd.duplicate(d, tree, primary));
  }, [edit, primary, tree]);

  const frameSel = useCallback(() => {
    stageRef.current?.frame(selRef.current.length ? selRef.current : undefined);
  }, []);

  const toggleVisible = useCallback(
    (nodes: ObjNode[]) => {
      if (!nodes.length) return;
      const hide = nodes.some((n) => n.spec.visible !== false);
      edit((d) => nodes.reduce((x, n) => sd.setField(x, n.path, 'visible', hide ? false : undefined), d));
    },
    [edit],
  );

  const dropToGround = useCallback(
    (node: ObjNode) => {
      const off = stageRef.current?.dropOffset(node.id);
      if (!off) return ui.toast('It is not built yet — wait for the view to update', 'info');
      const p = sd.transformOf(node.spec).position;
      edit((d) => sd.setTransform(d, node.path, { position: [p[0] + off[0], p[1] + off[1], p[2] + off[2]] }));
    },
    [edit, ui],
  );

  const onDrop = (dragged: ObjNode, target: ObjNode | null, where: DropWhere) => {
    edit((d) => {
      if (!target) return sd.reparent(d, tree, dragged, null);
      if (where === 'into') return sd.reparent(d, tree, dragged, target);
      if (dragged.operand) return sd.moveInList(d, dragged, where === 'before' ? (target.index > dragged.index ? target.index - 1 : target.index) : target.index > dragged.index ? target.index : target.index + 1);
      return sd.reparent(d, tree, dragged, target.parent && target.parent.kind === 'group' ? target.parent : null, where === 'before' ? target.index : target.index + 1);
    });
  };

  const nodeMenu = (node: ObjNode | null, x: number, y: number) => {
    if (!node) return;
    const nodes = selRef.current.includes(node.id) ? selNodes : [node];
    if (!selRef.current.includes(node.id)) setSel([node.id]);
    const items: MenuItem[] = [
      { label: 'Look at it', icon: <Maximize size={14} />, onClick: () => stageRef.current?.frame(nodes.map((n) => n.id)) },
      { label: 'Duplicate', icon: <Copy size={14} />, onClick: () => edit((d) => sd.duplicate(d, tree, node)) },
      { label: nodes.some((n) => n.spec.visible !== false) ? 'Hide' : 'Show', icon: <Eye size={14} />, onClick: () => toggleVisible(nodes.filter((n) => !n.operand)) },
    ];
    if (!node.operand) {
      items.push({ divider: true, label: '', onClick: () => {} });
      items.push({ label: nodes.length > 1 ? `Group these ${nodes.length}` : 'Put into a new group', icon: <Group size={14} />, onClick: () => edit((d) => sd.groupNodes(d, tree, nodes)) });
      if (node.kind === 'group') items.push({ label: 'Ungroup', icon: <Ungroup size={14} />, onClick: () => edit((d) => sd.ungroup(d, node)) });
      if (nodes.length > 1) {
        items.push({ label: 'Combine: cut the others out of the first', icon: <Combine size={14} />, onClick: () => edit((d) => sd.booleanFrom(d, tree, nodes, 'difference')) });
        items.push({ label: 'Combine: melt into one', icon: <Combine size={14} />, onClick: () => edit((d) => sd.booleanFrom(d, tree, nodes, 'union')) });
        items.push({ label: 'Combine: keep only the overlap', icon: <Combine size={14} />, onClick: () => edit((d) => sd.booleanFrom(d, tree, nodes, 'intersection')) });
      }
      items.push({ label: 'Stand on the ground', onClick: () => dropToGround(node) });
    }
    items.push({ divider: true, label: '', onClick: () => {} });
    items.push({
      label: nodes.length > 1 ? `Delete ${nodes.length} objects` : 'Delete',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => {
        const blocked = nodes.find((n) => n.operand && (n.parent?.children.length ?? 0) <= 2);
        if (blocked) return ui.toast('A boolean needs at least two parts', 'info');
        edit((d) => sd.removeObjects(d, nodes));
      },
    });
    setMenu({ x, y, items });
  };
  onContextRef.current = (id, x, y) => nodeMenu(id ? (byIdRef.current.get(id) ?? null) : null, x, y);

  const selectFromList = (id: string, additive: boolean, range: boolean) => {
    const cur = selRef.current;
    if (range && cur.length) {
      const order = sd.flatten(tree).map((n) => n.id);
      const a = order.indexOf(cur[cur.length - 1]);
      const b = order.indexOf(id);
      if (a >= 0 && b >= 0) {
        const span = order.slice(Math.min(a, b), Math.max(a, b) + 1);
        setSel([...new Set([...cur.filter((x) => !span.includes(x)), ...(a < b ? span : span.reverse())])]);
        setTab('object');
        return;
      }
    }
    setSel(additive ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]);
    setTab('object');
  };

  const liveMaterial = useCallback((name: string, s: Partial<MatSummary>) => stageRef.current?.applyMaterial(name, s), []);

  const cameraFromView = () => {
    const c = stageRef.current?.cameraState();
    if (c) edit((d) => d.set(['camera'], { position: c.position, target: c.target }));
  };
  const viewFromCamera = () => {
    const c = doc.get(['camera']);
    if (sd.isObj(c)) stageRef.current?.setCamera(Array.isArray(c.position) ? (c.position as Vec3) : undefined, Array.isArray(c.target) ? (c.target as Vec3) : undefined);
  };

  // keyboard: tools, delete, duplicate, undo/redo, save
  const onKey = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 's') {
      e.preventDefault();
      void onSave();
      return;
    }
    if (typing) return;
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && k === 'd') {
      e.preventDefault();
      duplicateSel();
    } else if (mod && k === 'g') {
      e.preventDefault();
      if (selNodes.length) edit((d) => sd.groupNodes(d, tree, selNodes));
    } else if (mod && k === 'a') {
      e.preventDefault();
      setSel(tree.map((n) => n.id));
    } else if (mod) {
      return;
    } else if (k === 'delete' || k === 'backspace') {
      e.preventDefault();
      removeSel();
    } else if (k === 'q') setTool('select');
    else if (k === 'w' || k === 'g') setTool('translate');
    else if (k === 'e' || k === 'r') setTool(k === 'e' ? 'rotate' : 'scale');
    else if (k === 'f') frameSel();
    else if (k === 'h') toggleVisible(selNodes.filter((n) => !n.operand));
    else if (k === 'escape') setSel([]);
    else if (k === 'x') setSnap((s) => !s);
  };

  const ctx: EditorCtx = {
    projectId,
    path,
    catalog,
    model,
    fresh,
    tree,
    doc,
    edit,
    select: (ids) => {
      setSel(ids);
      setTab('object');
    },
    openMaterial: (name) => {
      setSelMat(name);
      setTab('materials');
      setShowRight(true);
    },
    liveMaterial,
    dropToGround,
    toast: ui.toast,
    prompt: ui.prompt,
    confirm: ui.confirm,
    openFile: onOpenFile,
    pictures,
    reloadPictures,
    models,
  };

  const errors = fresh ? (model?.errors ?? []) : [];
  const warnCount = (model?.warnings.length ?? 0) + (model?.pluginErrors.length ?? 0);
  const toolBtn = (t: Tool, icon: React.ReactNode, title: string) => (
    <button className={`btn sm icon ${tool === t ? 'primary' : 'ghost'}`} onClick={() => setTool(t)} title={title}>
      {icon}
    </button>
  );

  return (
    <div className="s3" ref={rootRef} tabIndex={0} onKeyDown={onKey}>
      <div className="s3-bar">
        <button className={`btn sm icon ghost${showLeft ? ' on' : ''}`} onClick={() => setShowLeft(!showLeft)} title="Objects list">
          <PanelLeft size={15} />
        </button>
        <div className="seg">
          {toolBtn('select', <MousePointer2 size={15} />, 'Select (Q)')}
          {toolBtn('translate', <Move3d size={15} />, 'Move (W)')}
          {toolBtn('rotate', <Rotate3d size={15} />, 'Rotate (E)')}
          {toolBtn('scale', <Scale3d size={15} />, 'Scale (R)')}
        </div>
        <button className="btn sm ghost" onClick={() => setSpace(space === 'local' ? 'world' : 'local')} title="Move along the object's own directions (local) or along the scene's (world)">
          {space}
        </button>
        <button className={`btn sm icon ghost${snap ? ' on' : ''}`} onClick={() => setSnap(!snap)} title="Snap: 0.25 m, 15°, 0.1 (X)">
          <Magnet size={15} />
        </button>
        <span className="s3-sep" />
        <span style={{ position: 'relative' }}>
          <button className="btn sm" onClick={() => setAddOpen(!addOpen)} title="Add a shape, a group, a pack model …">
            <Plus size={15} /> Add
          </button>
          {addOpen && <AddMenu catalog={catalog} models={models} into={groupTarget?.label ?? null} onAdd={add} onClose={() => setAddOpen(false)} />}
        </span>
        <button className="btn sm icon ghost" disabled={!primary} onClick={duplicateSel} title="Duplicate (Ctrl+D)">
          <Copy size={15} />
        </button>
        <button className="btn sm icon ghost" disabled={!selNodes.length} onClick={removeSel} title="Delete (Del)">
          <Trash2 size={15} />
        </button>
        <span className="s3-sep" />
        <button className="btn sm icon ghost" disabled={!hist.undo} onClick={undo} title="Undo (Ctrl+Z)">
          <Undo2 size={15} />
        </button>
        <button className="btn sm icon ghost" disabled={!hist.redo} onClick={redo} title="Redo (Ctrl+Y)">
          <Redo2 size={15} />
        </button>
        <span className="spacer" />
        {syncing ? (
          <span className="s3-status">
            <Spinner size={12} /> building
          </span>
        ) : model ? (
          <span className="s3-status faint" title={`built in ${model.seconds}s`}>
            {model.stats.triangles.toLocaleString()} triangles
          </span>
        ) : null}
        {(errors.length > 0 || warnCount > 0) && (
          <button className={`btn sm ghost s3-warn${errors.length ? ' err' : ''}`} onClick={() => setShowMessages(!showMessages)} title="Messages of the last build">
            <AlertTriangle size={14} /> {errors.length + warnCount}
          </button>
        )}
        <button className="btn sm primary" onClick={() => setExportOpen(true)} title="Build the model: .glb for games and the web, .stl for 3D printing, .obj">
          <Download size={15} /> Build
        </button>
        <button className={`btn sm icon ghost${showRight ? ' on' : ''}`} onClick={() => setShowRight(!showRight)} title="Properties">
          <PanelRight size={15} />
        </button>
      </div>

      {(yamlError || engineError || showMessages) && (
        <div className="s3-banners">
          {yamlError && (
            <div className="notice error">
              <AlertTriangle size={15} />
              <span>The file has a YAML error — fix it in the Code view: {yamlError}</span>
            </div>
          )}
          {engineError && !yamlError && (
            <div className="notice error">
              <AlertTriangle size={15} />
              <span style={{ whiteSpace: 'pre-wrap' }}>{engineError}</span>
            </div>
          )}
          {showMessages && (
            <>
              {errors.map((e, i) => (
                <button key={`e${i}`} className="notice error s3-msg-btn" onClick={() => e.id && byId.has(e.id) && ctx.select([e.id])}>
                  <AlertTriangle size={15} />
                  <span>{e.error}</span>
                </button>
              ))}
              {(model?.pluginErrors ?? []).map((e, i) => (
                <div key={`p${i}`} className="notice error">
                  <AlertTriangle size={15} />
                  <span>
                    plugin {e.file}: {e.error}
                  </span>
                </div>
              ))}
              {(model?.warnings ?? []).map((w, i) => (
                <div key={`w${i}`} className="notice info">
                  <AlertTriangle size={15} color="var(--warn)" />
                  <span>{w}</span>
                </div>
              ))}
              <button className="icon-mini s3-banners-close" onClick={() => setShowMessages(false)} title="Hide">
                <X size={12} />
              </button>
            </>
          )}
        </div>
      )}

      <div className="s3-main">
        {showLeft && (
          <div className="s3-left">
            <div className="s3-panel-head">
              <Layers size={13} /> Objects
              <span className="spacer" />
              <span className="faint small">{byId.size}</span>
            </div>
            <Outliner
              tree={tree}
              sel={sel}
              model={model}
              fresh={fresh}
              onSelect={selectFromList}
              onRename={(n, name) => edit((d) => sd.setField(d, n.path, 'name', name || undefined))}
              onToggleVisible={(n) => toggleVisible([n])}
              onMenu={nodeMenu}
              onDrop={onDrop}
              onFrame={(n) => stageRef.current?.frame([n.id])}
            />
          </div>
        )}
        <div className="s3-view" onPointerDown={() => rootRef.current?.focus({ preventScroll: true })}>
          <div className="s3-canvas" ref={hostRef} />
          {!model && !engineError && (
            <div className="center s3-view-wait">
              <Spinner size={22} />
            </div>
          )}
          {model && !model.glb && !syncing && (
            <div className="center s3-view-wait">
              <div className="s3-empty">
                <Shapes size={26} />
                <div>The scene is empty.</div>
                <button className="btn sm primary" onClick={() => setAddOpen(true)}>
                  <Plus size={14} /> Add a shape
                </button>
              </div>
            </div>
          )}
          <div className="s3-hud">
            <button className="btn sm" onClick={frameSel} title={sel.length ? 'Look at the selection (F)' : 'Look at everything (F)'}>
              <Maximize size={14} />
            </button>
            <div className="seg s3-views">
              {(
                [
                  ['Front', [0, 0.0001, 1]],
                  ['Side', [1, 0.0001, 0]],
                  ['Top', [0, 1, 0.0001]],
                  ['3D', [0.6, 0.45, 0.8]],
                ] as [string, Vec3][]
              ).map(([label, dir]) => (
                <button key={label} className="btn sm" onClick={() => stageRef.current?.view(dir)} title={`Look from: ${label.toLowerCase()}`}>
                  {label}
                </button>
              ))}
            </div>
            <button className={`btn sm ${grid ? 'primary' : ''}`} onClick={() => setGrid(!grid)} title="Grid (1 m)">
              <Grid3x3 size={14} />
            </button>
            <button className={`btn sm ${wire ? 'primary' : ''}`} onClick={() => setWire(!wire)} title="Wireframe">
              <Box size={14} />
            </button>
          </div>
          {!fresh && model && !engineError && <div className="s3-stale">updating…</div>}
          {live && (
            <div className="s3-live mono">
              {tool === 'translate' && `x ${live.t.position[0]}  y ${live.t.position[1]}  z ${live.t.position[2]}`}
              {tool === 'rotate' && `${live.t.rotation[0]}°  ${live.t.rotation[1]}°  ${live.t.rotation[2]}°`}
              {tool === 'scale' && `× ${live.t.scale[0]}  ${live.t.scale[1]}  ${live.t.scale[2]}`}
            </div>
          )}
        </div>
        {showRight && (
          <div className="s3-right">
            <div className="s3-tabs">
              <button className={`tab${tab === 'object' ? ' active' : ''}`} onClick={() => setTab('object')}>
                <Box size={13} /> Object
              </button>
              <button className={`tab${tab === 'materials' ? ' active' : ''}`} onClick={() => setTab('materials')}>
                <Palette size={13} /> Materials
              </button>
              <button className={`tab${tab === 'scene' ? ' active' : ''}`} onClick={() => setTab('scene')}>
                <Settings2 size={13} /> Scene
              </button>
            </div>
            <div className="s3-right-body">
              {tab === 'object' &&
                (primary ? (
                  <>
                    {selNodes.length > 1 && (
                      <div className="s3-multi">
                        <b>{selNodes.length} objects selected</b>
                        <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                          <button className="btn sm" onClick={() => edit((d) => sd.groupNodes(d, tree, selNodes))} title="Ctrl+G">
                            <Group size={13} /> Group
                          </button>
                          <button className="btn sm" onClick={() => edit((d) => sd.booleanFrom(d, tree, selNodes, 'difference'))} title="Cut the others out of the first one">
                            <Combine size={13} /> Cut
                          </button>
                          <button className="btn sm" onClick={() => edit((d) => sd.booleanFrom(d, tree, selNodes, 'union'))} title="Melt them into one">
                            <Combine size={13} /> Join
                          </button>
                        </div>
                        <div className="s3-hint" style={{ padding: '6px 0 0' }}>Below: the one selected last ({primary.label}).</div>
                      </div>
                    )}
                    <Inspector key={primary.id} ctx={ctx} node={primary} live={live && live.id === primary.id ? live.t : null} />
                  </>
                ) : (
                  <div className="s3-hint pad">
                    Click an object in the view or in the list to change it — or add one with <b>Add</b>.
                    <br />
                    <br />
                    Drag in the view to look around, right-drag to pan, wheel to zoom. W / E / R: move, rotate, scale. F: look at the selection.
                    <br />
                    <br />
                    Everything you do here is written into the scene file ({path}); the Code view shows the text, and the AI can edit the same file.
                  </div>
                ))}
              {tab === 'materials' && <MaterialsPanel ctx={ctx} selected={selMat} onSelect={setSelMat} sel={sel} />}
              {tab === 'scene' && <ScenePanel ctx={ctx} model={model} onSelect={(id) => byId.has(id) && ctx.select([id])} cameraFromView={cameraFromView} viewFromCamera={viewFromCamera} />}
            </div>
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {exportOpen && <ExportDialog projectId={projectId} path={path} text={() => textRef.current} onClose={() => setExportOpen(false)} onOpenFile={onOpenFile} save={onSave} />}
    </div>
  );
}
