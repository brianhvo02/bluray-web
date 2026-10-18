import type { TitleSummary } from '../../engine/disc/nas-api';
import { displayName } from './title-model';
import { NasHttpError, type NasClient, type NasDevice, type NasTitleStatus } from './nas-client';

export const ADMIN_MESSAGES = {
  lastOwner: "You can't remove the last owner.",
} as const;

/** The admin calls the NAS settings screen makes. */
export type AdminApi = Pick<NasClient['admin'], 'devices' | 'createCode' | 'revokeDevice' | 'rescan'>;

export interface DeviceRow {
  readonly id: string;
  /** `name · paired <date> · last seen <relative>`, the name followed by `(this device)` on this device's row. */
  readonly text: string;
  /** This device's own row: revoking it asks for confirmation first. */
  readonly thisDevice: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const count = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/** How long ago `at` was: `just now`, `N minutes ago`, `N hours ago` or `N days ago`. */
export function lastSeen(at: number, now: number): string {
  const ago = now - at;
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) return count(Math.floor(ago / MINUTE), 'minute');
  if (ago < DAY) return count(Math.floor(ago / HOUR), 'hour');
  return count(Math.floor(ago / DAY), 'day');
}

/** A device's row; `dates` sets the locale and time zone of the pairing date (the browser's by default). */
export function deviceRow(device: NasDevice, now: number, thisDeviceId: string | null, dates: { locale?: string; timeZone?: string } = {}): DeviceRow {
  const paired = new Intl.DateTimeFormat(dates.locale, { dateStyle: 'medium', timeZone: dates.timeZone }).format(device.pairedAt);
  const thisDevice = device.id === thisDeviceId;
  const name = thisDevice ? `${device.name} (this device)` : device.name;
  return { id: device.id, text: `${name} · paired ${paired} · last seen ${lastSeen(device.lastSeen, now)}`, thisDevice };
}

/** Time left on a pairing code, `Expires in m:ss` (seconds rounded up), or `Expired`. */
export function countdown(expiresAt: number, now: number): string {
  const seconds = Math.ceil((expiresAt - now) / 1000);
  if (seconds <= 0) return 'Expired';
  return `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "New pairing code": a guest code, or an owner code when the Owner box is ticked. */
export function newCode(api: AdminApi, owner: boolean): ReturnType<AdminApi['createCode']> {
  return api.createCode(owner);
}

/** Revokes a device; resolves to null, or to the message to show when the NAS refused. */
export async function revoke(api: AdminApi, id: string): Promise<string | null> {
  try {
    await api.revokeDevice(id);
    return null;
  } catch (err) {
    if (err instanceof NasHttpError && err.status === 409 && err.code === 'last-owner') return ADMIN_MESSAGES.lastOwner;
    return err instanceof Error ? err.message : String(err);
  }
}

/** Whether the gate switch shows on: the NAS's gate is `everyone`, or turning it on is waiting for confirmation. */
export function gateSwitchOn(status: NasTitleStatus | null, confirming: boolean): boolean {
  return confirming || status?.gate === 'everyone';
}

/** The status after the owner's PUT of the gate succeeded, so the switch shows what the NAS now has. */
export function withGate(status: NasTitleStatus | null, gate: NasTitleStatus['gate']): NasTitleStatus | null {
  return status === null ? null : { ...status, gate };
}

/** TMDB's required notice (global constraints), shown with its logo in NAS settings. */
export const TMDB_ATTRIBUTION = 'This product uses the TMDB API but is not endorsed or certified by TMDB';

const discs = (n: number): string => `${n} ${n === 1 ? 'disc' : 'discs'}`;

/** The title library's matching status in NAS settings: the run's progress, the counts, and a note without TMDB. */
export function matchingStatus(s: NasTitleStatus, now: number): { progress: string; counts: string; tmdb: string | null } {
  const progress = s.running
    ? `Matching… ${s.groupsDone} of ${s.groupsTotal} folders`
    : s.lastRunAt === null
      ? 'Not matched yet'
      : `Last matched ${lastSeen(s.lastRunAt, now)}`;
  return {
    progress,
    counts: `${discs(s.filed)} filed · ${s.unsorted} unsorted · ${s.music} music`,
    tmdb: s.tmdb ? null : 'No TMDB key: discs that aren’t anime go to Unsorted.',
  };
}

/** The owner's own titles (spec §9), A–Z, for NAS settings' "Own titles" list. */
export function ownTitles(titles: readonly TitleSummary[]): TitleSummary[] {
  return titles.filter((t) => t.own).sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true, sensitivity: 'base' }));
}

/** An own title's kind: `Series · N seasons`, `Movie` or `Music`. */
export function ownTitleKind(t: TitleSummary): string {
  if (t.kind === 'movie') return 'Movie';
  if (t.kind === 'music') return 'Music';
  return `Series · ${t.seasons} ${t.seasons === 1 ? 'season' : 'seasons'}`;
}

/** The confirm step before deleting an own title. */
export function deleteTitleQuestion(name: string): string {
  return `Delete ${name}? Its discs go back to Unsorted.`;
}
