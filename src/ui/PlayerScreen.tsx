import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent, type ReactElement } from 'react';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { ControlBar } from './ControlBar';
import type { ShaderModel, ShaderModelState } from './shader-model';
import { collectDroppedFiles, splitPick } from '../player/drop-files';
import { EncodingPrompt } from './EncodingPrompt';
import { keyActionUo, keyToAction } from './keyboard';
import { toMenuSpace } from './pointer';
import { PlaylistPicker } from './PlaylistPicker';
import { RemotePad } from './RemotePad';
import type { MenuKey } from '../engine/protocol';

const HIDE_CONTROLS_MS = 3000;
const OFFSET_NOTICE_MS = 2000;


interface PlayerScreenProps {
  readonly controller: PlayerController;
  readonly snapshot: PlayerSnapshot;
  readonly shaderModel: ShaderModel;
  readonly shaderState: ShaderModelState;
}

/**
 * What the key handlers need to name a key's user operation (keyActionUo), from the controller's latest snapshot rather
 * than the last render, so a key pressed right after a menu opens already goes to the menu.
 */
function uoContext(controller: PlayerController): { playing: boolean; popupShown: boolean } {
  const now = controller.getSnapshot();
  return { playing: now.engineState === 'playing' || now.engineState === 'buffering', popupShown: now.menuActive && now.popupAvailable };
}

function toggleFullscreen(element: HTMLElement | null): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void element?.requestFullscreen();
}

