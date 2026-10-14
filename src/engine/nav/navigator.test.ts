import { describe, expect, it } from 'vitest';
import { buildIndex, buildMpls, type IndexObjectSpec, type MarkSpec, type PlayItemSpec } from '../../../tests/helpers/bdmv-builders';
import { asm, buildMovieObjects, imm } from '../../../tests/helpers/hdmv-builders';
import { simpleMenuSegments } from '../../../tests/helpers/ig-builders';
import type { Clpi } from '../bdmv/clpi-parser';
import { parseIndex } from '../bdmv/index-parser';
import { parseMovieObjects } from '../bdmv/mobj-parser';
import { parseMpls, type Mpls } from '../bdmv/mpls-parser';
import type { DiscModel } from '../disc/open-disc';
import { PSR, RegisterFile } from '../hdmv/registers';
import { HdmvEventType } from '../hdmv/vm';
import { Navigator, type NavigatorEvent, type PlaybackPort, type PlayAt } from './navigator';

class FakePort implements PlaybackPort {
  calls: string[] = [];
  missing = new Set<string>();
  lastAt: PlayAt | null = null;
  clipTime: number | undefined;
  /** R8 contract: the port reports playlistStarted from inside playPlaylist. */
  onOpen: ((id: string, at: PlayAt) => void) | null = null;
  async playPlaylist(id: string, at: PlayAt) {
    this.calls.push(`play ${id} ${at.item ?? '-'} ${at.mark ?? '-'}`);
    this.lastAt = at;
    if (this.missing.has(id)) return false;
    this.onOpen?.(id, at);
    return true;
  }
  currentClipTime45() { return this.clipTime; }
  seekPlayItem(i: number) { this.calls.push(`item ${i}`); }
  seekMark(m: number) { this.calls.push(`mark ${m}`); }
  stopPlaylist() { this.calls.push('stop'); }
  hold(on: boolean) { this.calls.push(`hold ${on}`); }
}

interface ObjectSpec { cmds: Uint8Array[]; resumeIntention?: boolean; menuCallMask?: boolean; titleSearchMask?: boolean }
interface PlaylistSpec { items: PlayItemSpec[]; uoMask?: number[]; marks?: MarkSpec[] }

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const item = (extra: Partial<PlayItemSpec> = {}): PlayItemSpec => ({ clipId: '00001', inTime: 0, outTime: 90000, ...extra });
const idle: ObjectSpec = { cmds: [] };

/** A clip with an EP map entry every 45000 ticks from `inTime` (packet 6 + 100 per entry) and 100 packets after the last. */
function fakeClip(inTime: number, outTime: number): Clpi {
  const entries = [];
  for (let k = 0; inTime + k * 45000 <= outTime; k++) entries.push({ pts: inTime + k * 45000, spn: 6 + k * 100 });
  return { version: '0200', numSourcePackets: 6 + entries.length * 100, recordingRate: 0, atcSequences: [], programs: [], epMaps: [{ pid: 0x1011, epStreamType: 1, entries }] };
}

function setup(opts: {
  objects: ObjectSpec[];
  titles?: IndexObjectSpec[];
  firstPlay?: IndexObjectSpec;
  playlists?: Record<string, PlaylistSpec>;
}) {
  const index = parseIndex(buildIndex({
    firstPlay: opts.firstPlay ?? { kind: 'hdmv', movieObjectId: 0 },
    topMenu: { kind: 'hdmv', movieObjectId: 1 },
    titles: opts.titles ?? [{ kind: 'hdmv', movieObjectId: 2 }, { kind: 'hdmv', movieObjectId: 3 }],
  }));
  const playlists = new Map<string, Mpls>();
  for (const [id, p] of Object.entries(opts.playlists ?? { '00000': { items: [item()] }, '00001': { items: [item()] } })) {
    playlists.set(id, parseMpls(buildMpls({ playItems: p.items, uoMask: p.uoMask, marks: p.marks })));
  }
  const clips = new Map<string, Clpi>();
  for (const p of Object.values(opts.playlists ?? { a: { items: [item()] } })) {
    for (const i of p.items) {
      const old = clips.get(i.clipId);
      clips.set(i.clipId, fakeClip(Math.min(i.inTime, old?.epMaps[0]?.entries[0]?.pts ?? i.inTime), Math.max(i.outTime, old ? old.epMaps[0]!.entries.at(-1)!.pts : i.outTime)));
    }
  }
  const disc = { index, playlists, clips, movieObjects: parseMovieObjects(buildMovieObjects(opts.objects)) } as unknown as DiscModel;
  const port = new FakePort();
  const regs = new RegisterFile();
  const events: NavigatorEvent[] = [];
  const clock = { scr: 0 };
  const nav = new Navigator({ disc, regs, port, emit: (e) => events.push(e), nowScr: () => clock.scr, seed: 1 });
  return { nav, port, regs, events, clock };
}

