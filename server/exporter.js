// Render: turn the flattened timeline into one FFmpeg filter graph. Every span
// is scaled and positioned with the same destRect() the preview uses and graded
// with the same LUT, then the spans are concatenated. Clips on audio tracks are
// delayed to their position and mixed over the result.

import fs from 'node:fs/promises';
import path from 'node:path';

import { bakeLut, colorKey, isIdentityColor, lutToCube } from '../shared/color.js';
import { destRect } from '../shared/geometry.js';
import { projectDuration, trackKind } from '../shared/model.js';
import { flatten } from '../shared/segments.js';
import { TICKS } from '../shared/time.js';
import { run } from './media.js';

const seconds = (ticks) => (ticks / TICKS).toFixed(6);
const AUDIO = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
// The output is always BT.709, limited range, and tagged as such.
const TO_YUV = 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p';
const OUTPUT_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

// Which YUV matrix a source uses. Untagged files are guessed the way browsers
// guess them: BT.709 for HD sizes, BT.601 below that.
function sourceMatrix(media) {
  const tag = media.colorSpace;
  if (tag === 'bt709') return 'bt709';
  if (tag === 'smpte170m' || tag === 'bt470bg') return 'bt601';
  if (tag === 'bt2020nc' || tag === 'bt2020c') return 'bt2020';
  return media.width >= 1280 || media.height >= 720 ? 'bt709' : 'bt601';
}

// Pure: returns the ffmpeg arguments and the LUT files they refer to (relative
// names, resolved against the working directory ffmpeg is started in).
export function buildExport(project, resolveMediaPath, outputPath) {
  const spans = flatten(project);
  if (!spans.length) throw new Error('The timeline is empty.');

  const { width, height, fps } = project;
  const rate = `${fps.num}/${fps.den}`;
  const inputs = [];
  const filters = [];
  const luts = new Map();
  const concatPads = [];

  spans.forEach((span, i) => {
    const duration = seconds(span.end - span.start);
    const canvas = `color=c=black:s=${width}x${height}:r=${rate}:d=${duration}`;
    const silence = `anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${i}]`;

    if (!span.clip) {
      filters.push(`${canvas},format=gbrp,${TO_YUV},setsar=1[v${i}]`, silence);
      concatPads.push(`[v${i}][a${i}]`);
      return;
    }

    const { clip } = span;
    const media = project.media[clip.mediaId];
    const input = inputs.length / 6;
    inputs.push('-ss', seconds(span.sourceStart), '-t', duration, '-i', resolveMediaPath(clip.mediaId));

    const rect = destRect(media.width, media.height, width, height, clip);
    const w = Math.max(2, Math.round(rect.w));
    const h = Math.max(2, Math.round(rect.h));
    // Go to RGB in the same step as the resize, naming the source's YUV matrix
    // so the picture is decoded the way the browser preview decodes it.
    const chain = [
      `fps=${rate}`,
      `scale=${w}:${h}:flags=bicubic:in_color_matrix=${sourceMatrix(media)}`,
      'format=gbrp',
      'setsar=1',
    ];
    if (!isIdentityColor(clip.color)) {
      const key = colorKey(clip.color);
      if (!luts.has(key)) luts.set(key, { name: `grade_${luts.size}.cube`, color: clip.color });
      chain.push(`lut3d=file=${luts.get(key).name}:interp=tetrahedral`);
    }
    filters.push(
      `[${input}:v]${chain.join(',')}[fg${i}]`,
      `${canvas},format=gbrp[bg${i}]`,
      `[bg${i}][fg${i}]overlay=x=${Math.round(rect.x)}:y=${Math.round(rect.y)}:format=gbrp:eof_action=repeat,` +
        `${TO_YUV},setsar=1,trim=duration=${duration},setpts=PTS-STARTPTS[v${i}]`,
    );

    // A clip whose sound was detached is silent; its twin is mixed in below.
    if (media.hasAudio && !clip.detached && !span.track.muted && clip.volume > 0) {
      filters.push(
        `[${input}:a]${AUDIO},volume=${clip.volume.toFixed(3)},apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${i}]`,
      );
    } else {
      filters.push(silence);
    }
    concatPads.push(`[v${i}][a${i}]`);
  });

  // Audio tracks: each clip is cut from its source, delayed to where it sits
  // on the timeline, and summed with the sound of the picture.
  const mixPads = [];
  for (const track of project.tracks) {
    if (trackKind(track) !== 'audio' || track.muted) continue;
    for (const clip of track.clips) {
      const media = project.media[clip.mediaId];
      if (!media?.hasAudio || !(clip.volume > 0)) continue;
      const input = inputs.length / 6;
      const duration = seconds(clip.end - clip.begin);
      inputs.push('-ss', seconds(clip.markIn), '-t', duration, '-i', resolveMediaPath(clip.mediaId));
      const pad = `[m${mixPads.length}]`;
      const delay = Math.round((clip.begin / TICKS) * 48000);
      filters.push(
        `[${input}:a]${AUDIO},volume=${clip.volume.toFixed(3)},atrim=duration=${duration},asetpts=PTS-STARTPTS,adelay=${delay}S:all=1${pad}`,
      );
      mixPads.push(pad);
    }
  }

  const concat = `${concatPads.join('')}concat=n=${spans.length}:v=1:a=1`;
  if (mixPads.length) {
    // Sum without rescaling, then catch peaks the sum pushes over full scale.
    filters.push(
      `${concat}[v][base]`,
      `[base]${mixPads.join('')}amix=inputs=${mixPads.length + 1}:normalize=0:duration=first,alimiter=limit=0.98:level=0[a]`,
    );
  } else {
    filters.push(`${concat}[v][a]`);
  }

  const args = [
    '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', ...OUTPUT_TAGS,
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    outputPath,
  ];
  const files = [...luts.values()].map(({ name, color }) => ({ name, content: lutToCube(bakeLut(color)) }));
  return { args, files, duration: projectDuration(project) };
}

