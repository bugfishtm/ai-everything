// Skills & instructions: how a user shapes what the AI does here.
//   Skills        know-how the AI loads when a task matches (or when called with /name)
//   Instructions  standing rules that are part of every prompt (for everything or one area)
import { BadgeCheck, Copy, Download, Earth, FileUp, GraduationCap, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg, type InstructionsData, type Skill } from '../api';
import { InstructionsEditor } from '../components/Instructions';
import { Markdown } from '../components/Markdown';
import { Empty, Modal, Spinner, useUi } from '../components/ui';
import { useStudio } from '../store';
import { cls } from '../util';

type AreaRef = { id: string; name: string };
type Filter = 'all' | 'active' | 'mine' | 'system' | 'global';

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

const NEW_BODY = `# What this skill does

1. First step — say exactly what to do and in which order.
2. Commands as they are typed, file names as they are called.
3. …

## Check the result
- How the AI knows the result is good (what to run, what to look at).

## Never
- Mistakes to avoid.
`;

function ScopeBadge({ s }: { s: Skill }) {
  if (s.scope === 'system') return <span className="badge">built-in</span>;
  if (s.scope === 'mine') return <span className="badge accent">mine{s.published ? ' · published' : ''}</span>;
  return (
    <span className="badge" title="Published to the Global Space">
      <Earth size={11} style={{ marginRight: 4 }} />@{s.owner}
    </span>
  );
}

function AreaChips({ value, areas, onChange }: { value: string[]; areas: AreaRef[]; onChange: (v: string[]) => void }) {
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      <button className={cls('chip', !value.length && 'active')} onClick={() => onChange([])}>
        All areas
      </button>
      {areas.map((a) => (
        <button
          key={a.id}
          className={cls('chip', value.includes(a.id) && 'active')}
          onClick={() => onChange(value.includes(a.id) ? value.filter((x) => x !== a.id) : [...value, a.id])}
        >
          {a.name}
        </button>
      ))}
    </div>
  );
}

interface Draft {
  name: string;
  slug: string;
  description: string;
  body: string;
  areas: string[];
  auto: boolean;
}

