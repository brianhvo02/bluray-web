import type { RemoteDiscSpec } from '../../engine/disc/disc-spec';
import type { DiscManifest } from '../../engine/disc/nas-api';
import { serveFetch } from '../../engine/disc/port-fetch';

/** A NAS disc for the engine, and what to call once it is closed. */
export interface NasDiscOpen {
  readonly spec: RemoteDiscSpec;
  readonly release: () => void;
}

/**
 * The engine's spec for a NAS disc at `base`. Over HTTPS the engine fetches the disc itself. Over WebRTC (`rtc://`)
 * the connection lives on this thread, so the spec carries a fetch port whose requests `discFetch` answers here
 * (`NasClient.discFetch`, which follows the NAS's current connection); `release` stops answering them.
 */
export function nasDiscSpec(base: string, token: string, manifest: DiscManifest, discFetch: typeof fetch): NasDiscOpen {
  if (!base.startsWith('rtc://')) return { spec: { kind: 'remote', base, token, manifest }, release: () => undefined };
  const { port1, port2 } = new MessageChannel();
  const stop = serveFetch(port1, discFetch);
  return {
    spec: { kind: 'remote', base, token, manifest, fetchPort: port2 },
    release: () => {
      stop();
      port1.close();
    },
  };
}
