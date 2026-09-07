import {serial as testAny, TestInterface} from 'ava';
import fs from 'fs';
import path from 'path';
import sinon from 'sinon';
import uniqueString from 'unique-string';

const test = testAny as TestInterface<{outputPath: string}>;

import {getVideoMetadata} from './helpers/video-utils';
import {almostEquals} from './helpers/assertions';
import {getFormatExtension} from '../main/common/constants';
import {Except, SetOptional} from 'type-fest';
import {mockImport} from './helpers/mocks';
import {Encoding, Format} from '../main/common/types';

const getRandomFileName = (ext: Format = Format.mp4) => `${uniqueString()}.${getFormatExtension(ext)}`;

const input = path.resolve(__dirname, 'fixtures', 'input.mp4');
const retinaInput = path.resolve(__dirname, 'fixtures', 'input@2x.mp4');

mockImport('../common/analytics', 'analytics');
mockImport('../plugins/service-context', 'service-context');
mockImport('../plugins', 'plugins');
const {settings} = mockImport('../common/settings', 'settings');

import {convertTo} from '../main/converters';
import {ConvertOptions} from '../main/converters/utils';

test.afterEach.always(t => {
  if (t.context.outputPath && fs.existsSync(t.context.outputPath)) {
    fs.unlinkSync(t.context.outputPath);
  }
});

const convert = async (format: Format, options: SetOptional<Except<ConvertOptions, 'outputPath'>, 'onCancel' | 'onProgress' | 'shouldMute'>) => {
  return convertTo(format, {
    defaultFileName: getRandomFileName(format),
    onProgress: sinon.fake(),
    onCancel: sinon.fake(),
    shouldMute: true,
    ...options
  });
};

// MP4

test('mp4: retina with sound', async t => {
  const onProgress = sinon.fake();

  t.context.outputPath = await convert(Format.mp4, {
    shouldMute: false,
    inputPath: retinaInput,
    fps: 39,
    width: 469,
    height: 839,
    startTime: 30,
    endTime: 43.5,
    shouldCrop: true,
    onProgress
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  // Makes dimensions even
  t.is(meta.size.width, 470);
  t.is(meta.size.height, 840);

  t.is(meta.fps, 39);
  t.true(almostEquals(meta.duration, 13.5));
  t.is(meta.encoding, 'h264');

  t.true(meta.hasAudio);

  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number));
  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number, sinon.match.string));
});

