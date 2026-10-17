/*
 * Original code for bluray-web: the playback state the engine publishes each tick for the BD-J worker's synchronous
 * natives (tellTimeN, getUOMaskN).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

const TIME45 = 0;
const UO_MASK = 1;
const BIGINT_WORDS = 2;
const PLAYLIST_OPEN = 0;
const INT_WORDS = 1;
const INT_OFFSET = BIGINT_WORDS * 8;

export function createStatusBlock(): SharedArrayBuffer {
  return new SharedArrayBuffer(INT_OFFSET + INT_WORDS * 4);
}

class StatusBlockViews {
  protected readonly longs: BigInt64Array;
  protected readonly ints: Int32Array;

  constructor(buffer: SharedArrayBuffer) {
    this.longs = new BigInt64Array(buffer, 0, BIGINT_WORDS);
    this.ints = new Int32Array(buffer, INT_OFFSET, INT_WORDS);
  }
}

export class StatusBlockWriter extends StatusBlockViews {
  /** bd_tell_time's out_time: the title time of the current packet, in 45 kHz ticks. */
  setTime45(t: bigint): void {
    Atomics.store(this.longs, TIME45, BigInt.asIntN(64, t));
  }

  /** bdpriv_get_uo_mask's bits. */
  setUoMask(bits: bigint): void {
    Atomics.store(this.longs, UO_MASK, BigInt.asIntN(64, bits));
  }

  setPlaylistOpen(open: boolean): void {
    Atomics.store(this.ints, PLAYLIST_OPEN, open ? 1 : 0);
  }
}

export class StatusBlockReader extends StatusBlockViews {
  time45(): bigint {
    return BigInt.asUintN(64, Atomics.load(this.longs, TIME45));
  }

  uoMask(): bigint {
    return BigInt.asUintN(64, Atomics.load(this.longs, UO_MASK));
  }

  playlistOpen(): boolean {
    return Atomics.load(this.ints, PLAYLIST_OPEN) !== 0;
  }
}
