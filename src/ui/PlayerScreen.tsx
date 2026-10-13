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
  const [pressed, setPressed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
      // Any key shows the controls again, like mouse movement does.
      setIdle(false);
      setActivity((a) => a + 1);
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLInputElement) {
        if (target.type !== 'range') return;
        // Only the volume slider keeps its native arrow-key stepping; on the seek bar arrows seek by 10 s.
        if (e.key.startsWith('Arrow') && target.dataset.role === 'volume') return;
      }
      if (target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
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
          controller.adjustVolume(action.delta);
          break;
        case 'fullscreen':
          toggleFullscreen(rootRef.current);
          break;
        case 'cycleAudio':
          controller.cycleAudio();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);

  useEffect(() => {
    if (!pressed) return;
    // The release can land outside the player (or on a control that hid meanwhile), so listen on the window.
    const release = (): void => {
      setPressed(false);
      setActivity((a) => a + 1);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [pressed]);

  useEffect(() => {
    if (!playing || pressed || menuOpen) return; // holding a control (e.g. the seek thumb) or an open menu keeps the controls up
    const timer = window.setTimeout(() => setIdle(true), HIDE_CONTROLS_MS);
    return () => window.clearTimeout(timer);
  }, [playing, activity, pressed, menuOpen]);

  const trackNotice = snapshot.notices.find((n) => n.code === 'audio-track')?.message;
  useEffect(() => {
    if (!trackNotice) return;
    const timer = window.setTimeout(() => controller.dismissNotice('audio-track'), 3000);
    return () => window.clearTimeout(timer);
  }, [controller, trackNotice]);

  const wake = (): void => {
    setIdle(false);
    setActivity((a) => a + 1);
  };

  const controlsVisible = !idle || !playing;
  // No current playlist (first pick, failed pick) shows the picker — but not while a pick is still loading.
  const showPicker = pickerOpen || (snapshot.currentPlaylistId === null && snapshot.engineState !== 'loading');

  return (
    <div
      ref={rootRef}
      className={`player${controlsVisible ? '' : ' idle'}`}
      data-testid="player"
      data-state={snapshot.engineState}
      onPointerMove={wake}
      onPointerDown={() => {
        setPressed(true);
        wake();
      }}
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
          messages={[...(snapshot.error ? [snapshot.error.message] : []), ...snapshot.notices.filter((n) => n.code.startsWith('unsupported-')).map((n) => n.message)]}
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
        onMenuOpenChange={setMenuOpen}
      />
    </div>
  );
}