describe('Navigator titles', () => {
  it('start() runs First Play and sets PSR4 to 0xffff', () => {
    const { nav, port, regs } = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }] });
    nav.start();
    expect(port.calls).toEqual(['play 00000 - -']);
    expect(regs.psrRead(PSR.TITLE_NUMBER)).toBe(0xffff);
  });

  it('jumps to a title and plays a playlist at a mark', () => {
    const { nav, port, regs, events } = setup({
      objects: [{ cmds: [asm.jumpTitle(imm(1))] }, idle, { cmds: [asm.playPlPm(imm(0), imm(1))] }, idle],
    });
    nav.start();
    expect(port.calls).toEqual(['play 00000 - 1']);
    expect(regs.psrRead(PSR.TITLE_NUMBER)).toBe(1);
    expect(events).toContainEqual({ type: 'title', title: 1 });
  });

  it('plays a playlist at a play item', () => {
    const { nav, port } = setup({ objects: [{ cmds: [asm.playPlPi(imm(1), imm(0))] }] });
    nav.start();
    expect(port.calls).toEqual(['play 00001 0 -']);
  });

  it('reports a BD-J title and does not run the VM', () => {
    const { nav, port, events, regs } = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }], firstPlay: { kind: 'bdj', name: '00000' } });
    nav.start();
    expect(events).toEqual([{ type: 'bdjTitle', title: 0xffff }]);
    expect(nav.vmRunning).toBe(false);
    expect(port.calls).toEqual([]);
    expect(regs.psrRead(PSR.TITLE_NUMBER)).toBe(0xffff);
  });

  it('reports an error when First Play points at a missing movie object', () => {
    const { nav, events } = setup({ objects: [idle], firstPlay: { kind: 'hdmv', movieObjectId: 9 } });
    nav.start();
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('playTitle() refuses before start() and plays titles afterwards', () => {
    const { nav, port } = setup({ objects: [idle, idle, { cmds: [asm.playPl(imm(1))] }, idle] });
    expect(nav.playTitle(1)).toBe(false);
    nav.start();
    expect(nav.playTitle(1)).toBe(true);
    expect(port.calls).toEqual(['play 00001 - -']);
    expect(nav.playTitle(7)).toBe(false);
  });

  it('refuses a title search when the playing object masks it', () => {
    const { nav, port } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))], titleSearchMask: true }, idle, { cmds: [asm.playPl(imm(1))] }, idle],
    });
    nav.start();
    expect(nav.isMasked('titleSearch')).toBe(true);
    expect(nav.playTitle(1)).toBe(false);
    expect(port.calls).toEqual(['play 00000 - -']);
  });
});

describe('Navigator playlists', () => {
  it('resumes the program at the end of the playlist', () => {
    const { nav, port } = setup({ objects: [{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }] });
    nav.start();
    nav.playlistEnded();
    expect(port.calls).toEqual(['play 00000 - -', 'play 00001 - -']);
  });

  it('resumes the program after a missing playlist', async () => {
    const { nav, port } = setup({ objects: [{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }] });
    port.missing = new Set(['00000']);
    nav.start();
    await flush();
    expect(port.calls).toEqual(['play 00000 - -', 'play 00001 - -']);
  });

  it('ignores the result of a playlist that was superseded', async () => {
    const { nav, port } = setup({ objects: [{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }] });
    port.missing = new Set(['00000']);
    nav.start();
    nav.stop();
    await flush();
    expect(port.calls).toEqual(['play 00000 - -']);
  });

  it('stops the VM and reports an error when a program never settles', () => {
    const { nav, port, events } = setup({ objects: [{ cmds: [asm.jumpTitle(imm(1))] }, idle, { cmds: [asm.jumpTitle(imm(1))] }, idle] });
    nav.start();
    nav.tick(0);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(nav.vmRunning).toBe(false);
    const before = events.length;
    nav.tick(0);
    expect(events).toHaveLength(before);
    expect(port.calls).toEqual([]);
  }, 2000);
});