/** View a skill (built-in / someone else's) or edit one (mine, new). */
function SkillModal({
  skillKey,
  areas,
  onClose,
  onChanged,
}: {
  /** null = a new skill */
  skillKey: string | null;
  areas: AreaRef[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const ui = useUi();
  const { user } = useStudio();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: '', slug: '', description: '', body: NEW_BODY, areas: [], auto: true });
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const isNew = skillKey === null;
  const editable = isNew || skill?.scope === 'mine';

  const load = useCallback(async () => {
    if (skillKey === null) return;
    const r = await api<{ skill: Skill }>(`/skills/${encodeURIComponent(skillKey)}`);
    setSkill(r.skill);
    setDraft({ name: r.skill.name, slug: r.skill.slug, description: r.skill.description, body: r.skill.body ?? '', areas: r.skill.areas, auto: r.skill.auto });
    setSlugTouched(true);
  }, [skillKey]);
  useEffect(() => {
    void load().catch((err) => setError(errMsg(err)));
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string, close = false) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      if (done) ui.toast(done);
      await onChanged();
      if (close) onClose();
      else await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy('');
    }
  };

  const save = () =>
    run(
      'save',
      () =>
        isNew
          ? api('/skills', { body: { ...draft, slug: draft.slug || slugOf(draft.name) } })
          : api(`/skills/${skill!.id}`, { method: 'PUT', body: draft }),
      isNew ? `Skill saved — call it with /${draft.slug || slugOf(draft.name)}` : 'Saved',
      isNew,
    );

  const remove = async () => {
    const ok = await ui.confirm({
      title: `Delete the skill "${skill!.name}"?`,
      body: skill!.published ? 'It is also removed from the Global Space — people who added it lose it.' : 'This cannot be undone.',
      confirm: 'Delete skill',
      danger: true,
    });
    if (ok) await run('delete', () => api(`/skills/${skill!.id}`, { method: 'DELETE' }), 'Skill deleted', true);
  };

  const publish = async () => {
    const ok = await ui.confirm({
      title: `Publish "${skill!.name}" to the Global Space?`,
      body: 'Everyone on this Studio can read it and add it to their own skills. Do not publish anything private (names, addresses, keys).',
      confirm: 'Publish',
    });
    if (ok) await run('publish', () => api(`/skills/${skill!.id}/publish`, { body: {} }), 'Published to the Global Space');
  };

  const copy = () =>
    run(
      'copy',
      () => api('/skills', { body: { name: draft.name, slug: draft.slug, description: draft.description, body: draft.body, areas: draft.areas, auto: draft.auto } }),
      `Copied to your skills — your own "${draft.slug}" now replaces this one`,
      true,
    );

  const loading = !isNew && !skill && !error;
  const valid = draft.name.trim() && draft.description.trim().length >= 8 && draft.body.trim();
  const dirty =
    isNew ||
    (skill &&
      (draft.name !== skill.name ||
        draft.slug !== skill.slug ||
        draft.description !== skill.description ||
        draft.body !== (skill.body ?? '') ||
        draft.auto !== skill.auto ||
        draft.areas.join() !== skill.areas.join()));

  return (
    <Modal
      title={isNew ? 'New skill' : (skill?.name ?? 'Skill')}
      icon={<GraduationCap size={18} color="var(--accent)" />}
      size="wide"
      onClose={onClose}
      footer={
        loading ? undefined : editable ? (
          <>
            {!isNew && (
              <button className="btn danger" disabled={!!busy} onClick={() => void remove()}>
                <Trash2 size={14} /> Delete
              </button>
            )}
            <span className="spacer" />
            {!isNew && (
              <a className="btn" href={`/api/skills/${skill!.key}/export`} title="Download as SKILL.md">
                <Download size={14} /> Export
              </a>
            )}
            {!isNew &&
              (skill!.published ? (
                <button className="btn" disabled={!!busy} onClick={() => void run('unpublish', () => api(`/skills/${skill!.id}/unpublish`, { body: {} }), 'Removed from the Global Space')}>
                  Unpublish
                </button>
              ) : (
                <button className="btn" disabled={!!busy || !!dirty} onClick={() => void publish()} title={dirty ? 'Save first' : 'Share it with everyone on this Studio'}>
                  <Earth size={14} /> Publish
                </button>
              ))}
            <button className="btn primary" disabled={!!busy || !valid || !dirty} onClick={() => void save()}>
              {busy === 'save' ? <Spinner size={14} /> : null} {isNew ? 'Create skill' : 'Save'}
            </button>
          </>
        ) : skill ? (
          <>
            {user?.role === 'admin' && skill.scope === 'global' && (
              <>
                <button className="btn" disabled={!!busy} onClick={() => void run('review', () => api(`/admin/skills/${skill.id}/review`, { body: { reviewed: !skill.reviewed } }))}>
                  <BadgeCheck size={14} /> {skill.reviewed ? 'Remove “reviewed”' : 'Mark as reviewed'}
                </button>
                <button className="btn danger" disabled={!!busy} onClick={() => void run('unpublish', () => api(`/skills/${skill.id}/unpublish`, { body: {} }), 'Removed from the Global Space', true)}>
                  Remove from Global Space
                </button>
              </>
            )}
            <span className="spacer" />
            <a className="btn" href={`/api/skills/${skill.key}/export`} title="Download as SKILL.md">
              <Download size={14} /> Export
            </a>
            <button className="btn" disabled={!!busy} onClick={() => void copy()} title="Make your own copy that you can change">
              <Copy size={14} /> Copy to my skills
            </button>
            <button
              className={cls('btn', !skill.enabled && 'primary')}
              disabled={!!busy}
              onClick={() => void run('enable', () => api(`/skills/${encodeURIComponent(skill.key)}/enable`, { body: { enabled: !skill.enabled } }), skill.enabled ? 'Switched off' : `Active — call it with /${skill.slug}`)}
            >
              {skill.enabled ? 'Switch off' : skill.scope === 'global' ? 'Add to my skills' : 'Switch on'}
            </button>
          </>
        ) : undefined
      }
    >
      {loading && <Spinner />}
      {error && (
        <div className="notice error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      {!loading && editable && (
        <div className="stack">
          <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="field grow" style={{ minWidth: 220 }}>
              <label className="label">Name</label>
              <input
                className="input"
                autoFocus={isNew}
                placeholder="Weekly report"
                value={draft.name}
                maxLength={128}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value, slug: slugTouched ? d.slug : slugOf(e.target.value) }))}
              />
            </div>
            <div className="field" style={{ width: 240, marginTop: 0 }}>
              <label className="label">Command</label>
              <div className="row" style={{ gap: 4 }}>
                <span className="mono faint">/</span>
                <input
                  className="input mono"
                  placeholder="weekly-report"
                  value={draft.slug}
                  maxLength={64}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setDraft((d) => ({ ...d, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }));
                  }}
                />
              </div>
            </div>
          </div>
          <div className="field">
            <label className="label">When should the AI use it?</label>
            <textarea
              className="textarea"
              rows={2}
              maxLength={1024}
              style={{ minHeight: 56 }}
              placeholder="Use when the user asks for the weekly report or a status mail for the team — collects the changes of the week and writes them in our style."
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            />
            <div className="hint">
              The AI only sees the name and this sentence when it decides — say what you would ask for and what comes out. Vague descriptions are never picked.
            </div>
          </div>
          <div className="field">
            <label className="label">Instructions</label>
            <textarea
              className="textarea mono"
              rows={16}
              spellCheck={false}
              value={draft.body}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              style={{ fontSize: 12.5, lineHeight: 1.55 }}
            />
            <div className="hint">Markdown. Write it for someone who was not there: steps in order, exact commands, how to check the result. {draft.body.length.toLocaleString()} characters.</div>
          </div>
          <div className="field">
            <label className="label">Offered in</label>
            <AreaChips value={draft.areas} areas={areas} onChange={(v) => setDraft((d) => ({ ...d, areas: v }))} />
          </div>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={draft.auto} onChange={(e) => setDraft((d) => ({ ...d, auto: e.target.checked }))} />
            <span>
              The AI may use it by itself when a task matches <span className="faint">(off: only when I call it with /{draft.slug || 'name'})</span>
            </span>
          </label>
          {skill?.published && (
            <div className="notice info">
              Published to the Global Space{skill.reviewed ? ' (reviewed by an admin)' : ''}. Changes are visible to everyone who added it; changed instructions must be reviewed again.
            </div>
          )}
        </div>
      )}
      {!loading && !editable && skill && (
        <div className="stack">
          <div className="row wrap" style={{ gap: 8 }}>
            <code className="code-inline">/{skill.slug}</code>
            <ScopeBadge s={skill} />
            {skill.scope === 'global' && <span className={cls('badge', skill.reviewed ? 'ok' : 'warn')}>{skill.reviewed ? 'reviewed' : 'not reviewed'}</span>}
            {!skill.auto && <span className="badge">only on /{skill.slug}</span>}
            <span className="faint small">{skill.areas.length ? skill.areas.map((a) => areas.find((x) => x.id === a)?.name ?? a).join(', ') : 'all areas'}</span>
          </div>
          <div className="muted">{skill.description}</div>
          {skill.scope === 'global' && !skill.reviewed && (
            <div className="notice warn">
              <span>An admin has not looked at this skill yet. A skill is a set of instructions your AI will follow — read it before you add it.</span>
            </div>
          )}
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', background: 'var(--bg-1)', maxHeight: '52vh', overflow: 'auto' }}>
            <Markdown text={skill.body ?? ''} />
          </div>
        </div>
      )}
    </Modal>
  );
}

