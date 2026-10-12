import type { StnTable, StreamEntry } from '../bdmv/mpls-parser';
import { CodingType } from '../bdmv/stream-types';

/** Audio coding types this build can decode. M2 adds AC-3 (and the TrueHD AC-3 core). */
export const PLAYABLE_AUDIO: ReadonlySet<number> = new Set([CodingType.LPCM]);

export interface StreamChoice {
  readonly video: StreamEntry | null;
  readonly audio: StreamEntry | null;
  /** Main-path audio streams present but not decodable (empty when `audio` is set). */
  readonly unsupportedAudio: readonly StreamEntry[];
}

export function chooseStreams(stn: StnTable, playableAudio: ReadonlySet<number> = PLAYABLE_AUDIO): StreamChoice {
  const video = stn.video.find((s) => !s.subPath) ?? null;
  const mainAudio = stn.audio.filter((s) => !s.subPath);
  const audio = mainAudio.find((s) => playableAudio.has(s.codingType)) ?? null;
  return { video, audio, unsupportedAudio: audio ? [] : mainAudio };
}
