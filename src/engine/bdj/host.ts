/*
 * The player side of libbluray's BD-J natives. RecordingHost's checks and return values are ported from libbluray
 * src/libbluray/bluray.c (bdpriv_play_playlist_at, bdpriv_play_title_internal/_play_title, bdpriv_seek,
 * bdpriv_reg_read/bdpriv_reg_write, bdpriv_get_uo_mask, bdpriv_set_bdj_uo_mask, bdpriv_sound_effect,
 * bdpriv_set_virtual_package, bd_select_angle, bd_tell_time, _fill_disc_info, bd_get_playlist_info/_fill_title_info,
 * _copy_streams) and bdnav/navigation.c (nav_title_open, _extrapolate_title, _fill_mark, nav_clip_lookup_aspect).
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { Clpi } from '../bdmv/clpi-parser';
import type { IndexObject } from '../bdmv/index-parser';
import type { StreamEntry } from '../bdmv/mpls-parser';
import { applyDiscProfile } from '../disc/disc-profile';
import type { DiscModel } from '../disc/open-disc';
import { streamPath } from '../disc/open-disc';
import { RegisterFile } from '../hdmv/registers';
import { EMPTY_UO_MASK, combineUoMasks, parseUoMaskTable, uoMaskBits } from '../hdmv/uo-mask';
import type { UoMask, UoOp } from '../hdmv/uo-mask';

/** One entry of libbluray's title list (BLURAY_TITLE): index 0 is the top menu, then the titles, then First Play. */
export interface TitleInfo {
  readonly number: number;
  readonly objectType: 'hdmv' | 'bdj';
  /** _make_title_info's playback type: interactive + 2 × bdj. */
  readonly playbackType: number;
  readonly bdjoName: string | null;
  readonly hdmvObjectId: number | null;
}

/** BLURAY_STREAM_INFO. */
export interface StreamInfo {
  readonly codingType: number;
  readonly format: number;
  readonly rate: number;
  readonly charCode: number;
  readonly lang: string;
  readonly pid: number;
  readonly aspect: number;
  readonly subpathId: number;
}

/** BLURAY_TITLE_MARK, the fields BD-J reads. */
export interface PlaylistMark {
  readonly type: number;
  readonly playItem: number;
  readonly startTicks: bigint;
}

/** BLURAY_CLIP_INFO, the fields BD-J reads. */
export interface PlaylistClip {
  readonly clipId: string;
  readonly inTicks: bigint;
  readonly outTicks: bigint;
  readonly videoStreams: readonly StreamInfo[];
  readonly audioStreams: readonly StreamInfo[];
  readonly pgStreams: readonly StreamInfo[];
  readonly igStreams: readonly StreamInfo[];
  readonly secondaryAudioStreams: readonly StreamInfo[];
  readonly secondaryVideoStreams: readonly StreamInfo[];
}

/** BLURAY_TITLE_INFO from bd_get_playlist_info; times are 90 kHz ticks. */
export interface PlaylistInfo {
  readonly playlist: number;
  readonly durationTicks: bigint;
  readonly angleCount: number;
  readonly marks: readonly PlaylistMark[];
  readonly clips: readonly PlaylistClip[];
}

/** One native call as tools/bdj-trace/trace.patch prints it: Java longs as decimal strings. */
export interface TraceEntry {
  readonly call: string;
  readonly args: readonly (number | string | boolean | null)[];
  readonly ret: number | string | boolean | null;
}

/**
 * What libbluray's natives reach in the player. Each method takes the arguments of its `native` declaration in
 * Libbluray.java without the `long np` handle and returns the JNI type (int → number, long → bigint).
 */
export interface BdjHost {
  selectTitle(title: number): number;
  selectPlaylist(playlist: number, playitem: number, playmark: number, time: bigint): number;
  seek(playitem: number, playmark: number, time: bigint): bigint;
  /** The 1-based angle as Java passes it. */
  selectAngle(angle: number): number;
  selectRate(rate: number, reason: number): number;
  tellTime(): bigint;
  readReg(isPsr: number, num: number): number;
  writeReg(isPsr: number, num: number, value: number, psrValueMask: number): number;
  getUOMask(): bigint;
  setUOMask(menuCallMask: boolean, titleSearchMask: boolean): void;
  /** libbluray's converted key interest mask, as setKeyInterestN receives it. */
  setKeyInterest(mask: number): void;
  soundEffect(id: number): number;
  /** num_titles + 2 entries; null where libbluray's title pointer is NULL (an unsupported First Play). */
  getTitleInfos(): readonly (TitleInfo | null)[];
  getPlaylistInfo(playlist: number): PlaylistInfo | null;
  getAacsData(type: number): Uint8Array | null;
  setVirtualPackage(vpPath: string | null, psrBackup: boolean): number;
  updateGraphic(width: number, height: number, argb: Int32Array | null, x0: number, y0: number, x1: number, y1: number): void;
  log(file: string | null, line: number, msg: string, error: boolean): void;
  /** Natives served by the file system rather than the player (cacheBdRomFileN, listBdFilesN, getBdjoN) report here. */
  record?(e: TraceEntry): void;
}

