/**
 * Runs the fansub search for a title: per season, SeaDex's ranked releases looked up on Anime Tosho, the tracks of each
 * episode's chosen file fetched, lined up with the owner's disc and attached in the subtitle store. One title runs at a
 * time, from the owner's button or the nightly pass. Original code.
 */
import { readFileSync } from 'node:fs';
import type {
  FansubAlignment, FansubEpisodeMark, FansubSeasonLine, FansubSource, FansubTitleState, StoredSubtitle, SubtitleAttachment,
} from '../../../src/engine/disc/nas-api';
import type { DiscActivity } from '../disc-activity';
import type { LevelDiscSource } from '../levels/level-discs';
import type { SubtitleStore } from '../subtitle-store';
import { TooLargeError } from '../subtitle-store';
import type { Catalogue } from '../titles/catalogue';
import { RateLimited } from '../titles/pacer';
import { SourceUnavailable } from '../titles/sources';
import { align } from './align';
import { fontsIn7z, TooLargeArchive, unxz } from './archive';
import { choosePerEpisode, normalizeLanguage, rankReleases } from './choose';
import type { Candidate, EpisodeChoice } from './choose';
import { dialogueIntervals } from './dialogue';
import { retime } from './retime';
import { episodeOfFile, mainFile, seasonEpisode } from './episode-files';
import type { FetchCache } from './fetch-cache';
import type { SeaDex, SeaDexRelease } from './seadex';
import type { FansubState } from './state';
import { NotFoundOnTosho } from './tosho';
import type { Tosho, ToshoFile, ToshoRelease, ToshoTrack } from './tosho';

/** A fetched track bigger than this once unpacked is skipped (spec §7). */
const MAX_TRACK_BYTES = 50 * 1024 * 1024;
const IDLE_STEP_MS = 30_000;
const UNSURE: FansubAlignment = { kind: 'none', reason: 'low-confidence' };

export interface FansubServiceOptions {
  readonly store: SubtitleStore;
  readonly state: FansubState;
  readonly seadex: SeaDex;
  readonly tosho: Tosho;
  readonly cache: FetchCache;
  readonly titles: { catalogue(): Catalogue };
  readonly discs: (discId: string) => Promise<LevelDiscSource | null>;
  readonly discKey: (discId: string) => string | null;
  readonly durationMs: (discId: string, playlistId: string) => number | null;
  readonly ffmpegPath: string;
  readonly activity: DiscActivity;
  /** A quality level is encoding. */
  readonly encoding: () => boolean;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  /** Local time the nightly pass stops at; 08:00 by default. */
  readonly windowEnd?: { readonly hour: number; readonly minute: number };
  /** Waits `ms`, rejecting on abort (tests pass a fake clock's). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** One episode of a unit: a season's episode, or a movie's one. */
interface UnitEpisode {
  readonly number: number;
  readonly discId: string;
  readonly playlistId: string;
}

/** What one SeaDex entry covers: an AniList season of a series, or a movie. */
interface Unit {
  readonly seasonId: string;
  readonly alId: number;
  /** Null for a movie. */
  readonly season: { readonly count: number; readonly before: number } | null;
  readonly episodes: readonly UnitEpisode[];
}

interface Job {
  readonly titleId: string;
  urgent: boolean;
  /** The nightly pass's end, for its own jobs; they also wait while a disc is read or a level encodes. */
  readonly windowEndAt: number | null;
  readonly controller: AbortController;
  readonly promise: Promise<FansubTitleState>;
  start(): void;
}

/** The nightly window closed while a title waited: it ends without counting as run. */
class WindowClosed extends Error {
  override name = 'WindowClosed';
}

const isServiceError = (e: unknown): boolean => e instanceof SourceUnavailable || e instanceof RateLimited;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const languageNames = new Intl.DisplayNames('en', { type: 'language' });
/** "English" for `eng`; the code itself when it names no language. */
function languageName(code: string): string {
  const c = normalizeLanguage(code);
  if (c === '' || c === 'und') return code || 'Unknown';
  try {
    return languageNames.of(c) ?? code;
  } catch {
    return code;
  }
}

const blank = (titleId: string): FansubTitleState => ({ titleId, lastRunAt: null, running: false, nothingFound: false, seasons: {}, episodes: {} });
const trackKey = (fileId: number, track: number): string => `${fileId}:${track}`;

export class FansubService {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly windowEnd: { readonly hour: number; readonly minute: number };
  private active: Job | null = null;
  private readonly queue: Job[] = [];
  private closed = false;
  private nightly: Promise<void> | null = null;
  private nightlyEndAt = 0;
  /** Titles the current nightly pass has already run (one that stays due isn't run again until the next scan). */
  private tried = new Set<string>();

