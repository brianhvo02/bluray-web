import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHandlers } from './app';
import { Auth } from './auth';
import { BdjStore } from './bdj-store';
import { ownerCode, printNasId } from './cli';
import { loadConfig } from './config';
import type { Config } from './config';
import { createServer } from './http';
import type { Handler } from './http';
import { levelsBackend } from './levels/backend-check';
import { Capacity, GPU_BUDGETS } from './levels/capacity';
import { probeScan } from './levels/encoder';
import { LevelService, libraryDiscSources } from './levels/level-service';
import { SegmentCache } from './levels/segment-cache';
import { Library, nextNightly } from './library';
import { RendezvousClient } from './rendezvous-client';
import { RtcPeers } from './rtc/peer';
import { RelayState, turnResponder } from './rtc/relay';
import { AddressAdvertiser } from './rtc/public-address';
import { SignallingClient } from './rtc/signalling-client';
import { trustedProxy } from './routes/pair';
import { Store } from './store';
import { createAniList } from './titles/anilist';
import { ArtCache } from './titles/art';
import { OwnerStore } from './titles/owner-store';
import { Pacer } from './titles/pacer';
import { downloadRootNames, fixtureSources, loadDiscDbOrNone, TitleService } from './titles/service';
import type { Entry, MetadataSource } from './titles/sources';
import { createTmdb } from './titles/tmdb';

const SHUTDOWN_GRACE_MS = 3_000;
const STUN_URL = 'stun:stun.cloudflare.com:3478';
const DEFAULT_DISCDB_INDEX = '/app/data/discdb-index.json';

/** AniList and TMDB, or the recorded entries of `METADATA_FIXTURE` in E2E tests (ruling R3). */
function metadataSources(config: Config): { anilist: MetadataSource; tmdb: MetadataSource | null } {
  const fixture = process.env.METADATA_FIXTURE;
  if (fixture) return fixtureSources(JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, Entry[]>);
  const anilist = createAniList(fetch, new Pacer(30, 60_000));
  if (config.tmdbApiKey === null) {
    console.log('TMDB key not set: non-anime discs go to Unsorted');
    return { anilist, tmdb: null };
  }
  return { anilist, tmdb: createTmdb(fetch, new Pacer(20, 1_000), config.tmdbApiKey) };
}

/** The rendezvous client when `RENDEZVOUS_URL` is set; its key lives next to the auth data. */
function rendezvousRegistrar(config: Config): RendezvousClient | undefined {
  if (config.rendezvousUrl === undefined) return undefined;
  return new RendezvousClient(config.rendezvousUrl, rendezvousKeyFile(config));
}

/** The NAS's rendezvous key, next to the auth data. */
function rendezvousKeyFile(config: Config): string {
  return join(config.dataDir, 'rendezvous-key.json');
}

/**
 * The WebRTC route: peers on UDP `RTC_PORT` advertising the public IPv4 (STUN at start, then hourly) and
 * `RTC_LAN_ADDRESS`, and the signalling socket to the rendezvous Worker. Gives the function that stops it all.
 */
function startRtc(config: Config, rendezvousUrl: string, rendezvous: RendezvousClient, handlers: readonly Handler[], auth: Auth, relay: RelayState): () => Promise<void> {
  // A changed public address likely means the signalling socket's path died with the old one.
  const advertiser = new AddressAdvertiser({ stun: STUN_URL, lan: config.rtc.lanAddress, fixed: config.rtc.advertise, onChange: () => signalling.reconnect() });
  // STUN only: the NAS's own peer never uses the relay (see `stunOnly`); devices get TURN through `turn-request`.
  const peers = new RtcPeers({
    handlers, auth, port: config.rtc.port, advertise: () => advertiser.advertise(), iceServers: async () => [{ urls: STUN_URL }], now: Date.now,
    onRelayedBytes: (bytes) => relay.addBytes(bytes),
  });
  peers.listen().then(
    () => console.log(`WebRTC on UDP ${config.rtc.port}`),
    (err: unknown) => console.error(`WebRTC: UDP ${config.rtc.port} could not be bound`, err),
  );
  const onTurnRequest = turnResponder({
    relay, auth, credentials: () => rendezvous.turnServers(), now: Date.now,
    onServers: (sid, ips) => peers.noteTurnServers(sid, ips),
  });
  const signalling = new SignallingClient({ url: rendezvousUrl, signer: rendezvous, peers, onTurnRequest });
  signalling.start();
  void advertiser.start();
  return async () => {
    signalling.stop();
    advertiser.stop();
    await peers.closeAll();
  };
}