const TITLE_FIRST_PLAY = 0xffff;
const TITLE_TOP_MENU = 0;
const PSR_TITLE_NUMBER = 4;
const HDMV_INTERACTIVE = 1;
const BDJ_INTERACTIVE = 3;
const MAX_SOUND_ID = 0xff;

type TitleType = 'undef' | 'hdmv' | 'bdj';

/** %.6g of a Java float, as trace.patch prints selectRateN's rate. */
const sixDigits = (v: number): number => Number(v.toPrecision(6));

/** _fill_disc_info's BLURAY_TITLE for an index object; a zeroed struct for objects of no known type. */
function titleOf(number: number, o: IndexObject): TitleInfo {
  if (o.kind === 'bdj') return { number, objectType: 'bdj', playbackType: (o.playbackType === BDJ_INTERACTIVE ? 1 : 0) + 2, bdjoName: o.name, hdmvObjectId: null };
  if (o.kind === 'hdmv' && o.movieObjectId !== 0xffff) {
    return { number, objectType: 'hdmv', playbackType: o.playbackType === HDMV_INTERACTIVE ? 1 : 0, bdjoName: null, hdmvObjectId: o.movieObjectId };
  }
  return { number, objectType: 'hdmv', playbackType: 0, bdjoName: null, hdmvObjectId: 0 };
}

/** _copy_streams: subpath_id follows the first entry's stream type, as libbluray reads `si->`. */
function copyStreams(entries: readonly StreamEntry[], clip: Clpi | undefined): StreamInfo[] {
  const first = entries[0];
  const subpathId = first && first.streamType >= 2 && first.streamType <= 4 ? first.subPathId : -1;
  return entries.map((s) => ({
    codingType: s.codingType,
    format: s.format,
    rate: s.rate,
    charCode: s.charCode,
    lang: s.lang,
    pid: s.pid,
    aspect: lookupAspect(clip, s.pid),
    subpathId,
  }));
}

/** nav_clip_lookup_aspect */
function lookupAspect(clip: Clpi | undefined, pid: number): number {
  for (const prog of clip?.programs ?? []) for (const ps of prog.streams) if (ps.pid === pid) return ps.aspect;
  return 0;
}

/**
 * The only host in milestone 5b: answers from the parsed disc and a real register file, plays nothing, and records
 * every call in trace.patch's format. Its state starts as bd_play leaves it, with First Play selected.
 */
export class RecordingHost implements BdjHost {
  readonly registers = new RegisterFile();
  updateGraphicCount = 0;
  private readonly entries: TraceEntry[] = [];
  private titleType: TitleType;
  private playlist: number | null = null;
  private titleUo: UoMask = EMPTY_UO_MASK;
  private playlistUo: UoMask = EMPTY_UO_MASK;

  constructor(
    private readonly disc: DiscModel,
    private readonly clips: ReadonlyMap<string, Clpi>,
    private readonly opts: { readonly startTitle: (title: number) => void; readonly onTrace?: (e: TraceEntry) => void },
  ) {
    applyDiscProfile(this.registers, disc.index);
    const fp = this.firstPlay();
    this.titleType = 'hdmv';
    if (fp?.objectType === 'bdj') this.titleType = 'bdj';
    else if (fp) this.playHdmv(fp.hdmvObjectId ?? 0);
  }

  get trace(): readonly TraceEntry[] {
    return this.entries;
  }

  record(e: TraceEntry): void {
    this.entries.push(e);
    this.opts.onTrace?.(e);
  }

  private traced<T extends number | bigint>(call: string, args: TraceEntry['args'], ret: T): T {
    this.record({ call, args, ret: typeof ret === 'bigint' ? ret.toString() : ret });
    return ret;
  }

  /** disc_info.first_play: present when First Play is a BD-J object or an HDMV object other than 0xffff. */
  private firstPlay(): TitleInfo | null {
    const fp = this.disc.index.firstPlay;
    return fp.kind === 'bdj' || (fp.kind === 'hdmv' && fp.movieObjectId !== 0xffff) ? titleOf(TITLE_FIRST_PLAY, fp) : null;
  }

