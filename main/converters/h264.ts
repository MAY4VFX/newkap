import PCancelable from 'p-cancelable';
import tempy from 'tempy';
import {convert, gifski} from './process';
import {areDimensionsEven, buildAtempoFilter, conditionalArgs, ConvertOptions, GIF_MAX_FPS, makeEven} from './utils';
import {settings} from '../common/settings';
import os from 'os';
import {Encoding, Format} from '../common/types';
import fs from 'fs';
import {isHardwareEncoderAvailable} from '../utils/hardware-encoding';

// VideoToolbox's `-q:v` is a 1-100 quality target (higher = bigger/better),
// unrelated to libx264/libx265's CRF scale. Measured against this project's
// software output on real screen recordings: VideoToolbox needs noticeably
// more bits than libx264/libx265 for the same SSIM on this kind of flat,
// low-motion UI content (hardware encoders are tuned for camera video, not
// screen captures), so matching software file size 1:1 costs visible quality.
// 50 lands on a middle ground verified by measurement — SSIM ~0.98 against
// the source (software preset lands ~0.996-0.999) at roughly 2.5-4x the
// software file size, instead of the 5-7x blowup a naive CBR/default bitrate
// produces. See newkap#2 for the numbers.
const HARDWARE_QUALITY = '50';

// GIF export: trim the clip with ffmpeg if a range is selected, then encode it
// with gifski. gifski reads video directly (its bundled binary statically links
// FFmpeg) and handles fps resampling and scaling itself, so no intermediate image
// frames are needed. It is multithreaded and higher quality than ffmpeg's
// palettegen/paletteuse pipeline, and its binary is universal (x86_64 + arm64) —
// so this also drops the x86_64-only gifsicle dependency that triggered the macOS
// Intel/Rosetta deprecation warning on Apple Silicon.
const convertToGif = PCancelable.fn(async (options: ConvertOptions, onCancel: PCancelable.OnCancelFunction) => {
  const shouldLoop = settings.get('loopExports');
  const useLossy = settings.get('lossyCompression', false);
  // GIF fps is capped (see GIF_MAX_FPS) because frame delays are stored in
  // 1/100s units; higher rates get mangled into slow motion.
  const fps = Math.min(options.fps, GIF_MAX_FPS);

  // Because gifski can't trim or change speed, use ffmpeg to cut the
  // selected range and/or apply the speed filter into a temporary clip when
  // needed; otherwise hand the input straight to gifski.
  const hasSpeed = options.speed !== 1;

  let gifskiInput = options.inputPath;
  let trimmedPath: string | undefined;

  try {
    if (options.shouldCrop || hasSpeed) {
      trimmedPath = tempy.file({extension: 'mp4'});

      const trimProcess = convert(trimmedPath, {
        onProgress: (progress, estimate) => {
          options.onProgress('Converting', progress, estimate);
        },
        startTime: options.startTime,
        endTime: options.endTime,
        speed: options.speed
      }, conditionalArgs(
        // setpts rescales the timeline, so once it's in the graph ffmpeg's
        // auto-inserted trim for an output-side -ss/-to lands *after* it —
        // trimming the sped-up timeline instead of the original one. Doing
        // the trim as an input option (before -i) keeps it on the original
        // timeline regardless of what's in -filter:v.
        {args: ['-ss', options.startTime.toString(), '-to', options.endTime.toString()], if: hasSpeed},
        '-i', options.inputPath,
        {args: ['-ss', options.startTime.toString(), '-to', options.endTime.toString()], if: !hasSpeed && options.shouldCrop},
        '-an', // GIFs have no audio track
        {args: ['-filter:v', `setpts=PTS/${options.speed}`], if: hasSpeed},
        // gifski re-quantizes to a 256-colour GIF, so the intermediate quality
        // barely matters — use the fastest x264 preset to keep the trim cheap.
        '-preset', 'ultrafast',
        '-crf', '18',
        trimmedPath
      ));

      onCancel(() => {
        trimProcess.cancel();
      });

      await trimProcess;
      gifskiInput = trimmedPath;
    }

    // By default gifski downscales output to ~800x600 unless the target size is
    // set explicitly, so always pass the export dimensions through.
    const gifProcess = gifski(options.outputPath, {
      onProgress: (progress, estimate) => {
        // Distinct label from the ffmpeg trim ('Converting') above, matching the
        // old pipeline's 'Compressing' phase, so the bar doesn't reset under one
        // label.
        options.onProgress('Compressing', progress, estimate);
      }
    }, conditionalArgs(
      '--fps', fps.toString(),
      '--quality', useLossy ? '70' : '90',
      '--width', options.width.toString(),
      '--height', options.height.toString(),
      {args: ['--repeat', '-1'], if: !shouldLoop}, // -1 == no loop; gifski's default 0 == loop forever
      '-o', options.outputPath,
      gifskiInput
    ));

    onCancel(() => {
      gifProcess.cancel();
    });

    await gifProcess;

    return options.outputPath;
  } finally {
    // Remove the temporary trimmed clip (if any), whether the export succeeded,
    // failed, or was cancelled.
    if (trimmedPath) {
      fs.rmSync(trimmedPath, {force: true});
    }
  }
});

