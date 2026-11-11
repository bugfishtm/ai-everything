// The list of everything in the scene: pick, rename, hide, drag to reorder or into a group.
import { Box, ChevronDown, ChevronRight, CircleAlert, Combine, Eye, EyeOff, FileBox, Group, Package } from 'lucide-react';
import { useState } from 'react';
import type { ObjNode } from './sceneDoc';
import type { SceneModel } from './types';

export type DropWhere = 'before' | 'after' | 'into';

export function KindIcon({ kind, size = 14 }: { kind: ObjNode['kind']; size?: number }) {
  if (kind === 'group') return <Group size={size} />;
  if (kind === 'boolean') return <Combine size={size} />;
  if (kind === 'use') return <Package size={size} />;
  if (kind === 'model') return <FileBox size={size} />;
  return <Box size={size} />;
}

interface Props {
  tree: ObjNode[];
  sel: string[];
  model: SceneModel | null;
  /** false while the build shown does not fit the text (counts and errors are of the old build) */
  fresh: boolean;
  onSelect: (id: string, additive: boolean, range: boolean) => void;
  onRename: (node: ObjNode, name: string) => void;
  onToggleVisible: (node: ObjNode) => void;
  onMenu: (node: ObjNode, x: number, y: number) => void;
  onDrop: (dragged: ObjNode, target: ObjNode | null, where: DropWhere) => void;
  onFrame: (node: ObjNode) => void;
}

export function Outliner({ tree, sel, model, fresh, onSelect, onRename, onToggleVisible, onMenu, onDrop, onFrame }: Props) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<ObjNode | null>(null);
  const [over, setOver] = useState<{ id: string; where: DropWhere } | null>(null);

  const zone = (e: React.DragEvent, node: ObjNode): DropWhere => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    if (node.kind === 'group' && f > 0.28 && f < 0.72) return 'into';
    return f < 0.5 ? 'before' : 'after';
  };
  const allowed = (node: ObjNode, where: DropWhere): boolean => {
    if (!drag || drag === node) return false;
    for (let p: ObjNode | null = node; p; p = p.parent) if (p === drag) return false; // not into itself
    if (drag.operand || node.operand) return !!drag.operand && !!node.operand && drag.parent === node.parent && where !== 'into';
    return true;
  };

  const rows: React.ReactNode[] = [];
  const walk = (n: ObjNode) => {
    const rec = fresh ? model?.objects[n.id] : undefined;
    const hidden = n.spec.visible === false;
    const isOver = over?.id === n.id ? over.where : null;
    rows.push(
      <div
        key={n.id}
        className={`s3-out-row${sel.includes(n.id) ? ' sel' : ''}${hidden ? ' hidden' : ''}${isOver ? ` drop-${isOver}` : ''}${n.operand ? ' operand' : ''}`}
        style={{ paddingLeft: 6 + n.depth * 14 }}
        draggable={renaming !== n.id}
        onDragStart={(e) => {
          setDrag(n);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', n.label);
        }}
        onDragEnd={() => {
          setDrag(null);
          setOver(null);
        }}
        onDragOver={(e) => {
          const where = zone(e, n);
          if (!allowed(n, where)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (over?.id !== n.id || over.where !== where) setOver({ id: n.id, where });
        }}
        onDragLeave={() => over?.id === n.id && setOver(null)}
        onDrop={(e) => {
          e.preventDefault();
          const where = zone(e, n);
          if (drag && allowed(n, where)) onDrop(drag, n, where);
          setDrag(null);
          setOver(null);
        }}
        onClick={(e) => onSelect(n.id, e.ctrlKey || e.metaKey, e.shiftKey)}
        onDoubleClick={() => onFrame(n)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(n, e.clientX, e.clientY);
        }}
        title={rec?.error ?? (n.operand ? 'a part of the boolean above' : undefined)}
      >
        {n.children.length > 0 ? (
          <button
            className="icon-mini"
            onClick={(e) => {
              e.stopPropagation();
              const next = new Set(closed);
              if (next.has(n.id)) next.delete(n.id);
              else next.add(n.id);
              setClosed(next);
            }}
          >
            {closed.has(n.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
        ) : (
          <span className="s3-out-gap" />
        )}
        <span className="s3-out-icon">
          <KindIcon kind={n.kind} />
        </span>
        {renaming === n.id ? (
          <input
            className="daw-input s3-out-rename"
            autoFocus
            defaultValue={typeof n.spec.name === 'string' ? n.spec.name : ''}
            placeholder={n.type}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              setRenaming(null);
              if (e.target.value.trim() !== (typeof n.spec.name === 'string' ? n.spec.name : '')) onRename(n, e.target.value.trim());
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(null);
            }}
          />
        ) : (
          <span
            className="s3-out-name ellipsis"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenaming(n.id);
            }}
          >
            {n.label}
          </span>
        )}
        {n.label !== n.type && renaming !== n.id && <span className="s3-out-type ellipsis">{n.type}</span>}
        <span className="spacer" />
        {rec?.error && <CircleAlert size={13} color="var(--danger)" />}
        {(rec?.instances ?? 1) > 1 && <span className="s3-out-count">×{rec!.instances}</span>}
        {!n.operand && (
          <button
            className={`icon-mini s3-out-eye${hidden ? ' on' : ''}`}
            title={hidden ? 'Hidden — show it' : 'Hide (visible: false)'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleVisible(n);
            }}
          >
            {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        )}
      </div>,
    );
    if (!closed.has(n.id)) n.children.forEach(walk);
  };
  tree.forEach(walk);

  return (
    <div
      className="s3-out"
      onDragOver={(e) => {
        if (drag && !drag.operand && e.target === e.currentTarget) {
          e.preventDefault();
          if (over) setOver(null);
        }
      }}
      onDrop={(e) => {
        if (drag && !drag.operand && e.target === e.currentTarget) {
          e.preventDefault();
          onDrop(drag, null, 'into');
        }
        setDrag(null);
        setOver(null);
      }}
    >
      {rows}
      {!tree.length && <div className="s3-out-empty faint small">Nothing here yet — add a shape with “Add”.</div>}
    </div>
  );
}
