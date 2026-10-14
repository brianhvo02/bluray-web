/*
 * Ported from libbluray src/libbluray/bluray.c (HDMV title and navigation parts)
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2012-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 * Copyright (C) 2012  Libbluray team
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { IndexObject } from '../bdmv/index-parser';
import { MarkType, type Mpls, type StreamEntry } from '../bdmv/mpls-parser';
import type { DiscModel } from '../disc/open-disc';
import { GraphicsController, GcStatus, type GcCtrl as GraphicsCtrl } from '../graphics/graphics-controller';
import { IgSegmentDecoder, type IgDisplaySet } from '../graphics/ig-decoder';
import { OverlayPlane, type OverlayOp } from '../graphics/overlay-plane';
import { PSR, type PsrEvent, type RegisterFile } from '../hdmv/registers';
import { combineUoMasks, EMPTY_UO_MASK, parseUoMaskTable, type UoMask, type UoOp } from '../hdmv/uo-mask';
import { HdmvEventType, HdmvVm, type HdmvEvent } from '../hdmv/vm';
import { itemPackets, lookupSpn, type ItemPackets } from './packets';

export interface PlaybackPort {
  /**
   * false if the playlist is missing. Contract (as libbluray's _open_playlist): once the playlist is open the port
   * calls Navigator.playlistStarted() synchronously from inside this call, before returning, so that PSR and UO mask
   * updates happen in libbluray's order relative to the rest of the VM step. `clipTime45` asks for a start at that
   * 45 kHz clip time within `item` (restore after a menu call).
   */
  playPlaylist(id: string, at: PlayAt): Promise<boolean>;
  seekPlayItem(item: number): void;
  seekMark(mark: number): void;
  stopPlaylist(): void;
  /** still: freeze presentation (clock stops), keep the frame */
  hold(on: boolean): void;
  /** 45 kHz clip time of the current presentation position (bd_get_scr-less _update_time_psr_from_stream), if known. */
  currentClipTime45(): number | undefined;
}

export interface PlayAt {
  readonly item?: number;
  readonly mark?: number;
  readonly clipTime45?: number;
}

export type NavigatorEvent =
  | { readonly type: 'uoMask'; readonly mask: UoMask }
  | { readonly type: 'menu'; readonly active: boolean }
  | { readonly type: 'popup'; readonly available: boolean }
  | { readonly type: 'sound'; readonly id: number }
  | { readonly type: 'title'; readonly title: number }
  /** A seek the program asked for was accepted (bd_seek_playitem, bd_seek_mark, _clip_seek_time); `value` is the item, mark or 45 kHz clip time. */
  | { readonly type: 'seek'; readonly what: 'item' | 'mark' | 'time'; readonly value: number }
  | { readonly type: 'bdjTitle'; readonly title: number }
  | { readonly type: 'error'; readonly message: string };

export interface NavigatorDeps {
  /** with movieObjects non-null */
  readonly disc: DiscModel;
  readonly regs: RegisterFile;
  readonly port: PlaybackPort;
  emit(event: NavigatorEvent): void;
  /** 90 kHz monotonic, as bd_get_scr() */
  nowScr(): number;
  readonly seed?: number;
  /**
   * _preload_m2ts for an IG sub-path: reads the whole sub-path clip and returns the PES units of `pid` in stream order.
   * Rejects when the clip cannot be read (no menu, counted as an IG error); the read stops when `signal` aborts.
   * Without it, IG streams carried in sub-paths show no menu.
   */
  preloadSubPathIg?(clipId: string, pid: number, signal: AbortSignal): Promise<IgUnit[]>;
}

const TITLE_FIRST_PLAY = 0xffff;
const TITLE_TOP_MENU = 0;
const STILL_TIME = 1;
const STILL_INFINITE = 2;
const SCR_HZ = 90000;
const MAX_VM_LOOPS = 100;
const MAX_INVALID_PL = 10;
const HDMV_MENU_CALL_MASK = 1;
const HDMV_TITLE_SEARCH_MASK = 2;
const INDEX_ID_NONE = 0xffff;
const INDEX_PLAYBACK_INTERACTIVE = [1, 3]; // indx_hdmv_playback_type_interactive, indx_bdj_playback_type_interactive
const NO_PLAYLIST = 0xffff;

type TitleType = 'undef' | 'hdmv' | 'bdj';
/** gc_ctrl_e values the navigator sends to the graphics controller. */
type GcCtrl = 'INIT_MENU' | 'ENABLE_BUTTON' | 'DISABLE_BUTTON' | 'SET_BUTTON_PAGE' | 'POPUP' | 'IG_END' | 'NOP';

const GC_CTRL: Readonly<Record<GcCtrl, GraphicsCtrl>> = {
  INIT_MENU: 'initMenu', ENABLE_BUTTON: 'enableButton', DISABLE_BUTTON: 'disableButton',
  SET_BUTTON_PAGE: 'setButtonPage', POPUP: 'popup', IG_END: 'igEnd', NOP: 'nop',
};

const DEFAULT_PLANE_WIDTH = 1920;
const DEFAULT_PLANE_HEIGHT = 1080;
const COMPOSITION_ACQUISITION_POINT = 1;

/** A graphics PES payload of the IG stream, in playlist time. */
export interface IgUnit {
  readonly data: Uint8Array;
  readonly ptsUs: number;
  /** Decode time: segments carry it ahead of the ICS's presentation time, and gating follows it (graphics_processor_decode_pes). */
  readonly dtsUs?: number;
}