/**
 * The quality levels (spec §5–§6): after the encoder's self-test at start, or none (Original only) when
 * `LEVELS_BACKEND=off`, there is no GPU for `qsv`, or the self-test fails. Segments are cached under `/data/transcode`.
 */
async function levelService(config: Config, library: Library): Promise<LevelService | undefined> {
  const encoder = await levelsBackend(config.levels);
  if (!encoder) return undefined;
  const { ffprobePath } = config.levels;
  return new LevelService({
    discs: libraryDiscSources(library),
    cache: new SegmentCache(join(config.dataDir, 'transcode'), config.levels.cacheBytes),
    capacity: new Capacity(GPU_BUDGETS),
    backend: encoder.backend,
    codecs: encoder.codecs,
    probe: (input, options) => probeScan(input, { ...options, binary: ffprobePath }),
    log: console.log,
  });
}

async function serve(config: Config): Promise<void> {
  const trustProxy = await trustedProxy(config.trustedProxy);
  const library = new Library(config.roots, join(config.dataDir, 'library.json'), { scanPauseMs: config.scanPauseMs });
  const auth = new Auth(new Store(config.dataDir), Date.now);
  const owner = new OwnerStore(config.dataDir);
  const titles = new TitleService({
    library,
    owner,
    dataDir: config.dataDir,
    ...metadataSources(config),
    discdb: loadDiscDbOrNone(process.env.DISCDB_INDEX || DEFAULT_DISCDB_INDEX),
    art: new ArtCache(join(config.dataDir, 'art'), fetch),
    downloadRoots: downloadRootNames(config.roots),
    titleLibrary: config.titleLibrary,
  });
  library.onScanned(() => void titles.runNow());
  const rendezvous = rendezvousRegistrar(config);
  const relay = new RelayState(config.dataDir, Date.now);
  // the key's thumbprint, read (or made) locally: `me` gives it to pairings made before the WebRTC route
  const nasId = rendezvous ? await rendezvous.localNasId() : null;
  const levels = await levelService(config, library);
  const handlers = appHandlers({ auth, library, bdjStore: new BdjStore(config.dataDir), publicBase: config.publicBase, registrar: rendezvous, trustProxy, titles: { service: titles, owner }, relay, nasId, ...(levels ? { levels } : {}) });
  const server = createServer(handlers);
  const stopRtc = rendezvous && config.rendezvousUrl !== undefined ? startRtc(config, config.rendezvousUrl, rendezvous, handlers, auth, relay) : async () => {};

  const scheduleScans = (): void => {
    const run = (): void => {
      library.scan().catch((err: unknown) => console.error('library scan failed', err));
    };
    run();
    const arm = (): void => {
      setTimeout(() => {
        run();
        arm();
      }, nextNightly(new Date(), config.nightlyScanAt).getTime() - Date.now()).unref();
    };
    arm();
  };

  server.listen(config.port, () => {
    console.log(`bluray-server listening on ${config.port}; roots: ${config.roots.map((r) => `${r.name}=${r.dir}`).join(', ')}`);
    scheduleScans();
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      titles.close();
      levels?.close();
      void stopRtc();
      server.close(() => process.exit(0));
      // Long disc streams would otherwise hold shutdown until Docker's SIGKILL.
      setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
    });
  }
}

/** `owner-code`'s arguments: nothing, or `--person <name>`; null for anything else. */
function ownerCodeArgs(args: readonly string[]): { person?: string } | null {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--person' && args[1]!.trim() !== '') return { person: args[1]! };
  return null;
}

const config = loadConfig(process.env);
const command = process.argv[2];
const ownerArgs = command === 'owner-code' ? ownerCodeArgs(process.argv.slice(3)) : null;
if (command === undefined) {
  await serve(config);
} else if (ownerArgs !== null) {
  const registrar = rendezvousRegistrar(config);
  await ownerCode(config.dataDir, Date.now, console.log, registrar && { registrar, publicBase: config.publicBase }, ownerArgs.person);
} else if (command === 'nas-id' && process.argv.length === 3) {
  await printNasId(rendezvousKeyFile(config));
} else {
  console.error(`unknown command "${process.argv.slice(2).join(' ')}"; usage: node server.mjs [owner-code [--person <name>] | nas-id]`);
  process.exit(2);
}