describe('Navigator menu call', () => {
  const objects = (menuCallMask: boolean): ObjectSpec[] => [
    { cmds: [asm.playPl(imm(0))], menuCallMask },
    { cmds: [asm.playPl(imm(1))] },
    idle,
    idle,
  ];

  it('is refused when the playing object masks menu call', () => {
    const { nav, port } = setup({ objects: objects(true) });
    nav.start();
    expect(nav.isMasked('menuCall')).toBe(true);
    expect(nav.menuCall()).toBe(false);
    expect(port.calls).toEqual(['play 00000 - -']);
  });

  it('runs the top menu otherwise, stopping the playlist first', () => {
    const { nav, port, regs } = setup({ objects: objects(false) });
    nav.start();
    expect(nav.menuCall()).toBe(true);
    expect(port.calls).toEqual(['play 00000 - -', 'stop', 'play 00001 - -']);
    expect(regs.psrRead(PSR.TITLE_NUMBER)).toBe(0);
  });

  it('is refused before start()', () => {
    const { nav } = setup({ objects: objects(false) });
    expect(nav.menuCall()).toBe(false);
  });

  it('returns to the interrupted program with RESUME, reopening the stored playlist and play item', async () => {
    const { nav, port, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0)), asm.nop()], resumeIntention: true }, { cmds: [asm.resume()] }, idle, idle],
      playlists: { '00000': { items: [item(), item()] }, '00001': { items: [item()] } },
    });
    nav.start();
    nav.playlistStarted('00000', 1);
    expect(regs.psrRead(PSR.PLAYITEM)).toBe(1);
    nav.menuCall();
    await flush();
    expect(port.calls).toEqual(['play 00000 - -', 'stop', 'play 00000 1 -']);
  });
});

describe('Navigator play item stills', () => {
  const stillDisc = (stillMode: number) => setup({
    objects: [{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }],
    playlists: { '00000': { items: [item({ stillMode, stillTime: 2 })] }, '00001': { items: [item()] } },
  });

  it('holds for the still time, then resumes the program', () => {
    const { nav, port, clock } = stillDisc(1);
    nav.start();
    nav.playlistStarted('00000', 0);
    nav.playlistEnded();
    expect(port.calls).toEqual(['play 00000 - -', 'hold true']);
    clock.scr = 2 * 90000 - 1;
    nav.tick(0);
    expect(port.calls).toEqual(['play 00000 - -', 'hold true']);
    clock.scr = 2 * 90000;
    nav.tick(0);
    expect(port.calls).toEqual(['play 00000 - -', 'hold true', 'hold false', 'play 00001 - -']);
  });

  it('holds an infinite still without resuming', () => {
    const { nav, port, clock } = stillDisc(2);
    nav.start();
    nav.playlistEnded();
    clock.scr = 1e9;
    nav.tick(0);
    expect(port.calls).toEqual(['play 00000 - -', 'hold true']);
  });

  it('moves on to the next play item after a time still in the middle of a playlist', () => {
    const { nav, port, clock } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }],
      playlists: { '00000': { items: [item({ stillMode: 1, stillTime: 1 }), item()] } },
    });
    nav.start();
    nav.playItemEnded(0);
    clock.scr = 90000;
    nav.tick(0);
    expect(port.calls).toEqual(['play 00000 - -', 'hold true', 'hold false', 'item 1']);
  });

  it('releases the hold when the title changes', () => {
    const { nav, port } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }, idle, idle, idle],
      playlists: { '00000': { items: [item({ stillMode: 2 })] } },
    });
    nav.start();
    nav.playlistEnded();
    nav.playTitle(1);
    expect(port.calls).toEqual(['play 00000 - -', 'hold true', 'stop', 'hold false']);
  });
});