/** str_to_uint32(s, 3) */
function langToUint32(lang: string): number {
  return (((lang.charCodeAt(0) || 0) << 16) | ((lang.charCodeAt(1) || 0) << 8) | (lang.charCodeAt(2) || 0)) >>> 0;
}

function sameMask(a: UoMask, b: UoMask): boolean {
  if (a.size !== b.size) return false;
  for (const op of a) if (!b.has(op)) return false;
  return true;
}

interface SubIgPreload {
  readonly key: string;
  readonly clipId: string;
  readonly pid: number;
  readonly abort: AbortController;
  /** null while the clip is loading; the whole stream's units once loaded. */
  units: readonly IgUnit[] | null;
  /** The read failed: no menu until the playlist closes (no retry, as libbluray). */
  failed: boolean;
  /** _init_ig_stream ran while the clip was still loading: decode when it settles. */
  initPending: boolean;
}

export class Navigator {
  private readonly gc: GraphicsController;
  private readonly igDecoder = new IgSegmentDecoder();
  /** The IG overlay (main path only), sized by the composition's video descriptor; null before the first display set. */
  private plane: OverlayPlane | null = null;
  /** IG units not yet due, in stream order (an ICS follows the ODS/PDS segments of an earlier DTS in the same set). */
  private igQueue: IgUnit[] = [];
  /** st0.ig_pid > 0: set by _init_ig_stream, cleared when a playlist opens or closes. */
  private igReady = false;
  /** After a reset, display sets are ignored until one that carries a whole epoch (epoch start or acquisition point). */
  private igNeedsEpoch = true;
  /** st_ig: the sub-path IG clip preloaded at playlist open, dropped when the playlist closes. */
  private subIg: SubIgPreload | null = null;
  /** Failed sub-path preloads; added to the decoder's corrupt-segment count. */
  private subIgErrors = 0;
  /** The graphics processor's queue of preloaded units not yet decoded (gc->igp->queue). */
  private subIgQueue: IgUnit[] = [];
  private gcStatus: number = GcStatus.NONE;
  private drawsSincePaint = 0;
  private vm: HdmvVm | null = null;
  private titleType: TitleType = 'undef';
  private hdmvSuspended = true;
  private hdmvNumInvalidPl = 0;

  private playlist: Mpls | null = null;
  /** A playlist was requested or is playing, and has not been closed. */
  private playing = false;
  /** end_of_playlist: the last play item ended. */
  private ended = false;
  /** Bumped whenever a pending playPlaylist() result must be ignored. */
  private generation = 0;

  private titleUoMask: UoMask = EMPTY_UO_MASK;
  private st0UoMask: UoMask = EMPTY_UO_MASK;
  private gcUoMask: UoMask = EMPTY_UO_MASK;
  private uoMaskValue: UoMask = EMPTY_UO_MASK;

  private itemStill: { readonly item: number; readonly until: number | null } | null = null;
  private igStill = false;
  private held = false;
  private restorePlaylist = NO_PLAYLIST;
  private restoreItem = 0;
  /** A restored PSR8 that the next playlistStarted() must keep. */
  private keepTime: number | null = null;
  private currentItem = 0;
  /** NAV_CLIP start_pkt / end_pkt / title_pkt of the current playlist's play items. */
  private geometry: readonly ItemPackets[] = [];
  /** What the playlist being opened was asked to start at, for the seeks that follow its open. */
  private startAt: PlayAt | null = null;

  constructor(private readonly deps: NavigatorDeps) {
    deps.regs.onPsrEvent((e) => this.onPsrEvent(e));
    this.gc = new GraphicsController({ regs: deps.regs, onOverlay: (op) => this.onOverlay(op), nowScr: deps.nowScr });
  }

  /** The IG plane to composite over the video, or null before any menu was decoded. */
  get igPlane(): OverlayPlane | null {
    return this.plane;
  }

  /** Corrupt IG segments dropped so far. */
  get igErrors(): number {
    return this.igDecoder.errors + this.subIgErrors;
  }

  /** Draw operations applied since the last call: what the last repaint of the plane drew. */
  takeDrawCount(): number {
    const n = this.drawsSincePaint;
    this.drawsSincePaint = 0;
    return n;
  }

  /**
   * An IG graphics unit of the main path arrived. Dropped unless a playlist is open (units of a torn-down
   * session can still be in flight); decoded by tick() in arrival order once the clock reaches its DTS (PTS if none).
   */
  pushIg(unit: IgUnit): void {
    if (!this.playing) return;
    this.igQueue.push(unit);
  }

  /**
   * The presentation position moved (a seek). As _seek_internal, which only sends GC_CTRL_PG_RESET, this keeps the
   * graphics controller and the decoder's epoch: only queued units from the old read position and a half-received
   * display set are dropped.
   */
  seekGraphics(): void {
    this.igQueue = [];
    this.igDecoder.discardPartial();
  }

  get uoMask(): UoMask {
    return this.uoMaskValue;
  }

  /** hdmv_vm_running */
  get vmRunning(): boolean {
    return this.vm?.running() ?? false;
  }

  /** bd_play: First Play title. */
  start(): void {
    this.dropVm();
    this.titleType = 'undef';
    this.playTitleInternal(TITLE_FIRST_PLAY);
    this.runVm();
  }

  /** bd_play_title */
  playTitle(title: number): boolean {
    if (title === TITLE_TOP_MENU) return this.menuCall();
    // _try_play_title
    if (this.titleType === 'undef' && title !== TITLE_FIRST_PLAY) return false;
    if (this.uoMaskValue.has('titleSearch')) return false;
    const ok = this.playTitleInternal(title);
    this.runVm();
    return ok;
  }

