// Import: probe a file with ffprobe, grab a poster frame, and cache both under
// a fingerprint of the file so a second import of the same file is instant.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { TICKS } from '../shared/time.js';

const WAVEFORM = 'aformat=channel_layouts=mono,showwavespic=s=1600x120:colors=0x5ad1c0:scale=sqrt:draw=full';

export function run(command, args, { cwd, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (onStdout) onStdout(text);
      else stdout += text;
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', (error) => reject(new Error(`Could not start ${command}: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}\n${stderr.trim().split('\n').slice(-6).join('\n')}`));
    });
  });
}

// Size, modified time and the first and last megabyte: stable for a file that
// has not changed, without reading gigabytes.
async function fingerprint(filePath, stat) {
  const hash = createHash('sha1');
  hash.update(`${stat.size}:${Math.round(stat.mtimeMs)}`);
  const chunk = 1024 * 1024;
  const ranges = [[0, Math.min(chunk, stat.size) - 1]];
  if (stat.size > chunk * 2) ranges.push([stat.size - chunk, stat.size - 1]);
  for (const [start, end] of ranges) {
    if (end < start) continue;
    for await (const data of createReadStream(filePath, { start, end })) hash.update(data);
  }
  return hash.digest('hex').slice(0, 16);
}

function parseRate(text) {
  const [num, den] = String(text || '0/1').split('/').map(Number);
  return den ? num / den : 0;
}

function describe(probe, filePath) {
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video && !audio) throw new Error('No video or audio found in this file.');

  const seconds = Number(probe.format?.duration ?? (video ?? audio).duration ?? 0);
  if (!(seconds > 0)) throw new Error('Could not read a duration from this file.');
  const common = {
    name: path.basename(filePath),
    path: filePath,
    duration: Math.round(seconds * TICKS),
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    container: probe.format?.format_name ?? '',
    size: Number(probe.format?.size ?? 0),
  };
  if (!video) return { kind: 'audio', ...common, width: 0, height: 0, frameRate: 0, videoCodec: null, colorSpace: null };

  let width = video.width;
  let height = video.height;
  const [sarNum, sarDen] = String(video.sample_aspect_ratio || '1:1').split(':').map(Number);
  if (sarNum > 0 && sarDen > 0 && sarNum !== sarDen) width = Math.round((width * sarNum) / sarDen);
  const sideRotation = (video.side_data_list ?? []).find((d) => d.rotation !== undefined)?.rotation;
  const rotation = Math.abs(Number(sideRotation ?? video.tags?.rotate ?? 0)) % 180;
  if (rotation === 90) [width, height] = [height, width];

  return {
    kind: 'video',
    ...common,
    width,
    height,
    frameRate: Number((parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate)).toFixed(3)),
    videoCodec: video.codec_name,
    // Chrome only trusts a file's colour tags when matrix, primaries and
    // transfer are all present; otherwise it guesses from the frame size. The
    // exporter follows the same rule so it matches the preview.
    colorSpace: [video.color_space, video.color_primaries, video.color_transfer].every((tag) => tag && tag !== 'unknown')
      ? video.color_space
      : null,
  };
}

export class MediaStore {
  constructor(dataDir) {
    this.cacheDir = path.join(dataDir, 'cache');
    this.uploadDir = path.join(dataDir, 'uploads');
    this.items = new Map();
  }

  async init() {
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.mkdir(this.uploadDir, { recursive: true });
    for (const file of await fs.readdir(this.cacheDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const info = JSON.parse(await fs.readFile(path.join(this.cacheDir, file), 'utf8'));
        this.items.set(info.id, info);
      } catch {
        // A damaged cache entry is rebuilt on the next import.
      }
    }
  }

  get(id) {
    return this.items.get(id) ?? null;
  }

  thumbPath(id) {
    return path.join(this.cacheDir, `${id}.jpg`);
  }

  // The waveform picture of a source's sound. An audio file's poster already
  // is one; for a video file it is drawn the first time it is asked for.
  async waveform(id) {
    const info = this.get(id);
    if (!info || !info.hasAudio) return null;
    if (info.kind === 'audio') return this.thumbPath(id);
    const target = path.join(this.cacheDir, `${id}.wave.jpg`);
    if (await fs.stat(target).catch(() => null)) return target;
    this.waves ??= new Map();
    if (!this.waves.has(id)) {
      const partial = `${target}.part.jpg`;
      const job = run('ffmpeg', ['-v', 'error', '-i', info.path, '-filter_complex', WAVEFORM, '-frames:v', '1', '-q:v', '3', '-y', partial])
        .then(() => fs.rename(partial, target))
        .then(() => target)
        .finally(() => this.waves.delete(id));
      this.waves.set(id, job);
    }
    return this.waves.get(id);
  }

  proxyPath(id) {
    return path.join(this.cacheDir, `${id}.proxy.mp4`);
  }

  // The file the browser should play: the proxy when one was built.
  async playablePath(id) {
    const info = this.get(id);
    if (!info) return null;
    if (info.proxy) {
      try {
        await fs.access(this.proxyPath(id));
        return this.proxyPath(id);
      } catch {
        // Fall through to the original.
      }
    }
    return info.path;
  }

  async importFile(filePath) {
    const absolute = path.resolve(filePath);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(`File not found: ${absolute}`);

    const id = await fingerprint(absolute, stat);
    const cached = this.items.get(id);
    if (cached && cached.path === absolute && cached.kind) return { ...cached, cached: true };

    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absolute,
    ]);
    const info = { id, ...describe(JSON.parse(stdout), absolute), proxy: cached?.proxy ?? false };

    // Poster: one frame for video, the whole waveform for audio.
    const seconds = info.duration / TICKS;
    const poster =
      info.kind === 'audio'
        ? ['-i', absolute, '-filter_complex', WAVEFORM, '-frames:v', '1', '-q:v', '3']
        : ['-ss', String(Math.min(5, seconds * 0.1).toFixed(3)), '-i', absolute, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4'];
    await run('ffmpeg', ['-v', 'error', ...poster, '-y', this.thumbPath(id)]).catch(() => {});

    this.items.set(id, info);
    await fs.writeFile(path.join(this.cacheDir, `${id}.json`), JSON.stringify(info, null, 2));
    return info;
  }

  // Transcode a browser-friendly copy for preview. Export still uses the original.
  async buildProxy(id) {
    const info = this.get(id);
    if (!info) throw new Error('Unknown media');
    if (!info.proxy) {
      const target = this.proxyPath(id);
      const partial = `${target}.part.mp4`;
      const picture =
        info.kind === 'audio'
          ? ['-vn']
          : ['-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-g', '30'];
      await run('ffmpeg', [
        '-v', 'error', '-i', info.path, ...picture,
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', partial,
      ]);
      await fs.rename(partial, target);
      info.proxy = true;
      await fs.writeFile(path.join(this.cacheDir, `${id}.json`), JSON.stringify(info, null, 2));
    }
    return info;
  }

  uploadTarget(name) {
    const safe = path.basename(name).replace(/[^\w.\- ()[\]]+/g, '_').slice(-120) || 'upload.bin';
    return path.join(this.uploadDir, `${Date.now()}-${safe}`);
  }
}
