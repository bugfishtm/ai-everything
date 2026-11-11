/**
 * Every project is a git repository. After each Claude turn the server makes a
 * checkpoint commit, so users can browse history and restore any version.
 * git always runs as the project owner.
 */
import type { ChildProcess } from 'node:child_process';
import { type SysUser, baseUserEnv, runAs, spawnAs } from './lib/system.js';

function gitEnv(su: SysUser, name: string, email: string): NodeJS.ProcessEnv {
  return baseUserEnv(su, {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: 'Everything Studio',
    GIT_COMMITTER_EMAIL: 'studio@localhost',
    GIT_TERMINAL_PROMPT: '0',
  });
}

export async function git(su: SysUser, dir: string, args: string[], author = { name: 'Studio', email: 'studio@localhost' }) {
  return runAs(su, 'git', ['-C', dir, ...args], { env: gitEnv(su, author.name, author.email), timeoutMs: 120_000 });
}

export async function gitInit(su: SysUser, dir: string, author: { name: string; email: string }): Promise<void> {
  await git(su, dir, ['init', '-q', '-b', 'main'], author);
  await git(su, dir, ['add', '-A'], author);
  await git(su, dir, ['commit', '-q', '-m', 'Project created'], author);
}

/** Commit everything that changed. Returns the new sha or null when nothing changed. */
export async function checkpoint(
  su: SysUser,
  dir: string,
  message: string,
  author: { name: string; email: string },
): Promise<{ sha: string; files: number } | null> {
  const status = await git(su, dir, ['status', '--porcelain'], author);
  if (status.code !== 0) return null; // not a repo (user removed .git?) — skip silently
  const files = status.stdout.split('\n').filter((l) => l.trim()).length;
  if (!files) return null;
  await git(su, dir, ['add', '-A'], author);
  const c = await git(su, dir, ['commit', '-q', '--no-verify', '-m', message], author);
  if (c.code !== 0) return null;
  const sha = (await git(su, dir, ['rev-parse', 'HEAD'], author)).stdout.trim();
  return { sha, files };
}

export interface Commit {
  sha: string;
  short: string;
  date: string;
  author: string;
  message: string;
  files: number;
}

export async function history(su: SysUser, dir: string, limit = 100): Promise<Commit[]> {
  const SEP = '\x1f';
  const r = await git(su, dir, [
    'log', `-n${limit}`, '--shortstat', `--pretty=format:%x1e%H${SEP}%h${SEP}%aI${SEP}%an${SEP}%s`,
  ]);
  if (r.code !== 0) return [];
  const out: Commit[] = [];
  for (const block of r.stdout.split('\x1e')) {
    const lines = block.trim().split('\n');
    if (!lines[0]) continue;
    const [sha, short, date, author, message] = lines[0].split(SEP);
    const stat = lines.slice(1).join(' ');
    const m = /(\d+) files? changed/.exec(stat);
    out.push({ sha, short, date, author, message, files: m ? Number(m[1]) : 0 });
  }
  return out;
}

/** Restore the working tree to a commit (as a new commit, history is kept). */
export async function restore(
  su: SysUser,
  dir: string,
  sha: string,
  author: { name: string; email: string },
): Promise<{ sha: string; files: number } | null> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('invalid commit');
  // save any uncommitted work first, so nothing is lost
  await checkpoint(su, dir, 'Auto-save before restore', author);
  // reset index + working tree to the target tree (removes files it did not have)
  const rt = await git(su, dir, ['read-tree', '-u', '--reset', sha], author);
  if (rt.code !== 0) throw new Error(rt.stderr.trim() || 'restore failed');
  return checkpoint(su, dir, `Restored version ${sha.slice(0, 7)}`, author);
}

export async function diffStat(su: SysUser, dir: string, sha: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return '';
  const r = await git(su, dir, ['show', '--stat', '--format=', sha]);
  return r.stdout.slice(0, 20_000);
}

// ---------------------------------------------------------------------------
// Releases: annotated tags (releases.ts)
// ---------------------------------------------------------------------------
const TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

export async function headSha(su: SysUser, dir: string): Promise<string | null> {
  const r = await git(su, dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export async function tagExists(su: SysUser, dir: string, tag: string): Promise<boolean> {
  if (!TAG_RE.test(tag)) return false;
  return (await git(su, dir, ['rev-parse', '--verify', '-q', `refs/tags/${tag}`])).code === 0;
}

/** Annotated tag on HEAD (the message is read from stdin: no quoting problems). */
export async function createTag(su: SysUser, dir: string, tag: string, message: string, author: { name: string; email: string }): Promise<void> {
  if (!TAG_RE.test(tag)) throw new Error('invalid tag name');
  const r = await runAs(su, 'git', ['-C', dir, 'tag', '-a', tag, '-F', '-'], {
    env: gitEnv(su, author.name, author.email),
    input: message.trim() || tag,
    timeoutMs: 60_000,
  });
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'could not create the tag');
}

export async function deleteTag(su: SysUser, dir: string, tag: string): Promise<void> {
  if (!TAG_RE.test(tag)) return;
  await git(su, dir, ['tag', '-d', tag]);
}

/** Subjects of the commits made after `ref` (all commits when `ref` is null or unknown). */
export async function commitsSince(su: SysUser, dir: string, ref: string | null, limit = 200): Promise<{ count: number; messages: string[] }> {
  const range = ref && (TAG_RE.test(ref) || /^[0-9a-f]{7,40}$/.test(ref)) ? [`${ref}..HEAD`] : ['HEAD'];
  const count = await git(su, dir, ['rev-list', '--count', ...range]);
  if (count.code !== 0) return { count: 0, messages: [] };
  const log = await git(su, dir, ['log', `-n${limit}`, '--pretty=format:%s', ...range]);
  return {
    count: Number(count.stdout.trim()) || 0,
    messages: log.code === 0 ? log.stdout.split('\n').filter((l) => l.trim()) : [],
  };
}

/** The tracked files of a tag or commit as a zip stream (stdout of the returned process). */
export function archiveZip(su: SysUser, dir: string, ref: string, prefix: string): ChildProcess {
  if (!TAG_RE.test(ref) && !/^[0-9a-f]{7,40}$/.test(ref)) throw new Error('invalid version');
  const safePrefix = prefix.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return spawnAs(su, 'git', ['-C', dir, 'archive', '--format=zip', `--prefix=${safePrefix}/`, ref], {
    env: gitEnv(su, 'Studio', 'studio@localhost'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
