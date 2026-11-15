import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechBuffer } from '../public/speech-buffer.js';

test('continuous speech survives multiple segment boundaries without missing samples', () => {
  const messages = [], buffer = new SpeechBuffer(message => messages.push(message));
  for (let i = 0; i < 1100; i++) buffer.push(new Float32Array(320).fill(0.02));
  buffer.flush();
  assert.deepEqual(messages.map(m => m.samples.length), [128000, 128000, 96000]);
  assert.deepEqual(messages.map(m => m.startSample), [0, 128000, 256000]);
  assert.equal(messages.reduce((n, m) => n + m.samples.length, 0), 352000);
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
