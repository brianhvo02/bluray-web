import { MarkType, type PlayItem, type PlayListMark } from '../bdmv/mpls-parser';
import { pts90ToUs, ptsDelta90, ticks45ToUs, usToTicks45 } from '../util/time';

export interface TimelineItem {
  readonly index: number;
  readonly clipId: string;
  /** 45 kHz clip time. */
  readonly inTime: number;
  readonly outTime: number;
  /** 45 kHz playlist time at which this item starts. */
  readonly start: number;
  readonly connectionCondition: number;
}

export interface Chapter {
  readonly index: number;
  readonly startUs: number;
}

export interface ItemPosition {
  readonly item: TimelineItem;
  readonly clipTime45: number;
}

/** Maps between continuous playlist time and per-clip PTS (libbluray navigation.c time math). */
export class Timeline {
  readonly items: readonly TimelineItem[];
  readonly duration45: number;

  constructor(playItems: readonly PlayItem[]) {
    const items: TimelineItem[] = [];
    let start = 0;
    playItems.forEach((p, index) => {
      items.push({ index, clipId: p.clipId, inTime: p.inTime, outTime: p.outTime, start, connectionCondition: p.connectionCondition });
      start += Math.max(0, p.outTime - p.inTime);
    });
    this.items = items;
    this.duration45 = start;
  }

  get durationUs(): number {
    return ticks45ToUs(this.duration45);
  }

  itemStartUs(index: number): number {
    return ticks45ToUs(this.items[index].start);
  }

  locate(playlistUs: number): ItemPosition {
    if (this.items.length === 0) throw new Error('Timeline has no play items');
    const t = Math.min(Math.max(0, usToTicks45(playlistUs)), Math.max(0, this.duration45 - 1));
    let item = this.items[0];
    for (const candidate of this.items) {
      if (candidate.start > t) break;
      if (candidate.outTime > candidate.inTime) item = candidate;
    }
    return { item, clipTime45: item.inTime + (t - item.start) };
  }

  toPlaylistUs(itemIndex: number, pts90: number): { us: number; inRange: boolean } {
    const item = this.items[itemIndex];
    const delta90 = ptsDelta90(pts90, item.inTime * 2);
    const length90 = (item.outTime - item.inTime) * 2;
    return { us: ticks45ToUs(item.start) + pts90ToUs(delta90), inRange: delta90 >= 0 && delta90 < length90 };
  }

  chapters(marks: readonly PlayListMark[]): Chapter[] {
    const starts = marks
      .filter((m) => m.type === MarkType.ENTRY && m.playItemRef < this.items.length)
      .map((m) => {
        const item = this.items[m.playItemRef];
        return ticks45ToUs(item.start + Math.max(0, m.time - item.inTime));
      });
    return [...new Set(starts)].sort((a, b) => a - b).map((startUs, index) => ({ index, startUs }));
  }
}
