import {serial as test} from 'ava';
import {isHardwareEncoderAvailable} from '../main/utils/hardware-encoding';

test('treats a probe failure as "unavailable", not a crash', async t => {
  // `ffmpeg -encoders` can list an encoder that then fails the moment it's
  // actually used (see the hevc_videotoolbox note in newkap#2), so the probe
  // has to run a real encode rather than trust the encoder list. A bogus
  // encoder name exercises that same failure path portably, without
  // depending on VideoToolbox being present on the machine running this test.
  // @ts-expect-error - deliberately not a real encoder, to hit the failure path
  const result = await isHardwareEncoderAvailable('not_a_real_encoder');

  t.is(result, false);
});

test('caches the probe result for the process', async t => {
  const first = await isHardwareEncoderAvailable('h264_videotoolbox');

  const startedAt = Date.now();
  const second = await isHardwareEncoderAvailable('h264_videotoolbox');
  const elapsedMs = Date.now() - startedAt;

  t.is(second, first);
  // A real probe spawns ffmpeg to encode a frame, which takes well over
  // 100ms; a cached lookup resolves near-instantly.
  t.true(elapsedMs < 100, `expected a cached lookup to be fast, took ${elapsedMs}ms`);
});
