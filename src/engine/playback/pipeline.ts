import { findEpAfter, findEpBefore, type Clpi } from '../bdmv/clpi-parser';
import { DiscError, type ByteSource } from '../disc/byte-source';
import { clipInfoPath, streamPath } from '../disc/open-disc';
import { M2tsReader, type DemuxStats } from '../demux/m2ts-reader';
import type { Timeline } from '../nav/timeline';

export interface PipelineUnit {
  readonly data: Uint8Array;
  /** Playlist time. */
  readonly ptsUs: number;
  /** False when the PTS lies outside the play item's in/out range. */
  readonly inRange: boolean;
}

export interface PipelineSinks {
  video(unit: PipelineUnit): void;
  audio(unit: PipelineUnit): void;
  /** Backpressure: reading pauses while this returns true. */
  isFull(): boolean;
  ended(): void;
  failed(err: unknown): void;
}

export interface PipelineConfig {
  readonly source: ByteSource;
  readonly timeline: Timeline;
  readonly clips: ReadonlyMap<string, Clpi>;
  readonly videoPid: number;
  readonly audioPid: number | null;
}

/** Reads a playlist's clips in order from a start time and feeds access units to the sinks. */
export class PlaybackPipeline {
  private generation = 0;
  private corruptPackets = 0;
  private continuityErrors = 0;

  constructor(
    private readonly config: PipelineConfig,
    private readonly sinks: PipelineSinks,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  get stats(): DemuxStats {
    return { corruptPackets: this.corruptPackets, continuityErrors: this.continuityErrors };
  }

  start(fromUs: number): void {
    const gen = ++this.generation;
    this.run(gen, fromUs).catch((err: unknown) => {
      if (gen === this.generation) this.sinks.failed(err);
    });
  }

  stop(): void {
    this.generation++;
  }

  private async run(gen: number, fromUs: number): Promise<void> {
    const { source, timeline, clips, videoPid, audioPid } = this.config;
    const pids = new Set([videoPid]);
    if (audioPid !== null) pids.add(audioPid);
    const startPos = timeline.locate(fromUs);

    for (let i = startPos.item.index; i < timeline.items.length; i++) {
      const item = timeline.items[i];
      if (item.outTime <= item.inTime) continue;
      const clip = clips.get(item.clipId);
      if (!clip) throw new DiscError('missing-file', `Missing clip info for ${item.clipId}`, [clipInfoPath(item.clipId)]);
      const ep = clip.epMaps.find((m) => m.pid === videoPid) ?? clip.epMaps[0];
      const target = i === startPos.item.index ? startPos.clipTime45 : item.inTime;
      const startSpn = ep ? (findEpBefore(ep, target)?.spn ?? 0) : 0;
      const endSpn = ep ? findEpAfter(ep, item.outTime)?.spn : undefined;
      const reader = new M2tsReader({ source, path: streamPath(item.clipId), startSpn, endSpn, pids });

      for (;;) {
        while (this.sinks.isFull()) {
          await this.wait(5);
          if (gen !== this.generation) return;
        }
        if (gen !== this.generation) return;
        const batch = await reader.next();
        if (gen !== this.generation) return;
        if (batch === null) break;
        for (const pes of batch) {
          if (gen !== this.generation) return;
          if (pes.pts === undefined) continue;
          const { us, inRange } = timeline.toPlaylistUs(i, pes.pts);
          const unit: PipelineUnit = { data: pes.payload, ptsUs: us, inRange };
          if (pes.pid === videoPid) this.sinks.video(unit);
          else this.sinks.audio(unit);
        }
      }
      this.corruptPackets += reader.stats.corruptPackets;
      this.continuityErrors += reader.stats.continuityErrors;
    }
    if (gen === this.generation) this.sinks.ended();
  }
}
