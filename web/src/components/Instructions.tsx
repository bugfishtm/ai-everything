// Standing instructions: text that is always part of the AI's prompt — one for everything and
// one per area. Used for a user's own instructions (Skills page) and the admin's (Admin page).
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errMsg, type Instruction } from '../api';
import { cls } from '../util';
import { Spinner, useUi } from './ui';

export function InstructionsEditor({
  items,
  areas,
  max,
  save,
  placeholder,
}: {
  items: Record<string, Instruction>;
  /** "all" first, then the areas */
  areas: { id: string; name: string }[];
  max: number;
  save: (scope: string, body: string, enabled: boolean) => Promise<void>;
  placeholder?: string;
}) {
  const ui = useUi();
  const [scope, setScope] = useState('all');
  const [body, setBody] = useState(items.all?.body ?? '');
  const [enabled, setEnabled] = useState(items.all?.enabled ?? true);
  const [busy, setBusy] = useState(false);

  const saved = items[scope];
  useEffect(() => {
    setBody(saved?.body ?? '');
    setEnabled(saved?.enabled ?? true);
  }, [scope, saved]);

  const dirty = body !== (saved?.body ?? '') || (!!body.trim() && enabled !== (saved?.enabled ?? true));

  const pick = async (id: string) => {
    if (id === scope) return;
    if (dirty) {
      const ok = await ui.confirm({ title: 'Discard the changes?', body: 'The text for this area has not been saved.', confirm: 'Discard', danger: true });
      if (!ok) return;
    }
    setScope(id);
  };

  const doSave = async () => {
    setBusy(true);
    try {
      await save(scope, body, enabled);
      ui.toast(body.trim() ? 'Saved — it applies from the next message on' : 'Removed');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const name = areas.find((a) => a.id === scope)?.name ?? scope;
  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 6 }}>
        {areas.map((a) => {
          const it = items[a.id];
          const has = !!it?.body.trim();
          return (
            <button key={a.id} className={cls('chip', scope === a.id && 'active')} onClick={() => void pick(a.id)} title={has ? (it.enabled ? 'has instructions' : 'has instructions (switched off)') : undefined}>
              {a.name}
              {has && <span className={`status-dot ${it.enabled ? 'ok' : 'bad'}`} style={{ marginLeft: 6 }} />}
            </button>
          );
        })}
      </div>
      <textarea
        className="textarea"
        rows={9}
        maxLength={max}
        spellCheck={false}
        placeholder={placeholder ?? (scope === 'all' ? 'Applies to every area …' : `Only for ${name} …`)}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        style={{ fontSize: 13, lineHeight: 1.5 }}
      />
      <div className="row wrap" style={{ gap: 12 }}>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Active
        </label>
        <span className="faint small">
          {scope === 'all' ? 'Sent with every message, in every area.' : `Sent with every message in ${name}, in addition to “${areas[0]?.name ?? 'Everything'}”.`}
        </span>
        <span className="spacer" />
        <span className="faint small">
          {body.length.toLocaleString()} / {max.toLocaleString()}
        </span>
        <button className="btn sm primary" disabled={!dirty || busy} onClick={() => void doSave()}>
          {busy ? <Spinner size={14} /> : <Save size={14} />} Save
        </button>
      </div>
    </div>
  );
}
