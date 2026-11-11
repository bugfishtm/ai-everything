import { api } from '../api';

// A small song to start from (DAW: New song, project bar: DAW button).
export const STARTER = (title: string) => `# ${title} — made in the Studio DAW (reference: studio-daw docs)
song:
  title: ${title}
  bpm: 100
  time: 4/4

instruments:
  drums: { use: drums }
  bass:  { use: bass, octave: 2 }
  keys:  { use: epiano }

patterns:
  beat:
    drums: |
      kick:  x-------x-------
      snare: ----x-------x---
      hat:   x-x-x-x-x-x-x-x-
  groove:
    bass: "C2:q r:q C2:e C2:e r:q | A1:q r:q A1:e A1:e r:q"
    keys: { chords: "C | Am" }

arrangement:
  - { section: intro, bars: 2, play: [groove] }
  - { section: main,  bars: 8, play: [beat, groove] }

mix:
  drums: { gain: -2 }
  bass:  { gain: -6 }
  keys:  { gain: -8, reverb: 0.25 }
`;


/** A song path in `dir` that does not exist yet: name.song.yaml, name-2.song.yaml … */
export async function freeSongPath(projectId: number, dir: string, name: string): Promise<string> {
  const exists = async (rel: string) => {
    try {
      await api(`/projects/${projectId}/file?path=${encodeURIComponent(rel)}`);
      return true;
    } catch {
      return false;
    }
  };
  const stem = name.replace(/\.song\.ya?ml$|\.ya?ml$|\.midi?$/i, '').replace(/[^\w.-]+/g, '-') || 'song';
  const base = dir ? `${dir}/` : '';
  let n = `${stem}.song.yaml`;
  for (let i = 2; await exists(`${base}${n}`); i++) n = `${stem}-${i}.song.yaml`;
  return `${base}${n}`;
}
