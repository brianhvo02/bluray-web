import { findEpAfter, findEpBefore, stcSpnRange, type Clpi, type EpEntry } from '../bdmv/clpi-parser';
import { TS_PACKET_SIZE } from '../demux/constants';
import { DiscError, type ByteSource } from '../disc/byte-source';
import { clipInfoPath, streamPath } from '../disc/open-disc';
import { M2tsReader, type DemuxStats } from '../demux/m2ts-reader';
import type { PlayItem } from '../bdmv/mpls-parser';
import type { Timeline } from '../nav/timeline';
import { audioEntryFor, igEntryFor } from './stream-selection';

export interface PipelineUnit {
  readonly data: Uint8Array;
  /** Playlist time. */
  readonly ptsUs: number;
  /** Playlist time of the decode timestamp, when the PES has one. */
  readonly dtsUs?: number;
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
  /** Graphics units of the selected IG stream (main path); without this sink no IG PID is read. */
  ig?(unit: PipelineUnit): void;
  /** Units of the PG PID set with setPgStream (main path); without this sink no PG PID is read. */
  pg?(unit: PipelineUnit): void;
  /**
   * A play item is about to be read, from `startUs` (playlist time: its start, or the seek target). Called before its
   * PIDs are chosen, so a setPgStream made here applies to this item.
   */
  itemStarted?(index: number, startUs: number): void;
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
  /** False when nothing decodes the video: its PID is dropped by the demuxer (its EP map still places reads). */
  readonly readVideo?: boolean;
  /** Same order as the timeline items; each has its own STN, so a stream's PID can change per item. */
  readonly playItems: readonly PlayItem[];
  /** 1-based audio stream number, or null for no audio. */
  readonly audioStream: number | null;
  /** 1-based IG stream number (PSR0), or null/absent for no IG. */
  readonly igStream?: number | null;
}

/** Reads a playlist's clips in order from a start time and feeds access units to the sinks. */
export class PlaybackPipeline {
  private generation = 0;
  private corruptPackets = 0;
  private continuityErrors = 0;
  /** Reader for the item being read; its counts join the totals when the item ends or a new read starts. */
  private current: M2tsReader | null = null;
  /** The stream file `current` reads and its clip's TS_recording_rate. */
  private currentClip: { readonly path: string; readonly recordingRate: number } | null = null;
  /** How `current` maps a source packet to playlist time (readUs). */
  private currentPlace: { readonly item: number; readonly entries: readonly EpEntry[]; readonly startSpn: number; readonly startUs: number; readonly recordingRate: number } | null = null;
  private audioStream: number | null;
  private igStream: number | null;
  private pgPid: number | null = null;

  constructor(
    private readonly config: PipelineConfig,
    private readonly sinks: PipelineSinks,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.audioStream = config.audioStream;
    this.igStream = config.igStream ?? null;
  }

  /** Takes effect on the next start(). */
  setIgStream(stream: number | null): void {
    this.igStream = stream;
  }

  /** Takes effect on the next play item read (or start()). */
  setPgStream(pid: number | null): void {
    this.pgPid = pid;
  }

  /** Takes effect on the next start(). */
  setAudioStream(stream: number | null): void {
    this.audioStream = stream;
  }

  /** The clip being read: its stream file and TS_recording_rate (bytes per second); null between reads. */
  get reading(): { readonly path: string; readonly recordingRate: number } | null {
    return this.currentClip;
  }

