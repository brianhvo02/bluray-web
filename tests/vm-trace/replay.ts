import { fileURLToPath } from 'node:url';
import { MarkType, type Mpls } from '../../src/engine/bdmv/mpls-parser';
import type { Clpi } from '../../src/engine/bdmv/clpi-parser';
import { FileSource } from '../../src/engine/disc/file-source';
import { loadClips, openDisc, type DiscModel } from '../../src/engine/disc/open-disc';
import { normalizeDiscPaths } from '../../src/engine/disc/paths';
import { PSR, RegisterFile, type PsrEvent } from '../../src/engine/hdmv/registers';
import type { UoMask, UoOp } from '../../src/engine/hdmv/uo-mask';
import { Navigator, type NavigatorEvent, type PlayAt, type PlaybackPort } from '../../src/engine/nav/navigator';
import { directoryEntries } from '../helpers/file-blob';
import type { TraceEntry } from './format';
import { parseScript, type ScriptStep } from './script';

const READ_SIZE = 6144;
const SCR_PER_READ = 1800;
const MAX_READS = 10_000_000;
const TAIL_READS = 200;
/** 48 Mbit/s in bytes per second, used when the clip declares no TS_recording_rate. */
const FALLBACK_RATE = 6_000_000;
const NO_CHAPTER = 0xffff;

/** bd_event_e BLURAY_UO_* bits of libbluray's _compressed_mask (playFirstPlay and pauseOff have none). */
const UO_BIT: Partial<Record<UoOp, number>> = {
  menuCall: 0x1, titleSearch: 0x2, chapterSearch: 0x4, timeSearch: 0x8, skipToNextPoint: 0x10, skipBackToPreviousPoint: 0x20,
  stop: 0x40, pauseOn: 0x80, stillOff: 0x100, forwardPlay: 0x200, backwardPlay: 0x400, resume: 0x800,
  moveUp: 0x1000, moveDown: 0x2000, moveLeft: 0x4000, moveRight: 0x8000, select: 0x10000, activate: 0x20000,
  selectAndActivate: 0x40000, primaryAudioChange: 0x80000, angleChange: 0x100000, popupOn: 0x200000, popupOff: 0x400000,
  pgEnableDisable: 0x800000, pgChange: 0x1000000, secondaryVideoEnableDisable: 0x2000000, secondaryVideoChange: 0x4000000,
  secondaryAudioEnableDisable: 0x8000000, secondaryAudioChange: 0x10000000, pipPgChange: 0x20000000,
};

