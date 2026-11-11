// One parameter of a shape, a modifier or a procedural texture — the control follows the value's type
// and the hints of the catalog (also for plugins an AI wrote: the catalog is asked from the engine).
import type { YamlDoc, Edit, ObjNode } from './sceneDoc';
import { DataField, isNumberList, isNumberRows, Num, Points, Row, Select, Text, Vec } from './fields';
import type { Catalog, MatSummary, ProjectPicture, SceneModel, UiHint } from './types';

/** What the panels need from the editor. */
export interface EditorCtx {
  projectId: number;
  path: string;
  catalog: Catalog | null;
  model: SceneModel | null;
  /** the build shown fits the text (same objects) */
  fresh: boolean;
  tree: ObjNode[];
  doc: YamlDoc;
  /** change the text (one undo step; edits with the same `coalesce` key within 2 s are one step) */
  edit: (fn: (d: YamlDoc) => YamlDoc | Edit, coalesce?: string) => boolean;
  select: (ids: string[]) => void;
  openMaterial: (name: string | null) => void;
  liveMaterial: (name: string, s: Partial<MatSummary>) => void;
  dropToGround: (node: ObjNode) => void;
  toast: (msg: string, kind?: 'ok' | 'error' | 'info') => void;
  prompt: (title: string, initial?: string, label?: string) => Promise<string | null>;
  confirm: (opts: { title: string; body?: string; confirm?: string; danger?: boolean }) => Promise<boolean>;
  openFile?: (path: string) => void;
  pictures: ProjectPicture[];
  reloadPictures: () => void;
  models: string[];
}

const ROW_LABELS: Record<string, string[]> = {
  profile: ['R', 'Y'],
  points: ['X', 'Z'],
  path: ['X', 'Y', 'Z'],
  sections: ['at', 'W', 'H', 'Y', 'rnd'],
  holes: ['X', 'Z'],
};
const INT_NAMES = /^(segments|sides|detail|resolution|seed|octaves|iterations|count|layers|blobs|legs|rings|steps)$/;

export function ParamField({
  name,
  value,
  def,
  hint,
  set,
  onChange,
  onReset,
  doc,
}: {
  name: string;
  value: unknown;
  def: unknown;
  hint?: UiHint;
  /** written in the file (not the default) */
  set: boolean;
  onChange: (v: unknown, done: boolean) => void;
  onReset?: () => void;
  doc?: string;
}) {
  const v = value !== undefined ? value : def;
  const label = name.replace(/_/g, ' ');
  let control: React.ReactNode;
  if (hint?.choices?.length) {
    control = <Select value={String(v ?? '')} options={hint.choices.map(String)} onChange={(s) => onChange(typeof hint.choices![0] === 'number' ? Number(s) : s, true)} />;
  } else if (typeof v === 'boolean') {
    control = <input type="checkbox" checked={v} onChange={(e) => onChange(e.target.checked, true)} />;
  } else if (typeof v === 'number' || ((v === null || v === undefined) && (hint?.optional || typeof def === 'number'))) {
    const int = hint?.int ?? (INT_NAMES.test(name) && Number.isInteger(typeof def === 'number' ? def : 1));
    control = (
      <Num
        value={typeof v === 'number' ? v : null}
        label="↔"
        min={hint?.min}
        max={hint?.max}
        step={hint?.step ?? (int ? 1 : Math.abs(Number(v) || 1) >= 10 ? 1 : 0.05)}
        int={int}
        placeholder={hint?.optional ? 'auto' : undefined}
        onChange={(x, done) => onChange(x === undefined ? (hint?.optional ? undefined : def) : x, done)}
      />
    );
  } else if (isNumberList(v)) {
    control = <Vec value={v} step={hint?.step ?? 0.1} min={hint?.min} max={hint?.max} labels={v.length === 2 ? (name === 'size' ? ['X', 'Z'] : ['1', '2']) : undefined} onChange={(x, done) => onChange(x, done)} />;
  } else if (isNumberRows(v)) {
    control = <Points value={v} labels={ROW_LABELS[name]} onChange={(x, done) => onChange(x, done)} />;
  } else if (typeof v === 'string') {
    control = <Text value={v} onChange={(s) => onChange(s, true)} />;
  } else {
    control = <DataField value={v} onChange={(x) => onChange(x, true)} />;
  }
  const wide = isNumberRows(v) || (!isNumberList(v) && typeof v === 'object' && v !== null);
  if (wide) {
    return (
      <div className="s3-wide" title={doc}>
        <div className="s3-row">
          <span className={`s3-label${set ? ' set' : ''}`}>{label}</span>
          <span className="spacer" />
        </div>
        {control}
      </div>
    );
  }
  return (
    <Row label={label} title={doc} set={set} onReset={onReset}>
      {control}
    </Row>
  );
}
