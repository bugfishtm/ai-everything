import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.stl': 'model/stl',
  '.ply': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/vnd.microsoft.portable-executable',
};

export function mimeFor(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export type AssetKind = 'model3d' | 'image' | 'audio' | 'music' | 'video' | 'font' | 'code' | 'document' | 'other';
export const ASSET_KINDS: AssetKind[] = ['model3d', 'image', 'audio', 'music', 'video', 'font', 'code', 'document', 'other'];

const KIND_BY_EXT: Record<string, AssetKind> = {};
const add = (kind: AssetKind, exts: string) => exts.split(' ').forEach((e) => (KIND_BY_EXT['.' + e] = kind));
add('model3d', 'glb gltf obj stl fbx ply dae 3mf usdz vox');
add('image', 'png jpg jpeg webp gif bmp svg tga avif ico psd');
add('audio', 'wav mp3 ogg oga opus flac m4a aac');
add('music', 'mid midi abc musicxml mxl ly');
add('video', 'mp4 m4v webm mov mkv');
add('font', 'ttf otf woff woff2');
add('code', 'js mjs ts tsx jsx py cs kt java c cpp h hpp rs go lua glsl wgsl html css');
add('document', 'md txt pdf');

/** Order of preference when picking the "main" file of a multi-file asset. */
const MAIN_PRIORITY: AssetKind[] = ['model3d', 'video', 'audio', 'music', 'image', 'font', 'document', 'code'];

export function kindForFile(file: string): AssetKind {
  const lower = file.toLowerCase();
  if (lower.endsWith('.song.json')) return 'music';
  return KIND_BY_EXT[path.extname(lower)] ?? 'other';
}

export function pickMainFile(files: string[]): { main: string | null; kind: AssetKind } {
  for (const kind of MAIN_PRIORITY) {
    const preferred = files.filter((f) => kindForFile(f) === kind);
    if (preferred.length) {
      // within 3D prefer glb/gltf
      const sorted = preferred.sort((a, b) => score(b) - score(a) || a.length - b.length);
      return { main: sorted[0], kind };
    }
  }
  return { main: files[0] ?? null, kind: 'other' };
}

function score(f: string): number {
  const e = path.extname(f).toLowerCase();
  return { '.glb': 5, '.gltf': 4, '.obj': 3, '.png': 2, '.wav': 2, '.mp4': 2 }[e] ?? 0;
}

export function isProbablyText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}