export class ExportQueue {
  constructor(dataDir, media, exportDir = null) {
    this.dir = exportDir || path.join(dataDir, 'exports');
    this.media = media;
    this.jobs = new Map();
    this.counter = 0;
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  async start(project) {
    await fs.mkdir(this.dir, { recursive: true });
    const id = `x${Date.now().toString(36)}${(this.counter += 1)}`;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = `${(project.name || 'export').replace(/[^\w\- ]+/g, '_')}-${project.aspect.replace(':', 'x')}-${stamp}.mp4`;
    const output = path.join(this.dir, file);
    const workDir = path.join(this.dir, `.work-${id}`);

    const plan = buildExport(
      project,
      (mediaId) => {
        const info = this.media.get(mediaId);
        if (!info) throw new Error(`A clip refers to media that is no longer imported (${mediaId}).`);
        return info.path;
      },
      output,
    );

    const job = { id, state: 'running', progress: 0, file, output, error: null };
    this.jobs.set(id, job);

    await fs.mkdir(workDir, { recursive: true });
    for (const lut of plan.files) await fs.writeFile(path.join(workDir, lut.name), lut.content);

    const total = plan.duration / TICKS;
    run('ffmpeg', plan.args, {
      cwd: workDir,
      onStdout: (text) => {
        const match = [...text.matchAll(/out_time_(?:us|ms)=(\d+)/g)].at(-1);
        if (match && total > 0) job.progress = Math.min(0.99, Number(match[1]) / 1e6 / total);
      },
    })
      .then(() => {
        job.state = 'done';
        job.progress = 1;
      })
      .catch((error) => {
        job.state = 'failed';
        job.error = error.message;
      })
      .finally(() => fs.rm(workDir, { recursive: true, force: true }).catch(() => {}));

    return job;
  }
}
