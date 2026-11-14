// App state shared by the views: the undoable project (via History) plus the
// things that are not part of the document - selection, playhead, zoom.

import { History } from '/shared/history.js';
import { findClip, projectDuration } from '/shared/model.js';

export class Store extends EventTarget {
  constructor(project) {
    super();
    this.history = new History(project);
    this.selection = new Set();
    this.time = 0;
    this.playing = false;
    this.pxPerSec = 60;
    this.mediaStatus = new Map();
    this.history.onChange((state, reason) => {
      for (const id of [...this.selection]) {
        if (!findClip(state, id)) this.selection.delete(id);
      }
      if (this.time > projectDuration(state)) this.time = projectDuration(state);
      this.emit('project', reason);
    });
  }

  get project() {
    return this.history.state;
  }

  get duration() {
    return projectDuration(this.project);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, listener) {
    this.addEventListener(type, (event) => listener(event.detail));
  }

  setTime(ticks) {
    const next = Math.min(Math.max(0, ticks), this.duration);
    if (next === this.time) return;
    this.time = next;
    this.emit('time');
  }

  setPlaying(playing) {
    if (playing && this.duration === 0) return;
    if (playing && this.time >= this.duration) this.time = 0;
    if (playing === this.playing) return;
    this.playing = playing;
    this.emit('playing');
    this.emit('time');
  }

  select(ids, { toggle = false } = {}) {
    if (toggle) {
      for (const id of ids) {
        if (this.selection.has(id)) this.selection.delete(id);
        else this.selection.add(id);
      }
    } else {
      this.selection = new Set(ids);
    }
    this.emit('selection');
  }

  setZoom(pxPerSec) {
    this.pxPerSec = Math.min(Math.max(pxPerSec, 2), 600);
    this.emit('zoom');
  }

  setMediaStatus(mediaId, status) {
    this.mediaStatus.set(mediaId, status);
    this.emit('media-status', mediaId);
  }
}