  /**
   * Playlist time up to which the source has been asked for data (read or prefetched), so reading can be paced on the
   * clock without decoding anything: the EP-map entry at or after that packet (the data before it is earlier), else the
   * clip's TS_recording_rate from where the read started; never past the play item's end. Null between reads.
   */
  get readUs(): number | null {
    const reader = this.current;
    const place = this.currentPlace;
    if (!reader || !place) return null;
    const { timeline } = this.config;
    const item = timeline.items[place.item]!;
    const endUs = timeline.itemStartUs(place.item) + ((item.outTime - item.inTime) * 1000) / 45;
    const spn = reader.requestedSpn;
    let us: number | null = null;
    const entries = place.entries;
    if (entries.length > 0) {
      let lo = 0;
      let hi = entries.length; // the first entry at or after spn (entries ascend in spn)
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid]!.spn < spn) lo = mid + 1;
        else hi = mid;
      }
      us = lo < entries.length ? timeline.toPlaylistUs(place.item, entries[lo]!.pts * 2).us : endUs;
    } else if (place.recordingRate > 0) {
      us = place.startUs + (((spn - place.startSpn) * TS_PACKET_SIZE) / place.recordingRate) * 1e6;
    }
    return us === null ? endUs : Math.min(us, endUs);
  }

  get stats(): DemuxStats {
    const live = this.current?.stats;
    return { corruptPackets: this.corruptPackets + (live?.corruptPackets ?? 0), continuityErrors: this.continuityErrors + (live?.continuityErrors ?? 0) };
  }

  private retire(reader: M2tsReader | null): void {
    if (!reader) return;
    this.corruptPackets += reader.stats.corruptPackets;
    this.continuityErrors += reader.stats.continuityErrors;
    if (this.current === reader) {
      this.current = null;
      this.currentClip = null;
      this.currentPlace = null;
    }
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
    const readVideo = this.config.readVideo ?? true;
    const audioStream = this.audioStream;
    const igStream = this.sinks.ig ? this.igStream : null;
    const startPos = timeline.locate(fromUs);

    for (let i = startPos.item.index; i < timeline.items.length; i++) {
      const item = timeline.items[i];
      if (item.outTime <= item.inTime) continue;
      const clip = clips.get(item.clipId);
      if (!clip) throw new DiscError('missing-file', `Missing clip info for ${item.clipId}`, [clipInfoPath(item.clipId)]);
      this.sinks.itemStarted?.(i, i === startPos.item.index ? fromUs : timeline.itemStartUs(i));
      if (gen !== this.generation) return;
      const pgPid = this.sinks.pg ? this.pgPid : null;
      const audioEntry = audioEntryFor(playItems[i], audioStream);
      const pids = new Set<number>(readVideo ? [videoPid] : []);
      if (audioEntry) pids.add(audioEntry.pid);
      const igEntry = igEntryFor(playItems[i], igStream);
      if (igEntry) pids.add(igEntry.pid);
      if (pgPid !== null) pids.add(pgPid);
      const ep = clip.epMaps.find((m) => m.pid === videoPid) ?? clip.epMaps[0];
      const target = i === startPos.item.index ? startPos.clipTime45 : item.inTime;
      // PTS can restart inside a clip; only this item's STC sequence is meaningful (libbluray clpi_lookup_spn).
      const range = stcSpnRange(clip, item.stcId);
      const rangeEnd = Number.isFinite(range.endSpn) ? range.endSpn : undefined;
      // _fill_clip: the first play item and seamless ones (connection 5, 6) start at packet 0, so data muxed ahead of the
      // first keyframe (an IG display set at the clip start) is read; a seek inside the item starts at its keyframe.
      const cc = playItems[i]?.connectionCondition;
      const fromClipStart = target <= item.inTime && (i === 0 || cc === 5 || cc === 6);
      const startSpn = fromClipStart || !ep ? range.startSpn : (findEpBefore(ep, target, range)?.spn ?? range.startSpn);
      const endSpn = ep ? (findEpAfter(ep, item.outTime, range)?.spn ?? rangeEnd) : rangeEnd;
      const reader = new M2tsReader({ source, path: streamPath(item.clipId), startSpn, endSpn, pids });
      this.current?.cancel();
      this.retire(this.current); // a stopped earlier read keeps its counts
      this.current = reader;
      this.currentClip = { path: streamPath(item.clipId), recordingRate: clip.recordingRate };
      const entries = ep?.entries.filter((e) => e.spn >= range.startSpn && e.spn < range.endSpn) ?? [];
      this.currentPlace = { item: i, entries, startSpn, startUs: i === startPos.item.index ? fromUs : timeline.itemStartUs(i), recordingRate: clip.recordingRate };

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
          if (readVideo && pes.pid === videoPid) this.sinks.video({ data: pes.payload, ptsUs: us, inRange });
          else if (igEntry && pes.pid === igEntry.pid) this.sinks.ig?.({ data: pes.payload, ptsUs: us, dtsUs: pes.dts === undefined ? undefined : timeline.toPlaylistUs(i, pes.dts).us, inRange });
          else if (pgPid !== null && pes.pid === pgPid) this.sinks.pg?.({ data: pes.payload, ptsUs: us, dtsUs: pes.dts === undefined ? undefined : timeline.toPlaylistUs(i, pes.dts).us, inRange });
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