export function PlayerScreen({ controller, snapshot, shaderModel, shaderState }: PlayerScreenProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [activity, setActivity] = useState(0);
  const [pressed, setPressed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const playing = snapshot.engineState === 'playing';
  /** The latest pointer position waiting for the next animation frame (moves are sent at most once per frame). */
  const pendingMove = useRef<{ x: number; y: number } | null>(null);

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
      if (target instanceof Element && target.closest('.audio-menu-list, .shader-dialog')) return; // an open audio or subtitle menu handles its own keys
      if (controller.getSnapshot().encodingPrompt) return; // the encoding dialog is modal
      if (target instanceof HTMLInputElement) {
        if (target.type !== 'range') return;
        // Only the volume slider keeps its native arrow-key stepping; on the seek bar arrows seek by 10 s.
        if (e.key.startsWith('Arrow') && target.dataset.role === 'volume') return;
      }
      const menuActive = controller.getSnapshot().menuActive;
      if (target instanceof HTMLButtonElement) {
        // A focused button keeps Space and Enter, except that while a disc menu is shown Enter is the menu's OK: after
        // clicking Pop-up or Top Menu the focus stays there, and a second click would close or restart the menu.
        // Dialogs over the player (the picker) keep Enter.
        if (e.key === ' ') return;
        if (e.key === 'Enter' && (!menuActive || target.closest('.picker-backdrop'))) return;
      }
      const action = keyToAction(e.key, { menuActive });
      if (!action) return;
      e.preventDefault();
      const op = keyActionUo(action, uoContext(controller));
      if (op && !controller.allow(op)) return;
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
        case 'cycleSubtitles':
          controller.cycleSubtitles();
          break;
        case 'cycleShaders':
          void shaderModel.cycle().catch((e) => console.error('shader cycle failed', e));
          break;
        case 'subtitleOffset':
          controller.shiftSubtitles(action.deltaMs);
          break;
        case 'menuKey':
          controller.menuKey(action.key);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller, shaderModel]);

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

  const offsetNotice = snapshot.notices.find((n) => n.code === 'subtitle-offset')?.message;
  useEffect(() => {
    if (!offsetNotice) return;
    const timer = window.setTimeout(() => controller.dismissNotice('subtitle-offset'), OFFSET_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [controller, offsetNotice]);

  const answerEncoding = useCallback((encoding: string | null) => void controller.answerEncoding(encoding), [controller]);

  /** Dropped subtitle files and fonts (or folders of them) load as the subtitle set; nothing opens in the tab. */
  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  };
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    if (snapshot.currentPlaylistId === null) return;
    // read synchronously: the item list is unusable once the event returns
    void collectDroppedFiles(e.dataTransfer.items).then((files) => {
      const { subtitles, fonts } = splitPick(files);
      if (subtitles.length || fonts.length) void controller.loadSubtitleFiles([...subtitles, ...fonts]);
    });
  };

  const maskedNotice = snapshot.notices.find((n) => n.code === 'uo-masked');
  useEffect(() => {
    if (!maskedNotice) return;
    const timer = window.setTimeout(() => controller.dismissNotice('uo-masked'), 3000);
    return () => window.clearTimeout(timer);
  }, [controller, maskedNotice]);

  const onCanvasPointerMove = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (!snapshot.menuActive) return;
    const point = toMenuSpace(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    if (!point) return;
    const first = pendingMove.current === null;
    pendingMove.current = point;
    if (!first) return;
    requestAnimationFrame(() => {
      const p = pendingMove.current;
      pendingMove.current = null;
      if (p) controller.pointer('move', p.x, p.y);
    });
  };

  const onCanvasClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    if (!snapshot.menuActive) {
      controller.togglePlay();
      return;
    }
    const point = toMenuSpace(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    if (point) controller.pointer('click', point.x, point.y);
  };

  /** A menu key from the control bar or the remote: checked against the UO mask like the keyboard. */
  const sendMenuKey = (key: MenuKey): void => {
    const op = keyActionUo({ type: 'menuKey', key }, uoContext(controller));
    if (op && !controller.allow(op)) return;
    controller.menuKey(key);
  };

  const wake = (): void => {
    setIdle(false);
    setActivity((a) => a + 1);
  };

  const controlsVisible = !idle || !playing;
  // No current playlist (first pick, failed pick) shows the picker — but not while a pick is still loading, nor while a
  // BD-J title runs (Java opens its playlists itself; the Playlists button still opens the picker).
  const showPicker = pickerOpen || (snapshot.currentPlaylistId === null && snapshot.engineState !== 'loading' && !snapshot.bdjActive);

  return (
    <div
      ref={rootRef}
      className={`player${controlsVisible ? '' : ' idle'}`}
      data-testid="player"
      data-state={snapshot.engineState}
      data-playlist={snapshot.currentPlaylistId ?? undefined}
      data-audio-tracks={snapshot.audioTracks.length}
      data-menu-active={snapshot.menuActive}
      onPointerMove={wake}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerDown={() => {
        setPressed(true);
        wake();
      }}
    >
      <canvas
        ref={canvasRef}
        className={`player-canvas${snapshot.menuActive && snapshot.pointerButton !== null ? ' over-button' : ''}`}
        data-testid="video-canvas"
        onPointerMove={onCanvasPointerMove}
        onClick={onCanvasClick}
      />
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
          bdjSupported={snapshot.bdjSupported}
          titles={snapshot.indexTitles?.titles}
          onPickTitle={(title) => {
            setPickerOpen(false);
            controller.playTitle(title);
          }}
          messages={[...(snapshot.error ? [snapshot.error.message] : []), ...snapshot.notices.filter((n) => n.code.startsWith('unsupported-')).map((n) => n.message)]}
          onPick={(id) => {
            setPickerOpen(false);
            controller.playPlaylist(id);
          }}
          onClose={snapshot.currentPlaylistId === null && !snapshot.bdjActive ? undefined : () => setPickerOpen(false)}
          onCloseDisc={() => controller.closeDisc()}
        />
      )}
      {remoteOpen && controlsVisible && snapshot.indexTitles && <RemotePad onKey={sendMenuKey} />}
      {snapshot.encodingPrompt && <EncodingPrompt fileName={snapshot.encodingPrompt.names.join(', ')} onAnswer={answerEncoding} />}
      <ControlBar
        controller={controller}
        snapshot={snapshot}
        shaderModel={shaderModel}
        shaderState={shaderState}
        visible={controlsVisible}
        onOpenPlaylists={() => setPickerOpen(true)}
        onFullscreen={() => toggleFullscreen(rootRef.current)}
        onMenuKey={sendMenuKey}
        remoteOpen={remoteOpen}
        onToggleRemote={() => setRemoteOpen((o) => !o)}
        onMenuOpenChange={setMenuOpen}
      />
    </div>
  );
}
