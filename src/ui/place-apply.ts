import type { PlaceTextFile } from '../engine/disc/nas-api';
import type { PgTrack, SubtitleChoice } from '../engine/protocol';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { isFontName } from '../player/drop-files';
import { settingsForUpNext } from './place-model';
import type { PlaceSaver } from './place-saver';
import type { StoredTextFile } from './place-store';

const PG_DISPLAY_FLAG = 0x80000000;

export interface LaunchSettingsDeps {
  readonly controller: Pick<
    PlayerController,
    'discOpens' | 'setVolume' | 'toggleMute' | 'selectAudio' | 'selectSubtitle' | 'loadSubtitleFiles' | 'setSubtitleStart' | 'shiftSubtitleFile' | 'scaleSubtitles'
  >;
  readonly places: Pick<PlaceSaver, 'takeLaunchSettings' | 'storedTextFiles' | 'addTextFiles'>;
  /** Chooses a shader set (null: off) the way the Shaders menu does; a set this device doesn't have is left alone. */
  readonly selectShader: (name: string | null) => void;
  readonly log?: (message: string, err: unknown) => void;
}

/** The text files being added again, until the engine reports them and their placements and offsets can be set. */
interface PendingText {
  readonly opens: number;
  readonly files: readonly PlaceTextFile[];
  readonly placed: boolean;
  readonly textOn: boolean;
  readonly psr2: number;
  readonly scale: number;
}

/** PSR2 as a subtitle choice: its PG stream when the display flag is on and the stream exists, else off. */
function pgChoice(psr2: number, pg: readonly PgTrack[]): SubtitleChoice {
  const stream = psr2 & 0xfff;
  return (psr2 & PG_DISPLAY_FLAG) !== 0 && pg.some((t) => t.index === stream) ? { kind: 'pg', stream } : { kind: 'off' };
}

/** The stored files a place's text files name (by name, and by size when the place knows it), with the stored fonts. */
export function filesToAdd(wanted: readonly PlaceTextFile[], stored: readonly StoredTextFile[]): { readonly subtitles: readonly StoredTextFile[]; readonly fonts: readonly StoredTextFile[] } {
  const subtitles = wanted.flatMap((w) => {
    const f = stored.find((s) => s.name === w.name && !isFontName(s.name) && (w.size === 0 || s.bytes.byteLength === w.size));
    return f ? [f] : [];
  });
  return { subtitles, fonts: subtitles.length > 0 ? stored.filter((s) => isFontName(s.name)) : [] };
}

/**
 * Applies a launch's settings once its disc plays (spec 2026-10-20 §6.1, §6.3, §6.6): volume and mute, the shader set,
 * audio and PG by language for another playlist's settings, and this device's stored text subtitle files with their
 * placements, offsets and scale. A carried file this device has no bytes for (for this disc) is skipped silently.
 */
export class LaunchSettingsApplier {
  private text: PendingText | null = null;

  constructor(private readonly deps: LaunchSettingsDeps) {}

  /** Each snapshot of the player, with the shader set chosen now. */
  observe(s: PlayerSnapshot, shaderSet: string | null): void {
    if (this.text) this.finishText(s);
    if (s.currentPlaylistId === null || (s.engineState !== 'playing' && s.engineState !== 'paused')) return;
    const launch = this.deps.places.takeLaunchSettings();
    if (!launch) return;
    const { controller } = this.deps;
    const settings = launch.byLanguage ? settingsForUpNext(launch.settings, s.audioTracks, s.subtitles?.pg ?? []) : launch.settings;
    controller.setVolume(settings.volume);
    if (settings.muted !== s.muted) controller.toggleMute();
    if (settings.shaderSet !== shaderSet) this.deps.selectShader(settings.shaderSet);
    if (launch.byLanguage) {
      controller.selectAudio(settings.psr1);
      if (!settings.textOn) controller.selectSubtitle(pgChoice(settings.psr2, s.subtitles?.pg ?? []));
    }
    if (settings.textFiles.length > 0) void this.addText(launch.discKey, settings, !launch.byLanguage);
  }

  private async addText(discKey: string, settings: { readonly textFiles: readonly PlaceTextFile[]; readonly textOn: boolean; readonly psr2: number; readonly textScale: number }, placed: boolean): Promise<void> {
    const { controller, places } = this.deps;
    const opens = controller.discOpens;
    try {
      const { subtitles, fonts } = filesToAdd(settings.textFiles, await places.storedTextFiles(discKey));
      if (subtitles.length === 0 || controller.discOpens !== opens) return;
      const files = [...subtitles, ...fonts].map((f) => new File([f.bytes as Uint8Array<ArrayBuffer>], f.name));
      const names = new Set(subtitles.map((f) => f.name));
      this.text = { opens, files: settings.textFiles.filter((f) => names.has(f.name)), placed, textOn: settings.textOn, psr2: settings.psr2, scale: settings.textScale };
      await controller.loadSubtitleFiles(files);
      // kept again for this disc's later places (their sizes)
      await places.addTextFiles(files);
    } catch (err) {
      this.deps.log?.('adding the subtitle files again failed', err);
    }
  }

  /** Once the engine has the files: their placements (the same playlist's only), offsets and scale, and PG back if text was off. */
  private finishText(s: PlayerSnapshot): void {
    const t = this.text!;
    const { controller } = this.deps;
    if (controller.discOpens !== t.opens) {
      this.text = null;
      return;
    }
    const subs = s.subtitles;
    const loaded = subs?.text?.files;
    if (!subs || !loaded || !t.files.every((f) => loaded.some((l) => l.name === f.name))) return;
    this.text = null;
    for (const f of t.files) {
      const i = loaded.findIndex((l) => l.name === f.name);
      const now = loaded[i]!;
      if (t.placed && f.startUs !== now.startUs) controller.setSubtitleStart(i, f.startUs);
      if (f.offsetMs !== now.offsetMs) controller.shiftSubtitleFile(i, f.offsetMs - now.offsetMs);
    }
    if (t.scale !== subs.scale) controller.scaleSubtitles(t.scale - subs.scale);
    if (!t.textOn) controller.selectSubtitle(pgChoice(t.psr2, subs.pg));
  }
}
