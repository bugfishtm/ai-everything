import { Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, X } from 'lucide-react';
import { useState } from 'react';
import { rawUrl } from '../api';
import { viewKind } from '../util';
import { Spinner } from './ui';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Input = Record<string, any>;

export interface ToolBlock {
  id: string;
  name: string;
  input: Input;
}
export interface ToolResult {
  isError: boolean;
  text: string;
}

function short(s: unknown, n = 160): string {
  const str = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  const one = str.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

export function summarize(name: string, i: Input, rel: (p: string) => string): { label: string; detail: string } {
  switch (name) {
    case 'Bash':
      return { label: 'Run', detail: short(i.command) };
    case 'Write':
      return { label: 'Write', detail: rel(i.file_path ?? '') };
    case 'Edit':
    case 'MultiEdit':
      return { label: 'Edit', detail: rel(i.file_path ?? '') };
    case 'Read':
      return { label: 'Read', detail: rel(i.file_path ?? '') };
    case 'NotebookEdit':
      return { label: 'Edit notebook', detail: rel(i.notebook_path ?? '') };
    case 'Glob':
      return { label: 'Find files', detail: short(i.pattern) };
    case 'Grep':
      return { label: 'Search', detail: short(i.pattern) };
    case 'WebFetch':
      return { label: 'Fetch', detail: short(i.url) };
    case 'WebSearch':
      return { label: 'Web search', detail: short(i.query) };
    case 'TodoWrite': {
      const todos: { status: string }[] = Array.isArray(i.todos) ? i.todos : [];
      return { label: 'Plan', detail: `${todos.filter((t) => t.status === 'completed').length}/${todos.length} done` };
    }
    case 'Task':
    case 'Agent':
      return { label: 'Subagent', detail: short(i.description ?? i.prompt) };
    case 'mcp__studio__library_search':
      return { label: 'Library search', detail: short(i.query || '(newest)') + (i.kind ? ` · ${i.kind}` : '') };
    case 'mcp__studio__library_info':
      return { label: 'Library info', detail: short(i.id) };
    case 'mcp__studio__library_get':
      return { label: 'Import from library', detail: short(i.id) };
    case 'mcp__studio__library_add':
      return { label: 'Save to library', detail: short(i.name) };
    default:
      if (name.startsWith('mcp__playwright__')) {
        return { label: 'Browser', detail: name.replace('mcp__playwright__browser_', '').replace(/_/g, ' ') + (i.url ? ` ${i.url}` : '') };
      }
      if (name.startsWith('mcp__')) return { label: name.split('__').slice(1).join(' › '), detail: short(i) };
      return { label: name, detail: short(i) };
  }
}

export function Todos({ input }: { input: Input }) {
  const todos: { content: string; status: string; activeForm?: string }[] = Array.isArray(input.todos) ? input.todos : [];
  return (
    <div className="todo">
      {todos.map((t, i) => (
        <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
          {t.status === 'completed' ? (
            <CircleCheck size={15} color="var(--ok)" style={{ marginTop: 2, flex: 'none' }} />
          ) : t.status === 'in_progress' ? (
            <CircleDot size={15} color="var(--accent)" style={{ marginTop: 2, flex: 'none' }} />
          ) : (
            <Circle size={15} color="var(--text-faint)" style={{ marginTop: 2, flex: 'none' }} />
          )}
          <span className={t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : ''}>
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ToolCall({
  block,
  result,
  running,
  projectId,
  rel,
}: {
  block: ToolBlock;
  result?: ToolResult;
  running: boolean;
  projectId: number;
  rel: (p: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const { label, detail } = summarize(block.name, block.input ?? {}, rel);
  const i = block.input ?? {};
  const pending = !result;

  const status = pending ? (
    running ? <Spinner size={14} /> : <Circle size={14} color="var(--text-faint)" />
  ) : result.isError ? (
    <X size={14} color="var(--danger)" />
  ) : (
    <Check size={14} color="var(--ok)" />
  );

  if (block.name === 'TodoWrite') {
    return (
      <div className="tool">
        <div className="tool-head" style={{ cursor: 'default' }}>
          {status}
          <span className="tool-name">{label}</span>
          <span className="tool-sum">{detail}</span>
        </div>
        <Todos input={i} />
      </div>
    );
  }

  const filePath: string = typeof i.file_path === 'string' ? i.file_path : '';
  const relPath = filePath ? rel(filePath) : '';
  const isImageRead = block.name === 'Read' && relPath && !relPath.startsWith('/') && viewKind(relPath) === 'image';

  return (
    <div className="tool">
      <div className="tool-head" onClick={() => setOpen(!open)}>
        {status}
        <span className="tool-name">{label}</span>
        <span className="tool-sum" title={detail}>
          {detail}
        </span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>
      {isImageRead && !open && <img className="tool-img" style={{ margin: '0 12px 10px', maxHeight: 220 }} src={rawUrl(projectId, relPath)} alt={relPath} />}
      {open && (
        <div className="tool-body">
          {block.name === 'Bash' && (
            <>
              <div className="lbl">command</div>
              <pre>{i.command}</pre>
            </>
          )}
          {block.name === 'Write' && (
            <>
              <div className="lbl">{relPath}</div>
              <pre>{String(i.content ?? '')}</pre>
            </>
          )}
          {(block.name === 'Edit' || block.name === 'MultiEdit') && (
            <>
              <div className="lbl">{relPath}</div>
              {(block.name === 'MultiEdit' ? (i.edits ?? []) : [i]).map((ed: Input, k: number) => (
                <div key={k} className="col" style={{ gap: 4 }}>
                  <pre style={{ borderColor: 'rgba(248,113,113,0.35)', color: '#fca5a5' }}>{String(ed.old_string ?? '')}</pre>
                  <pre style={{ borderColor: 'rgba(52,211,153,0.35)', color: '#86efac' }}>{String(ed.new_string ?? '')}</pre>
                </div>
              ))}
            </>
          )}
          {isImageRead && <img className="tool-img" src={rawUrl(projectId, relPath)} alt={relPath} />}
          {!['Bash', 'Write', 'Edit', 'MultiEdit', 'Read'].includes(block.name) && (
            <>
              <div className="lbl">input</div>
              <pre>{JSON.stringify(i, null, 2)}</pre>
            </>
          )}
          {result && block.name !== 'Write' && block.name !== 'Edit' && (
            <>
              <div className="lbl">{result.isError ? 'error' : 'output'}</div>
              <pre style={result.isError ? { color: '#fca5a5' } : undefined}>{result.text || '(no output)'}</pre>
            </>
          )}
          {result?.isError && (block.name === 'Write' || block.name === 'Edit') && <pre style={{ color: '#fca5a5' }}>{result.text}</pre>}
        </div>
      )}
    </div>
  );
}
