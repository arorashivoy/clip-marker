#!/usr/bin/env node
// Cut one clip for each marker of a stream. It uses yt-dlp (https://github.com/yt-dlp/yt-dlp) and ffmpeg.
// A range (a start marker and an end marker, for example a boss fight) becomes one clip of the full range.
// Usage: node clip.js <stream link or video ID> [--before 30] [--after 15] [--out clips] [--dry] [--no-ranges]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args.splice(i, 2)[1];
};
const dry = args.includes('--dry');
const noRanges = args.includes('--no-ranges');
const before = Number(option('before', 30));
const after = Number(option('after', 15));
const outDir = option('out', path.join(__dirname, 'clips'));
const input = args.find((a) => !a.startsWith('--'));
const videoId = input?.match(/(?:v=|youtu\.be\/|\/live\/|\/video\/)([\w-]{11})/)?.[1] || (/^[\w-]{11}$/.test(input || '') ? input : null);
if (!videoId) {
  console.error('Usage: node clip.js <stream link or video ID> [--before 30] [--after 15] [--out clips] [--dry] [--no-ranges]');
  process.exit(1);
}

const file = path.join(__dirname, 'data', 'markers.jsonl');
const all = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((m) => m.videoId === videoId && m.offsetSec != null)
  .sort((a, b) => a.offsetSec - b.offsetSec);
const markers = all.filter((m) => !m.kind);
if (!all.length) {
  console.error(`There are no markers with a stream time for ${videoId}.`);
  process.exit(1);
}

// Join the markers that overlap into one clip.
const clips = [];
for (const m of markers) {
  const start = Math.max(0, m.offsetSec - before), end = m.offsetSec + after;
  const last = clips.at(-1);
  if (last && start <= last.end) { last.end = end; last.terms.add(m.category || m.term); }
  else clips.push({ start, end, terms: new Set([m.category || m.term]) });
}

// One clip for each range that has an end marker.
for (const s of noRanges ? [] : all.filter((m) => m.kind === 'start')) {
  const e = all.find((m) => m.kind === 'end' && m.rangeId === s.rangeId);
  if (!e) { console.error(`The range "${s.category}" at ${s.offset} has no end marker. The tool skips it.`); continue; }
  clips.push({ start: Math.max(0, s.offsetSec - before), end: e.offsetSec + after, terms: new Set([`full-${s.category}`]) });
}

const stamp = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join('-');
fs.mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const clip of clips) {
  const name = `${videoId}_${stamp(clip.start)}_${[...clip.terms].join('+').replace(/[^\w+]+/g, '-')}`;
  const cmd = ['--download-sections', `*${clip.start}-${clip.end}`, '--force-keyframes-at-cuts',
    '-o', path.join(outDir, `${name}.%(ext)s`), `https://www.youtube.com/watch?v=${videoId}`];
  console.log(`yt-dlp ${cmd.join(' ')}`);
  if (dry) continue;
  const run = spawnSync('yt-dlp', cmd, { stdio: 'inherit' });
  if (run.error) { console.error('yt-dlp did not start. Install yt-dlp first.'); process.exit(1); }
  if (run.status !== 0) failed += 1;
}
console.log(`${clips.length - failed} of ${clips.length} clips are in ${outDir}.`);
process.exit(failed ? 1 : 0);