  /** bd_menu_call (_try_menu_call) */
  menuCall(): boolean {
    this.updateTimePsr();
    if (this.titleType === 'undef') return false;
    if (this.uoMaskValue.has('menuCall')) return false;
    if (this.titleType === 'hdmv') this.vm?.suspendPlaylist(); // failure only means no location to store
    const ok = this.playTitleInternal(TITLE_TOP_MENU);
    this.runVm();
    return ok;
  }

  /**
   * The VM part of _read_ext, plus the play-item still timer of bd_read_skip_still. IG units whose PTS the playlist
   * clock (`clockUs`) has reached are decoded first (spec 3.3), as _read_ext decodes a block before it runs the VM.
   */
  tick(clockUs: number): void {
    this.decodeDueIg(clockUs);
    if (this.itemStill && this.itemStill.until !== null && this.deps.nowScr() >= this.itemStill.until) this.skipStill();
    this.runVm();
  }

  /**
   * _update_playlist_psrs and the clip-open part of _open_m2ts, once the player has opened the playlist. Then, as
   * _open_playlist and the bd_seek_* calls that follow it do: _find_next_playmark (the chapter PSR) after the first clip,
   * and again after each seek to the requested item, mark or restored time.
   */
  playlistStarted(playlistId: string, item: number): void {
    const at = this.startAt;
    this.startAt = null;
    this.playlist = this.deps.disc.playlists.get(playlistId) ?? null;
    this.geometry = this.playlist ? itemPackets(this.playlist.playItems, this.deps.disc.clips) : [];
    this.playing = true;
    this.ended = false;
    this.st0UoMask = EMPTY_UO_MASK;
    this.gcUoMask = EMPTY_UO_MASK;
    // _open_playlist opens the first clip, then bd_seek_playitem / bd_seek_mark moves on
    this.updatePlaylistPsrs(playlistId, 0);
    const restoredTime = this.keepTime;
    this.keepTime = null;
    this.openClip(0);
    this.startSubPathPreload(); // _preload_subpaths follows the first _open_m2ts
    this.updateChapterPsrAtPkt(0);
    if (at) this.emitSeek(at);
    if (item !== 0) this.openClip(item);
    if (at) this.seekChapterUpdates(at);
    if (restoredTime !== null) this.deps.regs.psrWrite(PSR.TIME, restoredTime); // after the last clip open can overwrite it
  }

  /** _open_m2ts for the next play item. */
  playItemChanged(item: number): void {
    this.itemStill = null;
    this.syncHold();
    this.openClip(item);
  }

  /**
   * _playmark_reached: the position passed one or more play marks (ENTRY or LINK) and is now at packet `clipPkt` of play
   * item `item`. Updates the chapter PSR (_update_chapter_psr) even when the chapter is unchanged.
   */
  markReached(item: number, clipPkt: number): void {
    this.updateChapterPsrAtPkt(this.titlePkt(item, clipPkt));
  }

  /**
   * A user seek (bd_seek, bd_seek_time, bd_seek_chapter) landed at `clipTime45` in play item `item`: _seek_internal's
   * _find_next_playmark updates the chapter PSR for the packet the EP map gives for that time (nav_clip_time_search).
   */
  seeked(item: number, clipTime45: number): void {
    const pkt = this.clipTimeSearch(item, clipTime45);
    if (pkt !== undefined) this.updateChapterPsrAtPkt(this.titlePkt(item, pkt));
  }

  /** The last play item ended (see playItemEnded). */
  playlistEnded(): void {
    if (this.playlist) this.playItemEnded(this.playlist.playItems.length - 1);
    else if (this.playing && !this.ended) this.finishPlaylist();
  }

  /**
   * A play item ran to its end. May be called at every item end: only a still (_bd_read_locked) or the end of the
   * playlist does anything, a seamless boundary is left to the player.
   */
  playItemEnded(item: number): void {
    if (!this.playing || this.ended || this.itemStill) return;
    const pi = this.playlist?.playItems[item];
    if (pi?.stillMode === STILL_INFINITE) {
      this.itemStill = { item, until: null };
      this.syncHold();
      return;
    }
    if (pi?.stillMode === STILL_TIME) {
      this.itemStill = { item, until: this.deps.nowScr() + pi.stillTime * SCR_HZ };
      this.syncHold();
      return;
    }
    if (this.isLastItem(item)) this.finishPlaylist();
  }

  isMasked(op: UoOp): boolean {
    return this.isUoMasked(op);
  }

  /** The disc closed or a raw playlist was picked: drop VM and program state. */
  stop(): void {
    this.generation++;
    this.dropVm();
    this.titleType = 'undef';
    this.titleUoMask = EMPTY_UO_MASK;
    this.closePlaylist(false);
  }

  // ---- titles ----

  private objectOf(title: number): IndexObject | undefined {
    const { index } = this.deps.disc;
    if (title === TITLE_FIRST_PLAY) return index.firstPlay;
    if (title === TITLE_TOP_MENU) return index.topMenu;
    return index.titles[title - 1]?.object;
  }

  /** disc_info.first_play_supported / top_menu_supported: a BD-J object is handed to the application. */
  private isSupported(object: IndexObject): boolean {
    return object.kind === 'bdj' || (object.kind === 'hdmv' && object.movieObjectId !== INDEX_ID_NONE);
  }