  constructor(private readonly opts: FansubServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.sleep = opts.sleep ?? abortableSleep;
    this.windowEnd = opts.windowEnd ?? { hour: 8, minute: 0 };
    // A run that was going when the process stopped is over.
    opts.state.clearRunning();
  }

  /** Runs a title now or after the one running; a title already queued or running gives that run's answer. */
  runTitle(titleId: string, opts: { urgent?: boolean; signal?: AbortSignal } = {}): Promise<FansubTitleState> {
    return this.enqueue(titleId, opts.urgent ?? false, null, opts.signal);
  }

  /** The owner's button: the title runs next, ahead of the nightly pass. Answers the title's state at once. */
  runNow(titleId: string): FansubTitleState {
    if (this.find(titleId)) {
      if (!this.find(titleId)!.urgent) this.promote(titleId);
      return this.opts.state.title(titleId) ?? { ...blank(titleId), running: true };
    }
    const queued = { ...(this.opts.state.title(titleId) ?? blank(titleId)), running: true };
    this.opts.state.put(queued);
    this.enqueue(titleId, true, null).catch((e: unknown) => {
      if (!this.closed) this.log(`fansubs: ${titleId}: ${e instanceof Error ? e.message : String(e)}`);
    });
    return queued;
  }

  /** After a library scan: runs the due AniList titles one by one until the window's end (08:00 by default). */
  startNightly(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.nightlyEndAt = this.nextWindowEnd();
    this.tried = new Set();
    this.nightly ??= this.nightlyPass().finally(() => { this.nightly = null; });
    return this.nightly;
  }

  /** Stops the running title (its reads and ffmpeg) and the nightly pass; queued titles are dropped. */
  close(): void {
    this.closed = true;
    const err = new DOMException('closed', 'AbortError');
    this.active?.controller.abort(err);
    // each queued job's abort listener takes it out of the queue and rejects its promise
    for (const job of [...this.queue]) job.controller.abort(err);
  }

  /** The delete route deleted a fansub: its track isn't attached again until the owner asks. */
  deleted(subtitle: StoredSubtitle): void {
    const { source, attachment } = subtitle;
    if (!source) return;
    this.opts.state.markDeleted(attachment.titleId ?? '', source.toshoFileId, source.track);
  }

  /** The disc and playlist a fansub would be lined up on now: its episode's current one, else its attachment's. */
  private target(s: StoredSubtitle): { discId: string; discKey: string; playlistId: string } | null {
    const a = s.attachment;
    const detail = a.titleId !== undefined ? this.opts.titles.catalogue().detail(a.titleId) : null;
    if (a.kind === 'episode') {
      const ep = detail?.seasons.find((x) => x.id === a.seasonId)?.episodes?.find((e) => e.number === a.episode);
      const key = ep ? this.opts.discKey(ep.discId) : null;
      if (ep && key !== null) return { discId: ep.discId, discKey: key, playlistId: ep.playlistId };
    }
    for (const copy of (detail?.seasons ?? []).flatMap((x) => x.discs.flatMap((d) => d.copies))) {
      if (this.opts.discKey(copy.discId) === a.discKey) return { discId: copy.discId, discKey: a.discKey, playlistId: a.playlistId };
    }
    return null;
  }

  /** Lined up on a disc or playlist its episode no longer resolves to. */
  stale(subtitle: StoredSubtitle): boolean {
    const on = subtitle.source?.linedUpOn;
    if (!on) return false;
    const a = subtitle.attachment;
    const ep = a.kind === 'episode' && a.titleId !== undefined
      ? this.opts.titles.catalogue().detail(a.titleId)?.seasons.find((x) => x.id === a.seasonId)?.episodes?.find((e) => e.number === a.episode)
      : undefined;
    const key = ep ? this.opts.discKey(ep.discId) : null;
    const now = ep && key !== null ? { discKey: key, playlistId: ep.playlistId } : { discKey: a.discKey, playlistId: a.playlistId };
    return on.discKey !== now.discKey || on.playlistId !== now.playlistId;
  }

