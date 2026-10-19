import { relayLimitMessage } from './rtc/rtc-connection';
import type { NasRelayUsage, NasRoute } from './nas-client';

const GB = 1e9;

/** "Relay this month: 412 of 1,000 GB free": whole GB (rounded down), with a thousands separator. */
export function usageLine(usage: Pick<NasRelayUsage, 'usedBytes' | 'freeBytes'>): string {
  const gb = (bytes: number): string => Math.floor(Math.max(bytes, 0) / GB).toLocaleString('en-US');
  return `Relay this month: ${gb(usage.usedBytes)} of ${gb(usage.freeBytes)} GB free`;
}

/** "The relay's free allowance for this month is used up. It resets on {date}." */
export const limitMessage: (resetsOn: string, locale?: string) => string = relayLimitMessage;

/** The badge shown while a NAS disc plays over a relayed connection. */
export const RELAYED_BADGE = 'Relayed';

/** The admin screen's Relay section: its labels, and the terms they rest on (checked 2026-10-19). */
export const relaySettingsCopy = {
  heading: 'Relay',
  enable: 'Use the Cloudflare relay when a direct connection fails',
  allowPaid: 'Allow paid use beyond the free allowance',
  terms:
    "Cloudflare's relay (TURN) gives 1,000 GB free each month; its terms were checked on 2026-10-19. The usage shown is the NAS's own estimate. It is off until you turn it on, and stops at the free allowance unless you allow paid use.",
  paidWarning: 'Beyond the free allowance, Cloudflare bills the relay to your account.',
} as const;

/** How a device last reached the NAS, on the admin screen. */
export function routeLabel(route: NasRoute | undefined): string | null {
  switch (route) {
    case 'https':
      return 'Home or Tailscale';
    case 'webrtc':
      return 'WebRTC';
    case 'relay':
      return 'WebRTC (relayed)';
    default:
      return null;
  }
}
