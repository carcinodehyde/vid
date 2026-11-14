// Entry point: load the project, create the store, renderer and player, and
// wire the top bar, transport, keyboard, autosave and export dialog.

import { ASPECTS } from '/shared/geometry.js';
import * as model from '/shared/model.js';
import { FRAME_RATES, formatTimecode, fpsKey, frameTicks, snapToFrame } from '/shared/time.js';
import { api } from './api.js';
import { initBin } from './bin-view.js';
import { initInspector } from './inspector.js';
import { Player } from './player.js';
import { Renderer } from './renderer.js';
import { Store } from './store.js';
import { initTimeline } from './timeline-view.js';

const $ = (id) => document.getElementById(id);

function fail(message) {
  const box = document.createElement('p');
  box.className = 'status error';
  box.style.padding = '16px';
  box.textContent = message;
  $('stage').replaceChildren(box);
}

async function main() {
  let saved = null;
  try {
    saved = await api.loadProject();
  } catch (error) {
    console.warn('Could not load the saved project:', error);
  }
  const store = new Store(saved ?? model.createProject());

  let renderer;
  try {
    renderer = new Renderer($('canvas'));
  } catch (error) {
    fail(error.message);
    return;
  }
  const player = new Player(store, renderer);
  const timeline = initTimeline(store);
  const bin = initBin(store);
  initInspector(store);

  // ---- Top bar: format and undo ------------------------------------------
  const aspectSelect = $('aspect');
  const fpsSelect = $('fps');
  for (const key of Object.keys(ASPECTS)) aspectSelect.add(new Option(key, key));
  for (const key of Object.keys(FRAME_RATES)) fpsSelect.add(new Option(`${key} fps`, key));

  aspectSelect.addEventListener('change', () => {
    const aspect = aspectSelect.value;
    store.history.commit(`Aspect ratio ${aspect}`, (p) => model.setFormat(p, { aspect }));
  });
  fpsSelect.addEventListener('change', () => {
    const fps = FRAME_RATES[fpsSelect.value];
    store.history.commit(`Frame rate ${fpsSelect.value}`, (p) => model.setFormat(p, { fps }));
  });
  $('undo').addEventListener('click', () => store.history.undo());
  $('redo').addEventListener('click', () => store.history.redo());

  // ---- Preview size: fit the project shape inside the stage --------------
  const stage = $('stage');
  const canvas = $('canvas');
  function layoutCanvas() {
    const { width, height } = store.project;
    const availW = stage.clientWidth - 24;
    const availH = stage.clientHeight - 24;
    if (availW <= 0 || availH <= 0) return;
    const scale = Math.min(availW / width, availH / height);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.left = `${Math.round((stage.clientWidth - w) / 2)}px`;
    canvas.style.top = `${Math.round((stage.clientHeight - h) / 2)}px`;
  }
  new ResizeObserver(layoutCanvas).observe(stage);

  // ---- Transport ----------------------------------------------------------
  const step = (frames) => {
    store.setPlaying(false);
    const fps = store.project.fps;
    store.setTime(snapToFrame(store.time, fps) + frames * frameTicks(fps));
  };
  const jump = (ticks) => {
    store.setPlaying(false);
    store.setTime(ticks);
  };
  $('play').addEventListener('click', () => store.setPlaying(!store.playing));
  $('step-back').addEventListener('click', () => step(-1));
  $('step-forward').addEventListener('click', () => step(1));
  $('to-start').addEventListener('click', () => jump(0));
  $('to-end').addEventListener('click', () => jump(store.duration));

  function syncTime() {
    $('timecode').textContent = formatTimecode(store.time, store.project.fps);
  }
  function syncPlaying() {
    $('play').textContent = store.playing ? 'Pause' : 'Play';
  }
  function syncProject() {
    const { project, history } = store;
    aspectSelect.value = project.aspect;
    fpsSelect.value = fpsKey(project.fps);
    $('resolution').textContent = `${project.width}×${project.height}`;
    $('duration').textContent = `/ ${formatTimecode(store.duration, project.fps)}`;
    $('undo').disabled = !history.canUndo;
    $('redo').disabled = !history.canRedo;
    $('undo').title = history.undoLabel ? `Undo ${history.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    $('redo').title = history.redoLabel ? `Redo ${history.redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
    $('export').disabled = store.duration === 0;
    layoutCanvas();
    syncTime();
  }

  // ---- Autosave -----------------------------------------------------------
  const saveState = $('save-state');
  let saveTimer = null;
  let saving = Promise.resolve();
  function save() {
    saveTimer = null;
    const snapshot = structuredClone(store.project);
    saving = saving
      .then(() => api.saveProject(snapshot))
      .then(() => {
        if (!saveTimer) saveState.textContent = 'Saved';
      })
      .catch((error) => {
        saveState.textContent = `Not saved: ${error.message}`;
      });
    return saving;
  }
  function scheduleSave() {
    saveState.textContent = 'Saving...';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  }

  store.on('project', (reason) => {
    syncProject();
    if (reason !== 'reset') scheduleSave();
  });
  store.on('time', syncTime);
  store.on('playing', syncPlaying);
  syncProject();
  syncPlaying();

  // ---- Keyboard -----------------------------------------------------------
  window.addEventListener('keydown', (event) => {
    const tag = event.target.tagName;
    const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && event.target.type !== 'range' && event.target.type !== 'checkbox');
    if (typing || $('export-dialog').open) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (mod && key === 'z') {
      if (event.shiftKey) store.history.redo();
      else store.history.undo();
    } else if (mod && key === 'y') {
      store.history.redo();
    } else if (mod || event.altKey) {
      return;
    } else if (event.code === 'Space') {
      store.setPlaying(!store.playing);
    } else if (key === 's') {
      timeline.split();
    } else if (key === 'delete' || key === 'backspace') {
      timeline.remove();
    } else if (key === 'home') {
      jump(0);
    } else if (key === 'end') {
      jump(store.duration);
    } else if (tag === 'INPUT') {
      return; // arrow keys belong to the focused slider
    } else if (key === 'arrowleft') {
      step(event.shiftKey ? -10 : -1);
    } else if (key === 'arrowright') {
      step(event.shiftKey ? 10 : 1);
    } else {
      return;
    }
    event.preventDefault();
  });

  // ---- Export -------------------------------------------------------------
  const dialog = $('export-dialog');
  const exportStatus = $('export-status');
  const exportProgress = $('export-progress');
  const exportResult = $('export-result');
  const exportLink = $('export-link');
  let exportRun = 0;

  async function runExport() {
    const run = (exportRun += 1);
    store.setPlaying(false);
    exportStatus.classList.remove('error');
    exportStatus.textContent = 'Starting...';
    exportProgress.value = 0;
    exportResult.textContent = '';
    exportLink.hidden = true;
    if (!dialog.open) dialog.showModal();
    try {
      let job = await api.startExport(store.project);
      while (job.state === 'running') {
        if (run !== exportRun) return job;
        exportProgress.value = job.progress;
        exportStatus.textContent = `Rendering ${Math.round(job.progress * 100)}%`;
        await new Promise((resolve) => setTimeout(resolve, 500));
        job = await api.exportStatus(job.id);
      }
      if (job.state !== 'done') throw new Error(job.error || 'Export failed');
      exportProgress.value = 1;
      exportStatus.textContent = 'Done';
      exportResult.textContent = job.output;
      exportLink.href = `/exports/${encodeURIComponent(job.file)}`;
      exportLink.target = '_blank';
      exportLink.hidden = false;
      return job;
    } catch (error) {
      exportStatus.classList.add('error');
      exportStatus.textContent = error.message;
      throw error;
    }
  }
  $('export').addEventListener('click', () => runExport().catch(() => {}));
  $('export-close').addEventListener('click', () => dialog.close());

  // Handle for the console and the smoke test.
  window.vid = { store, renderer, player, timeline, bin, api, model, runExport, save };
}

main().catch((error) => {
  console.error(error);
  fail(`The editor failed to start: ${error.message}`);
});