test('mp4: retina without sound', async t => {
  t.context.outputPath = await convert(Format.mp4, {
    shouldMute: true,
    inputPath: retinaInput,
    fps: 10,
    width: 46,
    height: 83,
    startTime: 0,
    endTime: 5,
    shouldCrop: true
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  t.false(meta.hasAudio);
});

test('mp4: non-retina', async t => {
  t.context.outputPath = await convert(Format.mp4, {
    shouldMute: false,
    inputPath: input,
    fps: 30,
    width: 255,
    height: 143,
    startTime: 11.5,
    endTime: 27,
    // Should resize even though this is false, because dimensions are odd
    shouldCrop: false
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  // Makes dimensions even
  t.is(meta.size.width, 256);
  t.is(meta.size.height, 144);

  t.is(meta.fps, 30);
  t.true(almostEquals(meta.duration, 15.5));
  t.is(meta.encoding, 'h264');

  t.false(meta.hasAudio);
});

// MP4 remux fast path — when nothing about the stream actually changes, the
// mp4 converter should repackage it with `-c copy` instead of re-encoding.

test('mp4: remuxes instead of re-encoding when nothing changed', async t => {
  const startedAt = Date.now();

  t.context.outputPath = await convert(Format.mp4, {
    shouldMute: false,
    inputPath: input,
    sourceEncoding: Encoding.h264,
    sourceFps: 60,
    fps: 60,
    width: 2560,
    height: 1440,
    startTime: 0,
    endTime: 106.78,
    shouldCrop: false
  });

  const elapsedMs = Date.now() - startedAt;

  const meta = await getVideoMetadata(t.context.outputPath);

  t.is(meta.size.width, 2560);
  t.is(meta.size.height, 1440);
  t.is(meta.encoding, 'h264');
  t.true(almostEquals(meta.duration, 106.78, 1));

  // Re-encoding this fixture (2560x1440) takes several seconds even on the
  // fast paths added in this change; a remux is a plain file copy and
  // finishes in well under a second. A generous bound keeps this from being
  // flaky while still proving the encode was skipped.
  t.true(elapsedMs < 5000, `expected a remux to finish quickly, took ${elapsedMs}ms`);

  // `-c copy` keeps the original bitstream, so only container/muxing
  // overhead can move the file size — a re-encode of this clip lands at a
  // very different size.
  const inputSize = fs.statSync(input).size;
  const outputSize = fs.statSync(t.context.outputPath).size;
  t.true(
    Math.abs(outputSize - inputSize) / inputSize < 0.1,
    `expected output size (${outputSize}) close to input size (${inputSize})`
  );
});

test('mp4: does not remux when the fps changes', async t => {
  t.context.outputPath = await convert(Format.mp4, {
    shouldMute: false,
    inputPath: input,
    sourceEncoding: Encoding.h264,
    sourceFps: 60,
    fps: 30,
    width: 2560,
    height: 1440,
    startTime: 0,
    endTime: 5,
    shouldCrop: false
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  // A remux keeps the source's native ~60fps; only an actual re-encode
  // resamples to the requested rate.
  t.is(meta.fps, 30);
});

test('mp4: does not remux when muted', async t => {
  t.context.outputPath = await convert(Format.mp4, {
    shouldMute: true,
    inputPath: retinaInput,
    sourceEncoding: Encoding.h264,
    sourceFps: 60,
    fps: 60,
    width: 3358,
    height: 1874,
    startTime: 0,
    endTime: 5,
    shouldCrop: false
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  // `-c copy` alone can't drop the audio track; if this were incorrectly
  // remuxed, the source's audio stream would still be there.
  t.false(meta.hasAudio);
});

test('mp4: does not remux when the source is not h264', async t => {
  // The fixture is actually h264, so this only differs from the remux test
  // above in the (claimed) source encoding — isolating that one gate. Output
  // codec can't tell remux and re-encode apart here (both land on h264), so
  // fall back to timing: a real encode of this clip takes several seconds,
  // a remux finishes in well under one.
  const startedAt = Date.now();

  t.context.outputPath = await convert(Format.mp4, {
    shouldMute: false,
    inputPath: input,
    sourceEncoding: Encoding.hevc,
    sourceFps: 60,
    fps: 60,
    width: 2560,
    height: 1440,
    startTime: 0,
    endTime: 106.78,
    shouldCrop: false
  });

  const elapsedMs = Date.now() - startedAt;

  t.true(elapsedMs > 1000, `expected a real encode to take a while, took ${elapsedMs}ms`);
});

// WEBM

test('webm: retina with sound', async t => {
  const onProgress = sinon.fake();

  t.context.outputPath = await convert(Format.webm, {
    shouldMute: false,
    inputPath: retinaInput,
    fps: 39,
    width: 469,
    height: 839,
    startTime: 30,
    endTime: 43.5,
    shouldCrop: true,
    onProgress
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  t.is(meta.size.width, 470);
  t.is(meta.size.height, 840);

  t.is(meta.fps, 39);
  t.true(almostEquals(meta.duration, 13.5));
  t.is(meta.encoding, 'vp9');

  t.true(meta.hasAudio);

  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number));
  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number, sinon.match.string));
});

test('webm: retina without sound', async t => {
  t.context.outputPath = await convert(Format.webm, {
    shouldMute: true,
    inputPath: retinaInput,
    fps: 10,
    width: 46,
    height: 83,
    startTime: 0,
    endTime: 5,
    shouldCrop: true
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  t.false(meta.hasAudio);
});

test('webm: non-retina', async t => {
  t.context.outputPath = await convert(Format.webm, {
    shouldMute: false,
    inputPath: input,
    fps: 30,
    width: 255,
    height: 143,
    startTime: 11.5,
    endTime: 27,
    shouldCrop: true
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  t.is(meta.size.width, 256);
  t.is(meta.size.height, 144);

  t.is(meta.fps, 30);
  t.true(almostEquals(meta.duration, 15.5));
  t.is(meta.encoding, 'vp9');

  t.false(meta.hasAudio);
});

// APNG

test('apng: retina', async t => {
  const onProgress = sinon.fake();

  t.context.outputPath = await convert(Format.apng, {
    shouldMute: false,
    inputPath: retinaInput,
    fps: 15,
    width: 469,
    height: 839,
    startTime: 30,
    endTime: 43.5,
    shouldCrop: true,
    onProgress
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  t.is(meta.size.width, 469);
  t.is(meta.size.height, 839);

  t.is(meta.fps, 15);
  t.is(meta.encoding, 'apng');

  t.false(meta.hasAudio);

  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number));
  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number, sinon.match.string));
});

test('apng: non-retina', async t => {
  t.context.outputPath = await convert(Format.apng, {
    shouldMute: false,
    inputPath: input,
    fps: 15,
    width: 255,
    height: 143,
    startTime: 11.5,
    endTime: 27,
    shouldCrop: true
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  t.is(meta.size.width, 255);
  t.is(meta.size.height, 143);

  t.is(meta.fps, 15);
  t.is(meta.encoding, 'apng');

  t.false(meta.hasAudio);
});

// GIF

test('gif: retina', async t => {
  const onProgress = sinon.fake();

  t.context.outputPath = await convert(Format.gif, {
    shouldMute: false,
    inputPath: retinaInput,
    fps: 10,
    width: 236,
    height: 420,
    startTime: 0,
    endTime: 8.5,
    shouldCrop: true,
    onProgress
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  t.is(meta.size.width, 236);
  t.is(meta.size.height, 420);

  // Duplicate frames are merged by gifski into longer delays, so the stored
  // frame rate can fall below the requested fps (a tight lower bound would be
  // content-dependent and flaky); the playback duration below is the real
  // timing guarantee.
  t.true(meta.fps > 0 && meta.fps <= 10);
  t.true(almostEquals(meta.duration, 8.5));
  t.is(meta.encoding, 'gif');

  t.false(meta.hasAudio);

  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number));
  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number, sinon.match.string));
});

test('gif: non-retina', async t => {
  t.context.outputPath = await convert(Format.gif, {
    shouldMute: false,
    inputPath: input,
    fps: 15,
    width: 255,
    height: 143,
    startTime: 11.5,
    endTime: 27,
    shouldCrop: true
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  t.is(meta.size.width, 255);
  t.is(meta.size.height, 143);

  // Duplicate frames are merged by gifski into longer delays, so the stored
  // frame rate can fall below the requested fps (a tight lower bound would be
  // content-dependent and flaky); the playback duration below is the real
  // timing guarantee.
  t.true(meta.fps > 0 && meta.fps <= 15);
  t.true(almostEquals(meta.duration, 15.5));
  t.is(meta.encoding, 'gif');

  t.false(meta.hasAudio);
});

test('gif: lossy', async t => {
  settings.setMock('lossyCompression', false);

  const regular = await convert(Format.gif, {
    inputPath: input,
    fps: 20,
    width: 510,
    height: 286,
    startTime: 1,
    endTime: 10,
    shouldCrop: true
  });

  settings.setMock('lossyCompression', true);

  const lossy = await convert(Format.gif, {
    inputPath: input,
    fps: 20,
    width: 510,
    height: 286,
    startTime: 1,
    endTime: 10,
    shouldCrop: true
  });

  t.true(
    fs.statSync(regular).size >=
    fs.statSync(lossy).size
  );
});

// AV1

test('av1: retina with sound', async t => {
  const onProgress = sinon.fake();

  t.context.outputPath = await convert(Format.av1, {
    shouldMute: false,
    inputPath: retinaInput,
    fps: 15,
    width: 235,
    height: 420,
    startTime: 30,
    endTime: 35.5,
    shouldCrop: true,
    onProgress
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  // Makes dimensions even
  t.is(meta.size.width, 236);
  t.is(meta.size.height, 420);

  t.is(meta.fps, 15);
  t.true(almostEquals(meta.duration, 5.5));
  t.is(meta.encoding, 'av1');

  t.true(meta.hasAudio);

  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number));
  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number, sinon.match.string));
});

test('av1: retina without sound', async t => {
  t.context.outputPath = await convert(Format.av1, {
    shouldMute: true,
    inputPath: retinaInput,
    fps: 10,
    width: 100,
    height: 200,
    startTime: 0,
    endTime: 4,
    shouldCrop: true
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  t.false(meta.hasAudio);
});

test('av1: non-retina', async t => {
  t.context.outputPath = await convert(Format.av1, {
    shouldMute: false,
    inputPath: input,
    fps: 10,
    width: 255,
    height: 143,
    startTime: 11.5,
    endTime: 16,
    shouldCrop: true
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  // Makes dimensions even
  t.is(meta.size.width, 256);
  t.is(meta.size.height, 144);

  t.is(meta.fps, 10);
  t.true(almostEquals(meta.duration, 4.5));
  t.is(meta.encoding, 'av1');

  t.false(meta.hasAudio);
});

// HEVC

test('HEVC: retina', async t => {
  const onProgress = sinon.fake();

  t.context.outputPath = await convert(Format.hevc, {
    shouldMute: true,
    inputPath: retinaInput,
    fps: 15,
    width: 469,
    height: 839,
    startTime: 30,
    endTime: 43.5,
    shouldCrop: true,
    onProgress
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  // Makes dimensions even
  t.is(meta.size.width, 470);
  t.is(meta.size.height, 840);

  t.is(meta.fps, 15);
  t.is(meta.encoding, 'hevc');

  t.false(meta.hasAudio);

  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number));
  t.true(onProgress.calledWithMatch(sinon.match.string, sinon.match.number, sinon.match.string));
});

test('HEVC: non-retina', async t => {
  t.context.outputPath = await convert(Format.hevc, {
    shouldMute: true,
    inputPath: input,
    fps: 15,
    width: 255,
    height: 143,
    startTime: 11.5,
    endTime: 27,
    shouldCrop: true
  });

  const meta = await getVideoMetadata(t.context.outputPath);

  // Makes dimensions even
  t.is(meta.size.width, 256);
  t.is(meta.size.height, 144);

  t.is(meta.fps, 15);
  t.is(meta.encoding, 'hevc');

  t.false(meta.hasAudio);
});
