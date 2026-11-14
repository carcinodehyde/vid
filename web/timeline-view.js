// The timeline: ruler, track lanes, clips, playhead, and the pointer gestures
// that edit them (scrub, select, move, trim, drop from the media bin).

import { isIdentityColor } from '/shared/color.js';
import {
  addClip,
  allClips,
  deleteClips,
  findClip,
  moveClip,
  setTrackFlag,
  splitAt,
  trimClip,
} from '/shared/model.js';
import { TICKS, formatTimecode, snapToFrame } from '/shared/time.js';

const SNAP_PX = 8;
const DRAG_THRESHOLD = 3;
const TAIL_SECONDS = 10;
export const MEDIA_MIME = 'application/x-vid-media';

export function initTimeline(store) {
  const $ = (id) => document.getElementById(id);
  const heads = $('tl-heads');
  const scroll = $('tl-scroll');
  const content = $('tl-content');
  const lanes = $('tl-lanes');
  const playhead = $('tl-playhead');
  const ruler = $('tl-ruler');
  const zoom = $('zoom');

  const toPx = (ticks) => (ticks / TICKS) * store.pxPerSec;
  const toTicks = (px) => (px / store.pxPerSec) * TICKS;
  const timeAt = (clientX) => Math.max(0, toTicks(clientX - content.getBoundingClientRect().left));

  // ---- drawing -----------------------------------------------------------

  function renderHeads() {
    heads.replaceChildren(
      ...store.project.tracks.map((track) => {
        const head = document.createElement('div');
        head.className = 'tl-head';
        const name = document.createElement('b');
        name.textContent = track.name;
        head.append(name);
        for (const [flag, label, title] of [
          ['muted', 'M', 'Mute'],
          ['hidden', 'H', 'Hide'],
          ['locked', 'L', 'Lock'],
        ]) {
          const button = document.createElement('button');
          button.textContent = label;
          button.title = `${title} ${track.name}`;
          button.setAttribute('aria-pressed', String(track[flag]));
          button.classList.toggle('on', track[flag]);
          button.addEventListener('click', () => {
            store.history.commit(`${title} track`, (p) => setTrackFlag(p, track.id, flag, !track[flag]));
          });
          head.append(button);
        }
        return head;
      }),
    );
  }

  function renderLanes() {
    const project = store.project;
    const width = Math.max(scroll.clientWidth, toPx(store.duration) + TAIL_SECONDS * store.pxPerSec);
    content.style.width = `${width}px`;
    lanes.replaceChildren(
      ...project.tracks.map((track) => {
        const lane = document.createElement('div');
        lane.className = 'tl-lane';
        lane.dataset.track = track.id;
        lane.classList.toggle('locked', track.locked);
        lane.classList.toggle('hidden', track.hidden);
        for (const clip of track.clips) {
          const media = project.media[clip.mediaId];
          const el = document.createElement('div');
          el.className = 'clip';
          el.dataset.id = clip.id;
          el.classList.toggle('selected', store.selection.has(clip.id));
          el.style.left = `${toPx(clip.begin)}px`;
          el.style.width = `${toPx(clip.end - clip.begin)}px`;
          el.title = media?.name ?? 'Missing media';
          const thumbs = document.createElement('div');
          thumbs.className = 'clip-thumbs';
          thumbs.style.backgroundImage = `url("/thumb/${clip.mediaId}")`;
          const name = document.createElement('span');
          name.className = 'clip-name';
          name.textContent = media?.name ?? 'Missing media';
          el.append(thumbs, name);
          if (!isIdentityColor(clip.color)) {
            const dot = document.createElement('span');
            dot.className = 'clip-graded';
            dot.title = 'Color corrected';
            el.append(dot);
          }
          for (const side of ['l', 'r']) {
            const handle = document.createElement('i');
            handle.className = `handle ${side}`;
            el.append(handle);
          }
          lane.append(el);
        }
        return lane;
      }),
    );
    renderPlayhead();
    renderRuler();
  }

  function renderPlayhead() {
    playhead.style.left = `${toPx(store.time)}px`;
  }

  function renderRuler() {
    const dpr = window.devicePixelRatio || 1;
    const width = scroll.clientWidth;
    const height = 24;
    ruler.width = Math.round(width * dpr);
    ruler.height = Math.round(height * dpr);
    ruler.style.width = `${width}px`;
    const ctx = ruler.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const step = steps.find((s) => s * store.pxPerSec >= 80) ?? 3600;
    const first = Math.floor(scroll.scrollLeft / store.pxPerSec / step) * step;
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.fillStyle = '#969ba6';
    ctx.strokeStyle = '#4a505b';
    ctx.beginPath();
    for (let s = first; (s - first) * store.pxPerSec < width + step * store.pxPerSec; s += step) {
      const x = Math.round(s * store.pxPerSec - scroll.scrollLeft) + 0.5;
      ctx.moveTo(x, 12);
      ctx.lineTo(x, height);
      for (let k = 1; k < 5; k += 1) {
        const minor = Math.round(x + (k * step * store.pxPerSec) / 5) + 0.5;
        ctx.moveTo(minor, 19);
        ctx.lineTo(minor, height);
      }
      const label = formatTimecode(Math.round(s * TICKS), store.project.fps);
      ctx.fillText(step >= 1 ? label.slice(0, 8) : label, x + 4, 11);
    }
    ctx.stroke();
  }

  // ---- snapping ----------------------------------------------------------

  // Times a dragged edge may stick to: other clips' edges, the playhead, zero.
  function snapPoints(excludeId) {
    const points = [0, store.time];
    for (const clip of allClips(store.project)) {
      if (clip.id !== excludeId) points.push(clip.begin, clip.end);
    }
    return points;
  }

  function snap(ticks, points) {
    const tolerance = toTicks(SNAP_PX);
    let best = null;
    for (const point of points) {
      const distance = Math.abs(point - ticks);
      if (distance <= tolerance && (best === null || distance < Math.abs(best - ticks))) best = point;
    }
    return best ?? ticks;
  }

  function trackAt(clientY, fallback) {
    for (const lane of lanes.children) {
      const rect = lane.getBoundingClientRect();
      if (clientY >= rect.top && clientY < rect.bottom) return lane.dataset.track;
    }
    return fallback;
  }

  // ---- pointer gestures --------------------------------------------------

  // Listeners live on the window because the clip elements are rebuilt on
  // every change and would drop a pointer capture mid-drag.
  function drag(event, { move, end }) {
    const onMove = (e) => move(e);
    const onUp = (e) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      end?.(e);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    event.preventDefault();
  }

  function startScrub(event) {
    store.setPlaying(false);
    const seek = (e) => store.setTime(snapToFrame(timeAt(e.clientX), store.project.fps));
    seek(event);
    drag(event, { move: seek });
  }

  function startTrim(event, clipId, edge) {
    const points = snapPoints(clipId);
    let started = false;
    store.select([clipId]);
    drag(event, {
      move: (e) => {
        if (!started) {
          if (Math.abs(e.clientX - event.clientX) < DRAG_THRESHOLD) return;
          started = true;
          store.history.begin('Trim clip');
        }
        const t = snap(timeAt(e.clientX), points);
        store.history.replace((p) => trimClip(p, clipId, edge, t));
      },
      end: () => started && store.history.end(),
    });
  }

  function startMove(event, clipId) {
    const origin = findClip(store.project, clipId);
    if (!origin) return;
    const { begin, end } = origin.clip;
    const length = end - begin;
    const homeTrack = origin.track.id;
    const points = snapPoints(clipId);
    let started = false;
    drag(event, {
      move: (e) => {
        if (!started) {
          if (Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < DRAG_THRESHOLD) return;
          started = true;
          store.history.begin('Move clip');
        }
        let desired = begin + toTicks(e.clientX - event.clientX);
        const byStart = snap(desired, points);
        const byEnd = snap(desired + length, points) - length;
        if (byStart !== desired) desired = byStart;
        else if (byEnd !== desired) desired = byEnd;
        const trackId = trackAt(e.clientY, homeTrack);
        store.history.replace((p) => moveClip(p, clipId, trackId, desired));
      },
      end: () => started && store.history.end(),
    });
  }

  content.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const clipEl = event.target.closest('.clip');
    const handle = event.target.closest('.handle');
    if (handle && clipEl) {
      startTrim(event, clipEl.dataset.id, handle.classList.contains('l') ? 'start' : 'end');
    } else if (clipEl) {
      const id = clipEl.dataset.id;
      if (event.shiftKey || event.ctrlKey) store.select([id], { toggle: true });
      else if (!store.selection.has(id)) store.select([id]);
      startMove(event, id);
    } else {
      if (event.target.closest('.tl-lane')) store.select([]);
      startScrub(event);
    }
  });

  // ---- drop from the media bin -------------------------------------------

  lanes.addEventListener('dragover', (event) => {
    const lane = event.target.closest('.tl-lane');
    if (!lane || !event.dataTransfer.types.includes(MEDIA_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    for (const other of lanes.children) other.classList.toggle('drop', other === lane);
  });
  lanes.addEventListener('dragleave', () => {
    for (const lane of lanes.children) lane.classList.remove('drop');
  });
  lanes.addEventListener('drop', (event) => {
    const lane = event.target.closest('.tl-lane');
    const mediaId = event.dataTransfer.getData(MEDIA_MIME);
    if (!lane || !mediaId) return;
    event.preventDefault();
    const at = snap(timeAt(event.clientX), snapPoints(null));
    const id = store.history.commit('Add clip', (p) => addClip(p, { mediaId, trackId: lane.dataset.track, at }));
    if (id) store.select([id]);
  });

  // ---- toolbar -----------------------------------------------------------

  const actions = {
    split() {
      // Cut the selected clips under the playhead, or every clip under it.
      const t = snapToFrame(store.time, store.project.fps);
      const under = allClips(store.project).filter((c) => c.begin < t && t < c.end);
      const chosen = under.filter((c) => store.selection.has(c.id));
      const ids = (chosen.length ? chosen : under).map((c) => c.id);
      if (ids.length) store.history.commit('Split', (p) => splitAt(p, t, ids));
    },
    remove() {
      if (!store.selection.size) return;
      const ids = [...store.selection];
      store.history.commit('Delete', (p) => deleteClips(p, ids));
    },
    zoomFit() {
      const seconds = Math.max(5, store.duration / TICKS);
      store.setZoom((scroll.clientWidth - 40) / seconds);
      scroll.scrollLeft = 0;
    },
  };

  $('split').addEventListener('click', actions.split);
  $('delete').addEventListener('click', actions.remove);
  $('zoom-fit').addEventListener('click', actions.zoomFit);
  $('ripple').addEventListener('change', (event) => {
    store.history.commit('Toggle ripple', (p) => {
      p.rippleMode = event.target.checked;
    });
  });

  // The slider is logarithmic: 0..100 maps to 2..600 px per second.
  const sliderToZoom = (value) => 2 * Math.pow(300, value / 100);
  const zoomToSlider = (px) => (Math.log(px / 2) / Math.log(300)) * 100;
  zoom.addEventListener('input', () => store.setZoom(sliderToZoom(Number(zoom.value))));
  scroll.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      store.setZoom(store.pxPerSec * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
    },
    { passive: false },
  );

  // ---- wiring ------------------------------------------------------------

  function renderToolbar() {
    $('ripple').checked = store.project.rippleMode;
    $('delete').disabled = store.selection.size === 0;
  }

  store.on('project', () => {
    renderHeads();
    renderLanes();
    renderToolbar();
  });
  store.on('selection', () => {
    for (const el of lanes.querySelectorAll('.clip')) el.classList.toggle('selected', store.selection.has(el.dataset.id));
    renderToolbar();
  });
  store.on('zoom', () => {
    zoom.value = String(zoomToSlider(store.pxPerSec));
    renderLanes();
  });
  store.on('time', () => {
    renderPlayhead();
    if (!store.playing) return;
    const x = toPx(store.time);
    if (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - 40) scroll.scrollLeft = Math.max(0, x - 80);
  });
  scroll.addEventListener('scroll', renderRuler);
  new ResizeObserver(renderLanes).observe(scroll);

  zoom.value = String(zoomToSlider(store.pxPerSec));
  renderHeads();
  renderLanes();
  renderToolbar();
  return actions;
}
