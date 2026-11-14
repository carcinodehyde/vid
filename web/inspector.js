// Inspector: placement, volume and color sliders for the selected clips.
// The controls are built once per selection and then only have their values
// refreshed, so a slider is never replaced while it is being dragged.

import { COLOR_PARAMS, DEFAULT_COLOR } from '/shared/color.js';
import { FIT_MODES } from '/shared/geometry.js';
import { findClip, updateClips } from '/shared/model.js';
import { formatTimecode } from '/shared/time.js';

// Sliders show friendly units; `scale` converts them to the stored value.
const PLACEMENT = [
  { key: 'scale', label: 'Scale', min: 10, max: 400, scale: 100, unit: '%' },
  { key: 'posX', label: 'Position X', min: -100, max: 100, scale: 100, unit: '%' },
  { key: 'posY', label: 'Position Y', min: -100, max: 100, scale: 100, unit: '%' },
];
const PLACEMENT_DEFAULTS = { fit: 'fit', scale: 1, posX: 0, posY: 0 };

export function initInspector(store) {
  const root = document.getElementById('inspector');
  let builtFor = null;
  let refreshers = [];

  const selectedIds = () => [...store.selection];
  const firstClip = () => findClip(store.project, selectedIds()[0])?.clip ?? null;

  function group(title, onReset) {
    const header = document.createElement('div');
    header.className = 'insp-group';
    const h3 = document.createElement('h3');
    h3.textContent = title;
    header.append(h3);
    if (onReset) {
      const reset = document.createElement('button');
      reset.textContent = 'Reset';
      reset.addEventListener('click', onReset);
      header.append(reset);
    }
    return header;
  }

  // A labelled range input. Dragging it is one undo step; double-clicking the
  // label returns it to its default.
  function slider({ label, min, max, unit = '', read, patch, fallback }) {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('label');
    name.textContent = label;
    name.title = 'Double-click to reset';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = 1;
    input.setAttribute('aria-label', label);
    const output = document.createElement('output');
    output.className = 'mono';
    row.append(name, input, output);

    let dragging = false;
    input.addEventListener('input', () => {
      if (!dragging) {
        dragging = true;
        store.history.begin(`Change ${label.toLowerCase()}`);
      }
      const ids = selectedIds();
      const value = Number(input.value);
      store.history.replace((p) => updateClips(p, ids, patch(value)));
    });
    input.addEventListener('change', () => {
      if (dragging) store.history.end();
      dragging = false;
    });
    name.addEventListener('dblclick', () => {
      const ids = selectedIds();
      store.history.commit(`Reset ${label.toLowerCase()}`, (p) => updateClips(p, ids, patch(fallback)));
    });
    refreshers.push((clip) => {
      const value = Math.round(read(clip));
      if (!dragging) input.value = String(value);
      output.textContent = `${value}${unit}`;
    });
    return row;
  }

  function fitButtons() {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('label');
    name.textContent = 'Fit';
    const buttons = document.createElement('div');
    buttons.className = 'segmented';
    const made = FIT_MODES.map((mode) => {
      const button = document.createElement('button');
      button.textContent = mode;
      button.addEventListener('click', () => {
        const ids = selectedIds();
        store.history.commit('Change fit', (p) => updateClips(p, ids, { fit: mode }));
      });
      buttons.append(button);
      return [mode, button];
    });
    row.append(name, buttons);
    refreshers.push((clip) => {
      for (const [mode, button] of made) {
        button.classList.toggle('on', clip.fit === mode);
        button.setAttribute('aria-pressed', String(clip.fit === mode));
      }
    });
    return row;
  }

  function build() {
    refreshers = [];
    const ids = selectedIds();
    if (!ids.length) {
      const hint = document.createElement('p');
      hint.className = 'insp-hint';
      hint.textContent = 'Select a clip on the timeline to place it on the canvas and correct its color.';
      root.replaceChildren(hint);
      return;
    }

    const title = document.createElement('div');
    title.className = 'insp-title';
    const sub = document.createElement('div');
    sub.className = 'insp-sub mono';
    refreshers.push((clip) => {
      const media = store.project.media[clip.mediaId];
      title.textContent = ids.length > 1 ? `${ids.length} clips` : (media?.name ?? 'Missing media');
      const fps = store.project.fps;
      sub.textContent = `${formatTimecode(clip.begin, fps)} - ${formatTimecode(clip.end, fps)}`;
    });

    const nodes = [title, sub];
    nodes.push(
      group('Placement', () => store.history.commit('Reset placement', (p) => updateClips(p, selectedIds(), PLACEMENT_DEFAULTS))),
      fitButtons(),
    );
    for (const item of PLACEMENT) {
      nodes.push(
        slider({
          ...item,
          read: (clip) => clip[item.key] * item.scale,
          patch: (value) => ({ [item.key]: value / item.scale }),
          fallback: PLACEMENT_DEFAULTS[item.key] * item.scale,
        }),
      );
    }

    nodes.push(
      group('Audio'),
      slider({
        label: 'Volume',
        min: 0,
        max: 200,
        unit: '%',
        read: (clip) => clip.volume * 100,
        patch: (value) => ({ volume: value / 100 }),
        fallback: 100,
      }),
    );

    let lastGroup = null;
    for (const param of COLOR_PARAMS) {
      if (param.group !== lastGroup) {
        lastGroup = param.group;
        const keys = COLOR_PARAMS.filter((p) => p.group === param.group).map((p) => p.key);
        nodes.push(
          group(param.group, () => {
            const color = Object.fromEntries(keys.map((key) => [key, DEFAULT_COLOR[key]]));
            store.history.commit(`Reset ${param.group.toLowerCase()}`, (p) => updateClips(p, selectedIds(), { color }));
          }),
        );
      }
      nodes.push(
        slider({
          label: param.label,
          min: -100,
          max: 100,
          read: (clip) => clip.color[param.key] ?? 0,
          patch: (value) => ({ color: { [param.key]: value } }),
          fallback: 0,
        }),
      );
    }
    root.replaceChildren(...nodes);
  }

  function refresh() {
    const key = selectedIds().join(',');
    if (key !== builtFor) {
      builtFor = key;
      build();
    }
    const clip = firstClip();
    if (clip) for (const update of refreshers) update(clip);
  }

  store.on('selection', refresh);
  store.on('project', refresh);
  refresh();
}
