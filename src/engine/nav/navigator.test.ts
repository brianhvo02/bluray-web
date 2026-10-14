import { describe, expect, it } from 'vitest';
import { buildIndex, buildMpls, type IndexObjectSpec, type MarkSpec, type PlayItemSpec } from '../../../tests/helpers/bdmv-builders';
import { asm, buildMovieObjects, imm } from '../../../tests/helpers/hdmv-builders';
import { parseIndex } from '../bdmv/index-parser';
import { parseMovieObjects } from '../bdmv/mobj-parser';
import { parseMpls, type Mpls } from '../bdmv/mpls-parser';
import type { DiscModel } from '../disc/open-disc';
import { PSR, RegisterFile } from '../hdmv/registers';
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
  const disc = { index, playlists, movieObjects: parseMovieObjects(buildMovieObjects(opts.objects)) } as unknown as DiscModel;
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
    nav.tick();
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(nav.vmRunning).toBe(false);
    const before = events.length;
    nav.tick();
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
    nav.tick();
    expect(port.calls).toEqual(['play 00000 - -', 'hold true']);
    clock.scr = 2 * 90000;
    nav.tick();
    expect(port.calls).toEqual(['play 00000 - -', 'hold true', 'hold false', 'play 00001 - -']);
  });

  it('holds an infinite still without resuming', () => {
    const { nav, port, clock } = stillDisc(2);
    nav.start();
    nav.playlistEnded();
    clock.scr = 1e9;
    nav.tick();
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
    nav.tick();
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
    const run = (playbackType: number): number => {
      const { nav, regs } = setup({
        objects: [{ cmds: [asm.playPl(imm(0))] }],
        firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType },
        playlists: { '00000': { items: [item()], marks } },
      });
      nav.start();
      nav.playlistStarted('00000', 0);
      nav.chapterChanged(1);
      return regs.psrRead(PSR.CHAPTER);
    };
    expect(run(0)).toBe(2);
    expect(run(1)).toBe(0xffff);
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
