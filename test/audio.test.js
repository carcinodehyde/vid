import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExport } from '../server/exporter.js';
import {
  addClip,
  addMedia,
  audioClipsAt,
  canDetachAudio,
  clipAt,
  createProject,
  deleteClips,
  detachAudio,
  findClip,
  getTrack,
  moveClip,
  projectDuration,
  splitClip,
  updateClips,
  upgradeProject,
  validate,
} from '../shared/model.js';
import { flatten } from '../shared/segments.js';
import { TICKS } from '../shared/time.js';

const S = TICKS;

function mixedProject() {
  const project = createProject();
  addMedia(project, { id: 'v', kind: 'video', name: 'v.mp4', duration: 4 * S, width: 1280, height: 720, hasAudio: true });
  addMedia(project, { id: 'a', kind: 'audio', name: 'a.mp3', duration: 10 * S, width: 0, height: 0, hasAudio: true });
  return project;
}

test('a new project has two video and two audio tracks', () => {
  assert.deepEqual(
    createProject().tracks.map((track) => `${track.id}:${track.kind}`),
    ['V2:video', 'V1:video', 'A1:audio', 'A2:audio'],
  );
});

test('clips land on a track of their own kind wherever they are aimed', () => {
  const project = mixedProject();
  const audio = addClip(project, { mediaId: 'a', trackId: 'V1' });
  const video = addClip(project, { mediaId: 'v', trackId: 'A2' });
  const second = addClip(project, { mediaId: 'a', trackId: 'A2' });
  assert.equal(findClip(project, audio).track.id, 'A1');
  assert.equal(findClip(project, video).track.id, 'V1');
  assert.equal(findClip(project, second).track.id, 'A2');
  assert.deepEqual(validate(project), []);

  // Dragging onto the other kind of track moves in time but not across.
  moveClip(project, audio, 'V2', 2 * S);
  assert.equal(findClip(project, audio).track.id, 'A1');
  assert.equal(findClip(project, audio).clip.begin, 2 * S);
  moveClip(project, audio, 'A2', 20 * S);
  assert.equal(findClip(project, audio).track.id, 'A2');
});

test('audio never becomes the picture, but it does extend the timeline', () => {
  const project = mixedProject();
  addClip(project, { mediaId: 'v' });
  addClip(project, { mediaId: 'a' });
  assert.equal(projectDuration(project), 10 * S);
  assert.equal(clipAt(project, 6 * S), null);
  assert.equal(audioClipsAt(project, 6 * S).length, 1);
  assert.equal(audioClipsAt(project, 11 * S).length, 0);

  const spans = flatten(project);
  assert.deepEqual(
    spans.map((span) => [span.start / S, span.end / S, span.clip?.mediaId ?? null]),
    [
      [0, 4, 'v'],
      [4, 10, null],
    ],
  );
});

test('export mixes audio-track clips over the picture sound at their position', () => {
  const project = mixedProject();
  addClip(project, { mediaId: 'v' });
  const audio = addClip(project, { mediaId: 'a', at: 1.5 * S });
  updateClips(project, [audio], { volume: 0.5 });
  const plan = buildExport(project, (id) => `${id}.src`, 'out.mp4');
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];

  assert.equal(plan.args.filter((arg) => arg === '-i').length, 2);
  assert.match(graph, /\[1:a\][^;]*volume=0\.500[^;]*adelay=72000S:all=1\[m0\]/);
  assert.match(graph, /\[base\]\[m0\]amix=inputs=2:normalize=0:duration=first/);
  assert.equal(plan.duration, 11.5 * S);

  getTrack(project, 'A1').muted = true;
  const muted = buildExport(project, (id) => `${id}.src`, 'out.mp4');
  assert.doesNotMatch(muted.args[muted.args.indexOf('-filter_complex') + 1], /amix/);
});

