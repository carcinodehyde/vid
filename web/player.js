// Playback: keeps one <video> element per source, points the right one at the
// right source time for the playhead, and hands its frames to the renderer.
// While a clip is playing the playhead follows the video's own clock, so sound
// and picture cannot drift; across gaps it follows the wall clock.

//
// Clips on audio tracks each get an <audio> element that is kept in step with
// the playhead. When no picture is playing, the first of them is the clock.

import { audioClipsAt, clipAt } from '/shared/model.js';
import { TICKS, frameTicks } from '/shared/time.js';
import { api } from './api.js';

const SEEK_TOLERANCE = 0.3; // seconds of mismatch treated as a cut rather than drift
const AUDIO_TOLERANCE = 0.12; // audio tracks are pulled back in line sooner

export class Player {
  constructor(store, renderer) {
    this.store = store;
    this.renderer = renderer;
    this.videos = new Map();
    this.audios = new Map(); // "trackId:mediaId" -> { mediaId, el }
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
    video.src = this.sourceUrl(mediaId);
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

  sourceUrl(mediaId) {
    return `/media/${mediaId}${this.store.mediaStatus.get(mediaId) === 'proxy' ? '?proxy=1' : ''}`;
  }

  // One element per track and source: clips on one track never overlap, but
  // the same file may sound on two tracks at once.
  audioFor(trackId, mediaId) {
    const key = `${trackId}:${mediaId}`;
    let entry = this.audios.get(key);
    if (entry) return entry.el;
    const el = new Audio();
    el.preload = 'auto';
    el.src = this.sourceUrl(mediaId);
    el.addEventListener('error', () => this.recover(mediaId, el));
    entry = { mediaId, el };
    this.audios.set(key, entry);
    return el;
  }

  // The browser cannot play this file: ask the server for a proxy once.
  async recover(mediaId, element) {
    const status = this.store.mediaStatus.get(mediaId);
    if (status === 'proxying' || status === 'broken') return;
    if (status === 'proxy') {
      // Another element already had the proxy built; this one just switches.
      if (element.src.includes('proxy=1')) this.store.setMediaStatus(mediaId, 'broken');
      else element.src = this.sourceUrl(mediaId);
      return;
    }
    this.store.setMediaStatus(mediaId, 'proxying');
    try {
      await api.buildProxy(mediaId);
      this.store.setMediaStatus(mediaId, 'proxy');
      element.src = this.sourceUrl(mediaId);
      element.load();
    } catch {
      this.store.setMediaStatus(mediaId, 'broken');
    }
    this.dirty = true;
  }

  prune() {
    const release = (element) => {
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
    for (const [mediaId, video] of this.videos) {
      if (this.store.project.media[mediaId]) continue;
      release(video);
      this.videos.delete(mediaId);
    }
    for (const [key, { mediaId, el }] of this.audios) {
      if (this.store.project.media[mediaId]) continue;
      release(el);
      this.audios.delete(key);
    }
  }

  // Audio-track clips under the playhead, with their elements and the source
  // time each should be at.
  audioAt(project, t) {
    return audioClipsAt(project, t)
      .filter(({ clip }) => this.usable(clip.mediaId))
      .map(({ track, clip }) => ({
        track,
        clip,
        el: this.audioFor(track.id, clip.mediaId),
        target: (clip.markIn + (t - clip.begin)) / TICKS,
      }));
  }

  // Start, stop and re-seek the audio elements so they match the playhead.
  syncAudio(project) {
    const { store } = this;
    const wanted = new Set();
    for (const { track, clip, el, target } of this.audioAt(project, store.time)) {
      wanted.add(el);
      el.muted = track.muted;
      el.volume = Math.min(1, clip.volume);
      if (!el.seeking && Math.abs(el.currentTime - target) > AUDIO_TOLERANCE) el.currentTime = target;
      if (store.playing) {
        if (el.paused && !el.ended) el.play().catch(() => {});
      } else if (!el.paused) {
        el.pause();
      }
    }
    for (const { el } of this.audios.values()) {
      if (!wanted.has(el) && !el.paused) el.pause();
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
      active.muted = track.muted || Boolean(clip.detached);
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
      // No picture: follow an audio clip that is playing in step, else the wall clock.
      const lead = this.audioAt(project, store.time).find(
        ({ el, target }) => !el.paused && !el.seeking && el.readyState >= 3 && Math.abs(el.currentTime - target) <= AUDIO_TOLERANCE,
      );
      this.advanceTo(lead ? lead.clip.begin + (lead.el.currentTime * TICKS - lead.clip.markIn) : store.time + elapsed * TICKS);
    }
    this.syncAudio(project);

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
