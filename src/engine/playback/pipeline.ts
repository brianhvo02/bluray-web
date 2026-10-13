import { findEpAfter, findEpBefore, stcSpnRange, type Clpi } from '../bdmv/clpi-parser';
import { DiscError, type ByteSource } from '../disc/byte-source';
import { clipInfoPath, streamPath } from '../disc/open-disc';
import { M2tsReader, type DemuxStats } from '../demux/m2ts-reader';
import type { PlayItem } from '../bdmv/mpls-parser';
import type { Timeline } from '../nav/timeline';
import { audioEntryFor } from './stream-selection';

export interface PipelineUnit {
  readonly data: Uint8Array;
  /** Playlist time. */
  readonly ptsUs: number;
  /** False when the PTS lies outside the play item's in/out range. */
  readonly inRange: boolean;
}

export interface PipelineAudioUnit extends PipelineUnit {
  /** Coding type of the selected stream in this unit's play item. */
  readonly codingType: number;
  readonly streamIdExtension?: number;
}

export interface PipelineSinks {
  video(unit: PipelineUnit): void;
  audio(unit: PipelineAudioUnit): void;
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
  /** Same order as the timeline items; each has its own STN, so a stream's PID can change per item. */
  readonly playItems: readonly PlayItem[];
  /** 1-based audio stream number, or null for no audio. */
  readonly audioStream: number | null;
}

/** Reads a playlist's clips in order from a start time and feeds access units to the sinks. */
export class PlaybackPipeline {
  private generation = 0;
  private corruptPackets = 0;
  private continuityErrors = 0;
  /** Reader for the item being read; its counts join the totals when the item ends or a new read starts. */
  private current: M2tsReader | null = null;
  private audioStream: number | null;

  constructor(
    private readonly config: PipelineConfig,
    private readonly sinks: PipelineSinks,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.audioStream = config.audioStream;
  }

  /** Takes effect on the next start(). */
  setAudioStream(stream: number | null): void {
    this.audioStream = stream;
  }

  get stats(): DemuxStats {
    const live = this.current?.stats;
    return { corruptPackets: this.corruptPackets + (live?.corruptPackets ?? 0), continuityErrors: this.continuityErrors + (live?.continuityErrors ?? 0) };
  }

  private retire(reader: M2tsReader | null): void {
    if (!reader) return;
    this.corruptPackets += reader.stats.corruptPackets;
    this.continuityErrors += reader.stats.continuityErrors;
    if (this.current === reader) this.current = null;
  }

  start(fromUs: number): void {
    const gen = ++this.generation;
    this.run(gen, fromUs).catch((err: unknown) => {
      if (gen === this.generation) this.sinks.failed(err);
    });
  }

  stop(): void {
    this.generation++;
    this.current?.cancel(); // don't let a read nobody wants keep the disk (or network share) busy
  }

  private async run(gen: number, fromUs: number): Promise<void> {
    const { source, timeline, clips, videoPid, playItems } = this.config;
    const audioStream = this.audioStream;
    const startPos = timeline.locate(fromUs);

    for (let i = startPos.item.index; i < timeline.items.length; i++) {
      const item = timeline.items[i];
      if (item.outTime <= item.inTime) continue;
      const clip = clips.get(item.clipId);
      if (!clip) throw new DiscError('missing-file', `Missing clip info for ${item.clipId}`, [clipInfoPath(item.clipId)]);
      const audioEntry = audioEntryFor(playItems[i], audioStream);
      const pids = new Set([videoPid]);
      if (audioEntry) pids.add(audioEntry.pid);
      const ep = clip.epMaps.find((m) => m.pid === videoPid) ?? clip.epMaps[0];
      const target = i === startPos.item.index ? startPos.clipTime45 : item.inTime;
      // PTS can restart inside a clip; only this item's STC sequence is meaningful (libbluray clpi_lookup_spn).
      const range = stcSpnRange(clip, item.stcId);
      const rangeEnd = Number.isFinite(range.endSpn) ? range.endSpn : undefined;
      const startSpn = ep ? (findEpBefore(ep, target, range)?.spn ?? range.startSpn) : range.startSpn;
      const endSpn = ep ? (findEpAfter(ep, item.outTime, range)?.spn ?? rangeEnd) : rangeEnd;
      const reader = new M2tsReader({ source, path: streamPath(item.clipId), startSpn, endSpn, pids });
      this.current?.cancel();
      this.retire(this.current); // a stopped earlier read keeps its counts
      this.current = reader;

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
          if (pes.pid === videoPid) this.sinks.video({ data: pes.payload, ptsUs: us, inRange });
          else if (audioEntry && pes.pid === audioEntry.pid) {
            this.sinks.audio({ data: pes.payload, ptsUs: us, inRange, codingType: audioEntry.codingType, streamIdExtension: pes.streamIdExtension });
          }
        }
      }
      this.retire(reader);
    }
    if (gen === this.generation) this.sinks.ended();
  }
}
