import type { LevelId, LevelInfo, LevelReason } from '../../engine/disc/nas-api';
import { RATE_MARGIN, bufferPlan } from './buffer-model';

export const BUSY_COPY = 'The NAS is busy re-encoding for others. This will play at original quality.';
export const BUSY_TRY_LATER_COPY = 'The NAS is busy. Try again in a few minutes.';

/** What a NAS without levels means. */
export const ORIGINAL_ONLY: readonly LevelInfo[] = [{ level: 'original', label: 'Original', budgetMbps: 0, available: true }];

export function levelRateMbps(l: LevelInfo, originalMbps: number): number {
  return l.level === 'original' ? originalMbps : l.budgetMbps;
}

/** The level to open at: a phone takes Phone; a computer the first that fits; else the lowest rate. */
export function autoLevel(levels: readonly LevelInfo[], o: { connectionMbps: number; phone: boolean; originalMbps: number }): LevelId {
  const available = levels.filter((l) => l.available);
  const lowest = (): LevelId => {
    let best: LevelInfo | undefined;
    for (const l of available) if (!best || levelRateMbps(l, o.originalMbps) < levelRateMbps(best, o.originalMbps)) best = l;
    return best?.level ?? 'original';
  };
  if (o.phone) return available.find((l) => l.level === 'phone-720')?.level ?? lowest();
  const fits = available.find((l) => levelRateMbps(l, o.originalMbps) * RATE_MARGIN <= o.connectionMbps);
  return fits?.level ?? lowest();
}

export interface LevelRow {
  level: LevelId;
  label: string;
  available: boolean;
  note: string;
}

const REASON_COPY: Record<LevelReason, string> = {
  unplayable: "can't play in this browser",
  'no-encoder': 'not on this NAS',
  'no-hevc': "this device can't decode it",
  'no-hevc10': "this device can't decode it",
  'no-hdr-display': 'needs an HDR screen',
  busy: 'the NAS is busy',
};

export function levelRows(
  levels: readonly LevelInfo[],
  o: { durationS: number; originalBytes: number; connectionMbps: number; quotaBytes: number },
): LevelRow[] {
  return levels.map((l) => {
    const base = { level: l.level, label: l.label, available: l.available };
    if (!l.available) return { ...base, note: l.reason ? REASON_COPY[l.reason] : 'not available' };
    const playlistBytes = l.level === 'original' ? o.originalBytes : ((l.budgetMbps * 1e6) / 8) * o.durationS;
    const plan = bufferPlan({ durationS: o.durationS, playlistBytes, connectionMbps: o.connectionMbps, quotaBytes: o.quotaBytes });
    switch (plan.kind) {
      case 'play':
        return { ...base, note: 'plays now' };
      case 'silent':
      case 'ask':
        return { ...base, note: `about ${Math.ceil(plan.waitS / 60)} minutes` };
      case 'too-big':
        return { ...base, note: 'plays with pauses' };
    }
  });
}

export function busyMessage(levels: readonly LevelInfo[]): string | null {
  const reencoded = levels.filter((l) => l.level !== 'original');
  const original = levels.find((l) => l.level === 'original');
  const originalPlays = original ? original.available : true;
  const busy = reencoded.filter((l) => l.reason === 'busy');
  if (busy.length === 0) return null;
  if (!originalPlays && original?.reason === 'unplayable' && busy.length === reencoded.length) return BUSY_TRY_LATER_COPY;
  return originalPlays ? BUSY_COPY : null;
}

// Disc languages are ISO 639-2; a browser's are ISO 639-1 (private table, the repo has no helper).
const ISO_639_2: Record<string, readonly string[]> = {
  en: ['eng'],
  ja: ['jpn'],
  fr: ['fra', 'fre'],
  de: ['deu', 'ger'],
  es: ['spa'],
  it: ['ita'],
  zh: ['zho', 'chi'],
  ko: ['kor'],
};

/** The 1-based audio stream a level request asks for. */
export function levelAudio(audio: readonly { language: string }[], o: { psr1?: number; language: string }): number {
  if (o.psr1 !== undefined && Number.isInteger(o.psr1) && o.psr1 >= 1 && o.psr1 <= audio.length) return o.psr1;
  const codes = ISO_639_2[o.language.slice(0, 2).toLowerCase()];
  if (codes) {
    const i = audio.findIndex((a) => codes.includes(a.language.toLowerCase()));
    if (i >= 0) return i + 1;
  }
  return 1;
}

export function badgeText(l: LevelInfo): string | null {
  return l.level === 'original' ? null : `${l.label} · re-encoded on the NAS`;
}