function compressedMask(mask: UoMask): number {
  let value = 0;
  for (const op of mask) value |= UO_BIT[op] ?? 0;
  return value >>> 0;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Simulated player: playlist time advances by the duration of one 6144-byte read per step at the clip's rate, and the
 * Navigator hears about play items, chapters and the end of the playlist as the position crosses them.
 */
class SimPort implements PlaybackPort {
  navigator!: Navigator;
  held = false;
  private mpls: Mpls | null = null;
  private clips: ReadonlyMap<string, Clpi> = new Map();
  private item = 0;
  /** 45 kHz ticks since the current play item's IN time. */
  private pos = 0;
  private ended = false;
  private chapter = NO_CHAPTER;

  constructor(private readonly disc: DiscModel, private readonly onHold: (on: boolean) => void) {}

  setClips(clips: ReadonlyMap<string, Clpi>): void {
    this.clips = clips;
  }

  /** A playlist is open and has not reached its end. */
  get active(): boolean {
    return this.mpls !== null && !this.ended;
  }

  playPlaylist(id: string, at: PlayAt): Promise<boolean> {
    const mpls = this.disc.playlists.get(id);
    if (!mpls) return Promise.resolve(false);
    this.mpls = mpls;
    this.ended = false;
    this.held = false;
    this.chapter = NO_CHAPTER;
    this.item = 0;
    this.pos = 0;
    let item = 0;
    let pos = 0;
    if (at.mark !== undefined && mpls.marks[at.mark]) {
      const mark = mpls.marks[at.mark]!;
      item = mark.playItemRef;
      pos = Math.max(0, mark.time - mpls.playItems[item]!.inTime);
    } else if (at.item !== undefined && at.item < mpls.playItems.length) {
      item = at.item;
    }
    if (at.clipTime45 !== undefined && mpls.playItems[item]) pos = Math.max(0, at.clipTime45 - mpls.playItems[item]!.inTime);
    this.item = item;
    this.pos = pos;
    this.navigator.playlistStarted(id, item); // synchronously, as the real player does
    this.updateChapter();
    return Promise.resolve(true);
  }

  seekPlayItem(item: number): void {
    if (!this.mpls || item >= this.mpls.playItems.length) return;
    this.moveTo(item, 0);
  }

  seekMark(mark: number): void {
    const m = this.mpls?.marks[mark];
    if (!this.mpls || !m) return;
    this.moveTo(m.playItemRef, Math.max(0, m.time - this.mpls.playItems[m.playItemRef]!.inTime));
  }

  stopPlaylist(): void {
    this.mpls = null;
  }

  hold(on: boolean): void {
    this.held = on;
    this.onHold(on);
  }

  currentClipTime45(): number | undefined {
    const pi = this.mpls?.playItems[this.item];
    return pi ? pi.inTime + Math.floor(this.pos) : undefined;
  }

  /** One bd_read_ext() worth of stream data. */
  read(): void {
    const mpls = this.mpls;
    if (!mpls || this.ended || this.held) return;
    const pi = mpls.playItems[this.item]!;
    const rate = this.clips.get(pi.clipId)?.recordingRate || FALLBACK_RATE;
    this.pos += (READ_SIZE / rate) * 45_000;
    if (this.pos < pi.outTime - pi.inTime) {
      this.updateChapter();
      return;
    }
    this.pos = pi.outTime - pi.inTime;
    if (this.item < mpls.playItems.length - 1) {
      this.navigator.playItemEnded(this.item);
      if (!this.held && this.mpls === mpls && !this.ended) this.moveTo(this.item + 1, 0);
    } else {
      this.ended = true;
      this.navigator.playlistEnded();
    }
  }

  private moveTo(item: number, pos: number): void {
    const changed = item !== this.item;
    this.item = item;
    this.pos = pos;
    if (changed) this.navigator.playItemChanged(item);
    this.updateChapter();
  }

  /** bd_get_current_chapter: the last ENTRY mark at or before the position. */
  private updateChapter(): void {
    const mpls = this.mpls;
    if (!mpls) return;
    const here = this.item * 1e12 + (mpls.playItems[this.item]!.inTime + this.pos);
    let chapter = 0;
    let index = 0;
    for (const m of mpls.marks) {
      if (m.type !== MarkType.ENTRY) continue;
      if (m.playItemRef * 1e12 + m.time <= here) chapter = index;
      index++;
    }
    if (chapter !== this.chapter) {
      this.chapter = chapter;
      this.navigator.chapterChanged(chapter);
    }
  }
}

/** Runs the disc in `discDir` (a BDMV folder tree) through our Navigator, driven by a trace script. */
export async function replay(discDir: URL, scriptText: string): Promise<TraceEntry[]> {
  const steps = parseScript(scriptText);
  const source = new FileSource(normalizeDiscPaths(await directoryEntries(fileURLToPath(discDir))));
  const disc = await openDisc(source);
  const clipIds = [...new Set([...disc.playlists.values()].flatMap((p) => p.playItems.map((i) => i.clipId)))];
  const clips = await loadClips(source, clipIds);

  const trace: TraceEntry[] = [];
  const regs = new RegisterFile();
  regs.onWrite = (w): void => {
    if (w.kind === 'psr' && w.index === PSR.TIME) return;
    trace.push({ k: w.kind, i: w.index, v: w.value });
  };

  // libbluray's _process_psr_event queues BD_EVENT_TITLE/PLAYLIST/PLAYITEM/CHAPTER from PSR writes, inside the dispatch
  // and so before the register write itself is logged. Registered before the Navigator, as libbluray's callback is.
  let lastTitle = -1;
  let lastPlaylist = -1;
  regs.onPsrEvent((e: PsrEvent) => {
    if (e.type === 'restore') {
      if (e.psr === PSR.TITLE_NUMBER) trace.push({ k: 'title', v: (lastTitle = e.newValue) });
      return;
    }
    if (e.type !== 'write' && e.type !== 'change') return;
    if (e.psr === PSR.TITLE_NUMBER) trace.push({ k: 'title', v: (lastTitle = e.newValue) });
    else if (e.psr === PSR.PLAYLIST) trace.push({ k: 'playlist', v: (lastPlaylist = e.newValue) });
    else if (e.psr === PSR.PLAYITEM) trace.push({ k: 'playitem', v: e.newValue });
    else if (e.psr === PSR.CHAPTER && e.type === 'change' && e.newValue !== NO_CHAPTER) trace.push({ k: 'chapter', v: e.newValue });
  });

  let menuOpen = false;
  let popupOpen = false;
  let errored = false;
  let scr = 0;
  const port = new SimPort(disc, (on) => trace.push({ k: 'still', v: on ? 1 : 0 }));
  port.setClips(clips);
  const emit = (e: NavigatorEvent): void => {
    switch (e.type) {
      case 'uoMask': trace.push({ k: 'uo', v: compressedMask(e.mask).toString(16) }); break;
      case 'menu': menuOpen = e.active; trace.push({ k: 'menu', v: e.active ? 1 : 0 }); break;
      case 'popup': popupOpen = e.available; trace.push({ k: 'popup', v: e.available ? 1 : 0 }); break;
      case 'sound': trace.push({ k: 'sound', v: e.id }); break;
      case 'error': errored = true; break;
      default: break; // title events come from the PSR listener above
    }
  };
  const navigator = new Navigator({ disc, regs, port, emit, nowScr: () => scr, seed: 1 });
  port.navigator = navigator;

  const settle = async (): Promise<void> => {
    navigator.tick();
    await flush();
  };
  /** bd_trace_finished: the program has ended and no playlist is playing. */
  const finished = (): boolean => !navigator.vmRunning && !port.active;
  const waitMet = (s: ScriptStep): boolean => {
    if (s.op !== 'wait') return true;
    switch (s.what) {
      case 'title': return lastTitle === s.n;
      case 'playlist': return lastPlaylist === s.n;
      case 'menu': return menuOpen;
      case 'popup': return popupOpen;
      case 'end': return finished();
    }
  };
  const run = (s: ScriptStep): void => {
    switch (s.op) {
      case 'play': navigator.playTitle(s.title); break;
      case 'key':
        if (s.key !== 'topmenu') throw new Error(`replay: key ${s.key} needs the graphics controller (Task 12)`);
        navigator.menuCall();
        break;
      case 'mouse':
      case 'click':
        throw new Error(`replay: ${s.op} needs the graphics controller (Task 12)`);
      default: break;
    }
  };

  navigator.start();
  await flush();
  let idx = 0;
  let tail = 0;
  for (let reads = 0; reads < MAX_READS; reads++) {
    await settle();
    while (idx < steps.length && !errored && waitMet(steps[idx]!)) {
      run(steps[idx]!);
      await settle();
      trace.push({ k: 'step', n: idx });
      idx++;
    }
    if (errored) {
      trace.push({ k: 'end', why: 'error' });
      return trace;
    }
    if (idx === steps.length && (finished() || tail++ >= TAIL_READS)) {
      trace.push({ k: 'end', why: 'eof' });
      return trace;
    }
    scr += SCR_PER_READ;
    port.read();
    await flush();
  }
  trace.push({ k: 'end', why: 'limit' });
  return trace;
}