// Nothing is changing between input and output — same codec, same fps, no
// crop/trim/mute/speed/edit-plugin pass — so just repackage the stream instead
// of decoding and re-encoding it. This is the biggest win available: ~1000x
// faster than any encode, hardware or software.
const canRemux = (options: ConvertOptions) =>
  !options.editService &&
  !options.shouldMute &&
  !options.shouldCrop &&
  options.speed === 1 &&
  areDimensionsEven(options) &&
  options.sourceEncoding === Encoding.h264 &&
  options.sourceFps === options.fps;

const convertToMp4 = PCancelable.fn(async (options: ConvertOptions, onCancel: PCancelable.OnCancelFunction) => {
  const hasSpeed = options.speed !== 1;
  const shouldTrim = options.shouldCrop || !areDimensionsEven(options);

  const processOptions = {
    onProgress: (progress: number, estimate?: string) => {
      options.onProgress('Converting', progress, estimate);
    },
    startTime: options.startTime,
    endTime: options.endTime,
    speed: options.speed
  };

  if (canRemux(options)) {
    const remuxProcess = convert(options.outputPath, processOptions, conditionalArgs(
      '-i', options.inputPath,
      '-c', 'copy',
      options.outputPath
    ));

    onCancel(() => {
      remuxProcess.cancel();
    });

    return remuxProcess;
  }

  const canUseHardware = await isHardwareEncoderAvailable('h264_videotoolbox');

  const conversionProcess = convert(options.outputPath, processOptions, conditionalArgs(
    // See the comment in convertToGif: an output-side -ss/-to would trim
    // *after* -filter:v once that's present, so it has to move before -i.
    {args: ['-ss', options.startTime.toString(), '-to', options.endTime.toString()], if: hasSpeed && shouldTrim},
    '-i', options.inputPath,
    '-r', options.fps.toString(),
    {
      args: ['-c:v', 'h264_videotoolbox', '-q:v', HARDWARE_QUALITY],
      if: canUseHardware
    },
    {args: ['-filter:v', `setpts=PTS/${options.speed}`], if: hasSpeed},
    {args: ['-filter:a', buildAtempoFilter(options.speed)], if: hasSpeed && !options.shouldMute},
    {
      args: ['-an'],
      if: options.shouldMute
    },
    {
      args: [
        '-s',
        `${makeEven(options.width)}x${makeEven(options.height)}`,
        ...(hasSpeed ? [] : ['-ss', options.startTime.toString(), '-to', options.endTime.toString()])
      ],
      if: shouldTrim
    },
    options.outputPath
  ));

  onCancel(() => {
    conversionProcess.cancel();
  });

  return conversionProcess;
});

