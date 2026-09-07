import execa from 'execa';
import ffmpegPath from './ffmpeg-path';

export type HardwareEncoder = 'h264_videotoolbox' | 'hevc_videotoolbox';

// `ffmpeg -encoders` lists the VideoToolbox encoders even when macOS refuses to
// hand out a hardware compression session for them — on the ffmpeg 4.4.1 binary
// this project used to bundle, `hevc_videotoolbox` is listed but fails with
// "cannot create compression session: -12908" the moment it's used. So the only
// reliable check is to actually encode a throwaway frame and see if it works.
// The result only depends on the ffmpeg binary and the OS/hardware, neither of
// which change while the app is running, so it's cached for the process lifetime.
const availability = new Map<HardwareEncoder, Promise<boolean>>();

const probe = async (encoder: HardwareEncoder): Promise<boolean> => {
  try {
    await execa(ffmpegPath, [
      '-f', 'lavfi',
      '-i', 'nullsrc=s=64x64',
      '-frames:v', '1',
      '-c:v', encoder,
      '-f', 'null',
      '-'
    ]);

    return true;
  } catch {
    return false;
  }
};

export const isHardwareEncoderAvailable = async (encoder: HardwareEncoder): Promise<boolean> => {
  if (!availability.has(encoder)) {
    availability.set(encoder, probe(encoder));
  }

  return availability.get(encoder)!;
};