  /** Lines a fansub up again from its original, on its episode's current disc and playlist. */
  async realign(subtitleId: string): Promise<StoredSubtitle | null> {
    const s = this.opts.store.get(subtitleId);
    const original = s ? this.opts.store.originalPath(subtitleId) : null;
    if (!s?.source || original === null) return null;
    const target = this.target(s);
    if (!target) return null;
    const disc = await this.opts.discs(target.discId);
    const duration = this.opts.durationMs(target.discId, target.playlistId);
    if (!disc || duration === null) return null;
    // A file's tracks share the offset of its track with the most dialogue (a signs track has too little to go on).
    const siblings = this.opts.store.list().filter((o) => o.source?.toshoFileId === s.source!.toshoFileId && o.attachment.discKey === s.attachment.discKey);
    let base = readFileSync(original, 'utf8');
    let most = dialogueIntervals(base).length;
    for (const o of siblings) {
      const path = this.opts.store.originalPath(o.id);
      if (path === null || o.id === s.id) continue;
      const text = readFileSync(path, 'utf8');
      const n = dialogueIntervals(text).length;
      if (n > most) { base = text; most = n; }
    }
    const alignment = await align(disc, target.playlistId, duration, base, this.opts.ffmpegPath, undefined, { log: this.log });
    const source: FansubSource = { ...s.source, alignment, linedUpOn: { discKey: target.discKey, playlistId: target.playlistId } };
    const replaced = this.opts.store.replaceFile(subtitleId, Buffer.from(retime(readFileSync(original, 'utf8'), alignment)), source);
    if (!replaced) return null;
    if (s.attachment.kind === 'episode' && (s.attachment.discKey !== target.discKey || s.attachment.playlistId !== target.playlistId)) {
      return this.opts.store.update(subtitleId, { attachment: { ...s.attachment, discKey: target.discKey, playlistId: target.playlistId } });
    }
    return replaced;
  }

  /** Goes back to the track as fetched, unshifted. */
  useOriginal(subtitleId: string): StoredSubtitle | null {
    const s = this.opts.store.get(subtitleId);
    const original = s ? this.opts.store.originalPath(subtitleId) : null;
    if (!s?.source || original === null) return null;
    return this.opts.store.replaceFile(subtitleId, readFileSync(original), { ...s.source, alignment: { kind: 'original' } });
  }

  // --- the queue ---

  private find(titleId: string): Job | undefined {
    return this.active?.titleId === titleId ? this.active : this.queue.find((j) => j.titleId === titleId);
  }

  private promote(titleId: string): void {
    const at = this.queue.findIndex((j) => j.titleId === titleId);
    if (at < 0) return;
    const [job] = this.queue.splice(at, 1);
    job!.urgent = true;
    this.insert(job!);
  }

  /** Urgent jobs go after the other urgent ones, ahead of the rest. */
  private insert(job: Job): void {
    const before = job.urgent ? this.queue.findIndex((j) => !j.urgent) : -1;
    if (before < 0) this.queue.push(job);
    else this.queue.splice(before, 0, job);
  }

