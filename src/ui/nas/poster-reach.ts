import type { NasRoute } from './nas-client';

/** What Chrome's Network Information API reports; Safari and Firefox report nothing. */
export interface ConnectionInfo {
  readonly saveData?: boolean;
  readonly type?: string;
  readonly effectiveType?: string;
}

/**
 * Whether every poster loads, those out of scroll range included, or only those on screen and within scroll range.
 * Every poster loads over HTTPS (at home or on the tailnet) unless the browser says the connection is metered or slow:
 * Data Saver, a cellular connection, or 3G and below. Over WebRTC or the relay (a friend away from home, often on
 * mobile data) posters load as they come within scroll range. Original code.
 */
export function loadsEveryPoster(route: NasRoute | null, connection: ConnectionInfo | undefined): boolean {
  if (route !== 'https') return false;
  if (connection?.saveData) return false;
  if (connection?.type === 'cellular') return false;
  return !['slow-2g', '2g', '3g'].includes(connection?.effectiveType ?? '');
}
