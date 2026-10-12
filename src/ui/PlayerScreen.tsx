import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { ControlBar } from './ControlBar';
import { keyToAction } from './keyboard';
import { PlaylistPicker } from './PlaylistPicker';

const HIDE_CONTROLS_MS = 3000;

interface PlayerScreenProps {
  readonly controller: PlayerController;
  readonly snapshot: PlayerSnapshot;
}

function toggleFullscreen(element: HTMLElement | null): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void element?.requestFullscreen();
}

export function PlayerScreen({ controller, snapshot }: PlayerScreenProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [activity, setActivity] = useState(0);
  const playing = snapshot.engineState === 'playing';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    controller.attachCanvas(canvas);
    const observer = new ResizeObserver(([entry]) => {
      const dpr = window.devicePixelRatio || 1;
      controller.resize(entry.contentRect.width * dpr, entry.contentRect.height * dpr);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [controller]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement || target instanceof HTMLTextAreaElement) return;
      const action = keyToAction(e.key);
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case 'togglePlay':
          controller.togglePlay();
          break;
        case 'seekBy':
          controller.seekBy(action.deltaUs);
          break;
        case 'volumeBy':
          controller.setVolume(controller.getSnapshot().volume + action.delta);
          break;
        case 'fullscreen':
          toggleFullscreen(rootRef.current);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setIdle(true), HIDE_CONTROLS_MS);
    return () => window.clearTimeout(timer);
  }, [playing, activity]);

  const wake = (): void => {
    setIdle(false);
    setActivity((a) => a + 1);
  };

  const controlsVisible = !idle || !playing;
  const showPicker = pickerOpen || snapshot.currentPlaylistId === null;

  return (
    <div
      ref={rootRef}
      className={`player${controlsVisible ? '' : ' idle'}`}
      data-testid="player"
      data-state={snapshot.engineState}
      onMouseMove={wake}
    >
      <canvas ref={canvasRef} className="player-canvas" data-testid="video-canvas" onClick={() => controller.togglePlay()} />
      <div className="notices">
        {snapshot.error && (
          <div className="error-banner" role="alert" data-testid="error">
            {snapshot.error.message}
          </div>
        )}
        {snapshot.notices.map((n) => (
          <div key={n.code} className="notice" role="status">
            {n.message}
            <button type="button" aria-label="Dismiss" onClick={() => controller.dismissNotice(n.code)}>
              ×
            </button>
          </div>
        ))}
      </div>
      {snapshot.engineState === 'buffering' && <div className="spinner" aria-label="Buffering" />}
      {showPicker && (
        <PlaylistPicker
          playlists={snapshot.playlists}
          usesBdj={snapshot.usesBdj}
          onPick={(id) => {
            setPickerOpen(false);
            controller.playPlaylist(id);
          }}
          onClose={snapshot.currentPlaylistId === null ? undefined : () => setPickerOpen(false)}
          onCloseDisc={() => controller.closeDisc()}
        />
      )}
      <ControlBar
        controller={controller}
        snapshot={snapshot}
        visible={controlsVisible}
        onOpenPlaylists={() => setPickerOpen(true)}
        onFullscreen={() => toggleFullscreen(rootRef.current)}
      />
    </div>
  );
}
