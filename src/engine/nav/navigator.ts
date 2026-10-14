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
import { PSR, type PsrEvent, type RegisterFile } from '../hdmv/registers';
import { combineUoMasks, EMPTY_UO_MASK, parseUoMaskTable, type UoMask, type UoOp } from '../hdmv/uo-mask';
import { HdmvEventType, HdmvVm, type HdmvEvent } from '../hdmv/vm';

export interface PlaybackPort {
  /** false if the playlist is missing */
  playPlaylist(id: string, at: { readonly item?: number; readonly mark?: number }): Promise<boolean>;
  seekPlayItem(item: number): void;
  seekMark(mark: number): void;
  stopPlaylist(): void;
  /** still: freeze presentation (clock stops), keep the frame */
  hold(on: boolean): void;
}

export type NavigatorEvent =
  | { readonly type: 'uoMask'; readonly mask: UoMask }
  | { readonly type: 'menu'; readonly active: boolean }
  | { readonly type: 'popup'; readonly available: boolean }
  | { readonly type: 'sound'; readonly id: number }
  | { readonly type: 'title'; readonly title: number }
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
/** gc_ctrl_e values the graphics controller will handle (Task 12). */
type GcCtrl = 'INIT_MENU' | 'RESET' | 'ENABLE_BUTTON' | 'DISABLE_BUTTON' | 'SET_BUTTON_PAGE' | 'POPUP' | 'IG_END' | 'NOP';

/** str_to_uint32(s, 3) */
function langToUint32(lang: string): number {
  return (((lang.charCodeAt(0) || 0) << 16) | ((lang.charCodeAt(1) || 0) << 8) | (lang.charCodeAt(2) || 0)) >>> 0;
}

function sameMask(a: UoMask, b: UoMask): boolean {
  if (a.size !== b.size) return false;
  for (const op of a) if (!b.has(op)) return false;
  return true;
}

export class Navigator {
  /** Graphics controller: Task 12 fills _run_gc / _init_ig_stream. */
  private readonly gc: null = null;
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

  constructor(private readonly deps: NavigatorDeps) {
    deps.regs.onPsrEvent((e) => this.onPsrEvent(e));
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
    if (this.titleType === 'undef') return false;
    if (this.uoMaskValue.has('menuCall')) return false;
    if (this.titleType === 'hdmv') this.vm?.suspendPlaylist(); // failure only means no location to store
    const ok = this.playTitleInternal(TITLE_TOP_MENU);
    this.runVm();
    return ok;
  }

  /** The VM part of _read_ext, plus the play-item still timer of bd_read_skip_still. */
  tick(): void {
    if (this.itemStill && this.itemStill.until !== null && this.deps.nowScr() >= this.itemStill.until) this.skipStill();
    this.runVm();
  }

  /** _update_playlist_psrs and the clip-open part of _open_m2ts, once the player has opened the playlist. */
  playlistStarted(playlistId: string, item: number): void {
    this.playlist = this.deps.disc.playlists.get(playlistId) ?? null;
    this.playing = true;
    this.ended = false;
    this.st0UoMask = EMPTY_UO_MASK;
    this.gcUoMask = EMPTY_UO_MASK;
    this.updatePlaylistPsrs(playlistId, item);
    this.openClip(item);
  }

  /** _open_m2ts for the next play item. */
  playItemChanged(item: number): void {
    this.itemStill = null;
    this.syncHold();
    this.openClip(item);
  }

  /** _update_chapter_psr; `chapter` is bd_get_current_chapter (0-based). */
  chapterChanged(chapter: number): void {
    const hasChapters = this.playlist?.marks.some((m) => m.type === MarkType.ENTRY) ?? false;
    if (!this.isInteractiveTitle() && hasChapters) this.deps.regs.psrWrite(PSR.CHAPTER, chapter + 1);
  }

  /** The last play item ended (see playItemEnded). */
  playlistEnded(): void {
    if (this.playlist) this.playItemEnded(this.playlist.playItems.length - 1);
    else if (this.playing && !this.ended) this.finishPlaylist();
  }

  /** A play item ran to its end: honour its still mode (_bd_read_locked), else go on or end the playlist. */
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
    this.afterItem(item);
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
        this.deps.port.seekPlayItem(ev.param);
        break;

      case HdmvEventType.PLAY_PM:
        this.deps.port.seekMark(ev.param);
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

  /** _run_gc: no graphics controller yet. */
  private runGc(_msg: GcCtrl): void {
    if (this.gc === null) return;
  }

  /** _init_ig_stream: no graphics controller yet. */
  private initIgStream(): void {
    if (this.gc === null) return;
  }

  // ---- playlists ----

  /** _open_playlist; `done` is skipped when the playlist was superseded meanwhile. */
  private openPlaylist(num: number, at: { readonly item?: number; readonly mark?: number }, done: (ok: boolean) => void): void {
    this.closePlaylist(false);
    const generation = ++this.generation;
    const id = String(num).padStart(5, '0');
    let request: Promise<boolean>;
    if (num > 99999) {
      request = Promise.resolve(false);
    } else {
      this.playlist = this.deps.disc.playlists.get(id) ?? null;
      this.playing = true;
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
    this.runGc('RESET');
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

  private afterItem(item: number): void {
    const last = !this.playlist || item >= this.playlist.playItems.length - 1;
    if (last) this.finishPlaylist();
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
      case PSR.PLAYITEM: {
        const playlist = this.restorePlaylist;
        this.restorePlaylist = NO_PLAYLIST;
        if (playlist <= 99999) {
          this.openPlaylist(playlist, { item: e.newValue }, (ok) => {
            if (!ok) this.fail(`Cannot restore playlist ${playlist}`);
          });
        }
        break;
      }
      default: break;
    }
  }

  // ---- UO masks ----

  private openClip(item: number): void {
    const pl = this.playlist;
    const pi = pl?.playItems[item];
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

  /** _is_interactive_title */
  private isInteractiveTitle(): boolean {
    if (this.titleType === 'undef') return false;
    const title = this.deps.regs.psrRead(PSR.TITLE_NUMBER);
    const object = title === TITLE_FIRST_PLAY || title <= this.deps.disc.index.titles.length ? this.objectOf(title) : undefined;
    return object !== undefined && object.kind !== 'unknown' && INDEX_PLAYBACK_INTERACTIVE.includes(object.playbackType);
  }
}
