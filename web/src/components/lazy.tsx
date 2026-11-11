// Heavy components (three.js, CodeMirror, xterm) load on demand.
import { forwardRef, lazy, Suspense, type ComponentProps } from 'react';
import type { ModelViewerHandle } from './ModelViewer';
import { Spinner } from './ui';

const ModelViewerImpl = lazy(() => import('./ModelViewer').then((m) => ({ default: m.ModelViewer })));
const CodeEditorImpl = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })));
const TerminalViewImpl = lazy(() => import('./TerminalView').then((m) => ({ default: m.TerminalView })));
const DawEditorImpl = lazy(() => import('../daw/DawEditor'));
const SceneEditorImpl = lazy(() => import('../scene3d/SceneEditor'));

function Loading() {
  return (
    <div className="center" style={{ position: 'absolute', inset: 0 }}>
      <Spinner />
    </div>
  );
}

export const ModelViewer = forwardRef<ModelViewerHandle, ComponentProps<typeof ModelViewerImpl>>(function LazyModelViewer(props, ref) {
  return (
    <Suspense fallback={<Loading />}>
      <ModelViewerImpl ref={ref} {...props} />
    </Suspense>
  );
});

export function CodeEditor(props: ComponentProps<typeof CodeEditorImpl>) {
  return (
    <Suspense fallback={<Loading />}>
      <CodeEditorImpl {...props} />
    </Suspense>
  );
}

export function TerminalView(props: ComponentProps<typeof TerminalViewImpl>) {
  return (
    <Suspense fallback={<Loading />}>
      <TerminalViewImpl {...props} />
    </Suspense>
  );
}

export function DawEditor(props: ComponentProps<typeof DawEditorImpl>) {
  return (
    <Suspense fallback={<Loading />}>
      <DawEditorImpl {...props} />
    </Suspense>
  );
}

export function SceneEditor(props: ComponentProps<typeof SceneEditorImpl>) {
  return (
    <Suspense fallback={<Loading />}>
      <SceneEditorImpl {...props} />
    </Suspense>
  );
}