  private enqueue(titleId: string, urgent: boolean, windowEndAt: number | null, signal?: AbortSignal): Promise<FansubTitleState> {
    if (this.closed) return Promise.reject(new DOMException('closed', 'AbortError'));
    const existing = this.find(titleId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    let start!: () => void;
    const promise = new Promise<FansubTitleState>((resolve, reject) => {
      start = () => {
        // The queue moves on before the caller hears back, so a caller running the same title again starts a new run.
        const done = (): void => {
          this.active = null;
          this.pump();
        };
        this.execute(job).then((v) => { done(); resolve(v); }, (e: unknown) => { done(); reject(e); });
      };
      controller.signal.addEventListener('abort', () => {
        // Dropped while it waited its turn.
        const at = this.queue.indexOf(job);
        if (at >= 0) {
          this.queue.splice(at, 1);
          reject(controller.signal.reason);
        }
      }, { once: true });
    });
    const job: Job = { titleId, urgent, windowEndAt, controller, promise, start: () => start() };
    this.insert(job);
    this.pump();
    return promise;
  }

  private pump(): void {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    job.start();
  }

  private nextWindowEnd(): number {
    const now = this.now();
    const end = new Date(now);
    end.setHours(this.windowEnd.hour, this.windowEnd.minute, 0, 0);
    if (end.getTime() <= now) end.setDate(end.getDate() + 1);
    return end.getTime();
  }

  private async nightlyPass(): Promise<void> {
    while (!this.closed && this.now() < this.nightlyEndAt) {
      const ids = this.opts.titles.catalogue().titles.map((t) => t.id).filter((id) => /^anilist:\d+$/.test(id));
      const next = this.opts.state.due(ids, this.now()).find((id) => !this.tried.has(id));
      if (next === undefined) return;
      this.tried.add(next);
      try {
        await this.enqueue(next, false, this.nightlyEndAt);
      } catch (e) {
        if (this.closed) return;
        this.log(`fansubs: ${next}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // --- one title ---

  private units(titleId: string): Unit[] {
    const detail = this.opts.titles.catalogue().detail(titleId);
    if (!detail) return [];
    const out: Unit[] = [];
    let before = 0;
    for (const s of detail.seasons) {
      const m = /^anilist:(\d+)#season$/.exec(s.id);
      if (!m) continue;
      const count = Math.max(0, ...(s.episodes ?? []).map((e) => e.number));
      if (s.episodes?.length) {
        out.push({ seasonId: s.id, alId: Number(m[1]), season: { count, before }, episodes: s.episodes.map(({ number, discId, playlistId }) => ({ number, discId, playlistId })) });
      }
      before += count;
    }
    const movie = /^anilist:(\d+)$/.exec(titleId);
    if (movie && detail.title.kind === 'movie') {
      const discs = detail.seasons.find((s) => s.id === `${titleId}#discs`)?.discs ?? [];
      const discId = discs[0]?.copies[0]?.discId;
      // the playlist is the disc's longest, found when the unit runs
      if (discId !== undefined) out.push({ seasonId: `${titleId}#discs`, alId: Number(movie[1]), season: null, episodes: [{ number: 1, discId, playlistId: '' }] });
    }
    return out;
  }

  private async longestPlaylist(discId: string): Promise<string | null> {
    const disc = await this.opts.discs(discId);
    if (!disc) return null;
    let best: { id: string; ms: number } | null = null;
    for (const f of (await disc.manifest()).files) {
      const id = /^BDMV\/PLAYLIST\/(\d{5})\.MPLS$/.exec(f.path)?.[1];
      const ms = id !== undefined ? this.opts.durationMs(discId, id) : null;
      if (id !== undefined && ms !== null && (!best || ms > best.ms)) best = { id, ms };
    }
    return best?.id ?? null;
  }

  private async execute(job: Job): Promise<FansubTitleState> {
    const { titleId } = job;
    const { state } = this.opts;
    const prev = state.title(titleId);
    let cur: FansubTitleState = { ...(prev ?? blank(titleId)), titleId, running: true };
    state.put(cur);
    const marks: FansubEpisodeMark[] = [];
    try {
      for (const unit of this.units(titleId)) {
        const line = await this.runUnit(titleId, unit, job, (n, mark) => {
          marks.push(mark);
          cur = { ...cur, episodes: { ...cur.episodes, [`${unit.seasonId}#${n}`]: mark } };
          state.put(cur);
        });
        if (line) {
          cur = { ...cur, seasons: { ...cur.seasons, [unit.seasonId]: line } };
          state.put(cur);
        }
      }
    } catch (e) {
      cur = { ...cur, running: false };
      state.put(cur);
      if (e instanceof WindowClosed) return cur;
      throw e;
    }
    // A run where every episode met an unreachable service stays due: the next night tries again.
    const unavailable = marks.length > 0 && marks.every((m) => m.reason === 'service-unavailable');
    cur = unavailable
      ? { ...cur, running: false }
      : { ...cur, running: false, lastRunAt: this.now(), nothingFound: !marks.some((m) => m.status === 'attached') };
    state.put(cur);
    return cur;
  }

  /** The nightly pass waits while a disc is read or a level encodes, and gives up at the window's end. */
  private async waitIdle(job: Job): Promise<void> {
    const { signal } = job.controller;
    signal.throwIfAborted();
    if (job.urgent) return;
    for (;;) {
      if (job.windowEndAt !== null && this.now() >= job.windowEndAt) throw new WindowClosed();
      if (!this.opts.activity.busy() && !this.opts.encoding()) return;
      await this.sleep(IDLE_STEP_MS, signal);
    }
  }

  private async runUnit(
    titleId: string, unit: Unit, job: Job, mark: (episode: number, m: FansubEpisodeMark) => void,
  ): Promise<FansubSeasonLine | null> {
    const { seadex, tosho, state } = this.opts;
    const paced = { urgent: job.urgent, signal: job.controller.signal };
    const all = (m: FansubEpisodeMark): null => {
      for (const e of unit.episodes) mark(e.number, m);
      return null;
    };
    let episodes = unit.episodes;
    if (unit.season === null) {
      const playlistId = await this.longestPlaylist(episodes[0]!.discId);
      if (playlistId === null) {
        this.log(`fansubs: ${titleId}: the movie's disc can't be read`);
        return null;
      }
      episodes = [{ ...episodes[0]!, playlistId }];
    }

    let entry;
    try {
      entry = await seadex.entry(unit.alId, paced);
    } catch (e) {
      if (!isServiceError(e)) throw e;
      this.log(`fansubs: ${titleId}: SeaDex: ${(e as Error).message}`);
      return all({ status: 'not-found', reason: 'service-unavailable' });
    }
    if (!entry) return all({ status: 'not-found', reason: 'no-release' });
    const ranked = rankReleases(entry);
    const line = (used: readonly Candidate[]): FansubSeasonLine => ({
      bestGroup: ranked.find((r) => r.rank === 'best')?.release.group ?? null,
      usedGroups: used.filter((c, i) => used.findIndex((o) => o.seadex.group === c.seadex.group && o.rank === c.rank) === i)
        .map((c) => ({ group: c.seadex.group, rank: c.rank })),
    });

    // Each release on Anime Tosho by hash, best first, until every episode is covered.
    let serviceDown = false;
    const looked = new Map<SeaDexRelease, ToshoRelease | null>();
    const lookUp = async (r: SeaDexRelease): Promise<ToshoRelease | null> => {
      if (looked.has(r)) return looked.get(r)!;
      let release: ToshoRelease | null = null;
      try {
        release = await tosho.byHash(r.infoHash!, paced);
      } catch (e) {
        if (!isServiceError(e)) throw e;
        serviceDown = true;
        this.log(`fansubs: ${titleId}: Anime Tosho: ${(e as Error).message}`);
      }
      looked.set(r, release);
      return release;
    };
    const languages = state.languages();
    const numbers = episodes.map((e) => e.number);
    const candidates: Candidate[] = [];
    for (const r of ranked) {
      if (choosePerEpisode(candidates, numbers, unit.season, languages).size === numbers.length) break;
      const release = await lookUp(r.release);
      if (release) candidates.push({ release, seadex: r.release, rank: r.rank });
    }
    const choices = choosePerEpisode(candidates, numbers, unit.season, languages);

    const used: Candidate[] = [];
    for (const ep of episodes) {
      await this.waitIdle(job);
      const choice = choices.get(ep.number);
      if (!choice) {
        mark(ep.number, { status: 'not-found', reason: serviceDown ? 'service-unavailable' : candidates.length === 0 ? 'no-release' : 'no-tracks' });
        continue;
      }
      const m = await this.episode(titleId, unit, ep, choice, ranked.map((r) => r.release), lookUp, job);
      if (m.status === 'attached') used.push(choice.candidate);
      mark(ep.number, m);
    }
    return line(used);
  }

  /** The files of `release` for one episode, best first; a movie's main file. */
  private filesFor(release: ToshoRelease, unit: Unit, episode: number): ToshoFile[] {
    if (unit.season === null) {
      const f = mainFile(release.files);
      return f ? [f] : [];
    }
    const season = unit.season;
    return release.files.filter((f) => {
      const n = episodeOfFile(f.name);
      return n !== null && seasonEpisode(n, season) === episode;
    });
  }

  /** The fonts of a file's pack; when it has none on Anime Tosho, the same group's other release's pack for the episode. */
  private async fonts(
    unit: Unit, episode: number, choice: EpisodeChoice, releases: readonly SeaDexRelease[],
    lookUp: (r: SeaDexRelease) => Promise<ToshoRelease | null>, job: Job,
  ): Promise<{ name: string; data: Buffer }[] | null> {
    const paced = { urgent: job.urgent, signal: job.controller.signal };
    const pack = async (fileId: number): Promise<{ name: string; data: Buffer }[] | null> => {
      const url = this.opts.tosho.fontPackUrl(fileId);
      try {
        return await fontsIn7z(await this.opts.cache.get(url, () => this.opts.tosho.download(url, paced)));
      } catch (e) {
        if (job.controller.signal.aborted) throw e;
        if (!(e instanceof NotFoundOnTosho)) this.log(`fansubs: font pack of file ${fileId}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    };
    const own = await pack(choice.file.id);
    if (own) return own;
    for (const r of releases) {
      if (r === choice.candidate.seadex || r.group !== choice.candidate.seadex.group || r.infoHash === null) continue;
      const release = await lookUp(r);
      for (const f of release ? this.filesFor(release, unit, episode) : []) {
        const fonts = await pack(f.id);
        if (fonts) return fonts;
      }
    }
    return null;
  }

  /** Fetches, lines up and attaches one episode's tracks, replacing its earlier fansubs. */
  private async episode(
    titleId: string, unit: Unit, ep: UnitEpisode, choice: EpisodeChoice, releases: readonly SeaDexRelease[],
    lookUp: (r: SeaDexRelease) => Promise<ToshoRelease | null>, job: Job,
  ): Promise<FansubEpisodeMark> {
    const { store, state, tosho, cache } = this.opts;
    const { signal } = job.controller;
    const paced = { urgent: job.urgent, signal };
    const discKey = this.opts.discKey(ep.discId);
    if (discKey === null) return { status: 'not-found', reason: 'no-release' };

    const tracks = choice.tracks.filter((t) => !state.isDeleted(choice.file.id, t.track));
    const fetched: { track: ToshoTrack; text: string }[] = [];
    let tooLarge = false;
    let down = false;
    for (const track of tracks) {
      try {
        const raw = await cache.get(track.url, () => tosho.download(track.url, paced));
        fetched.push({ track, text: (await unxz(raw, MAX_TRACK_BYTES)).toString('utf8') });
      } catch (e) {
        signal.throwIfAborted();
        if (e instanceof TooLargeArchive) tooLarge = true;
        else if (isServiceError(e)) down = true;
        else if (!(e instanceof NotFoundOnTosho)) this.log(`fansubs: track ${track.track} of file ${choice.file.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (fetched.length === 0) return { status: 'not-found', reason: down ? 'service-unavailable' : tooLarge ? 'too-large' : 'no-tracks' };

    const fonts = await this.fonts(unit, ep.number, choice, releases, lookUp, job);
    // The file's tracks share the offset of the one with the most dialogue.
    const main = fetched.reduce((a, b) => (dialogueIntervals(b.text).length > dialogueIntervals(a.text).length ? b : a));
    const disc = await this.opts.discs(ep.discId);
    const duration = this.opts.durationMs(ep.discId, ep.playlistId);
    const alignment = disc && duration !== null
      ? await align(disc, ep.playlistId, duration, main.text, this.opts.ffmpegPath, signal, { log: this.log })
      : UNSURE;
    signal.throwIfAborted();

    const attachment: SubtitleAttachment = unit.season === null
      ? { kind: 'chapter', discKey, playlistId: ep.playlistId, chapter: 0, titleId }
      : { kind: 'episode', discKey, playlistId: ep.playlistId, titleId, seasonId: unit.seasonId, episode: ep.number };
    // The episode's earlier fansubs make way; the owner's edits to a track carry over to its new copy.
    const earlier = store.list().filter((s) => {
      const a = s.attachment;
      if (!s.source || a.titleId !== titleId) return false;
      return unit.season === null ? a.kind === 'chapter' : a.kind === 'episode' && a.seasonId === unit.seasonId && a.episode === ep.number;
    });
    const kept = new Map(earlier.map((s) => [trackKey(s.source!.toshoFileId, s.source!.track), s]));
    for (const s of earlier) store.delete(s.id);

    let attached = 0;
    for (const { track, text } of fetched) {
      const trackName = track.name || languageName(track.language);
      const was = kept.get(trackKey(choice.file.id, track.track));
      const source: FansubSource = {
        kind: 'fansub', group: choice.candidate.seadex.group, tracker: choice.candidate.seadex.tracker, rank: choice.candidate.rank,
        toshoFileId: choice.file.id, track: track.track, trackName, alignment, linedUpOn: { discKey, playlistId: ep.playlistId },
      };
      try {
        store.createFansub(
          {
            name: was?.name ?? `${choice.candidate.seadex.group} · ${trackName}`, language: was?.language ?? track.language,
            offsetMs: was?.offsetMs ?? 0, attachment, source, ...(fonts === null ? { fontsMissing: true } : {}),
          },
          { name: `${choice.file.id}-${track.track}.ass`, data: Buffer.from(retime(text, alignment)), original: Buffer.from(text) },
          fonts ?? [],
        );
        attached++;
      } catch (e) {
        if (!(e instanceof TooLargeError)) throw e;
        tooLarge = true;
        this.log(`fansubs: the fansub store is full; track ${track.track} of file ${choice.file.id} left out`);
      }
    }
    return attached > 0 ? { status: 'attached' } : { status: 'not-found', reason: tooLarge ? 'too-large' : 'no-tracks' };
  }
}
