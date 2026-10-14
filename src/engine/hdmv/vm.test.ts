import { describe, expect, it } from 'vitest';
import { asm, buildMovieObjects, imm, psr, reg } from '../../../tests/helpers/hdmv-builders';
import { parseMovieObjects } from '../bdmv/mobj-parser';
import { RegisterFile } from './registers';
import { HdmvEventType, HdmvVm, type HdmvEvent } from './vm';

function vm(objects: Array<{ cmds: Uint8Array[]; resumeIntention?: boolean; menuCallMask?: boolean; titleSearchMask?: boolean }>, opts = { numTitles: 3, firstPlay: true, topMenu: true, seed: 1 }) {
  const regs = new RegisterFile();
  const m = new HdmvVm(parseMovieObjects(buildMovieObjects(objects)), regs, opts);
  return { m, regs };
}
/** Runs until END/IG_END, an error, or `limit` events; returns the events. */
function runAll(m: HdmvVm, limit = 20): Array<HdmvEvent | null> {
  const out: Array<HdmvEvent | null> = [];
  for (let i = 0; i < limit; i++) {
    const ev = m.run();
    out.push(ev);
    if (ev === null || ev.type === HdmvEventType.END || ev.type === HdmvEventType.IG_END) break;
    for (let e = m.nextEvent(); e; e = m.nextEvent()) out.push(e);
    if (!m.running()) break;
  }
  return out;
}

describe('HdmvVm SET group', () => {
  it.each([
    ['move', 5, 7, 7], ['add', 0xfffffff0, 0x20, 0xffffffff], ['sub', 3, 5, 0], ['mul', 0x10000, 0x10000, 0xffffffff],
    ['div', 7, 0, 0xffffffff], ['mod', 7, 3, 1], ['and', 6, 3, 2], ['or', 4, 1, 5], ['xor', 6, 3, 5],
    ['bitset', 0, 4, 16], ['bitclr', 31, 0, 30], ['shl', 1, 31, 0x80000000], ['shr', 0x80000000, 32, 0],
  ] as const)('%s %d, %d = %d (libbluray saturation and edge rules)', (op, a, b, want) => {
    const { m, regs } = vm([{ cmds: [asm.set('move', reg(1), imm(a)), asm.set(op, reg(1), imm(b))] }]);
    m.selectObject(0);
    runAll(m);
    expect(regs.gprRead(1) >>> 0).toBe(want);
  });

  it('swaps two registers', () => {
    const { m, regs } = vm([{ cmds: [asm.set('move', reg(1), imm(1)), asm.set('move', reg(2), imm(2)), asm.set('swap', reg(1), reg(2))] }]);
    m.selectObject(0); runAll(m);
    expect([regs.gprRead(1), regs.gprRead(2)]).toEqual([2, 1]);
  });

  it('draws RND from the seeded LCG in 1..range', () => {
    const { m, regs } = vm([{ cmds: [asm.set('rnd', reg(1), imm(6)), asm.set('rnd', reg(2), imm(6))] }]);
    m.selectObject(0); runAll(m);
    // seed 1: rand = rand * 6364136223846793005 + 1 (mod 2^64); value = (rand >> 32) % 6 + 1
    const lcg = (s: bigint) => (s * 6364136223846793005n + 1n) & 0xffffffffffffffffn;
    const s1 = lcg(1n), s2 = lcg(s1);
    expect([regs.gprRead(1), regs.gprRead(2)]).toEqual([Number((s1 >> 32n) % 6n) + 1, Number((s2 >> 32n) % 6n) + 1]);
  });

  it('never stores to a PSR', () => {
    const { m, regs } = vm([{ cmds: [asm.set('move', psr(10), imm(3))] }]);
    m.selectObject(0); runAll(m);
    expect(regs.psrRead(10)).toBe(0xffff);
  });
});

describe('HdmvVm CMP and GOTO', () => {
  it('skips the next command when a compare is false', () => {
    const { m, regs } = vm([{ cmds: [
      asm.cmp('eq', imm(1), imm(2)), asm.set('move', reg(1), imm(9)),  // skipped
      asm.cmp('lt', imm(1), imm(2)), asm.set('move', reg(2), imm(9)),  // runs
      asm.cmp('bc', imm(0b0100), imm(0b0110)), asm.set('move', reg(3), imm(9)), // BC: skip if src & ~dst
    ] }]);
    m.selectObject(0); runAll(m);
    expect([regs.gprRead(1), regs.gprRead(2), regs.gprRead(3)]).toEqual([0, 9, 0]);
  });

  it('GOTO jumps and BREAK ends the object with END', () => {
    const { m, regs } = vm([{ cmds: [asm.goto(2), asm.set('move', reg(1), imm(1)), asm.set('move', reg(2), imm(2)), asm.break(), asm.set('move', reg(3), imm(3))] }]);
    m.selectObject(0);
    const evs = runAll(m);
    expect(evs.at(-1)?.type).toBe(HdmvEventType.END);
    expect([regs.gprRead(1), regs.gprRead(2), regs.gprRead(3)]).toEqual([0, 2, 0]);
  });

  it('stops an endless loop after MAX_LOOP steps with an error', () => {
    const { m } = vm([{ cmds: [asm.goto(0)] }]);
    m.selectObject(0);
    // select_object queues PLAY_STOP, which hdmv_vm_run returns before executing anything
    expect(m.run()?.type).toBe(HdmvEventType.PLAY_STOP);
    expect(m.run()).toBeNull();
    expect(m.running()).toBe(false);
  });
});
