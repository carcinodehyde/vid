// The project document and every edit that can be made to it. Edits are plain
// functions that mutate a project in place; History (history.js) takes care of
// snapshots, so nothing here knows about undo.
//
//   project { width, height, aspect, fps, rippleMode, media{}, tracks[] }
//   track   { id, name, muted, hidden, locked, clips[] }      tracks[0] is on top
//   clip    { id, mediaId, begin, end, markIn, fit, scale, posX, posY, volume, color }
//
// begin/end are timeline positions and markIn is the offset into the source,
// all in ticks (time.js). A clip plays source [markIn, markIn + end - begin).

import { DEFAULT_COLOR } from './color.js';
import { ASPECTS } from './geometry.js';
import { floorToFrame, frameTicks, snapToFrame } from './time.js';

export function createProject() {
  return {
    version: 1,
    name: 'Untitled',
    aspect: '16:9',
    width: ASPECTS['16:9'][0],
    height: ASPECTS['16:9'][1],
    fps: { num: 30, den: 1 },
    rippleMode: false,
    media: {},
    tracks: [
      { id: 'V2', name: 'V2', muted: false, hidden: false, locked: false, clips: [] },
      { id: 'V1', name: 'V1', muted: false, hidden: false, locked: false, clips: [] },
    ],
    nextId: 1,
  };
}

const newId = (project) => `c${project.nextId++}`;
const sortTrack = (track) => track.clips.sort((a, b) => a.begin - b.begin);
const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);

export function getTrack(project, trackId) {
  return project.tracks.find((track) => track.id === trackId) ?? null;
}

export function findClip(project, clipId) {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export function allClips(project) {
  return project.tracks.flatMap((track) => track.clips);
}

export function projectDuration(project) {
  let end = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) end = Math.max(end, clip.end);
  }
  return end;
}

export function trackEnd(track) {
  return track.clips.reduce((end, clip) => Math.max(end, clip.end), 0);
}

// The clip the viewer sees at time t: first hit scanning tracks from the top.
export function clipAt(project, t) {
  for (const track of project.tracks) {
    if (track.hidden) continue;
    const clip = track.clips.find((c) => c.begin <= t && t < c.end);
    if (clip) return { track, clip };
  }
  return null;
}

// Usable length of a source on the current frame grid (at least one frame).
export function sourceDuration(project, mediaId) {
  const frame = frameTicks(project.fps);
  return Math.max(frame, floorToFrame(project.media[mediaId].duration, project.fps));
}

// Nearest position to `desired` where a clip of `duration` fits without
// overlapping anything on the track.
export function findFreeBegin(track, desired, duration) {
  const overlaps = (begin) => track.clips.some((c) => begin < c.end && begin + duration > c.begin);
  if (!overlaps(desired)) return desired;
  let best = null;
  for (const c of track.clips) {
    for (const candidate of [c.end, c.begin - duration]) {
      if (candidate < 0 || overlaps(candidate)) continue;
      if (best === null || Math.abs(candidate - desired) < Math.abs(best - desired)) best = candidate;
    }
  }
  return best ?? trackEnd(track);
}

function shiftFrom(track, from, delta, exceptId = null) {
  for (const c of track.clips) {
    if (c.id !== exceptId && c.begin >= from) {
      c.begin += delta;
      c.end += delta;
    }
  }
}

function splitInternal(project, track, clip, t) {
  const right = structuredClone(clip);
  right.id = newId(project);
  right.begin = t;
  right.markIn = clip.markIn + (t - clip.begin);
  clip.end = t;
  track.clips.push(right);
  return right;
}

