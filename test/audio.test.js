import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExport } from '../server/exporter.js';
import {
  addClip,
  addMedia,
  audioClipsAt,
  clipAt,
  createProject,
  findClip,
  getTrack,
  moveClip,
  projectDuration,
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
