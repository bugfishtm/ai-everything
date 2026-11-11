import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { xml } from '@codemirror/lang-xml';
import { StreamLanguage } from '@codemirror/language';
import { c, cpp, csharp, kotlin } from '@codemirror/legacy-modes/mode/clike';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import { ext } from '../util';

function languageFor(path: string): Extension {
  const e = ext(path);
  switch (e) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
    case 'mts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'json':
    case 'gltf':
    case 'jsonc':
      return json();
    case 'html':
    case 'htm':
      return html();
    case 'css':
      return css();
    case 'md':
    case 'markdown':
      return markdown();
    case 'py':
      return python();
    case 'xml':
    case 'svg':
    case 'musicxml':
    case 'csproj':
    case 'plist':
      return xml();
    case 'java':
      return java();
    case 'kt':
    case 'kts':
    case 'gradle':
      return StreamLanguage.define(kotlin);
    case 'cs':
      return StreamLanguage.define(csharp);
    case 'c':
    case 'h':
      return StreamLanguage.define(c);
    case 'cpp':
    case 'cc':
    case 'hpp':
    case 'glsl':
    case 'frag':
    case 'vert':
      return StreamLanguage.define(cpp);
    case 'sh':
    case 'bash':
    case 'nsi':
      return StreamLanguage.define(shell);
    case 'toml':
      return StreamLanguage.define(toml);
    case 'yml':
    case 'yaml':
      return StreamLanguage.define(yaml);
    case 'lua':
      return StreamLanguage.define(lua);
    default:
      return [];
  }
}

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#0d1016' },
  '.cm-gutters': { backgroundColor: '#0d1016', borderRight: '1px solid #1d2330' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
});

export function CodeEditor({
  path,
  value,
  readOnly,
  onChange,
  onSave,
}: {
  path: string;
  value: string;
  readOnly?: boolean;
  onChange?: (v: string) => void;
  onSave?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          oneDark,
          theme,
          languageFor(path),
          EditorView.lineWrapping,
          EditorState.readOnly.of(!!readOnly),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly]);

  useEffect(() => {
    const v = view.current;
    if (v && value !== v.state.doc.toString()) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="cm-host" ref={host} />;
}
