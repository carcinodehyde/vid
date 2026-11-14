// Generate small test files in samples/ with FFmpeg's built-in sources: a
// landscape clip of colour bars and a portrait test pattern, both with a tone,
// and an audio-only tone.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../server/media.js';

export const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');

const SAMPLES = [
  { file: 'bars-landscape.mp4', video: 'smptebars=size=1280x720:rate=30', tone: 440, seconds: 6 },
  { file: 'pattern-portrait.mp4', video: 'testsrc2=size=720x1280:rate=25', tone: 660, seconds: 4 },
  { file: 'tone.mp3', video: null, tone: 220, seconds: 12 },
];

export async function makeSamples({ force = false } = {}) {
  await fs.mkdir(SAMPLES_DIR, { recursive: true });
  const made = [];
  for (const sample of SAMPLES) {
    const output = path.join(SAMPLES_DIR, sample.file);
    made.push(output);
    if (!force && (await fs.stat(output).catch(() => null))) continue;
    const tone = ['-f', 'lavfi', '-i', `sine=frequency=${sample.tone}:sample_rate=48000`, '-t', String(sample.seconds)];
    const encode = sample.video
      ? ['-f', 'lavfi', '-i', sample.video, ...tone, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart']
      : [...tone, '-c:a', 'libmp3lame', '-b:a', '160k', '-ac', '2'];
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...encode, output]);
  }
  return made;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const file of await makeSamples({ force: process.argv.includes('--force') })) console.log(file);
}
