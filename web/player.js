// Playback: keeps one <video> element per source, points the right one at the
// right source time for the playhead, and hands its frames to the renderer.
// While a clip is playing the playhead follows the video's own clock, so sound
// and picture cannot drift; across gaps it follows the wall clock.

import { clipAt } from '/shared/model.js';
import { TICKS, frameTicks } from '/shared/time.js';
import { api } from './api.js';

const SEEK_TOLERANCE = 0.3; // seconds of mismatch treated as a cut rather than drift

export class Player {
  constructor(store, renderer) {
    this.store = store;
    this.renderer = renderer;
    this.videos = new Map();
    this.dirty = true;
    this.lastNow = performance.now();

    store.on('project', () => {
      this.renderer.resize(store.project);
      this.prune();
      this.dirty = true;
    });
    store.on('time', () => {
      this.dirty = true;
    });
    this.renderer.resize(store.project);
    requestAnimationFrame((now) => this.frame(now));
  }

  videoFor(mediaId) {
    let video = this.videos.get(mediaId);
    if (video) return video;
    video = document.createElement('video');
    video.preload = 'auto';
    video.playsInline = true;
    video.src = `/media/${mediaId}`;
    const markDirty = () => {
      this.dirty = true;
    };
    video.addEventListener('seeked', markDirty);
    video.addEventListener('loadeddata', markDirty);
    video.addEventListener('canplay', markDirty);
    video.addEventListener('error', () => this.recover(mediaId, video));
    video.addEventListener('loadedmetadata', () => {
      // Audio decodes but the picture does not (an unsupported video codec).
      if (video.videoWidth === 0) this.recover(mediaId, video);
    });
    this.videos.set(mediaId, video);
    return video;
  }

  // The browser cannot play this file: ask the server for an H.264 proxy once.
  async recover(mediaId, video) {
    const status = this.store.mediaStatus.get(mediaId);
    if (status === 'proxying' || status === 'broken') return;
    if (status === 'proxy') {
      this.store.setMediaStatus(mediaId, 'broken');
      return;
    }
    this.store.setMediaStatus(mediaId, 'proxying');
    try {
      await api.buildProxy(mediaId);
      this.store.setMediaStatus(mediaId, 'proxy');
      video.src = `/media/${mediaId}?proxy=1`;
      video.load();
    } catch {
      this.store.setMediaStatus(mediaId, 'broken');
    }
    this.dirty = true;
  }

  prune() {
    for (const [mediaId, video] of this.videos) {
      if (this.store.project.media[mediaId]) continue;
      video.pause();
      video.removeAttribute('src');
      video.load();
      this.videos.delete(mediaId);
    }
  }

  usable(mediaId) {
    const status = this.store.mediaStatus.get(mediaId);
    return status !== 'proxying' && status !== 'broken';
  }

  frame(now) {
    const { store } = this;
    const elapsed = Math.min(0.25, (now - this.lastNow) / 1000);
    this.lastNow = now;
    const project = store.project;
    const duration = store.duration;

    // At the very end, keep showing the last frame instead of going black.
    const lookup = duration > 0 ? Math.min(store.time, duration - frameTicks(project.fps) / 2) : 0;
    const hit = duration > 0 ? clipAt(project, lookup) : null;
    const active = hit && this.usable(hit.clip.mediaId) ? this.videoFor(hit.clip.mediaId) : null;

    for (const video of this.videos.values()) {
      if (video !== active && !video.paused) video.pause();
    }

    if (active) {
      const { clip, track } = hit;
      const target = (clip.markIn + (lookup - clip.begin)) / TICKS;
      active.muted = track.muted;
      active.volume = Math.min(1, clip.volume);

      if (store.playing) {
        if (active.ended) {
          // The picture ran out before the clip did: coast on the wall clock.
          this.advanceTo(store.time + elapsed * TICKS);
        } else if (Math.abs(active.currentTime - target) > SEEK_TOLERANCE) {
          if (!active.seeking) active.currentTime = target;
        } else if (active.paused) {
          active.play().catch(() => {});
        } else if (!active.seeking && active.readyState >= 3) {
          this.advanceTo(clip.begin + (active.currentTime * TICKS - clip.markIn));
        }
      } else {
        if (!active.paused) active.pause();
        const halfFrame = frameTicks(project.fps) / TICKS / 2;
        if (!active.seeking && Math.abs(active.currentTime - target) > halfFrame) active.currentTime = target;
      }
    } else if (store.playing) {
      this.advanceTo(store.time + elapsed * TICKS);
    }

    if (store.playing || this.dirty) {
      if (!hit) {
        this.renderer.clear();
        this.dirty = false;
      } else if (active && active.readyState >= 2 && active.videoWidth > 0) {
        this.renderer.draw(active, project.media[hit.clip.mediaId], hit.clip, project);
        // Keep redrawing until a pending seek has delivered its frame.
        this.dirty = active.seeking;
      } else if (!active) {
        this.renderer.clear();
        this.dirty = false;
      }
    }

    requestAnimationFrame((next) => this.frame(next));
  }

  advanceTo(ticks) {
    const { store } = this;
    if (ticks >= store.duration) {
      store.time = store.duration;
      store.playing = false;
      store.emit('playing');
    } else if (ticks > store.time) {
      store.time = ticks;
    }
    store.emit('time');
  }
}