describe('Navigator UO masks and PSRs', () => {
  const timeSearch = [0x10, 0, 0, 0, 0, 0, 0, 0];
  const uoEvents = (events: NavigatorEvent[]) => events.filter((e) => e.type === 'uoMask');

  it('applies the playlist and play item masks once', () => {
    const { nav, events } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }],
      playlists: { '00000': { items: [item({ uoMask: [0, 0, 0, 0, 0, 0, 0x40, 0] })], uoMask: timeSearch } },
    });
    nav.start();
    nav.playlistStarted('00000', 0);
    expect(nav.isMasked('timeSearch')).toBe(true);
    expect(uoEvents(events)).toHaveLength(1);
    nav.playlistStarted('00000', 0);
    expect(uoEvents(events)).toHaveLength(1);
  });

  it('clears the playlist mask when the playlist closes', () => {
    const { nav, events } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }, idle, idle, idle],
      playlists: { '00000': { items: [item()], uoMask: timeSearch } },
    });
    nav.start();
    nav.playlistStarted('00000', 0);
    nav.playTitle(1);
    expect(nav.uoMask.has('timeSearch')).toBe(false);
    expect(uoEvents(events)).toHaveLength(2);
  });

  it('updates the playlist and clip PSRs and selects streams by language', () => {
    const { nav, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }],
      playlists: {
        '00000': {
          items: [item({
            inTime: 12345,
            audio: [{ pid: 0x1100, codingType: 0x80, lang: 'eng' }, { pid: 0x1101, codingType: 0x80, lang: 'jpn' }],
            pg: [{ pid: 0x1200, codingType: 0x90, lang: 'eng' }, { pid: 0x1201, codingType: 0x90, lang: 'jpn' }],
          })],
        },
      },
    });
    regs.psrSettingWrite(PSR.AUDIO_LANG, 0x6a706e); // jpn
    regs.psrSettingWrite(PSR.PG_AND_SUB_LANG, 0x656e67); // eng
    nav.start();
    nav.playlistStarted('00000', 0);
    expect(regs.psrRead(PSR.PLAYLIST)).toBe(0);
    expect(regs.psrRead(PSR.CHAPTER)).toBe(0xffff);
    expect(regs.psrRead(PSR.PLAYITEM)).toBe(0);
    expect(regs.psrRead(PSR.TIME)).toBe(12345);
    expect(regs.psrRead(PSR.PRIMARY_AUDIO_ID)).toBe(2);
    // preferred subtitle language eng exists and the audio is jpn, so subtitles are enabled
    expect(regs.psrRead(PSR.PG_STREAM)).toBe(0x8fff0001); // psr_write_bits keeps the bits outside 0x80000fff
  });

  it('writes the chapter PSR only for non-interactive titles', () => {
    const marks = [{ playItemRef: 0, time: 0 }, { playItemRef: 0, time: 45000 }];
    const run = (playbackType: number): number[] => {
      const { nav, regs } = setup({
        objects: [{ cmds: [asm.playPl(imm(0))] }],
        firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType },
        playlists: { '00000': { items: [item()], marks } },
      });
      const seen: number[] = [];
      regs.onWrite = (w) => { if (w.kind === 'psr' && w.index === PSR.CHAPTER) seen.push(w.value); };
      nav.start();
      nav.playlistStarted('00000', 0);
      nav.markReached(0, 120);
      return seen;
    };
    expect(run(0)).toEqual([0xffff, 1, 2]);
    expect(run(1)).toEqual([0xffff]);
  });

  it('follows libbluray for a start item: PSR5 after the first clip, again after the seek, and on every mark (LINK too)', () => {
    const marks = [
      { playItemRef: 0, time: 0 }, { playItemRef: 0, time: 45000, type: 2 },
      { playItemRef: 1, time: 0 }, { playItemRef: 1, time: 45000 },
    ];
    const { nav, regs, port } = setup({
      objects: [{ cmds: [asm.playPlPi(imm(0), imm(1)), asm.playPlPm(imm(0), imm(3))] }],
      firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType: 0 },
      playlists: { '00000': { items: [item(), item()], marks } },
    });
    const writes: string[] = [];
    regs.onWrite = (w) => { if (w.kind === 'psr' && (w.index === PSR.CHAPTER || w.index === PSR.PLAYITEM)) writes.push(`${w.index}=${w.value}`); };
    port.onOpen = (id, at) => nav.playlistStarted(id, at.mark !== undefined ? 1 : at.item ?? 0);
    nav.start();
    expect(writes).toEqual(['5=65535', '7=0', '5=1', '7=1', '5=2']);
    nav.markReached(1, 50); // a LINK mark would do the same: PSR5 is written even when unchanged
    nav.markReached(1, 51);
    expect(writes.slice(5)).toEqual(['5=2', '5=2']);
  });

  it('compares packets: a start item with a seamless connection begins before the first EP entry, so the chapter at its start mark is not reached', () => {
    const marks = [{ playItemRef: 0, time: 0 }, { playItemRef: 1, time: 0 }];
    const run = (connectionCondition: number): number => {
      const { nav, regs, port } = setup({
        objects: [{ cmds: [asm.playPlPi(imm(0), imm(1))] }],
        firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType: 0 },
        playlists: { '00000': { items: [item(), item({ connectionCondition })], marks } },
      });
      port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
      nav.start();
      return regs.psrRead(PSR.CHAPTER);
    };
    expect(run(5)).toBe(1); // start_pkt 0 < the mark's packet 6 (libbluray)
    expect(run(1)).toBe(2); // start_pkt = the EP entry at the item's IN time = the mark's packet
  });

  it('updates the chapter PSR after PLAY_PM and PLAY_PI within the playlist', async () => {
    // LINK_MK / LINK_PI only run in button objects (Task 12), so the VM events are injected
    const marks = [{ playItemRef: 0, time: 0 }, { playItemRef: 0, time: 45000 }, { playItemRef: 1, time: 0 }];
    const { nav, regs, port } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }],
      firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType: 0 },
      playlists: { '00000': { items: [item(), item()], marks } },
    });
    port.onOpen = (id) => nav.playlistStarted(id, 0);
    nav.start();
    await flush();
    const seen: number[] = [];
    regs.onWrite = (w) => { if (w.kind === 'psr' && w.index === PSR.CHAPTER) seen.push(w.value); };
    const inject = (type: HdmvEventType, param: number): void =>
      (nav as unknown as { processHdmvVmEvent(e: { type: HdmvEventType; param: number; param2: number }): void }).processHdmvVmEvent({ type, param, param2: 0 });
    inject(HdmvEventType.PLAY_PM, 1);
    inject(HdmvEventType.PLAY_PI, 1);
    inject(HdmvEventType.PLAY_PM, 9); // out of range: libbluray's bd_seek_mark fails without touching anything
    expect(port.calls.slice(1)).toEqual(['mark 1', 'item 1', 'mark 9']);
    expect(seen).toEqual([2, 3]);
  });
});