test('a timeline with only audio exports over black', () => {
  const project = mixedProject();
  addClip(project, { mediaId: 'a' });
  const plan = buildExport(project, () => 'a.mp3', 'out.mp4');
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
  assert.match(graph, /color=c=black/);
  assert.match(graph, /amix=inputs=2/);
});

test('projects saved before audio tracks existed are upgraded', () => {
  const old = createProject();
  old.version = 1;
  old.tracks = old.tracks.slice(0, 2).map(({ kind, ...track }) => track);
  old.media.m = { id: 'm', name: 'm.mp4', duration: S, width: 640, height: 360 };
  upgradeProject(old);
  assert.deepEqual(old.tracks.map((track) => track.kind), ['video', 'video', 'audio', 'audio']);
  assert.equal(old.media.m.kind, 'video');
});

test('detaching audio puts the sound of a video clip on an audio track', () => {
  const project = mixedProject();
  const video = addClip(project, { mediaId: 'v', at: 2 * S });
  splitClip(project, video, 3 * S);
  updateClips(project, [video], { volume: 0.5 });
  assert.equal(canDetachAudio(project, video), true);

  const [sound] = detachAudio(project, [video]);
  const twin = findClip(project, sound);
  assert.equal(twin.track.id, 'A1');
  assert.deepEqual(
    [twin.clip.mediaId, twin.clip.begin, twin.clip.end, twin.clip.markIn, twin.clip.volume],
    ['v', 2 * S, 3 * S, 0, 0.5],
  );
  assert.equal(findClip(project, video).clip.detached, true);
  assert.deepEqual(validate(project), []);

  // Once is enough, and the picture is still the picture.
  assert.equal(canDetachAudio(project, video), false);
  assert.deepEqual(detachAudio(project, [video, sound]), []);
  assert.equal(clipAt(project, 2.5 * S).clip.id, video);

  // The two halves are independent from here on.
  moveClip(project, sound, 'A2', 6 * S);
  assert.equal(findClip(project, sound).clip.begin, 6 * S);
  assert.equal(findClip(project, video).clip.begin, 2 * S);
});

test('detached audio needs a free, unlocked audio track under the clip', () => {
  const project = mixedProject();
  const video = addClip(project, { mediaId: 'v' });
  addClip(project, { mediaId: 'a', trackId: 'A1' });
  const [sound] = detachAudio(project, [video]);
  assert.equal(findClip(project, sound).track.id, 'A2');

  const blocked = mixedProject();
  const other = addClip(blocked, { mediaId: 'v' });
  addClip(blocked, { mediaId: 'a', trackId: 'A1' });
  getTrack(blocked, 'A2').locked = true;
  assert.deepEqual(detachAudio(blocked, [other]), []);
  assert.equal(findClip(blocked, other).clip.detached, undefined);

  const silent = createProject();
  addMedia(silent, { id: 'n', kind: 'video', name: 'n.mp4', duration: S, width: 640, height: 360, hasAudio: false });
  assert.equal(canDetachAudio(silent, addClip(silent, { mediaId: 'n' })), false);
});

test('export takes detached sound from the audio track, not from the picture', () => {
  const project = mixedProject();
  const video = addClip(project, { mediaId: 'v' });
  const [sound] = detachAudio(project, [video]);
  moveClip(project, sound, 'A1', 1 * S);
  const graphOf = () => {
    const plan = buildExport(project, (id) => `${id}.src`, 'out.mp4');
    return plan.args[plan.args.indexOf('-filter_complex') + 1];
  };

  let graph = graphOf();
  assert.doesNotMatch(graph, /\[0:a\]/);
  assert.match(graph, /\[1:a\][^;]*adelay=48000S:all=1\[m0\]/);

  // Deleting the audio clip leaves a silent picture.
  deleteClips(project, [sound]);
  graph = graphOf();
  assert.doesNotMatch(graph, /\[\d:a\]/);
  assert.doesNotMatch(graph, /amix/);
});
