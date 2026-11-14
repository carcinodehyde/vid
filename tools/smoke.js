// End-to-end check: start the server on a spare port with a throwaway data
// folder, drive the real page in headless Chrome over the DevTools protocol,
// and verify import, timeline edits, aspect ratio, colour, playback and export.
//
//   node tools/smoke.js            (set CHROME_PATH if Chrome is elsewhere,
//                                   VID_SMOKE_OUT for where screenshots go)

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { toolPath } from '../server/media.js';
import { makeSamples } from './make-samples.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const DEBUG_PORT = 9339;
const APP = `http://127.0.0.1:${PORT}/`;
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH.');
  return found;
}

async function waitFor(what, probe, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.problems = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.problems.push(`exception: ${details.exception?.description ?? details.text}`);
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.problems.push(`console.error: ${message.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        this.problems.push(`log: ${message.params.entry.text} ${message.params.entry.url ?? ''}`);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not connect to Chrome')), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // Run an async function body in the page and return its JSON value.
  async run(body) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }
}

// Helpers installed in the page.
const PAGE_HELPERS = `
  window.T = {
    frames: (n = 2) => new Promise((done) => { const tick = () => (n-- > 0 ? requestAnimationFrame(tick) : done()); tick(); }),
    async settle(timeout = 20000) {
      const deadline = performance.now() + timeout;
      await T.frames(3);
      while (vid.player.dirty) {
        if (performance.now() > deadline) throw new Error('preview never settled');
        await T.frames(1);
      }
      await T.frames(2);
    },
    async at(seconds) {
      vid.store.setPlaying(false);
      vid.store.setTime(Math.round(seconds * 705600000));
      await T.settle();
    },
    px: (fx, fy) => vid.renderer.readPixel(fx, fy),
    clips: () => vid.model.allClips(vid.store.project).length,
    commit: (label, fn) => vid.store.history.commit(label, fn),
  };
`;

async function framePixel(file, seconds, fx, fy, width, height) {
  const x = Math.floor(fx * width);
  const y = Math.floor(fy * height);
  const { stdout } = await exec(
    toolPath('ffmpeg'),
    ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x - (x % 2)}:${y - (y % 2)},scale=in_color_matrix=bt709:in_range=tv,format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer' },
  );
  return [stdout[0], stdout[1], stdout[2]];
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const near = (a, b, tolerance) => a.every((value, i) => Math.abs(value - b[i]) <= tolerance);
const isBlack = (p) => p.every((value) => value <= 6);

async function main() {
  const outDir = process.env.VID_SMOKE_OUT || (await fs.mkdtemp(path.join(os.tmpdir(), 'vid-smoke-out-')));
  await fs.mkdir(outDir, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vid-smoke-data-'));
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vid-smoke-chrome-'));
  const [landscape, portrait, tone] = await makeSamples();
  const children = [];

  try {
    const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), VID_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(server);
    let serverLog = '';
    server.stdout.on('data', (chunk) => (serverLog += chunk));
    server.stderr.on('data', (chunk) => (serverLog += chunk));
    await waitFor('the server', async () => (await fetch(`${APP}api/project`)).ok);

    const chrome = spawn(
      findChrome(),
      [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        ...(process.env.VID_SMOKE_GPU ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
        '--mute-audio',
        '--window-size=1440,900',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    children.push(chrome);
    const target = await waitFor('Chrome', async () => {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      return list.find((entry) => entry.type === 'page');
    });
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const shot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(outDir, name);
      await fs.writeFile(file, Buffer.from(data, 'base64'));
      return file;
    };

    await cdp.send('Page.navigate', { url: APP });
    await waitFor('the app', () => cdp.run('return Boolean(window.vid)'));
    await cdp.run(PAGE_HELPERS);

    // 1. Import -----------------------------------------------------------
    const imported = await cdp.run(`
      const paths = ${JSON.stringify([landscape, portrait])};
      const out = [];
      for (const p of paths) out.push(await vid.bin.importOne(p, () => vid.api.importPath(p)));
      return out;
    `);
    const [mediaA, mediaB] = imported;
    check('import probes both files', Boolean(mediaA && mediaB), mediaA && mediaB ? `${mediaA.width}x${mediaA.height} ${mediaA.videoCodec}, ${mediaB.width}x${mediaB.height}` : 'import failed');
    check('media bin lists two cards with thumbnails', await cdp.run(`
      const imgs = [...document.querySelectorAll('#bin-list .media img')];
      await Promise.all(imgs.map((img) => img.decode().catch(() => {})));
      return imgs.length === 2 && imgs.every((img) => img.naturalWidth > 0);
    `));

    // 2. Timeline ---------------------------------------------------------
    const clipA = await cdp.run(`
      const id = T.commit('Add clip', (p) => vid.model.addClip(p, { mediaId: ${JSON.stringify(mediaA.id)}, trackId: 'V1' }));
      vid.store.select([id]);
      await T.at(1);
      return id;
    `);
    const green = await cdp.run('return T.px(0.5, 0.3)');
    check('preview draws the clip (green bar at centre)', green[1] > 120 && green[0] < 90 && green[2] < 90, `rgb ${green}`);
    check('timeline shows one clip element', (await cdp.run(`return document.querySelectorAll('#tl-lanes .clip').length`)) === 1);

    await cdp.run(`vid.store.setTime(2 * 705600000); vid.timeline.split(); await T.frames(2);`);
    check('split makes two clips', (await cdp.run('return T.clips()')) === 2);
    await cdp.run('vid.store.history.undo()');
    const afterUndo = await cdp.run('return T.clips()');
    await cdp.run('vid.store.history.redo()');
    check('undo and redo restore the split', afterUndo === 1 && (await cdp.run('return T.clips()')) === 2);

    // 3. Aspect ratio -----------------------------------------------------
    await cdp.run(`
      const select = document.getElementById('aspect');
      select.value = '9:16';
      select.dispatchEvent(new Event('change'));
      await T.at(1);
    `);
    const shape = await cdp.run(`return [vid.store.project.width, vid.store.project.height, vid.renderer.canvas.width, vid.renderer.canvas.height]`);
    check('aspect 9:16 resizes the project and preview', shape.join() === '1080,1920,720,1280', shape.join('x'));
    const letterTop = await cdp.run('return T.px(0.5, 0.1)');
    const letterMid = await cdp.run('return T.px(0.5, 0.42)');
    check('landscape clip is letterboxed in the portrait canvas', isBlack(letterTop) && near(letterMid, green, 4), `top ${letterTop}, bars ${letterMid}`);

    await cdp.run(`T.commit('Change fit', (p) => vid.model.updateClips(p, [${JSON.stringify(clipA)}], { fit: 'fill' })); await T.settle();`);
    const fillTop = await cdp.run('return T.px(0.5, 0.1)');
    check('fit "fill" covers the canvas', !isBlack(fillTop), `top ${fillTop}`);
    await cdp.run('vid.store.history.undo(); await T.settle();');

    // 4. Colour -----------------------------------------------------------
    await cdp.run(`vid.store.select([${JSON.stringify(clipA)}]); await T.frames(2);`);
    const sliderWorked = await cdp.run(`
      const slider = document.querySelector('#inspector input[aria-label="Exposure"]');
      if (!slider) return 'no exposure slider';
      const before = vid.store.history.undoStack.length;
      for (const value of [10, 25, 40]) { slider.value = value; slider.dispatchEvent(new Event('input', { bubbles: true })); }
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      await T.settle();
      const clip = vid.model.findClip(vid.store.project, ${JSON.stringify(clipA)}).clip;
      return clip.color.exposure === 40 && vid.store.history.undoStack.length === before + 1 ? 'ok' : 'exposure ' + clip.color.exposure + ', undo steps +' + (vid.store.history.undoStack.length - before);
    `);
    check('dragging the exposure slider is one undo step', sliderWorked === 'ok', sliderWorked);
    const graded = await cdp.run('return T.px(0.5, 0.42)');
    check('exposure brightens the preview', graded[1] > letterMid[1] + 10, `green ${letterMid[1]} -> ${graded[1]}`);
    const predicted = await cdp.run(`
      const { gradePixel } = await import('/shared/color.js');
      const clip = vid.model.findClip(vid.store.project, ${JSON.stringify(clipA)}).clip;
      const [r, g, b] = ${JSON.stringify(letterMid)}.map((v) => v / 255);
      return gradePixel(r, g, b, clip.color).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
    `);
    check('preview matches the colour math', near(graded, predicted, 6), `shown ${graded}, computed ${predicted}`);

    // 5. Second clip and playback -------------------------------------------
    await cdp.run(`
      document.querySelectorAll('#bin-list .media')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await T.at(8);
    `);
    let duration = await cdp.run('return vid.store.duration / 705600000');
    check('double-click appends the second clip', (await cdp.run('return T.clips()')) === 3 && Math.abs(duration - 10) < 0.05, `duration ${duration.toFixed(2)} s`);
    check('second clip draws', !isBlack(await cdp.run('return T.px(0.5, 0.5)')));

    const played = await cdp.run(`
      await T.at(0.5);
      const start = vid.store.time;
      vid.store.setPlaying(true);
      await new Promise((r) => setTimeout(r, 2500));
      const moved = (vid.store.time - start) / 705600000;
      vid.store.setPlaying(false);
      return moved;
    `);
    check('playback advances the playhead in real time', played > 1.2 && played < 3.2, `${played.toFixed(2)} s in 2.5 s`);

    // 5b. Audio file ----------------------------------------------------------
    const toneMedia = await cdp.run(`const p = ${JSON.stringify(tone)}; return vid.bin.importOne(p, () => vid.api.importPath(p));`);
    check('audio file imports as audio', toneMedia?.kind === 'audio' && toneMedia.hasAudio, toneMedia ? `${toneMedia.audioCodec}, ${(toneMedia.duration / 705600000).toFixed(1)} s` : 'import failed');
    check('audio card shows a waveform', await cdp.run(`
      const img = document.querySelectorAll('#bin-list .media.audio img')[0];
      if (!img) return false;
      await img.decode().catch(() => {});
      return img.naturalWidth > 0;
    `));
    const placed = await cdp.run(`
      document.querySelector('#bin-list .media.audio').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await T.frames(2);
      const a1 = vid.model.getTrack(vid.store.project, 'A1');
      return {
        onA1: a1.clips.length,
        id: a1.clips[0]?.id,
        drawn: document.querySelectorAll('#tl-lanes .tl-lane.audio .clip.audio').length,
        lanes: document.querySelectorAll('#tl-lanes .tl-lane').length,
        sliders: [...document.querySelectorAll('#inspector input[type=range]')].map((s) => s.getAttribute('aria-label')).join(),
      };
    `);
    duration = await cdp.run('return vid.store.duration / 705600000');
    check('double-click puts the audio on A1 and extends the timeline', placed.onA1 === 1 && placed.drawn === 1 && placed.lanes === 4 && Math.abs(duration - 12) < 0.05, `duration ${duration.toFixed(2)} s`);
    check('an audio clip only offers a volume slider', placed.sliders === 'Volume', placed.sliders);
    const wrongLane = await cdp.run(`
      const id = T.commit('Add clip', (p) => vid.model.addClip(p, { mediaId: ${JSON.stringify(toneMedia?.id)}, trackId: 'V2', at: 0 }));
      const track = vid.model.findClip(vid.store.project, id).track.id;
      vid.store.history.undo();
      return track;
    `);
    check('audio aimed at a video track goes to an audio track', wrongLane === 'A1' || wrongLane === 'A2', wrongLane);

    const withPicture = await cdp.run(`
      await T.at(0.5);
      vid.store.setPlaying(true);
      await new Promise((r) => setTimeout(r, 2000));
      const el = [...vid.player.audios.values()][0]?.el;
      const out = el ? { playing: !el.paused, drift: Math.abs(el.currentTime - vid.store.time / 705600000) } : null;
      vid.store.setPlaying(false);
      return out;
    `);
    check('audio plays in step with the picture', Boolean(withPicture?.playing) && withPicture.drift < 0.15, withPicture ? `drift ${(withPicture.drift * 1000).toFixed(0)} ms` : 'no audio element');
    const tail = await cdp.run(`
      await T.at(10.3);
      const start = vid.store.time;
      vid.store.setPlaying(true);
      await new Promise((r) => setTimeout(r, 1200));
      const el = [...vid.player.audios.values()][0].el;
      const out = { moved: (vid.store.time - start) / 705600000, playing: !el.paused, black: T.px(0.5, 0.5) };
      vid.store.setPlaying(false);
      await T.frames(3);
      out.pausedAfter = el.paused;
      return out;
    `);
    check('audio keeps playing over black after the picture ends', tail.playing && tail.pausedAfter && tail.moved > 0.7 && tail.moved < 1.6 && isBlack(tail.black), `${tail.moved.toFixed(2)} s in 1.2 s`);

    // 5c. Detach audio --------------------------------------------------------
    const detached = await cdp.run(`
      const button = document.getElementById('detach');
      vid.store.select([${JSON.stringify(placed.id)}]);
      await T.frames(2);
      const offForAudio = button.disabled;
      vid.store.select([${JSON.stringify(clipA)}]);
      await T.frames(2);
      const onForVideo = !button.disabled;
      button.click();
      await T.frames(2);
      const source = vid.model.findClip(vid.store.project, ${JSON.stringify(clipA)}).clip;
      const twin = vid.model.getTrack(vid.store.project, 'A2').clips[0];
      const wave = await fetch('/wave/' + source.mediaId);
      return {
        offForAudio,
        onForVideo,
        offAfter: button.disabled,
        silent: source.detached === true,
        twin: twin ? [twin.mediaId === source.mediaId, twin.begin === source.begin, twin.end === source.end, twin.markIn === source.markIn].join() : 'none',
        selected: twin ? vid.store.selection.has(twin.id) : false,
        sliders: [...document.querySelectorAll('#inspector input[type=range]')].map((s) => s.getAttribute('aria-label')).join(),
        badge: document.querySelectorAll('#tl-lanes .clip.detached').length,
        wave: wave.status + ' ' + wave.headers.get('content-type'),
        problems: vid.model.validate(vid.store.project).join('; '),
      };
    `);
    check('Detach audio is offered for video clips only', detached.offForAudio && detached.onForVideo && detached.offAfter);
    check('detaching puts the clip\'s sound on A2 under the picture', detached.silent && detached.twin === 'true,true,true,true' && detached.selected && detached.badge === 1 && detached.problems === '', `twin ${detached.twin} ${detached.problems}`);
    check('the detached clip is an audio clip with a waveform', detached.sliders === 'Volume' && detached.wave === '200 image/jpeg', `${detached.sliders}; ${detached.wave}`);
    const detachedPlay = await cdp.run(`
      await T.at(0.5);
      vid.store.setPlaying(true);
      await new Promise((r) => setTimeout(r, 1200));
      const video = vid.player.videos.get(${JSON.stringify(mediaA.id)});
      const el = vid.player.audios.get('A2:' + ${JSON.stringify(mediaA.id)})?.el;
      const out = { pictureMuted: video.muted, playing: Boolean(el) && !el.paused, drift: el ? Math.abs(el.currentTime - vid.store.time / 705600000) : 9 };
      vid.store.setPlaying(false);
      return out;
    `);
    check('preview plays the detached sound and silences the picture', detachedPlay.pictureMuted && detachedPlay.playing && detachedPlay.drift < 0.15, `drift ${(detachedPlay.drift * 1000).toFixed(0)} ms`);

    await cdp.run(`vid.store.select([${JSON.stringify(placed.id)}]); await T.at(8);`);
    const editorShot = await shot('editor.png');

    // 6. Autosave and reload ------------------------------------------------
    await waitFor('autosave', () => cdp.run(`return document.getElementById('save-state').textContent === 'Saved'`), 8000);
    const savedText = await fs.readFile(path.join(dataDir, 'project.json'), 'utf8').catch(() => '');
    check('project is autosaved to disk', savedText.includes('"aspect": "9:16"'));

    // 7. Export ---------------------------------------------------------------
    const previewA = await cdp.run('await T.at(1); return T.px(0.5, 0.42)');
    const previewB = await cdp.run('await T.at(3); return T.px(0.5, 0.42)');
    const job = await cdp.run(`
      const job = await vid.runExport();
      return job;
    `);
    const exportShot = await shot('export-dialog.png');
    check('export finishes', job.state === 'done', job.error ?? job.file);
    if (job.state === 'done') {
      const probe = JSON.parse((await exec(toolPath('ffprobe'), ['-v', 'error', '-of', 'json', '-show_streams', '-show_format', job.output])).stdout);
      const video = probe.streams.find((s) => s.codec_type === 'video');
      const audio = probe.streams.find((s) => s.codec_type === 'audio');
      const length = Number(probe.format.duration);
      check('exported file is 1080x1920 H.264 with audio', video.width === 1080 && video.height === 1920 && video.codec_name === 'h264' && Boolean(audio), `${video.width}x${video.height} ${video.codec_name} + ${audio?.codec_name}`);
      check('exported length matches the timeline', Math.abs(length - duration) < 0.15, `${length.toFixed(2)} s vs ${duration.toFixed(2)} s`);
      const exportTop = await framePixel(job.output, 1, 0.5, 0.1, 1080, 1920);
      const exportA = await framePixel(job.output, 1, 0.5, 0.42, 1080, 1920);
      const exportB = await framePixel(job.output, 3, 0.5, 0.42, 1080, 1920);
      check('export is letterboxed like the preview', isBlack(exportTop), `top ${exportTop}`);
      check('export colour matches preview (graded part)', near(exportA, previewA, 14), `export ${exportA}, preview ${previewA}`);
      check('export colour matches preview (ungraded part)', near(exportB, previewB, 14), `export ${exportB}, preview ${previewB}`);
      // 10-12 s has no picture sound, so anything audible there is the audio track.
      const loudness = async (from) => {
        const { stderr } = await exec(toolPath('ffmpeg'), ['-hide_banner', '-ss', String(from), '-t', '1', '-i', job.output, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
        return Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr)?.[1] ?? -99);
      };
      const tailDb = await loudness(10.5);
      check('exported sound includes the audio track', tailDb > -40, `${tailDb} dB at 10.5 s`);
      const link = await cdp.run(`const r = await fetch(document.getElementById('export-link').href, { method: 'HEAD' }); return r.status;`);
      check('exported file is served for download', link === 200, `HTTP ${link}`);
    }

    await cdp.run(`document.getElementById('export-close').click();`);
    await cdp.send('Page.reload');
    await waitFor('the reloaded app', () => cdp.run('return Boolean(window.vid)'));
    await cdp.run(PAGE_HELPERS);
    check('reload restores the saved project', (await cdp.run('return T.clips()')) === 5 && (await cdp.run('return vid.store.project.aspect')) === '9:16');

    const ignorable = (line) => /favicon/.test(line);
    const problems = cdp.problems.filter((line) => !ignorable(line));
    check('no page errors', problems.length === 0, problems.slice(0, 5).join(' | '));

    console.log(`\nScreenshots: ${editorShot}\n             ${exportShot}`);
    if (/Error/.test(serverLog)) console.log(`\nServer log:\n${serverLog}`);
  } finally {
    for (const child of children) child.kill();
    await sleep(500);
    for (const dir of [dataDir, profileDir]) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  }

  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
