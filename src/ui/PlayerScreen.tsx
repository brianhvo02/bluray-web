import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent, type ReactElement } from 'react';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { ControlBar } from './ControlBar';
import type { ShaderModel, ShaderModelState } from './shader-model';
import { collectDroppedFiles, splitPick } from '../player/drop-files';
import { checkCapabilities } from './capabilities';
import { FULLSCREEN_HINT_TEXT, evaluateFullscreenHint, markFullscreenHintDismissed, safeLocalStorage, toggleFullscreen } from './fullscreen';
import { EncodingPrompt } from './EncodingPrompt';
import { keyActionUo, keyToAction } from './keyboard';
import { toMenuSpace } from './pointer';
import { classifyTap, controlsMayIdle, DOUBLE_TAP_MS, idleAfterTap, pairableTap, type Tap } from './touch';
import { PlaylistPicker } from './PlaylistPicker';
import { RemotePad } from './RemotePad';
import type { MenuKey } from '../engine/protocol';

const HIDE_CONTROLS_MS = 3000;
const OFFSET_NOTICE_MS = 2000;
const TAP_NOTICE_MS = 6000;


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

function Notice({ message, onDismiss, testId }: { message: string; onDismiss(): void; testId?: string }): ReactElement {
  return (
    <div className="notice" role="status" data-testid={testId}>
      {message}
      <button type="button" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
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
  const [fullscreen] = useState(() => checkCapabilities().fullscreen);
  const [hintVisible, setHintVisible] = useState(() => evaluateFullscreenHint(fullscreen));
  const playing = snapshot.engineState === 'playing';
  /** The latest pointer position waiting for the next animation frame (moves are sent at most once per frame). */
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  /** Touch state: the previous tap, the delayed single-tap timer, whether the last pointerup was touch (its synthesized click is ignored). */
  const lastTap = useRef<Tap | null>(null);
  const tapTimer = useRef<number | null>(null);
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const lastUpWasTouch = useRef(false);

  useEffect(
    () => () => {
      if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
    },
    [],
  );

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
      // a BD-J menu on screen takes the arrows, Enter and digits as an HDMV menu does
      const now = controller.getSnapshot();
      const menuActive = now.menuActive || now.bdjMenuVisible;
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
          if (fullscreen && rootRef.current) toggleFullscreen(document, rootRef.current, fullscreen);
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
          controller.menuKey(action.key, e.repeat);
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
    // holding a control (e.g. the seek thumb), an open menu, or the remote over a BD-J menu keeps the controls up
    if (!controlsMayIdle({ playing, pressed, menuOpen, remoteOpen, bdjMenuVisible: snapshot.bdjMenuVisible })) return;
    const timer = window.setTimeout(() => setIdle(true), HIDE_CONTROLS_MS);
    return () => window.clearTimeout(timer);
  }, [playing, activity, pressed, menuOpen, remoteOpen, snapshot.bdjMenuVisible]);

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

  // The first tap a BD-J menu ignores opens the remote, with the controls it sits over, once per menu (with the notice):
  // a remote the user closes stays closed until the next menu.
  const remoteRequests = snapshot.bdjRemoteRequests;
  const seenRemoteRequests = useRef(remoteRequests);
  useEffect(() => {
    if (remoteRequests === seenRemoteRequests.current) return;
    seenRemoteRequests.current = remoteRequests;
    setRemoteOpen(true);
    setIdle(false);
    setActivity((a) => a + 1);
  }, [remoteRequests]);

  const tapNotice = snapshot.notices.find((n) => n.code === 'bdj-tap-ignored');
  useEffect(() => {
    if (!tapNotice) return;
    const timer = window.setTimeout(() => controller.dismissNotice('bdj-tap-ignored'), TAP_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [controller, tapNotice]);

  const maskedNotice = snapshot.notices.find((n) => n.code === 'uo-masked');
  useEffect(() => {
    if (!maskedNotice) return;
    const timer = window.setTimeout(() => controller.dismissNotice('uo-masked'), 3000);
    return () => window.clearTimeout(timer);
  }, [controller, maskedNotice]);

  // A BD-J title hears the mouse wherever it is over the picture (BDJ_EVENT_MOUSE), as libbluray's hosts send it.
  const onCanvasPointerMove = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (e.pointerType === 'touch' || !(snapshot.menuActive || snapshot.bdjActive)) return;
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

  const onCanvasPointerUp = (e: PointerEvent<HTMLCanvasElement>): void => {
    lastUpWasTouch.current = e.pointerType === 'touch';
    if (e.pointerType !== 'touch') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const tap: Tap = { x: e.clientX - rect.left, timeMs: e.timeStamp };
    // the snapshot the engine last sent: the tap is mapped with the canvas rectangle as it is now (after a rotation too)
    const now = controller.getSnapshot();
    const action = classifyTap(lastTap.current, tap, { width: rect.width, menuActive: now.menuActive, bdjMenuVisible: now.bdjMenuVisible });
    lastTap.current = pairableTap(action, tap);
    if (tapTimer.current !== null) {
      window.clearTimeout(tapTimer.current);
      tapTimer.current = null;
    }
    switch (action) {
      case 'menuClick': {
        const point = toMenuSpace(e.clientX, e.clientY, rect);
        if (point) controller.pointer('click', point.x, point.y);
        break;
      }
      case 'seekBack':
      case 'seekForward': {
        const op = keyActionUo({ type: 'seekBy', deltaUs: 0 }, uoContext(controller));
        if (op && !controller.allow(op)) break;
        controller.seekBy(action === 'seekForward' ? 10_000_000 : -10_000_000);
        break;
      }
      case 'toggleControls': {
        // Delayed so that the first tap of a double tap doesn't flash the controls.
        tapTimer.current = window.setTimeout(() => {
          tapTimer.current = null;
          const next = idleAfterTap(idleRef.current, controller.getSnapshot().engineState);
          if (next === idleRef.current) return;
          setIdle(next);
          if (!next) setActivity((a) => a + 1);
        }, DOUBLE_TAP_MS);
        break;
      }
      case 'none':
        break;
    }
  };

  const onCanvasClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    if (lastUpWasTouch.current) {
      lastUpWasTouch.current = false; // the click the browser synthesized after a tap, already handled on pointerup
      return;
    }
    const now = controller.getSnapshot();
    if (!(now.menuActive || now.bdjMenuVisible)) {
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

  const isVideoTouch = (e: PointerEvent<HTMLElement>): boolean => e.pointerType === 'touch' && e.target === canvasRef.current;

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
      data-bdj-menu={snapshot.bdjMenuVisible}
      onPointerMove={(e) => {
        if (!isVideoTouch(e)) wake();
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerDown={(e) => {
        setPressed(true);
        if (!isVideoTouch(e)) {
          // A touch off the video cancels a pending single tap: it would otherwise hide the controls just woken.
          if (tapTimer.current !== null) {
            window.clearTimeout(tapTimer.current);
            tapTimer.current = null;
          }
          wake();
        } // a touch on the video shows or hides the controls on its own, after the double-tap window
      }}
    >
      <canvas
        ref={canvasRef}
        className={`player-canvas${snapshot.menuActive && snapshot.pointerButton !== null ? ' over-button' : ''}`}
        data-testid="video-canvas"
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onClick={onCanvasClick}
      />
      <div className="notices">
        {snapshot.error && (
          <div className="error-banner" role="alert" data-testid="error">
            {snapshot.error.message}
          </div>
        )}
        {snapshot.notices.map((n) => (
          <Notice key={n.code} message={n.message} onDismiss={() => controller.dismissNotice(n.code)} />
        ))}
        {hintVisible && (
          <Notice
            message={FULLSCREEN_HINT_TEXT}
            testId="fullscreen-hint"
            onDismiss={() => {
              setHintVisible(false);
              const storage = safeLocalStorage();
              if (storage) markFullscreenHintDismissed(storage);
            }}
          />
        )}
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
      {remoteOpen && controlsVisible && (snapshot.indexTitles || snapshot.bdjActive) && <RemotePad onKey={sendMenuKey} />}
      {snapshot.encodingPrompt && <EncodingPrompt fileName={snapshot.encodingPrompt.names.join(', ')} onAnswer={answerEncoding} />}
      <ControlBar
        controller={controller}
        snapshot={snapshot}
        shaderModel={shaderModel}
        shaderState={shaderState}
        visible={controlsVisible}
        onOpenPlaylists={() => setPickerOpen(true)}
        onFullscreen={
          fullscreen
            ? () => {
                if (rootRef.current) toggleFullscreen(document, rootRef.current, fullscreen);
              }
            : undefined
        }
        onMenuKey={sendMenuKey}
        remoteOpen={remoteOpen}
        onToggleRemote={() => setRemoteOpen((o) => !o)}
        onMenuOpenChange={setMenuOpen}
      />
    </div>
  );
}
