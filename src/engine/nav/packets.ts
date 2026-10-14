/*
 * Derived from libbluray navigation code (src/libbluray/bdnav/navigation.c: _fill_clip, _fill_mark; clpi_parse.c: clpi_lookup_spn)
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2012  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { Clpi } from '../bdmv/clpi-parser';
import type { PlayItem } from '../bdmv/mpls-parser';

/**
 * clpi_lookup_spn without the STC refinement: `before` gives the packet of the last EP map entry at or before the time
 * (0 if there is none), otherwise the first entry after it (the packet count past the last entry).
 */
export function lookupSpn(clip: Clpi | undefined, time45: number, before: boolean): number {
  const entries = clip?.epMaps[0]?.entries ?? [];
  if (!clip || entries.length === 0) return before ? 0 : (clip?.numSourcePackets ?? 0);
  if (before) {
    let spn = 0;
    for (const e of entries) if (e.pts <= time45) spn = e.spn;
    return spn;
  }
  for (const e of entries) if (e.pts > time45) return e.spn;
  return clip.numSourcePackets;
}

/** NAV_CLIP's packet geometry of one play item. */
export interface ItemPackets {
  /** start_pkt */
  readonly startPkt: number;
  /** end_pkt */
  readonly endPkt: number;
  /** title_pkt: packets in the playlist before this item */
  readonly titlePkt: number;
}

/** _fill_clip: start_pkt is 0 for the first item and for seamless connections (condition 5 and 6). */
export function itemPackets(playItems: readonly PlayItem[], clips: ReadonlyMap<string, Clpi> | undefined): ItemPackets[] {
  const out: ItemPackets[] = [];
  let pos = 0;
  playItems.forEach((pi, ref) => {
    const clip = clips?.get(pi.clipId);
    let startPkt = 0;
    let endPkt = 0;
    if (clip) {
      startPkt = pi.connectionCondition === 5 || pi.connectionCondition === 6 || ref === 0 ? 0 : lookupSpn(clip, pi.inTime, true);
      endPkt = lookupSpn(clip, pi.outTime, false);
    }
    out.push({ startPkt, endPkt, titlePkt: pos });
    pos += endPkt - startPkt;
  });
  return out;
}