// eslint-disable-next-line @typescript-eslint/promise-function-async
const convertToWebm = (options: ConvertOptions) => {
  const hasSpeed = options.speed !== 1;
  const shouldTrim = options.shouldCrop || !areDimensionsEven(options);

  return convert(options.outputPath, {
    onProgress: (progress, estimate) => {
      options.onProgress('Converting', progress, estimate);
    },
    startTime: options.startTime,
    endTime: options.endTime,
    speed: options.speed
  }, conditionalArgs(
    {args: ['-ss', options.startTime.toString(), '-to', options.endTime.toString()], if: hasSpeed && shouldTrim},
    '-i', options.inputPath,
    // http://wiki.webmproject.org/ffmpeg
    // https://trac.ffmpeg.org/wiki/Encode/VP9
    '-threads', Math.max(os.cpus().length - 1, 1).toString(),
    '-deadline', 'good', // `best` is twice as slow and only slighty better
    '-b:v', '1M', // Bitrate (same as the MP4)
    '-codec:v', 'vp9',
    '-codec:a', 'vorbis',
    '-ac', '2', // https://stackoverflow.com/questions/19004762/ffmpeg-covert-from-mp4-to-webm-only-working-on-some-files
    '-strict', '-2', // Needed because `vorbis` is experimental
    '-r', options.fps.toString(),
    {args: ['-filter:v', `setpts=PTS/${options.speed}`], if: hasSpeed},
    {args: ['-filter:a', buildAtempoFilter(options.speed)], if: hasSpeed && !options.shouldMute},
    {
      args: ['-an'],
      if: options.shouldMute
    },
    {
      args: [
        '-s',
        `${makeEven(options.width)}x${makeEven(options.height)}`,
        ...(hasSpeed ? [] : ['-ss', options.startTime.toString(), '-to', options.endTime.toString()])
      ],
      if: shouldTrim
    },
    options.outputPath
  ));
};

// eslint-disable-next-line @typescript-eslint/promise-function-async
const convertToAv1 = (options: ConvertOptions) => {
  const hasSpeed = options.speed !== 1;
  const shouldTrim = options.shouldCrop || !areDimensionsEven(options);

  return convert(options.outputPath, {
    onProgress: (progress, estimate) => {
      options.onProgress('Converting', progress, estimate);
    },
    startTime: options.startTime,
    endTime: options.endTime,
    speed: options.speed
  }, conditionalArgs(
    {args: ['-ss', options.startTime.toString(), '-to', options.endTime.toString()], if: hasSpeed && shouldTrim},
    '-i', options.inputPath,
    '-r', options.fps.toString(),
    '-c:v', 'libaom-av1',
    '-c:a', 'libopus',
    '-crf', '34',
    '-b:v', '0',
    '-strict', 'experimental',
    // Enables row-based multi-threading which maximizes CPU usage
    // https://trac.ffmpeg.org/wiki/Encode/AV1
    '-cpu-used', '4',
    '-row-mt', '1',
    '-tiles', '2x2',
    {args: ['-filter:v', `setpts=PTS/${options.speed}`], if: hasSpeed},
    {args: ['-filter:a', buildAtempoFilter(options.speed)], if: hasSpeed && !options.shouldMute},
    {
      args: ['-an'],
      if: options.shouldMute
    },
    {
      args: [
        '-s',
        `${makeEven(options.width)}x${makeEven(options.height)}`,
        ...(hasSpeed ? [] : ['-ss', options.startTime.toString(), '-to', options.endTime.toString()])
      ],
      if: shouldTrim
    },
    options.outputPath
  ));
};