describe('Navigator review fixes', () => {
  it('keeps the presentation time across menu call and resume', () => {
    const { nav, port, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))], resumeIntention: true }, { cmds: [asm.resume()] }, idle, idle],
      playlists: { '00000': { items: [item({ inTime: 1000, outTime: 91000 })] } },
    });
    port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
    nav.start();
    expect(regs.psrRead(PSR.TIME)).toBe(1000);
    port.clipTime = 40000;
    nav.menuCall();
    expect(port.lastAt).toEqual({ item: 0, clipTime45: 40000 });
    expect(port.calls).toEqual(['play 00000 - -', 'stop', 'play 00000 0 -']);
    expect(regs.psrRead(PSR.TIME)).toBe(40000); // playlistStarted does not clobber the restored time
  });

  it('restores the time inside a later play item', () => {
    const { nav, port, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))], resumeIntention: true }, { cmds: [asm.resume()] }, idle, idle],
      playlists: { '00000': { items: [item({ inTime: 1000, outTime: 91000 }), item({ inTime: 5000, outTime: 95000 })] } },
    });
    port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
    nav.start();
    nav.playItemChanged(1);
    port.clipTime = 60000;
    nav.menuCall();
    expect(port.lastAt).toEqual({ item: 1, clipTime45: 60000 });
    expect(regs.psrRead(PSR.PLAYITEM)).toBe(1);
    expect(regs.psrRead(PSR.TIME)).toBe(60000);
  });

  it('does not store a position outside the play item', () => {
    const { nav, port, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))], resumeIntention: true }, { cmds: [asm.resume()] }, idle, idle],
      playlists: { '00000': { items: [item({ inTime: 1000, outTime: 91000 })] } },
    });
    port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
    nav.start();
    port.clipTime = 500;
    nav.menuCall();
    expect(port.lastAt?.clipTime45).toBe(1000);
    expect(regs.psrRead(PSR.TIME)).toBe(1000);
  });

  it('opens the first clip before moving to the requested play item', () => {
    const stream = (lang: string) => [{ pid: 0x1100, codingType: 0x80, lang }];
    const { nav, regs } = setup({
      objects: [{ cmds: [asm.playPlPi(imm(0), imm(1))] }],
      playlists: { '00000': { items: [item({ audio: stream('eng') }), item({ audio: [...stream('eng'), ...stream('jpn')] })] } },
    });
    const writes: string[] = [];
    regs.onWrite = (w) => { if (w.kind === 'psr') writes.push(`${w.index}=${w.value}`); };
    regs.psrSettingWrite(PSR.AUDIO_LANG, 0x6a706e); // jpn
    writes.length = 0;
    const port = (nav as unknown as { deps: { port: FakePort } }).deps.port;
    port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
    nav.start();
    const psr7 = writes.filter((w) => w.startsWith('7='));
    expect(psr7).toEqual(['7=0', '7=1']);
    // item 0 only has eng, so PSR1 = 1 there; item 1 keeps 1 (valid) as in _update_clip_psrs
    expect(regs.psrRead(PSR.PRIMARY_AUDIO_ID)).toBe(1);
    expect(writes.indexOf('1=1')).toBeGreaterThan(writes.indexOf('7=0'));
  });

  it('orders register writes and UO mask events as libbluray does', () => {
    const order: string[] = [];
    const { nav, port, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))], menuCallMask: true }],
      playlists: { '00000': { items: [item()], uoMask: [0x10, 0, 0, 0, 0, 0, 0, 0] } },
    });
    regs.onWrite = (w) => { if (w.kind === 'psr') order.push(`psr${w.index}`); };
    (nav as unknown as { deps: { emit: (e: NavigatorEvent) => void } }).deps.emit = (e) => { if (e.type === 'uoMask') order.push(`uo:${[...e.mask].sort().join('+')}`); };
    port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
    nav.start();
    // The first _run_hdmv pass returns the pending PLAY_STOP and publishes the object's menu-call mask;
    // PLAY_PL then opens the playlist: playlist PSRs, play item UO mask, clip PSRs.
    expect(order).toEqual(['psr4', 'uo:menuCall', 'psr6', 'psr3', 'psr5', 'uo:menuCall+timeSearch', 'psr7', 'psr8']);
  });

  it('does not seek at every seamless item boundary', () => {
    const { nav, port } = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }], playlists: { '00000': { items: [item(), item()] } } });
    nav.start();
    nav.playItemEnded(0);
    expect(port.calls).toEqual(['play 00000 - -']);
  });

  it('ignores a missing-playlist result after a title change', async () => {
    const { nav, port } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }, idle, { cmds: [asm.playPl(imm(1)), asm.playPl(imm(0))] }, idle],
    });
    port.missing = new Set(['00000']);
    nav.start();
    nav.playTitle(1);
    await flush();
    expect(port.calls).toEqual(['play 00000 - -', 'stop', 'play 00001 - -']);
  });
});