  private titleList(): (TitleInfo | null)[] {
    const index = this.disc.index;
    return [titleOf(0, index.topMenu), ...index.titles.map((t, i) => titleOf(i + 1, t.object)), this.firstPlay()];
  }

  getTitleInfos(): readonly (TitleInfo | null)[] {
    const list = this.titleList();
    this.record({ call: 'getTitleInfosN', args: [], ret: list.length });
    return list;
  }

  getPlaylistInfo(playlist: number): PlaylistInfo | null {
    const info = this.playlistInfo(playlist);
    this.record({ call: 'getPlaylistInfoN', args: [playlist], ret: info ? info.playlist : null });
    return info;
  }

  /** _get_mpls_info and _fill_title_info for angle 0. */
  private playlistInfo(playlist: number): PlaylistInfo | null {
    if (playlist < 0 || playlist > 99999) return null;
    const mpls = this.disc.playlists.get(String(playlist).padStart(5, '0'));
    if (!mpls) return null;
    const items = mpls.playItems;
    const titleTimes: number[] = [];
    let duration = 0;
    let angleCount = 0;
    for (const pi of items) {
      angleCount = Math.max(angleCount, pi.angleCount);
      titleTimes.push(duration);
      duration = (duration + ((pi.outTime - pi.inTime) >>> 0)) >>> 0;
    }
    const marks = mpls.marks.map((m) => {
      const ref = m.playItemRef < items.length ? m.playItemRef : 0;
      const pi = items[m.playItemRef];
      const titleTime = pi ? (titleTimes[m.playItemRef]! + m.time - pi.inTime) >>> 0 : 0;
      return { type: m.type, playItem: ref, startTicks: BigInt(titleTime) * 2n };
    });
    const clips = items.map((pi) => {
      const clpi = this.clips.get(pi.clipId);
      return {
        clipId: pi.clipId,
        inTicks: BigInt(pi.inTime) * 2n,
        outTicks: BigInt(pi.outTime) * 2n,
        videoStreams: copyStreams(pi.stn.video, clpi),
        audioStreams: copyStreams(pi.stn.audio, clpi),
        pgStreams: copyStreams([...pi.stn.pg, ...pi.stn.pipPg], clpi),
        igStreams: copyStreams(pi.stn.ig, clpi),
        secondaryAudioStreams: copyStreams(pi.stn.secondaryAudio, clpi),
        secondaryVideoStreams: copyStreams(pi.stn.secondaryVideo, clpi),
      };
    });
    return { playlist, durationTicks: BigInt(duration) * 2n, angleCount, marks, clips };
  }

  /** _play_title, without playback: a BD-J title starts once the native has returned, as bdj_process_event(START) does. */
  selectTitle(title: number): number {
    return this.traced('selectTitleN', [title | 0], this.playTitle(title >>> 0));
  }

  private playTitle(title: number): number {
    const index = this.disc.index;
    if (title === TITLE_FIRST_PLAY) {
      this.registers.psrWrite(PSR_TITLE_NUMBER, TITLE_FIRST_PLAY);
      const fp = this.firstPlay();
      if (!fp) {
        this.titleType = 'hdmv';
        return 1;
      }
      return fp.objectType === 'bdj' ? this.playBdj(title) : this.playHdmv(fp.hdmvObjectId ?? 0);
    }
    if (this.titleType === 'undef') return 0;
    const top = index.topMenu;
    if (title === TITLE_TOP_MENU && !(top.kind === 'bdj' || (top.kind === 'hdmv' && top.movieObjectId !== 0xffff))) {
      this.titleType = 'hdmv';
      return 0;
    }
    if (title > index.titles.length) return 0;
    this.registers.psrWrite(PSR_TITLE_NUMBER, title);
    const t = titleOf(title, title === TITLE_TOP_MENU ? top : index.titles[title - 1]!.object);
    return t.objectType === 'bdj' ? this.playBdj(title) : this.playHdmv(t.hdmvObjectId ?? 0);
  }

  private playBdj(title: number): number {
    this.titleType = 'bdj';
    queueMicrotask(() => this.opts.startTitle(title));
    return 1;
  }

  /** _play_hdmv: hdmv_vm_select_object fails without MovieObject.bdmv or for an object it does not have. */
  private playHdmv(idRef: number): number {
    const objects = this.disc.movieObjects?.objects;
    if (!objects || idRef >= objects.length) {
      this.titleType = 'undef';
      return 0;
    }
    this.titleType = 'hdmv';
    return 1;
  }