  /** _play_title */
  private playTitleInternal(title: number): boolean {
    const { index, movieObjects } = this.deps.disc;
    if (!movieObjects) return false;

    if (title === TITLE_FIRST_PLAY) {
      this.deps.regs.psrWrite(PSR.TITLE_NUMBER, TITLE_FIRST_PLAY); // 5.2.3.3
      if (!this.isSupported(index.firstPlay)) {
        this.titleType = 'hdmv'; // no first play title (5.2.3.3)
        this.deps.emit({ type: 'title', title });
        return true;
      }
      return this.playObject(index.firstPlay, title);
    }

    if (this.titleType === 'undef') return false; // bd_play() not called

    if (title === TITLE_TOP_MENU && !this.isSupported(index.topMenu)) {
      this.titleType = 'hdmv'; // no top menu (5.2.3.3)
      return false;
    }

    if (title <= index.titles.length) {
      const object = this.objectOf(title);
      if (!object) return false;
      this.deps.regs.psrWrite(PSR.TITLE_NUMBER, title); // 5.2.3.3
      return this.playObject(object, title);
    }
    return false; // title not found
  }

  private playObject(object: IndexObject, title: number): boolean {
    if (object.kind === 'bdj') return this.playBdj(title);
    if (object.kind === 'hdmv') {
      this.deps.emit({ type: 'title', title });
      return this.playHdmv(object.movieObjectId);
    }
    this.fail('Unsupported title object type');
    return false;
  }

  /** _play_bdj: BD-J is left to the application. */
  private playBdj(title: number): boolean {
    this.titleType = 'bdj';
    this.hdmvSuspended = true;
    this.deps.emit({ type: 'bdjTitle', title });
    return true;
  }

  /** _play_hdmv */
  private playHdmv(id: number): boolean {
    this.titleType = 'hdmv';
    if (!this.vm) {
      const { index, movieObjects } = this.deps.disc;
      this.vm = new HdmvVm(movieObjects!, this.deps.regs, {
        numTitles: index.titles.length,
        firstPlay: this.isSupported(index.firstPlay),
        topMenu: this.isSupported(index.topMenu),
        seed: this.deps.seed,
      });
    }
    const ok = this.vm.selectObject(id) === 0;
    this.hdmvSuspended = !this.vm.running();
    if (!ok) {
      this.titleType = 'undef';
      this.fail(`Cannot start movie object ${id}`);
    }
    return ok;
  }

  private fail(message: string): void {
    this.deps.emit({ type: 'error', message });
  }

  private dropVm(): void {
    this.vm = null;
    this.hdmvSuspended = true;
    this.hdmvNumInvalidPl = 0;
    this.restorePlaylist = NO_PLAYLIST;
  }

  // ---- VM ----

  /** The HDMV part of _read_ext. */
  private runVm(): void {
    let loops = 0;
    while (this.titleType === 'hdmv' && this.vm && !this.hdmvSuspended) {
      if (this.runHdmv() < 0) {
        this.titleType = 'undef';
        return;
      }
      if (loops++ > MAX_VM_LOOPS) {
        // libbluray only queues an error and keeps looping; here the VM stays stopped (spec 6)
        this.fail('HDMV program does not settle (possible live lock)');
        this.dropVm();
        this.titleType = 'undef';
        return;
      }
    }
    this.runGc('NOP');
  }

  /** _run_hdmv */
  private runHdmv(): number {
    const vm = this.vm!;
    let ev = vm.run();
    if (!ev) {
      this.fail('HDMV VM error');
      this.hdmvSuspended = !vm.running();
      return -1;
    }
    do {
      this.processHdmvVmEvent(ev);
    } while ((ev = vm.nextEvent()) !== null);
    this.hdmvSuspended = !vm.running();
    this.updateHdmvUoMask();
    return 0;
  }

  /** _process_hdmv_vm_event */
  private processHdmvVmEvent(ev: HdmvEvent): void {
    switch (ev.type) {
      case HdmvEventType.TITLE:
        this.closePlaylist(true);
        this.playTitleInternal(ev.param);
        break;

      case HdmvEventType.PLAY_PL:
      case HdmvEventType.PLAY_PL_PI:
      case HdmvEventType.PLAY_PL_PM: {
        const at = ev.type === HdmvEventType.PLAY_PL_PM ? { mark: ev.param2 } : ev.type === HdmvEventType.PLAY_PL_PI ? { item: ev.param2 } : {};
        this.openPlaylist(ev.param, at, (ok) => {
          if (!ok) {
            // Missing playlist: some discs probe for one, so resume the program (ignored after 10 in a row)
            this.hdmvNumInvalidPl++;
            if (this.hdmvNumInvalidPl < MAX_INVALID_PL && this.vm) {
              this.vm.resume();
              this.hdmvSuspended = !this.vm.running();
              this.runVm();
              return;
            }
          } else {
            this.hdmvNumInvalidPl = 0;
          }
          this.initIgStream();
          this.runGc('INIT_MENU');
        });
        break;
      }

      case HdmvEventType.PLAY_PI:
        this.emitSeek({ item: ev.param });
        this.deps.port.seekPlayItem(ev.param);
        this.seekChapterUpdates({ item: ev.param });
        break;

      case HdmvEventType.PLAY_PM:
        this.emitSeek({ mark: ev.param });
        this.deps.port.seekMark(ev.param);
        this.seekChapterUpdates({ mark: ev.param });
        break;

      case HdmvEventType.PLAY_STOP:
        this.closePlaylist(true);
        this.hdmvSuspended = !this.vm?.running();
        break;

      case HdmvEventType.STILL:
        this.igStill = ev.param !== 0; // BD_EVENT_STILL
        this.syncHold();
        break;

      case HdmvEventType.ENABLE_BUTTON: this.runGc('ENABLE_BUTTON'); break;
      case HdmvEventType.DISABLE_BUTTON: this.runGc('DISABLE_BUTTON'); break;
      case HdmvEventType.SET_BUTTON_PAGE: this.runGc('SET_BUTTON_PAGE'); break;
      case HdmvEventType.POPUP_OFF: this.runGc('POPUP'); break;
      case HdmvEventType.IG_END: this.runGc('IG_END'); break;
      default: break; // END, NONE
    }
  }