// How an edit treats the rest of the track. "free" leaves other clips alone and
// refuses overlaps; "ripple" keeps the track packed by sliding later clips.
const POLICIES = {
  free: {
    insert(project, track, clip) {
      clip.begin = findFreeBegin(track, clip.begin, clip.end - clip.begin);
      track.clips.push(clip);
    },
    remove(track, removed) {
      void track;
      void removed;
    },
    trimStart(project, track, clip, t, frame) {
      const previousEnd = track.clips.reduce(
        (end, c) => (c !== clip && c.end <= clip.begin ? Math.max(end, c.end) : end),
        0,
      );
      const lower = Math.max(0, clip.begin - clip.markIn, previousEnd);
      const begin = clamp(t, lower, clip.end - frame);
      clip.markIn += begin - clip.begin;
      clip.begin = begin;
    },
    trimEnd(project, track, clip, t, frame, maxEnd) {
      const nextBegin = track.clips.reduce(
        (begin, c) => (c !== clip && c.begin >= clip.end ? Math.min(begin, c.begin) : begin),
        Infinity,
      );
      clip.end = clamp(t, clip.begin + frame, Math.min(maxEnd, nextBegin));
    },
  },
  ripple: {
    insert(project, track, clip) {
      const at = clip.begin;
      const duration = clip.end - clip.begin;
      const under = track.clips.find((c) => c.begin < at && at < c.end);
      if (under) splitInternal(project, track, under, at);
      shiftFrom(track, at, duration);
      track.clips.push(clip);
    },
    remove(track, removed) {
      // Right to left, so closing one gap never moves a gap still to be closed.
      for (const gone of [...removed].sort((a, b) => b.begin - a.begin)) {
        shiftFrom(track, gone.end, gone.begin - gone.end);
      }
    },
    trimStart(project, track, clip, t, frame) {
      // The clip keeps its position; the cut moves through the source instead.
      const duration = clip.end - clip.begin;
      const delta = clamp(t - clip.begin, -clip.markIn, duration - frame);
      const oldEnd = clip.end;
      clip.markIn += delta;
      clip.end -= delta;
      shiftFrom(track, oldEnd, -delta, clip.id);
    },
    trimEnd(project, track, clip, t, frame, maxEnd) {
      const oldEnd = clip.end;
      clip.end = clamp(t, clip.begin + frame, maxEnd);
      shiftFrom(track, oldEnd, clip.end - oldEnd, clip.id);
    },
  },
};

const policyOf = (project) => (project.rippleMode ? POLICIES.ripple : POLICIES.free);

export function addMedia(project, info) {
  project.media[info.id] = info;
  return info.id;
}

// Put a source on a track. `at` defaults to the end of the track.
export function addClip(project, { mediaId, trackId, at = null }) {
  const media = project.media[mediaId];
  const track = getTrack(project, trackId);
  if (!media || !track) throw new Error('Unknown media or track');
  if (track.locked) return null;
  const duration = sourceDuration(project, mediaId);
  const begin = at === null ? trackEnd(track) : Math.max(0, snapToFrame(at, project.fps));
  const clip = {
    id: newId(project),
    mediaId,
    begin,
    end: begin + duration,
    markIn: 0,
    fit: 'fit',
    scale: 1,
    posX: 0,
    posY: 0,
    volume: 1,
    color: { ...DEFAULT_COLOR },
  };
  const length = clip.end - clip.begin;
  policyOf(project).insert(project, track, clip);
  clip.end = clip.begin + length;
  sortTrack(track);
  return clip.id;
}

// Cut one clip in two at timeline time t. Returns the new right-hand clip id.
export function splitClip(project, clipId, t) {
  const found = findClip(project, clipId);
  if (!found || found.track.locked) return null;
  const at = snapToFrame(t, project.fps);
  if (!(found.clip.begin < at && at < found.clip.end)) return null;
  const right = splitInternal(project, found.track, found.clip, at);
  sortTrack(found.track);
  return right.id;
}

// Cut the given clips at t, or every clip under t when none are given.
export function splitAt(project, t, clipIds = []) {
  const at = snapToFrame(t, project.fps);
  const targets = clipIds.length
    ? clipIds
    : allClips(project)
        .filter((c) => c.begin < at && at < c.end)
        .map((c) => c.id);
  return targets.map((id) => splitClip(project, id, at)).filter(Boolean);
}