  /** _play_playlist_at and _open_playlist's checks: the playlist and its first clip's stream must exist. */
  selectPlaylist(playlist: number, playitem: number, playmark: number, time: bigint): number {
    let r = 1;
    if (playlist < 0) this.closePlaylist();
    else {
      this.closePlaylist();
      const id = String(playlist).padStart(5, '0');
      const mpls = playlist <= 99999 ? this.disc.playlists.get(id) : undefined;
      const first = mpls?.playItems[0];
      const summary = this.disc.summaries.find((s) => s.id === id);
      if (!mpls || !first || summary?.missingPaths.includes(streamPath(first.clipId))) r = 0;
      else {
        this.playlist = playlist;
        this.playlistUo = combineUoMasks(parseUoMaskTable(mpls.uoMask), parseUoMaskTable(first.uoMask));
      }
    }
    return this.traced('selectPlaylistN', [playlist, playitem, playmark, time.toString()], r);
  }

  private closePlaylist(): void {
    this.playlist = null;
    this.playlistUo = EMPTY_UO_MASK;
  }

  /** bdpriv_seek always reports success. */
  seek(playitem: number, playmark: number, time: bigint): bigint {
    return this.traced('seekN', [playitem, playmark, time.toString()], 1n);
  }

  /** bd_select_angle(angle - 1): fails while no playlist is open. */
  selectAngle(angle: number): number {
    return this.traced('selectAngleN', [angle], this.playlist === null ? 0 : 1);
  }

  selectRate(rate: number, reason: number): number {
    return this.traced('selectRateN', [sixDigits(rate), reason], 1);
  }

  tellTime(): bigint {
    return this.traced('tellTimeN', [], 0n);
  }

  /** bdpriv_reg_read, as the signed int Java receives. */
  readReg(isPsr: number, num: number): number {
    const v = isPsr ? this.registers.psrRead(num) : this.registers.gprRead(num);
    return this.traced('readRegN', [isPsr, num], v | 0);
  }

  /** bdpriv_reg_write: bd_psr_write_bits for PSRs, bd_gpr_write for GPRs. */
  writeReg(isPsr: number, num: number, value: number, psrValueMask: number): number {
    const r = isPsr ? this.registers.psrWriteBits(num, value >>> 0, psrValueMask >>> 0) : this.registers.gprWrite(num, value >>> 0);
    return this.traced('writeRegN', [isPsr | 0, num | 0, value | 0, psrValueMask | 0], r);
  }

  /** bdpriv_get_uo_mask: the title's BD-J mask combined with the playing playlist's. */
  getUOMask(): bigint {
    return this.traced('getUOMaskN', [], uoMaskBits(combineUoMasks(this.titleUo, this.playlistUo)));
  }

  setUOMask(menuCallMask: boolean, titleSearchMask: boolean): void {
    const ops: UoOp[] = [];
    if (menuCallMask) ops.push('menuCall');
    if (titleSearchMask) ops.push('titleSearch');
    this.titleUo = new Set(ops);
    this.record({ call: 'setUOMaskN', args: [menuCallMask, titleSearchMask], ret: null });
  }

  setKeyInterest(mask: number): void {
    this.record({ call: 'setKeyInterestN', args: [mask], ret: null });
  }

  /** bdpriv_sound_effect */
  soundEffect(id: number): number {
    const sounds = this.disc.sounds;
    const ok = !(sounds && id >= sounds.clips.length) && id >= 0 && id <= MAX_SOUND_ID;
    return this.traced('soundEffectN', [id], ok ? 0 : -1);
  }

  /** Decrypted discs have no AACS data. */
  getAacsData(type: number): Uint8Array | null {
    this.record({ call: 'getAacsDataN', args: [type], ret: null });
    return null;
  }

  /** _bd_set_virtual_package */
  setVirtualPackage(vpPath: string | null, psrBackup: boolean): number {
    let r = -1;
    if (this.playlist === null && this.titleType === 'bdj') {
      if (psrBackup) this.registers.resetBackupRegisters();
      r = 0;
    }
    return this.traced('setVirtualPackageN', [vpPath, psrBackup], r);
  }

  updateGraphic(width: number, height: number, argb: Int32Array | null, x0: number, y0: number, x1: number, y1: number): void {
    this.updateGraphicCount++;
    this.record({ call: 'updateGraphicN', args: [width, height, x0, y0, x1, y1, argb === null], ret: null });
  }

  log(file: string | null, line: number, msg: string, _error: boolean): void {
    this.record({ call: 'logN', args: [file, line, msg], ret: null });
  }
}
