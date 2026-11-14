// Media bin: import files (upload, pasted path, or drop onto the window) and
// list them as cards that can be dragged onto the timeline.

import { addClip, addMedia, mediaKind } from '/shared/model.js';
import { TICKS } from '/shared/time.js';
import { api } from './api.js';
import { MEDIA_MIME } from './timeline-view.js';

function clock(ticks) {
  const total = Math.round(ticks / TICKS);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const STATUS_TEXT = {
  proxying: ['Building preview copy...', false],
  proxy: ['Previewing a converted copy', false],
  broken: ['Cannot preview this file', true],
};

export function initBin(store) {
  const $ = (id) => document.getElementById(id);
  const list = $('bin-list');
  const status = $('bin-status');
  const fileInput = $('file-input');
  const pathInput = $('import-path');

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle('error', isError);
  }

  function render() {
    const items = Object.values(store.project.media);
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'bin-empty';
      empty.textContent = 'Import video or audio, then drag it onto a track.';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...items.map((media) => {
        const card = document.createElement('div');
        const audio = mediaKind(media) === 'audio';
        card.className = audio ? 'media audio' : 'media';
        card.draggable = true;
        card.title = `${media.path}\nDouble-click to add at the end of ${audio ? 'the first audio track' : 'V1'}`;
        const img = document.createElement('img');
        img.src = `/thumb/${media.id}`;
        img.alt = '';
        img.draggable = false;
        const text = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'media-name';
        name.textContent = media.name;
        const meta = document.createElement('div');
        meta.className = 'media-meta';
        meta.textContent = audio
          ? `${clock(media.duration)} · audio · ${media.audioCodec}`
          : `${clock(media.duration)} · ${media.width}×${media.height} · ${media.videoCodec}`;
        text.append(name, meta);
        const state = STATUS_TEXT[store.mediaStatus.get(media.id)];
        if (state) {
          const flag = document.createElement('div');
          flag.className = `media-flag${state[1] ? ' error' : ''}`;
          flag.textContent = state[0];
          text.append(flag);
        }
        card.append(img, text);
        card.addEventListener('dragstart', (event) => {
          event.dataTransfer.setData(MEDIA_MIME, media.id);
          event.dataTransfer.effectAllowed = 'copy';
        });
        card.addEventListener('dblclick', () => {
          const id = store.history.commit('Add clip', (p) => addClip(p, { mediaId: media.id }));
          if (id) store.select([id]);
        });
        return card;
      }),
    );
  }

  // Run one import and add its result to the project as a single undo step.
  async function importOne(label, job) {
    setStatus(`Importing ${label}...`);
    try {
      const media = await job();
      store.history.commit('Import media', (p) => addMedia(p, media));
      setStatus('');
      return media;
    } catch (error) {
      setStatus(`${label}: ${error.message}`, true);
      return null;
    }
  }

  async function importFiles(files) {
    for (const file of files) await importOne(file.name, () => api.upload(file));
  }

  $('import-files').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    await importFiles([...fileInput.files]);
    fileInput.value = '';
  });
  $('import-path-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = pathInput.value.trim();
    if (!value) return;
    if (await importOne(value.split(/[\\/]/).pop(), () => api.importPath(value))) pathInput.value = '';
  });

  // Files dropped anywhere on the window are imported.
  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    importFiles([...event.dataTransfer.files]);
  });

  store.on('project', render);
  store.on('media-status', render);
  render();
  return { importOne };
}
