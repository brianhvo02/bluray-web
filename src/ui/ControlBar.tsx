import { useRef, useState, type ReactElement } from 'react';
import type { Chapter } from '../engine/nav/timeline';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { formatTime } from './format';

interface SeekBarProps {
  readonly durationUs: number;
  readonly timeUs: number;
  readonly chapters: readonly Chapter[];
  onSeek(timeUs: number): void;
}

function SeekBar({ durationUs, timeUs, chapters, onSeek }: SeekBarProps): ReactElement {
  const [dragUs, setDragUs] = useState<number | null>(null);
  const max = Math.max(1, durationUs);
  const pointerDown = useRef(false);
  const commit = (): void => {
    pointerDown.current = false;
    if (dragUs !== null) onSeek(dragUs);
    setDragUs(null);
  };
  const cancel = (): void => {
    pointerDown.current = false;
    setDragUs(null);
  };
  return (
    <div className="seek-bar">
      <input
        type="range"
        aria-label="Seek"
        data-testid="seek"
        min={0}
        max={max}
        step={100_000}
        value={Math.min(dragUs ?? timeUs, max)}
        onChange={(e) => {
          const value = Number(e.target.value);
          if (pointerDown.current) {
            setDragUs(value);
          } else {
            onSeek(value);
            setDragUs(null);
          }
        }}
        onPointerDown={() => {
          pointerDown.current = true;
        }}
        onPointerUp={commit}
        onPointerCancel={cancel}
        onBlur={cancel}
      />
      {durationUs > 0 &&
        chapters.map((c) => <span key={c.index} className="chapter-tick" style={{ left: `${(c.startUs / durationUs) * 100}%` }} />)}
    </div>
  );
}

interface ControlBarProps {
  readonly controller: PlayerController;
  readonly snapshot: PlayerSnapshot;
  readonly visible: boolean;
  onOpenPlaylists(): void;
  onFullscreen(): void;
}

export function ControlBar({ controller, snapshot, visible, onOpenPlaylists, onFullscreen }: ControlBarProps): ReactElement {
  const playing = snapshot.engineState === 'playing' || snapshot.engineState === 'buffering';
  const silent = snapshot.muted || snapshot.volume === 0;
  return (
    <div className={`control-bar${visible ? '' : ' hidden'}`} data-testid="control-bar">
      <SeekBar durationUs={snapshot.durationUs} timeUs={snapshot.timeUs} chapters={snapshot.chapters} onSeek={(us) => controller.seek(us)} />
      <div className="control-row">
        <button type="button" aria-label="Previous chapter" onClick={() => controller.prevChapter()}>
          ⏮
        </button>
        <button type="button" aria-label={playing ? 'Pause' : 'Play'} data-testid="play-toggle" onClick={() => controller.togglePlay()}>
          {playing ? '⏸' : '▶'}
        </button>
        <button type="button" aria-label="Next chapter" data-testid="next-chapter" onClick={() => controller.nextChapter()}>
          ⏭
        </button>
        <span className="time" data-testid="time">
          {formatTime(snapshot.timeUs)} / {formatTime(snapshot.durationUs)}
        </span>
        <span className="spacer" />
        <button type="button" aria-label={snapshot.muted ? 'Unmute' : 'Mute'} onClick={() => controller.toggleMute()}>
          {silent ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          aria-label="Volume"
          data-role="volume"
          min={0}
          max={1}
          step={0.05}
          value={snapshot.muted ? 0 : snapshot.volume}
          onChange={(e) => {
            if (snapshot.muted) controller.toggleMute();
            controller.setVolume(Number(e.target.value));
          }}
        />
        <button type="button" onClick={onOpenPlaylists}>
          Playlists
        </button>
        <button type="button" aria-label="Fullscreen" onClick={onFullscreen}>
          ⛶
        </button>
      </div>
    </div>
  );
}
