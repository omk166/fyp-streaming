import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechBuffer } from '../public/speech-buffer.js';

test('continuous speech is cut into 4 s windows that overlap by 1 s, without missing samples', () => {
  const messages = [], buffer = new SpeechBuffer(message => messages.push(message));
  // 22 s of speech, each sample numbered so the windows' contents can be checked.
  for (let i = 0; i < 1100; i++) buffer.push(Float32Array.from({ length: 320 }, (_, j) => 0.02 + (i * 320 + j) * 1e-7));
  buffer.flush();
  assert.deepEqual(messages.map(m => m.startSample), [0, 48000, 96000, 144000, 192000, 240000, 288000, 336000]);
  assert.deepEqual(messages.map(m => m.samples.length), [64000, 64000, 64000, 64000, 64000, 64000, 64000, 16000]);
  assert.deepEqual(messages.map(m => m.overlapSamples), [0, 16000, 16000, 16000, 16000, 16000, 16000, 16000]);
  assert.deepEqual(messages.map(m => m.continues), [true, true, true, true, true, true, true, false]);
  for (const m of messages) assert.ok(Math.abs(m.samples[0] - (0.02 + m.startSample * 1e-7)) < 1e-6, 'each window starts where it says');
  const covered = new Set(messages.flatMap(m => [...m.samples.keys()].map(k => m.startSample + k)));
  assert.equal(covered.size, 352000, 'every sample is in a window');
});

test('a window closed by a pause does not overlap the next one', () => {
  const messages = [], buffer = new SpeechBuffer(message => messages.push(message));
  for (let i = 0; i < 100; i++) buffer.push(new Float32Array(320).fill(0.02));
  for (let i = 0; i < 40; i++) buffer.push(new Float32Array(320));
  for (let i = 0; i < 100; i++) buffer.push(new Float32Array(320).fill(0.02));
  buffer.flush();
  assert.deepEqual(messages.map(m => [m.overlapSamples, m.continues]), [[0, false], [0, false]]);
});

test('quiet speech is kept, silence does not trigger recognition, final short words flush', () => {
  const messages = [], buffer = new SpeechBuffer(message => messages.push(message));
  for (let i = 0; i < 100; i++) buffer.push(new Float32Array(320));
  assert.equal(messages.length, 0);
  for (let i = 0; i < 15; i++) buffer.push(new Float32Array(320).fill(0.0015));
  buffer.flush();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].samples.filter(x => x > 0).length, 4800);
});

test('pauses close sentences and mute reset discards buffered speech', () => {
  const messages = [], buffer = new SpeechBuffer(message => messages.push(message));
  for (let i = 0; i < 80; i++) buffer.push(new Float32Array(320).fill(0.02));
  for (let i = 0; i < 40; i++) buffer.push(new Float32Array(320));
  assert.equal(messages.length, 1);
  for (let i = 0; i < 20; i++) buffer.push(new Float32Array(320).fill(0.02));
  buffer.reset(); buffer.flush(); assert.equal(messages.length, 1);
});

test('worklet closes final sentence when capture omits channels during silence', async () => {
  let Worklet;
  const emitted = [];
  globalThis.sampleRate = 16000;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: message => emitted.push(message) }; } };
  globalThis.registerProcessor = (_name, Class) => { Worklet = Class; };
  try {
    await import('../public/transcription-worklet.js');
    const processor = new Worklet();
    for (let i = 0; i < 250; i++) processor.process([[new Float32Array(128).fill(0.02)]]);
    assert.equal(emitted.length, 0);
    for (let i = 0; i < 100; i++) processor.process([[]]);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].samples.filter(x => x > 0).length, 32000);
  } finally {
    delete globalThis.sampleRate; delete globalThis.AudioWorkletProcessor; delete globalThis.registerProcessor;
  }
});