  private onOverlay(op: OverlayOp): void {
    if (!this.plane) this.plane = new OverlayPlane(DEFAULT_PLANE_WIDTH, DEFAULT_PLANE_HEIGHT);
    if (op.cmd === 'draw') this.drawsSincePaint++;
    this.plane.apply(op);
  }

  /** The plane follows the composition's video descriptor; a new one starts blank (and dirty, so the old picture goes). */
  private ensurePlane(ds: IgDisplaySet): void {
    const width = ds.composition?.videoWidth || DEFAULT_PLANE_WIDTH;
    const height = ds.composition?.videoHeight || DEFAULT_PLANE_HEIGHT;
    if (this.plane && this.plane.width === width && this.plane.height === height) return;
    this.plane = new OverlayPlane(width, height);
    this.plane.apply({ cmd: 'clear', pts: -1, x: 0, y: 0, w: 0, h: 0 });
  }

  /**
   * The decode half of _read_ext for the IG stream: gc_decode_ts, and INIT_MENU for every complete display set.
   * libbluray decodes into gc->igs in place, so while a display set is still arriving (ICS seen, END not yet)
   * gc_run answers -1 to everything but reset; here only complete sets are handed over, so input in that window
   * acts on the previous set (Task 13 may need to align).
   */
  private decodeDueIg(clockUs: number): void {
    if (!this.igReady || !this.playing) return;
    while (this.igQueue.length > 0 && (this.igQueue[0]!.dtsUs ?? this.igQueue[0]!.ptsUs) <= clockUs) {
      this.decodeIgUnit(this.igQueue.shift()!);
    }
  }

  /** gc_decode_ts for one graphics unit: INIT_MENU when it completes a display set. Returns true if a display set completed. */
  private decodeIgUnit(unit: IgUnit): boolean {
    const to90 = (us: number): number => Math.round((us * 90) / 1000);
    const ds = this.igDecoder.push(unit.data, to90(unit.ptsUs), unit.dtsUs === undefined ? null : to90(unit.dtsUs));
    if (!ds) return false;
    if (!ds.composition) return true;
    if (this.igNeedsEpoch) {
      if (!ds.epochStart && ds.composition.compositionState !== COMPOSITION_ACQUISITION_POINT) return true;
      this.igNeedsEpoch = false;
    }
    this.ensurePlane(ds);
    if (this.gc.decodeDisplaySet(ds)) this.runGc('INIT_MENU'); // initialize menus
    return true;
  }

  /** _run_gc */
  private runGc(msg: GcCtrl, param = 0): number {
    const gc = this.gc;
    const vm = this.vm;
    if (!vm) {
      if (this.gcStatus & GcStatus.MENU_OPEN) this.deps.emit({ type: 'menu', active: false });
      if (this.gcStatus & GcStatus.POPUP) this.deps.emit({ type: 'popup', available: false });
      this.gcStatus = GcStatus.NONE;
      return -1;
    }

    const { result, cmds } = gc.run(GC_CTRL[msg], param);
    if (cmds.navCmds && cmds.navCmds.length > 0) {
      vm.setObject(cmds.navCmds);
      this.hdmvSuspended = !vm.running();
    }
    if (cmds.status !== this.gcStatus) {
      const changed = cmds.status ^ this.gcStatus;
      this.gcStatus = cmds.status;
      if (changed & GcStatus.MENU_OPEN) this.deps.emit({ type: 'menu', active: !!(this.gcStatus & GcStatus.MENU_OPEN) });
      if (changed & GcStatus.POPUP) this.deps.emit({ type: 'popup', available: !!(this.gcStatus & GcStatus.POPUP) });
    }
    if (cmds.soundId >= 0 && cmds.soundId < 0xff) this.deps.emit({ type: 'sound', id: cmds.soundId });
    this.gcUoMask = cmds.pageUoMask;
    this.updateUoMask();
    return result;
  }

  /**
   * gc_run(GC_CTRL_RESET) as _close_playlist calls it: no _run_gc epilogue, so no menu event and the page UO mask stays
   * until the next _run_gc. _gc_reset also frees the graphics processors.
   */
  private resetGc(): void {
    this.igDecoder.reset();
    this.igQueue = [];
    this.subIgQueue = [];
    this.igNeedsEpoch = true;
    this.gc.run('reset');
  }

  /** _find_ig_stream: the IG entry PSR0 names in the current play item's STN. */
  private findIgEntry(): StreamEntry | undefined {
    const stn = this.playlist?.playItems[this.currentItem]?.stn;
    const stream = this.deps.regs.psrRead(PSR.IG_STREAM_ID);
    return stn && stream > 0 && stream <= stn.ig.length ? stn.ig[stream - 1] : undefined;
  }