// Drag one edge of a clip to timeline time t.
export function trimClip(project, clipId, edge, t) {
  const found = findClip(project, clipId);
  if (!found || found.track.locked) return false;
  const { track, clip } = found;
  const frame = frameTicks(project.fps);
  const at = snapToFrame(t, project.fps);
  const policy = policyOf(project);
  if (edge === 'start') {
    policy.trimStart(project, track, clip, at, frame);
  } else {
    const maxEnd = clip.begin + Math.max(frame, sourceDuration(project, clip.mediaId) - clip.markIn);
    policy.trimEnd(project, track, clip, at, frame, maxEnd);
  }
  sortTrack(track);
  return true;
}

// Move a clip to another position and/or track; it lands in the nearest gap.
export function moveClip(project, clipId, trackId, desiredBegin) {
  const found = findClip(project, clipId);
  const target = getTrack(project, trackId);
  if (!found || !target || found.track.locked || target.locked) return false;
  const { track, clip } = found;
  const duration = clip.end - clip.begin;
  track.clips.splice(track.clips.indexOf(clip), 1);
  const begin = findFreeBegin(target, Math.max(0, snapToFrame(desiredBegin, project.fps)), duration);
  clip.begin = begin;
  clip.end = begin + duration;
  target.clips.push(clip);
  sortTrack(target);
  return true;
}

export function deleteClips(project, clipIds) {
  const ids = new Set(clipIds);
  let count = 0;
  for (const track of project.tracks) {
    if (track.locked) continue;
    const removed = track.clips.filter((c) => ids.has(c.id));
    if (!removed.length) continue;
    track.clips = track.clips.filter((c) => !ids.has(c.id));
    policyOf(project).remove(track, removed);
    sortTrack(track);
    count += removed.length;
  }
  return count;
}

const CLIP_LIMITS = {
  scale: [0.1, 4],
  posX: [-1, 1],
  posY: [-1, 1],
  volume: [0, 2],
};

// Change properties on clips. `patch.color` is merged key by key.
export function updateClips(project, clipIds, patch) {
  for (const id of clipIds) {
    const found = findClip(project, id);
    if (!found) continue;
    const { clip } = found;
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'color') {
        for (const [name, amount] of Object.entries(value)) {
          clip.color[name] = clamp(Number(amount) || 0, -100, 100);
        }
      } else if (key in CLIP_LIMITS) {
        clip[key] = clamp(Number(value), ...CLIP_LIMITS[key]);
      } else if (key === 'fit') {
        clip.fit = value;
      }
    }
  }
}

// Change the canvas shape and/or frame rate. Clips are untouched: their
// placement is normalized, so they re-fit the new canvas when drawn.
export function setFormat(project, { aspect, fps } = {}) {
  if (aspect && ASPECTS[aspect]) {
    project.aspect = aspect;
    [project.width, project.height] = ASPECTS[aspect];
  }
  if (fps) project.fps = { num: fps.num, den: fps.den };
}

export function setTrackFlag(project, trackId, flag, value) {
  const track = getTrack(project, trackId);
  if (track && ['muted', 'hidden', 'locked'].includes(flag)) track[flag] = Boolean(value);
}

// Structural checks; returns a list of problems (empty when the project is sound).
export function validate(project) {
  const problems = [];
  for (const track of project.tracks) {
    const clips = [...track.clips].sort((a, b) => a.begin - b.begin);
    clips.forEach((clip, i) => {
      if (!project.media[clip.mediaId]) problems.push(`${clip.id}: missing media`);
      if (clip.begin < 0) problems.push(`${clip.id}: starts before zero`);
      if (clip.end <= clip.begin) problems.push(`${clip.id}: empty or reversed`);
      if (clip.markIn < 0) problems.push(`${clip.id}: negative source offset`);
      if (i > 0 && clip.begin < clips[i - 1].end) problems.push(`${clip.id}: overlaps ${clips[i - 1].id}`);
    });
  }
  return problems;
}
