import { fileURLToPath } from 'node:url';
import type { Mpls } from '../../src/engine/bdmv/mpls-parser';
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
 * Simulated player, positioned in source packets like libbluray's read loop: a read takes the rest of the current 6144-byte
 * aligned unit of the play item's clip, seeks land on the EP map entry at or before the target (clpi_lookup_spn), and
 * every play item starts at packet 0 (true of disc-vm: first item and seamless connections, see _fill_clip). The Navigator
 * hears about play items, play marks and the end of the playlist as the position crosses them.
 */
class SimPort implements PlaybackPort {
  navigator!: Navigator;
  held = false;
  private mpls: Mpls | null = null;
  private clips: ReadonlyMap<string, Clpi> = new Map();
  private item = 0;
  /** Byte position in the current play item's clip (clip_pos). */
  private bytes = 0;
  private ended = false;
  /** libbluray's next_mark: the first play mark after the position, -1 when none is left. */
  private nextMark = -1;

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
    let item = 0;
    let pkt = 0;
    if (at.mark !== undefined && mpls.marks[at.mark]) {
      const mark = mpls.marks[at.mark]!;
      item = mark.playItemRef;
      pkt = this.lookupPkt(item, mark.time);
    } else if (at.item !== undefined && at.item < mpls.playItems.length) {
      item = at.item;
    }
    if (at.clipTime45 !== undefined && mpls.playItems[item] && at.clipTime45 < mpls.playItems[item]!.outTime) pkt = this.lookupPkt(item, at.clipTime45);
    this.item = item;
    this.bytes = pkt * 192;
    this.findNextMark();
    this.navigator.playlistStarted(id, item); // synchronously, as the real player does
    return Promise.resolve(true);
  }

  seekPlayItem(item: number): void {
    if (!this.mpls || item >= this.mpls.playItems.length) return;
    this.moveTo(item, 0, true);
  }

  seekMark(mark: number): void {
    const m = this.mpls?.marks[mark];
    if (this.mpls && m) this.moveTo(m.playItemRef, this.lookupPkt(m.playItemRef, m.time), true);
  }

  stopPlaylist(): void {
    this.mpls = null;
  }

  hold(on: boolean): void {
    this.held = on;
    this.onHold(on);
  }

  /** _update_time_psr_from_stream: nav_clip_packet_search at the read position. */
  currentClipTime45(): number | undefined {
    const pi = this.mpls?.playItems[this.item];
    if (!pi) return undefined;
    const pkt = Math.floor(this.bytes / 192);
    const eps = this.epEntries(this.item);
    let time = 0;
    for (const e of eps) if (e.spn <= pkt) time = e.pts;
    return time !== 0 && time < pi.inTime ? pi.inTime : time; // the EP map does not store the low 8 bits
  }

  /** One bd_read_ext() worth of stream data (_bd_read). */
  read(): void {
    const mpls = this.mpls;
    if (!mpls || this.ended || this.held) return;
    if (this.bytes >= this.clipBytes(this.item)) {
      // the clip is used up: still, next play item, or the end of the title
      if (this.item >= mpls.playItems.length - 1) {
        this.ended = true;
        this.navigator.playlistEnded();
        return;
      }
      this.navigator.playItemEnded(this.item);
      if (this.held || this.mpls !== mpls || this.ended) return;
      this.moveTo(this.item + 1, 0, false);
    }
    this.bytes = Math.min(this.clipBytes(this.item), (Math.floor(this.bytes / READ_SIZE) + 1) * READ_SIZE);
    this.playmarkReached();
  }

  private epEntries(item: number): readonly { pts: number; spn: number }[] {
    return this.clips.get(this.mpls!.playItems[item]!.clipId)?.epMaps[0]?.entries ?? [];
  }

  /** clpi_lookup_spn(before): the packet of the last EP map entry at or before `time45`. */
  private lookupPkt(item: number, time45: number): number {
    let pkt = 0;
    for (const e of this.epEntries(item)) if (e.pts <= time45) pkt = e.spn;
    return pkt;
  }

  private clipBytes(item: number): number {
    const clip = this.clips.get(this.mpls!.playItems[item]!.clipId);
    return (clip?.numSourcePackets ?? 0) * 192;
  }

  /** Byte position in the whole playlist (s_pos). */
  private position(): number {
    let pos = this.bytes;
    for (let i = 0; i < this.item; i++) pos += this.clipBytes(i);
    return pos;
  }

  private markPosition(index: number): number {
    const m = this.mpls!.marks[index]!;
    let pos = this.lookupPkt(m.playItemRef, m.time) * 192;
    for (let i = 0; i < m.playItemRef; i++) pos += this.clipBytes(i);
    return pos;
  }

  /** _find_next_playmark (the chapter PSR part is the Navigator's). */
  private findNextMark(): void {
    const here = this.position();
    this.nextMark = -1;
    for (let i = 0; i < this.mpls!.marks.length; i++) {
      if (this.markPosition(i) > here) {
        this.nextMark = i;
        break;
      }
    }
  }

  /** _playmark_reached: marks the position has passed, one chapter update for all of them. */
  private playmarkReached(): void {
    const here = this.position();
    let reached = -1;
    while (this.nextMark >= 0 && here > this.markPosition(this.nextMark)) {
      reached = this.nextMark;
      this.nextMark = this.nextMark + 1 < this.mpls!.marks.length ? this.nextMark + 1 : -1;
    }
    if (reached >= 0) this.navigator.markReached(this.item, Math.floor(this.bytes / 192));
  }

  /** `seek`: _seek_internal (restarts mark tracking); otherwise the next clip is simply opened. */
  private moveTo(item: number, pkt: number, seek: boolean): void {
    const changed = item !== this.item;
    this.item = item;
    this.bytes = pkt * 192;
    if (seek) this.findNextMark();
    if (changed) this.navigator.playItemChanged(item);
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
  let readsDone = 0;
  let readsBase = 0;
  const port = new SimPort(disc, (on) => trace.push({ k: 'still', v: on ? 1 : 0 }));
  port.setClips(clips);
  const emit = (e: NavigatorEvent): void => {
    switch (e.type) {
      case 'uoMask': trace.push({ k: 'uo', v: compressedMask(e.mask).toString(16) }); break;
      case 'menu': menuOpen = e.active; trace.push({ k: 'menu', v: e.active ? 1 : 0 }); break;
      case 'popup': popupOpen = e.available; trace.push({ k: 'popup', v: e.available ? 1 : 0 }); break;
      case 'sound': trace.push({ k: 'sound', v: e.id }); break;
      case 'seek': trace.push({ k: 'seek', what: e.what, v: e.value }); break;
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
      case 'reads': return readsDone - readsBase >= s.n;
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
      readsBase = readsDone;
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
    readsDone++;
    await flush();
  }
  trace.push({ k: 'end', why: 'limit' });
  return trace;
}