  /**
   * _init_ig_stream. A main-path IG stream is decoded from the clip as the pipeline delivers it. A sub-path stream was
   * preloaded at playlist open: all of it is decoded now, in stream order and with no timing gate (gc_decode_ts with
   * stc -1), or as soon as the preload settles if it is still loading.
   */
  private initIgStream(): number {
    this.igReady = false;
    const entry = this.findIgEntry();
    if (!entry) return 0;
    if (!entry.subPath) {
      this.igReady = true;
      return 1;
    }
    const preload = this.preloadSubPathIg(entry);
    if (!preload || preload.failed) return 0;
    if (preload.units) this.decodePreloadedIg(preload.units);
    else preload.initPending = true;
    return 1;
  }

  /** _preload_ig_subpath at playlist open, for the IG stream PSR0 names in the first play item. */
  private startSubPathPreload(): void {
    this.dropSubIg();
    const entry = this.findIgEntry();
    if (entry?.subPath) this.preloadSubPathIg(entry);
  }

  /** Starts (or reuses) the preload of the sub-path clip `entry` is carried in; null if it names no usable clip. */
  private preloadSubPathIg(entry: StreamEntry): SubIgPreload | null {
    const load = this.deps.preloadSubPathIg;
    const clip = this.playlist?.subPaths[entry.subPathId]?.items[entry.subClipId]; // invalid subclip id: no preload
    if (!load || !clip) return null;
    const key = `${clip.clipId}:${entry.pid}`;
    if (this.subIg?.key === key) return this.subIg;
    this.dropSubIg();
    const preload: SubIgPreload = { key, clipId: clip.clipId, pid: entry.pid, abort: new AbortController(), units: null, failed: false, initPending: false };
    this.subIg = preload;
    const generation = this.generation;
    const settle = (): boolean => generation === this.generation && this.subIg === preload;
    let request: Promise<IgUnit[]>;
    try {
      request = load(clip.clipId, entry.pid, preload.abort.signal);
    } catch (err) {
      request = Promise.reject(err);
    }
    request.then(
      (units) => {
        if (!settle()) return;
        preload.units = units;
        if (!preload.initPending) return;
        preload.initPending = false;
        this.decodePreloadedIg(units);
        this.runGc('INIT_MENU');
      },
      () => {
        if (!settle()) return; // aborted or superseded
        this.subIgErrors++; // a failed preload means no menu, as _close_preload leaves no st_ig clip
        preload.failed = true;
        preload.initPending = false;
      },
    );
    return preload;
  }

  /**
   * gc_decode_ts(pid, buffer, ..., -1): the preloaded units join the graphics processor's queue and are decoded from its
   * head with no timing gate, but graphics_processor_decode_pes returns at the first complete display set. The rest stays
   * queued (until the playlist closes), where only a further init in the same playlist would reach it.
   */
  private decodePreloadedIg(units: readonly IgUnit[]): void {
    for (const unit of units) this.subIgQueue.push(unit);
    while (this.subIgQueue.length > 0) {
      if (this.decodeIgUnit(this.subIgQueue.shift()!)) return;
    }
  }

  private dropSubIg(): void {
    this.subIg?.abort.abort();
    this.subIg = null;
  }

  // ---- playlists ----

  /** _open_playlist; `done` is skipped when the playlist was superseded meanwhile. */
  private openPlaylist(num: number, at: PlayAt, done: (ok: boolean) => void): void {
    this.closePlaylist(false);
    this.igReady = false;
    const generation = ++this.generation;
    const id = String(num).padStart(5, '0');
    let request: Promise<boolean>;
    if (num > 99999) {
      request = Promise.resolve(false);
    } else {
      this.playlist = this.deps.disc.playlists.get(id) ?? null;
      this.playing = true;
      this.keepTime = at.clipTime45 ?? null;
      this.startAt = at;
      request = this.deps.port.playPlaylist(id, at);
    }
    request.then(
      (ok) => this.settleOpen(generation, ok, done),
      (err: unknown) => {
        if (generation === this.generation) this.fail(err instanceof Error ? err.message : String(err));
        this.settleOpen(generation, false, done);
      },
    );
  }

  private settleOpen(generation: number, ok: boolean, done: (ok: boolean) => void): void {
    if (generation !== this.generation) return;
    if (!ok) {
      this.playing = false;
      this.playlist = null;
    }
    done(ok);
  }

  /** _close_playlist; the port is only told to stop a playlist that has not ended. */
  private closePlaylist(stopPort: boolean): void {
    this.dropSubIg();
    this.resetGc();
    this.igReady = false;
    this.keepTime = null;
    this.startAt = null;
    this.generation++; // a pending playPlaylist() result no longer applies
    if (stopPort && this.playing && !this.ended) this.deps.port.stopPlaylist();
    this.playing = false;
    this.ended = false;
    this.playlist = null;
    this.itemStill = null;
    this.igStill = false;
    this.syncHold();
    this.st0UoMask = EMPTY_UO_MASK;
    this.gcUoMask = EMPTY_UO_MASK;
    this.updateUoMask();
  }

  /** End of title: resume the HDMV program that started the playlist. */
  private finishPlaylist(): void {
    this.ended = true;
    if (this.titleType === 'hdmv' && this.vm) {
      this.vm.resume();
      this.hdmvSuspended = !this.vm.running();
      this.runVm();
    }
  }

  /** bd_read_skip_still for a time still, then the usual end-of-item handling. */
  private skipStill(): void {
    const still = this.itemStill;
    this.itemStill = null;
    this.syncHold();
    if (still) this.afterItem(still.item);
  }

  private isLastItem(item: number): boolean {
    return !this.playlist || item >= this.playlist.playItems.length - 1;
  }

  /** After a still: bd_read_skip_still takes the next clip, or the end of title follows. */
  private afterItem(item: number): void {
    if (this.isLastItem(item)) this.finishPlaylist();
    else this.deps.port.seekPlayItem(item + 1);
  }