export function SkillsPage() {
  const ui = useUi();
  const [tab, setTab] = useState<'skills' | 'instructions'>('skills');
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [areas, setAreas] = useState<AreaRef[]>([]);
  const [instr, setInstr] = useState<InstructionsData | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [area, setArea] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null | undefined>(undefined); // undefined = closed, null = new
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await api<{ skills: Skill[]; areas: AreaRef[] }>('/skills');
    setSkills(r.skills);
    setAreas(r.areas);
  }, []);
  const loadInstr = useCallback(async () => setInstr(await api<InstructionsData>('/instructions')), []);
  useEffect(() => {
    void load().catch((err) => ui.toast(errMsg(err), 'error'));
    void loadInstr().catch(() => {});
  }, [load, loadInstr, ui]);

  const toggle = async (s: Skill) => {
    try {
      await api(`/skills/${encodeURIComponent(s.key)}/enable`, { body: { enabled: !s.enabled } });
      await load();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  const importFiles = async (files: FileList | null) => {
    for (const f of [...(files ?? [])]) {
      try {
        if (f.size > 100_000) throw new Error(`${f.name} is too large for a SKILL.md`);
        const r = await api<{ skill: Skill; updated: boolean }>('/skills/import', { body: { markdown: await f.text() } });
        ui.toast(`${r.updated ? 'Updated' : 'Imported'} “${r.skill.name}” — call it with /${r.skill.slug}`);
      } catch (err) {
        ui.toast(`${f.name}: ${errMsg(err)}`, 'error');
      }
    }
    await load().catch(() => {});
  };

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (skills ?? [])
      .filter((s) => (filter === 'all' ? true : filter === 'active' ? s.enabled : s.scope === filter))
      .filter((s) => !area || !s.areas.length || s.areas.includes(area))
      .filter((s) => words.every((w) => `${s.name} ${s.slug} ${s.description} ${s.owner ?? ''}`.toLowerCase().includes(w)))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  }, [skills, filter, area, query]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, active: 0, mine: 0, system: 0, global: 0 };
    for (const s of skills ?? []) {
      c.all++;
      c[s.scope]++;
      if (s.enabled) c.active++;
    }
    return c;
  }, [skills]);

  // one name, one skill: the user's own beats an added one beats a built-in one — the others do nothing
  const replaced = useMemo(() => {
    const rank = { mine: 0, global: 1, system: 2 } as const;
    const winner = new Map<string, Skill>();
    for (const s of skills ?? []) {
      if (!s.enabled) continue;
      const w = winner.get(s.slug);
      if (!w || rank[s.scope] < rank[w.scope]) winner.set(s.slug, s);
    }
    const out = new Map<string, Skill>();
    for (const s of skills ?? []) {
      const w = winner.get(s.slug);
      if (s.enabled && w && w.key !== s.key) out.set(s.key, w);
    }
    return out;
  }, [skills]);

  const adminInstr = Object.entries(instr?.global ?? {});

  return (
    <div className="page stack-lg">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="row" style={{ gap: 12 }}>
          <GraduationCap size={28} color="var(--accent)" />
          <div>
            <h1>Skills &amp; instructions</h1>
            <p>
              Teach the AI how you work. <b>Skills</b> are know-how for recurring tasks — the AI reads one when a task matches, or when you start a message with{' '}
              <code className="code-inline">/name</code>. <b>Instructions</b> are rules that always apply. Both work with every AI provider.
            </p>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={() => fileInput.current?.click()} title="Import SKILL.md files (front matter + instructions)">
            <FileUp size={15} /> Import
          </button>
          <button
            className="btn primary"
            onClick={() => {
              setTab('skills');
              setOpen(null);
            }}
          >
            <Plus size={15} /> New skill
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept=".md,.markdown,.txt"
            onChange={(e) => {
              const files = e.target.files;
              void importFiles(files).finally(() => {
                e.target.value = '';
              });
            }}
          />
        </div>
      </div>

      <div className="tabs">
        <button className={cls('tab', tab === 'skills' && 'active')} onClick={() => setTab('skills')}>
          <GraduationCap size={14} /> Skills{skills ? ` (${counts.active} active)` : ''}
        </button>
        <button className={cls('tab', tab === 'instructions' && 'active')} onClick={() => setTab('instructions')}>
          <Pencil size={14} /> Instructions
        </button>
      </div>

      {tab === 'skills' && (
        <div className="stack">
          <div className="row wrap" style={{ gap: 8 }}>
            <div className="row" style={{ position: 'relative', flex: '1 1 220px', maxWidth: 340 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, color: 'var(--text-faint)' }} />
              <input className="input" style={{ paddingLeft: 30 }} placeholder="Search skills…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {(
              [
                ['all', 'All'],
                ['active', 'Active'],
                ['mine', 'Mine'],
                ['system', 'Built-in'],
                ['global', 'Global Space'],
              ] as [Filter, string][]
            ).map(([k, label]) => (
              <button key={k} className={cls('chip', filter === k && 'active')} onClick={() => setFilter(k)}>
                {label} <span className="faint">{counts[k]}</span>
              </button>
            ))}
            <select className="select" style={{ width: 'auto' }} value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="">Every area</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          {!skills && <Spinner />}
          {skills && !shown.length && (
            <Empty icon={GraduationCap} title={skills.length ? 'No skill matches' : 'No skills yet'}>
              Create one with <b>New skill</b> — or ask the AI in any project: “save how we did this as a skill”.
            </Empty>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {shown.map((s) => (
              <div
                key={s.key}
                className="card"
                style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8, opacity: s.enabled && !replaced.has(s.key) ? 1 : 0.72, cursor: 'pointer' }}
                onClick={() => setOpen(s.key)}
              >
                <div className="row" style={{ gap: 8 }}>
                  <b className="grow ellipsis">{s.name}</b>
                  <label className="row small" style={{ gap: 5, cursor: 'pointer' }} onClick={(e) => e.stopPropagation()} title={s.enabled ? 'Active for you — click to switch off' : 'Switched off — click to activate'}>
                    <input type="checkbox" checked={s.enabled} onChange={() => void toggle(s)} />
                    {s.enabled ? 'on' : 'off'}
                  </label>
                </div>
                <div className="muted small" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: 54 }}>
                  {s.description}
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  <code className="code-inline">/{s.slug}</code>
                  <ScopeBadge s={s} />
                  {s.scope === 'global' && !s.reviewed && <span className="badge warn">not reviewed</span>}
                  {!s.auto && <span className="badge" title="The AI does not pick it by itself">only on call</span>}
                  {replaced.has(s.key) && (
                    <span className="badge warn" title={`"${replaced.get(s.key)!.name}" has the same command /${s.slug} and is used instead`}>
                      replaced by {replaced.get(s.key)!.scope === 'mine' ? 'yours' : `@${replaced.get(s.key)!.owner}`}
                    </span>
                  )}
                  <span className="faint small ellipsis">{s.areas.length ? s.areas.map((a) => areas.find((x) => x.id === a)?.name ?? a).join(', ') : 'all areas'}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="hint">
            In a chat, type <code className="code-inline">/</code> to pick a skill. The AI can write skills too: “remember how to do this as a skill” — it shows up here as yours. A SKILL.md
            file is a name, a description and the instructions: <a onClick={() => fileInput.current?.click()} style={{ cursor: 'pointer' }}><Upload size={11} /> import</a> files from elsewhere or export yours.
          </div>
        </div>
      )}

      {tab === 'instructions' && (
        <div className="stack-lg">
          <div className="card">
            <div className="card-head">
              <Pencil size={18} />
              <h2 className="grow">My instructions</h2>
            </div>
            <div className="card-body stack">
              <div className="muted small">
                What the AI should always know or do when it works for you: your language and tone, how you like results delivered, the tools and styles you prefer, things it
                must never do. Keep it short — every word is sent with every message. For how-to knowledge of single tasks, make a skill instead.
              </div>
              {!instr ? (
                <Spinner />
              ) : (
                <InstructionsEditor
                  items={instr.mine}
                  areas={instr.areas}
                  max={instr.max}
                  save={async (scope, body, enabled) => {
                    const r = await api<{ mine: InstructionsData['mine'] }>(`/instructions/${scope}`, { method: 'PUT', body: { body, enabled } });
                    setInstr((d) => (d ? { ...d, mine: r.mine } : d));
                  }}
                  placeholder={'e.g.\n- Answer in German, short and direct.\n- Ask before deleting files.\n- Music: I like 90s house and lo-fi; never use autotune-style leads.'}
                />
              )}
            </div>
          </div>
          {adminInstr.length > 0 && (
            <div className="card">
              <div className="card-head">
                <BadgeCheck size={18} />
                <h2 className="grow">From this Studio's admin</h2>
                <span className="faint small">applies to everyone</span>
              </div>
              <div className="card-body stack">
                {adminInstr.map(([scope, it]) => (
                  <div key={scope}>
                    <div className="label">{instr?.areas.find((a) => a.id === scope)?.name ?? scope}</div>
                    <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0, color: 'var(--text-dim)' }}>
                      {it.body}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {open !== undefined && <SkillModal skillKey={open} areas={areas} onClose={() => setOpen(undefined)} onChanged={load} />}
    </div>
  );
}