const convertToHevc = PCancelable.fn(async (options: ConvertOptions, onCancel: PCancelable.OnCancelFunction) => {
  const hasSpeed = options.speed !== 1;
  const shouldTrim = options.shouldCrop || !areDimensionsEven(options);
  const canUseHardware = await isHardwareEncoderAvailable('hevc_videotoolbox');

  const conversionProcess = convert(options.outputPath, {
    onProgress: (progress, estimate) => {
      options.onProgress('Converting', progress, estimate);
    },
    startTime: options.startTime,
    endTime: options.endTime,
    speed: options.speed
  }, conditionalArgs(
    {args: ['-ss', options.startTime.toString(), '-to', options.endTime.toString()], if: hasSpeed && shouldTrim},
    '-i', options.inputPath,
    '-r', options.fps.toString(),
    {
      args: ['-c:v', 'hevc_videotoolbox', '-q:v', HARDWARE_QUALITY],
      if: canUseHardware
    },
    {
      args: ['-c:v', 'libx265', '-preset', 'medium'],
      if: !canUseHardware
    },
    '-c:a', 'libopus',
    '-tag:v', 'hvc1', // Metadata for macOS
    {args: ['-filter:v', `setpts=PTS/${options.speed}`], if: hasSpeed},
    {args: ['-filter:a', buildAtempoFilter(options.speed)], if: hasSpeed && !options.shouldMute},
    {
      args: ['-an'],
      if: options.shouldMute
    },
    {
      args: [
        '-s',
        `${makeEven(options.width)}x${makeEven(options.height)}`,
        ...(hasSpeed ? [] : ['-ss', options.startTime.toString(), '-to', options.endTime.toString()])
      ],
      if: shouldTrim
    },
    options.outputPath
  ));

  onCancel(() => {
    conversionProcess.cancel();
  });

  return conversionProcess;
});

// eslint-disable-next-line @typescript-eslint/promise-function-async
const convertToApng = (options: ConvertOptions) => {
  const hasSpeed = options.speed !== 1;
  // setpts has to come first in the chain so fps resamples the already
  // sped-up timeline, not the original one.
  const videoFilter = `${hasSpeed ? `setpts=PTS/${options.speed},` : ''}fps=${options.fps}${options.shouldCrop ? `,scale=${options.width}:${options.height}:flags=lanczos` : ''}`;

  return convert(options.outputPath, {
    onProgress: (progress, estimate) => {
      options.onProgress('Converting', progress, estimate);
    },
    startTime: options.startTime,
    endTime: options.endTime,
    speed: options.speed
  }, conditionalArgs(
    // See the comment in convertToGif: an output-side -ss/-to would trim
    // *after* -vf once it contains setpts, so it has to move before -i.
    {args: ['-ss', options.startTime.toString(), '-to', options.endTime.toString()], if: hasSpeed && options.shouldCrop},
    '-i', options.inputPath,
    '-vf', videoFilter,
    // Strange for APNG instead of -loop it uses -plays see: https://stackoverflow.com/questions/43795518/using-ffmpeg-to-create-looping-apng
    '-plays', settings.get('loopExports') ? '0' : '1', // 0 == forever; 1 == no loop
    {
      args: ['-an'],
      if: options.shouldMute
    },
    {
      args: [
        '-ss',
        options.startTime.toString(),
        '-to',
        options.endTime.toString()
      ],
      if: !hasSpeed && options.shouldCrop
    },
    options.outputPath
  ));
};

// eslint-disable-next-line @typescript-eslint/promise-function-async
export const crop = (options: ConvertOptions) => convert(options.outputPath, {
  onProgress: (progress, estimate) => {
    options.onProgress('Cropping', progress, estimate);
  },
  startTime: options.startTime,
  endTime: options.endTime
}, conditionalArgs(
  '-i', options.inputPath,
  '-s', `${makeEven(options.width)}x${makeEven(options.height)}`,
  '-ss', options.startTime.toString(),
  '-to', options.endTime.toString(),
  options.outputPath
));

export default new Map([
  [Format.gif, convertToGif],
  [Format.mp4, convertToMp4],
  [Format.hevc, convertToHevc],
  [Format.webm, convertToWebm],
  [Format.apng, convertToApng],
  [Format.av1, convertToAv1]
]);