  private syncHold(): void {
    const want = this.itemStill !== null || this.igStill;
    if (want === this.held) return;
    this.held = want;
    this.deps.port.hold(want);
  }

  /** hdmv_vm RESUME restores PSR6 and PSR7: reopen the stored playlist at the stored play item. */
  private onPsrEvent(e: PsrEvent): void {
    if (e.type !== 'restore') return;
    switch (e.psr) {
      case PSR.TITLE_NUMBER:
        this.deps.emit({ type: 'title', title: e.newValue });
        break;
      case PSR.PLAYLIST:
        this.restorePlaylist = e.newValue;
        break;
      case PSR.PLAYITEM:
        this.restoreItem = e.newValue;
        break;
      case PSR.TIME: {
        const playlist = this.restorePlaylist;
        this.restorePlaylist = NO_PLAYLIST;
        if (playlist <= 99999) {
          this.openPlaylist(playlist, { item: this.restoreItem, clipTime45: e.newValue }, (ok) => {
            if (!ok) {
              this.fail(`Cannot restore playlist ${playlist}`);
              return;
            }
            this.initIgStream();
            this.runGc('INIT_MENU');
          });
        }
        break;
      }
      default: break;
    }
  }

  // ---- UO masks ----

  /** _update_time_psr: PSR8 follows the presentation position, within the play item's IN and OUT time. */
  private updateTimePsr(): void {
    const t = this.deps.port.currentClipTime45();
    const pi = this.playlist?.playItems[this.currentItem];
    if (t === undefined || !pi || t < pi.inTime || t > pi.outTime) return;
    this.deps.regs.psrWrite(PSR.TIME, t);
  }

  private openClip(item: number): void {
    const pl = this.playlist;
    const pi = pl?.playItems[item];
    this.currentItem = item;
    if (!pl || !pi) {
      this.updateUoMask();
      return;
    }
    this.st0UoMask = combineUoMasks(parseUoMaskTable(pl.uoMask), parseUoMaskTable(pi.uoMask));
    this.updateUoMask();
    this.updateClipPsrs(pl, item);
  }

  /** _update_uo_mask */
  private updateUoMask(): void {
    const next = combineUoMasks(this.gcUoMask, combineUoMasks(this.titleUoMask, this.st0UoMask));
    const changed = !sameMask(this.uoMaskValue, next);
    this.uoMaskValue = next;
    if (changed) this.deps.emit({ type: 'uoMask', mask: next });
  }

  /** _update_hdmv_uo_mask */
  private updateHdmvUoMask(): void {
    const mask = this.vm?.uoMask() ?? 0;
    const ops: UoOp[] = [];
    if (mask & HDMV_TITLE_SEARCH_MASK) ops.push('titleSearch');
    if (mask & HDMV_MENU_CALL_MASK) ops.push('menuCall');
    this.titleUoMask = new Set(ops);
    this.updateUoMask();
  }

  /** _is_uo_masked */
  private isUoMasked(op: UoOp): boolean {
    return this.titleType !== 'undef' && this.uoMaskValue.has(op);
  }

  // ---- PSRs ----

  /** _update_stream_psr_by_lang; returns the chosen stream's language. */
  private updateStreamPsrByLang(
    psrLang: number, psrStream: number, enableFlag: number, streams: readonly StreamEntry[], blacklist: number,
  ): number {
    const regs = this.deps.regs;
    const preferred = regs.psrRead(psrLang);
    let idx = streams.findIndex((s) => langToUint32(s.lang) === preferred);
    if (idx < 0) {
      idx = 0; // preferred language not found: first stream, no subtitles
      enableFlag = 0;
    }
    const lang = langToUint32(streams[idx]!.lang);
    if (blacklist && blacklist === lang) enableFlag = 0; // no subtitles in the audio language
    regs.psrWriteBits(psrStream, ((idx + 1) | enableFlag) >>> 0, 0x80000fff);
    return lang;
  }

  /** _update_playlist_psrs */
  private updatePlaylistPsrs(playlistId: string, item: number): void {
    const regs = this.deps.regs;
    regs.psrWrite(PSR.PLAYLIST, parseInt(playlistId, 10) || 0);
    regs.psrWrite(PSR.ANGLE_NUMBER, 1);
    regs.psrWrite(PSR.CHAPTER, 0xffff);

    const pi = this.playlist?.playItems[item];
    if (pi && this.titleType === 'undef') {
      // Without menus, pick audio and subtitles from the language settings
      regs.psrWrite(PSR.PLAYITEM, item);
      let audioLang = 0;
      if (pi.stn.audio.length > 0) {
        audioLang = this.updateStreamPsrByLang(PSR.AUDIO_LANG, PSR.PRIMARY_AUDIO_ID, 0, pi.stn.audio, 0);
      }
      if (pi.stn.pg.length > 0) {
        this.updateStreamPsrByLang(PSR.PG_AND_SUB_LANG, PSR.PG_STREAM, 0x80000000, pi.stn.pg, audioLang);
      }
    }
  }