describe('Navigator interactive graphics', () => {
  const pushMenu = (nav: Navigator, ptsUs: number, opts: Parameters<typeof simpleMenuSegments>[0] = {}): void => {
    for (const data of simpleMenuSegments(opts)) nav.pushIg({ data, ptsUs });
  };
  const IG = { pid: 0x1400, codingType: 0x91 };
  async function menuSetup() {
    const t = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }], playlists: { '00000': { items: [item({ ig: [IG] })] } } });
    t.port.onOpen = (id, at) => t.nav.playlistStarted(id, at.item ?? 0);
    t.nav.start();
    await flush();
    return t;
  }
  const menuEvents = (events: NavigatorEvent[]) => events.filter((e) => e.type === 'menu');

  it('holds a display set back until the clock reaches its PTS', async () => {
    const { nav, events } = await menuSetup();
    pushMenu(nav, 5_000_000);
    nav.tick(4_999_999);
    expect(nav.igPlane).toBeNull();
    expect(menuEvents(events)).toEqual([]);
    nav.tick(5_000_000);
    expect(nav.igPlane).not.toBeNull();
    expect(menuEvents(events)).toEqual([{ type: 'menu', active: true }]);
    expect(nav.takeDrawCount()).toBeGreaterThan(0);
  });

  it('decodes units in PTS order whatever order they arrive in', async () => {
    const { nav, events } = await menuSetup();
    pushMenu(nav, 2_000_000, { compositionState: 'normal' });
    pushMenu(nav, 1_000_000);
    nav.tick(3_000_000);
    expect(menuEvents(events)).toEqual([{ type: 'menu', active: true }]);
  });

  it('after resetGraphics() waits for a new epoch start before drawing a menu again', async () => {
    const { nav, events, regs } = await menuSetup();
    pushMenu(nav, 0);
    nav.tick(0);
    expect(regs.psrRead(PSR.MENU_PAGE_ID)).toBe(0);
    expect(menuEvents(events)).toEqual([{ type: 'menu', active: true }]);
    const plane = nav.igPlane!;
    const hashOpen = plane.hash();

    pushMenu(nav, 9_000_000); // queued, not yet due
    nav.resetGraphics();
    expect(menuEvents(events).at(-1)).toEqual({ type: 'menu', active: false });
    expect(plane.hash()).not.toBe(hashOpen);
    const draws = nav.takeDrawCount();

    nav.tick(10_000_000); // the queued unit was dropped by the reset
    pushMenu(nav, 10_000_000, { compositionState: 'normal' });
    nav.tick(10_000_000);
    expect(menuEvents(events)).toHaveLength(2);
    expect(nav.takeDrawCount()).toBe(0);
    expect(draws).toBeGreaterThan(0);

    pushMenu(nav, 10_000_000);
    nav.tick(10_000_000);
    expect(menuEvents(events).at(-1)).toEqual({ type: 'menu', active: true });
    expect(plane.hash()).toBe(hashOpen);
  });

  it('resizes the plane to the composition video size', async () => {
    const { nav } = await menuSetup();
    pushMenu(nav, 0, { width: 1280, height: 720 });
    nav.tick(0);
    expect(nav.igPlane).toMatchObject({ width: 1280, height: 720 });
  });

  it('ignores IG units without an open playlist and when the playlist has no IG stream', async () => {
    const t = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }], playlists: { '00000': { items: [item()] } } });
    t.port.onOpen = (id, at) => t.nav.playlistStarted(id, at.item ?? 0);
    pushMenu(t.nav, 0); // nothing open yet
    t.nav.start();
    await flush();
    pushMenu(t.nav, 0);
    t.nav.tick(0);
    expect(t.nav.igPlane).toBeNull();
    expect(menuEvents(t.events)).toEqual([]);
  });

  it('clears the overlay and drops stale units when stopped', async () => {
    const { nav, events } = await menuSetup();
    pushMenu(nav, 0);
    nav.tick(0);
    const plane = nav.igPlane!;
    nav.stop();
    expect(menuEvents(events).at(-1)).toEqual({ type: 'menu', active: false });
    const cleared = plane.hash();
    pushMenu(nav, 0);
    nav.tick(0);
    expect(plane.hash()).toBe(cleared);
    expect(menuEvents(events)).toHaveLength(2);
  });
});
