export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function timeAgo(d: string | number | Date | null | undefined): string {
  if (!d) return '';
  const t = new Date(d).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

export function ext(path: string): string {
  const name = path.split('/').pop() ?? '';
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function dirname(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export type ViewKind = 'image' | 'audio' | 'video' | 'model' | 'pdf' | 'text' | 'binary';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const AUDIO = new Set(['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac']);
const VIDEO = new Set(['mp4', 'm4v', 'webm', 'mov']);
const MODEL = new Set(['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx']);

export function viewKind(path: string): ViewKind {
  const e = ext(path);
  if (IMAGE.has(e)) return 'image';
  if (AUDIO.has(e)) return 'audio';
  if (VIDEO.has(e)) return 'video';
  if (MODEL.has(e)) return 'model';
  if (e === 'pdf') return 'pdf';
  return 'text';
}

export function isModelFile(path: string): boolean {
  return MODEL.has(ext(path));
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export const MODEL_SUGGESTIONS = ['fable', 'opus', 'sonnet', 'haiku'];

export const PERMISSION_MODES: { id: 'bypass' | 'acceptEdits' | 'ask' | 'plan'; label: string; hint: string }[] = [
  { id: 'bypass', label: 'Autonomous', hint: 'The AI edits files and runs commands without asking (isolated in your sandbox account).' },
  { id: 'acceptEdits', label: 'Ask for commands', hint: 'File edits are automatic; you approve each command in the chat.' },
  { id: 'ask', label: 'Ask for everything', hint: 'You approve every edit and command.' },
  { id: 'plan', label: 'Plan only', hint: 'The AI only reads and proposes a plan — nothing is changed.' },
];

export const ASSET_KINDS: { id: string; label: string }[] = [
  { id: 'model3d', label: '3D' },
  { id: 'image', label: 'Image' },
  { id: 'audio', label: 'Audio' },
  { id: 'music', label: 'Music' },
  { id: 'video', label: 'Video' },
  { id: 'font', label: 'Font' },
  { id: 'code', label: 'Code' },
  { id: 'document', label: 'Document' },
  { id: 'other', label: 'Other' },
];

export function guessKind(path: string): string {
  const e = ext(path);
  if (MODEL.has(e) || ['dae', '3mf', 'vox'].includes(e)) return 'model3d';
  if (IMAGE.has(e) || ['tga', 'psd'].includes(e)) return 'image';
  if (AUDIO.has(e)) return 'audio';
  if (['mid', 'midi', 'abc', 'musicxml', 'mxl', 'ly'].includes(e) || path.endsWith('.song.json')) return 'music';
  if (VIDEO.has(e) || e === 'mkv') return 'video';
  if (['ttf', 'otf', 'woff', 'woff2'].includes(e)) return 'font';
  if (['md', 'txt', 'pdf'].includes(e)) return 'document';
  if (['js', 'ts', 'py', 'cs', 'kt', 'java', 'c', 'cpp', 'html', 'css', 'glsl', 'lua'].includes(e)) return 'code';
  return 'other';
}

export function prettyName(path: string): string {
  const b = basename(path).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return b ? b[0].toUpperCase() + b.slice(1) : 'Asset';
}
