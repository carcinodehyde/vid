// The project document and every edit that can be made to it. Edits are plain
// functions that mutate a project in place; History (history.js) takes care of
// snapshots, so nothing here knows about undo.
//
//   project { width, height, aspect, fps, rippleMode, media{}, tracks[] }
//   media   { id, kind: 'video' | 'audio', duration, width, height, ... }
//   track   { id, name, kind, muted, hidden, locked, clips[] }  tracks[0] is on top
//   clip    { id, mediaId, begin, end, markIn, fit, scale, posX, posY, volume, color, detached? }
//
// begin/end are timeline positions and markIn is the offset into the source,
// all in ticks (time.js). A clip plays source [markIn, markIn + end - begin).
//
// Video tracks hold video files and decide the picture (and its sound); audio
// tracks hold audio files and are mixed on top. A file from the bin only ever
// lands on a track of its own kind. The one exception is detachAudio(): it
// puts the sound of a video clip on an audio track as a clip of its own (same
// mediaId) and marks the video clip `detached`, which makes it silent.

import { DEFAULT_COLOR } from './color.js';
import { ASPECTS } from './geometry.js';
import { floorToFrame, frameTicks, snapToFrame } from './time.js';

const makeTrack = (id, kind) => ({ id, name: id, kind, muted: false, hidden: false, locked: false, clips: [] });

export const trackKind = (track) => track.kind ?? 'video';
export const mediaKind = (media) => media?.kind ?? 'video';

export function createProject() {
  return {
    version: 2,
    name: 'Untitled',
    aspect: '16:9',
    width: ASPECTS['16:9'][0],
    height: ASPECTS['16:9'][1],
    fps: { num: 30, den: 1 },
    rippleMode: false,
    media: {},
    tracks: [makeTrack('V2', 'video'), makeTrack('V1', 'video'), makeTrack('A1', 'audio'), makeTrack('A2', 'audio')],
    nextId: 1,
  };
}

// Bring a project saved by an older version up to date (in place).
export function upgradeProject(project) {
  for (const track of project.tracks) track.kind = trackKind(track);
  for (const media of Object.values(project.media)) media.kind = mediaKind(media);
  if (!project.tracks.some((track) => track.kind === 'audio')) {
    project.tracks.push(makeTrack('A1', 'audio'), makeTrack('A2', 'audio'));
  }
  project.version = 2;
  return project;
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

// Where a source goes when no suitable track was named: the lowest video
// track for video, the first audio track for audio, skipping locked ones.
export function defaultTrackFor(project, mediaId) {
  const kind = mediaKind(project.media[mediaId]);
  const open = project.tracks.filter((track) => trackKind(track) === kind && !track.locked);
  return (kind === 'video' ? open.at(-1) : open[0]) ?? null;
}

// Every audio-track clip sounding at time t.
export function audioClipsAt(project, t) {
  const hits = [];
  for (const track of project.tracks) {
    if (trackKind(track) !== 'audio') continue;
    const clip = track.clips.find((c) => c.begin <= t && t < c.end);
    if (clip) hits.push({ track, clip });
  }
  return hits;
}

// The clip the viewer sees at time t: first hit scanning tracks from the top.
export function clipAt(project, t) {
  for (const track of project.tracks) {
    if (track.hidden || trackKind(track) !== 'video') continue;
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

// Put a source on a track. `at` defaults to the end of the track. A source
// aimed at a track of the wrong kind (or at none) goes to its default track.
export function addClip(project, { mediaId, trackId = null, at = null }) {
  const media = project.media[mediaId];
  let track = trackId === null ? null : getTrack(project, trackId);
  if (!media || (trackId !== null && !track)) throw new Error('Unknown media or track');
  if (!track || trackKind(track) !== mediaKind(media)) track = defaultTrackFor(project, mediaId);
  if (!track || track.locked) return null;
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
  const named = getTrack(project, trackId);
  if (!found || !named) return false;
  const { track, clip } = found;
  // Dragged over a track of the other kind: it stays on its own track.
  const target = trackKind(named) === trackKind(track) ? named : track;
  if (track.locked || target.locked) return false;
  const duration = clip.end - clip.begin;
  track.clips.splice(track.clips.indexOf(clip), 1);
  const begin = findFreeBegin(target, Math.max(0, snapToFrame(desiredBegin, project.fps)), duration);
  clip.begin = begin;
  clip.end = begin + duration;
  target.clips.push(clip);
  sortTrack(target);
  return true;
}

// A video clip whose sound is still attached and can be split off.
export function canDetachAudio(project, clipId) {
  const found = findClip(project, clipId);
  if (!found || found.track.locked || trackKind(found.track) !== 'video') return false;
  return Boolean(project.media[found.clip.mediaId]?.hasAudio) && !found.clip.detached;
}

// Split the sound off video clips: each gets a twin on an audio track at the
// same position, trim and volume, and goes silent itself. From then on the two
// are independent clips. The twin must sit exactly under its picture, so it
// goes to the first unlocked audio track that is free there; a clip with no
// such track is left alone. Returns the ids of the new audio clips.
export function detachAudio(project, clipIds) {
  const made = [];
  for (const id of clipIds) {
    if (!canDetachAudio(project, id)) continue;
    const { clip } = findClip(project, id);
    const target = project.tracks.find(
      (track) =>
        trackKind(track) === 'audio' && !track.locked && !track.clips.some((c) => clip.begin < c.end && clip.end > c.begin),
    );
    if (!target) continue;
    const sound = structuredClone(clip);
    sound.id = newId(project);
    target.clips.push(sound);
    sortTrack(target);
    clip.detached = true;
    made.push(sound.id);
  }
  return made;
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
      const media = project.media[clip.mediaId];
      if (!media) problems.push(`${clip.id}: missing media`);
      else if (trackKind(track) === 'audio' ? mediaKind(media) !== 'audio' && !media.hasAudio : mediaKind(media) !== 'video') {
        // An audio track also takes the detached sound of a video file.
        problems.push(`${clip.id}: ${mediaKind(media)} clip on a ${trackKind(track)} track`);
      }
      if (clip.begin < 0) problems.push(`${clip.id}: starts before zero`);
      if (clip.end <= clip.begin) problems.push(`${clip.id}: empty or reversed`);
      if (clip.markIn < 0) problems.push(`${clip.id}: negative source offset`);
      if (i > 0 && clip.begin < clips[i - 1].end) problems.push(`${clip.id}: overlaps ${clips[i - 1].id}`);
    });
  }
  return problems;
}