  /** _update_clip_psrs */
  private updateClipPsrs(pl: Mpls, item: number): void {
    const regs = this.deps.regs;
    const pi = pl.playItems[item]!;
    const stn = pi.stn;
    let audioLang = 0;

    regs.psrWrite(PSR.PLAYITEM, item);
    regs.psrWrite(PSR.TIME, pi.inTime);

    if (stn.audio.length > 0) {
      const v = regs.psrRead(PSR.PRIMARY_AUDIO_ID);
      if (v === 0 || v > stn.audio.length) {
        audioLang = this.updateStreamPsrByLang(PSR.AUDIO_LANG, PSR.PRIMARY_AUDIO_ID, 0, stn.audio, 0);
      } else {
        audioLang = langToUint32(stn.audio[v - 1]!.lang);
      }
    }
    if (stn.pg.length > 0) {
      const v = regs.psrRead(PSR.PG_STREAM) & 0xfff;
      if (v === 0 || v > stn.pg.length) {
        this.updateStreamPsrByLang(PSR.PG_AND_SUB_LANG, PSR.PG_STREAM, 0x80000000, stn.pg, audioLang);
      }
    }
    if (stn.ig.length > 0 && this.titleType !== 'undef') {
      const v = regs.psrRead(PSR.IG_STREAM_ID);
      if (v === 0 || v > stn.ig.length) regs.psrWrite(PSR.IG_STREAM_ID, 1);
    }
  }

  // ---- chapter PSR ----

  /** The accepted bd_seek_mark / bd_seek_playitem request (before the clip is reopened). */
  private emitSeek(at: PlayAt): void {
    const pl = this.playlist;
    if (!pl) return;
    if (at.mark !== undefined) {
      if (pl.marks[at.mark]) this.deps.emit({ type: 'seek', what: 'mark', value: at.mark });
    } else if (at.item !== undefined && pl.playItems[at.item]) {
      this.deps.emit({ type: 'seek', what: 'item', value: at.item });
    }
  }

  /**
   * The _seek_internal tail (_find_next_playmark) of the bd_seek_playitem, bd_seek_mark and _clip_seek_time calls that
   * bd_seek_* / restore make; a seek that libbluray rejects (index out of range, time past the item) changes nothing.
   */
  private seekChapterUpdates(at: PlayAt): void {
    const pl = this.playlist;
    if (!pl) return;
    if (at.mark !== undefined) {
      const mark = pl.marks[at.mark];
      if (mark) this.updateChapterPsrAtPkt(this.markTitlePkt(mark));
      return;
    }
    const pi = at.item !== undefined ? pl.playItems[at.item] : undefined;
    if (at.item !== undefined && pi) this.updateChapterPsrAtPkt(this.geometry[at.item]?.titlePkt ?? 0); // out_pkt = clip->title_pkt
    if (at.clipTime45 !== undefined && at.item !== undefined && pi && at.clipTime45 < pi.outTime) {
      this.deps.emit({ type: 'seek', what: 'time', value: at.clipTime45 });
      const pkt = this.clipTimeSearch(at.item, at.clipTime45);
      if (pkt !== undefined) this.updateChapterPsrAtPkt(this.titlePkt(at.item, pkt));
    }
  }

  /** nav_clip_time_search: the clip packet for a clip time within the play item. */
  private clipTimeSearch(item: number, clipTime45: number): number | undefined {
    const pi = this.playlist?.playItems[item];
    const geo = this.geometry[item];
    if (!pi || !geo) return undefined;
    if (clipTime45 >= pi.outTime) return geo.endPkt;
    return Math.max(lookupSpn(this.deps.disc.clips?.get(pi.clipId), clipTime45, true), geo.startPkt);
  }

  /** s_pos in packets: title_pkt + clip_pkt - start_pkt. */
  private titlePkt(item: number, clipPkt: number): number {
    const geo = this.geometry[item];
    return geo ? geo.titlePkt + clipPkt - geo.startPkt : clipPkt;
  }

  /** _fill_mark: the mark's title_pkt. */
  private markTitlePkt(mark: Mpls['marks'][number]): number {
    const ref = mark.playItemRef >= this.geometry.length ? 0 : mark.playItemRef;
    const geo = this.geometry[ref];
    const pi = this.playlist?.playItems[ref];
    if (!geo || !pi) return 0;
    const clip = this.deps.disc.clips?.get(pi.clipId);
    const clipPkt = clip ? lookupSpn(clip, mark.time, true) : geo.startPkt;
    return geo.titlePkt + clipPkt - geo.startPkt;
  }

  /** nav_chapter_get_current over the ENTRY marks; 0-based. */
  private chapterAtPkt(titlePkt: number): number {
    const chapters = (this.playlist?.marks ?? []).filter((m) => m.type === MarkType.ENTRY).map((m) => this.markTitlePkt(m));
    for (let i = 0; i < chapters.length; i++) {
      if (chapters[i]! <= titlePkt) {
        if (i === chapters.length - 1) return i;
        if (chapters[i + 1]! > titlePkt) return i;
      }
    }
    return 0;
  }

  /** _update_chapter_psr at packet position `titlePkt`. */
  private updateChapterPsrAtPkt(titlePkt: number): void {
    const hasChapters = this.playlist?.marks.some((m) => m.type === MarkType.ENTRY) ?? false;
    if (!this.isInteractiveTitle() && hasChapters) this.deps.regs.psrWrite(PSR.CHAPTER, this.chapterAtPkt(titlePkt) + 1);
  }

  /** _is_interactive_title */
  private isInteractiveTitle(): boolean {
    if (this.titleType === 'undef') return false;
    const title = this.deps.regs.psrRead(PSR.TITLE_NUMBER);
    const object = title === TITLE_FIRST_PLAY || title <= this.deps.disc.index.titles.length ? this.objectOf(title) : undefined;
    return object !== undefined && object.kind !== 'unknown' && INDEX_PLAYBACK_INTERACTIVE.includes(object.playbackType);
  }
}
