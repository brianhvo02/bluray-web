import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { UoOp } from '../engine/hdmv/uo-mask';
import type { SubtitleChoice } from '../engine/protocol';
import { languageName } from '../player/language';
import { formatSubtitleOffset, MAX_SUBTITLE_SCALE, MIN_SUBTITLE_SCALE, type SubtitlesState } from '../player/player-controller';

const OFFSET_STEP_MS = 100;
const SCALE_STEP = 0.1;
const MASKED_TOOLTIP = "The disc doesn't allow this here";

interface SubtitleMenuProps {
  readonly subtitles: SubtitlesState | null;
  /** The disc's UO mask: picks it does not allow here are disabled with a tooltip. */
  isMasked(op: UoOp): boolean;
  onSelect(choice: SubtitleChoice): void;
  onLoadFile(file: File): void;
  onShift(deltaMs: number): void;
  onScale(delta: number): void;
  onRemove(): void;
  /** While open, the player keeps its controls up. */
  onOpenChange(open: boolean): void;
}

/** Disc PG tracks, the user's subtitle file (with timing and size), Off, and loading a file. Keyboard handling as AudioMenu. */
export function SubtitleMenu({ subtitles, isMasked, onSelect, onLoadFile, onShift, onScale, onRemove, onOpenChange }: SubtitleMenuProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const shown = subtitles !== null;

  const items = (): HTMLButtonElement[] => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const choose = (choice: SubtitleChoice): void => {
    close(true);
    onSelect(choice);
  };

  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  useEffect(() => onOpenChange(open), [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const list = items();
    (list.find((b) => b.getAttribute('aria-checked') === 'true') ?? list[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(true);
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  const moveFocus = (e: ReactKeyboardEvent): void => {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    list[(next + list.length) % list.length].focus();
  };

  if (!subtitles) return null;
  const { pg, text, selected, offsetMs, scale } = subtitles;
  const currentPg = typeof selected === 'object' ? selected.pg : null;
  // moving to another PG stream is pgChange; leaving a shown PG stream for Off or the file turns PG's display off
  const pgMasked = (stream: number): boolean => currentPg !== null && stream !== currentPg && isMasked('pgChange');
  const offMasked = currentPg !== null && isMasked('pgEnableDisable');
  return (
    <div className="audio-menu subtitle-menu" ref={rootRef}>
      <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open} data-testid="subtitle-menu" onClick={() => setOpen((o) => !o)}>
        Subtitles
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".srt,text/plain"
        hidden
        data-testid="subtitle-file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // the same file can be picked again
          if (file) onLoadFile(file);
        }}
      />
      {open && (
        <ul ref={listRef} role="menu" className="audio-menu-list" onKeyDown={moveFocus}>
          <li role="none">
            <button type="button" role="menuitemradio" aria-checked={selected === 'off'} data-testid="subtitle-off" disabled={offMasked} title={offMasked ? MASKED_TOOLTIP : undefined} onClick={() => choose({ kind: 'off' })}>
              Off
            </button>
          </li>
          {pg.map((t) => (
            <li key={t.index} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={typeof selected === 'object' && selected.pg === t.index}
                data-testid={`subtitle-pg-${t.index}`}
                disabled={pgMasked(t.index)}
                title={pgMasked(t.index) ? MASKED_TOOLTIP : undefined}
                onClick={() => choose({ kind: 'pg', stream: t.index })}
              >
                {languageName(t.language) || `Subtitles ${t.index}`}
              </button>
            </li>
          ))}
          {text && (
            <li role="none">
              <button type="button" role="menuitemradio" aria-checked={selected === 'text'} data-testid="subtitle-text" disabled={offMasked} title={offMasked ? MASKED_TOOLTIP : `${text.cues} subtitles`} onClick={() => choose({ kind: 'text' })}>
                {text.name}
              </button>
            </li>
          )}
          {text && (
            <li role="none" className="subtitle-adjust">
              <span>Timing</span>
              <button type="button" aria-label="Show subtitles earlier" data-testid="subtitle-offset-minus" onClick={() => onShift(-OFFSET_STEP_MS)}>
                −
              </button>
              <output data-testid="subtitle-offset">{formatSubtitleOffset(offsetMs)}</output>
              <button type="button" aria-label="Show subtitles later" data-testid="subtitle-offset-plus" onClick={() => onShift(OFFSET_STEP_MS)}>
                +
              </button>
            </li>
          )}
          {text && (
            <li role="none" className="subtitle-adjust">
              <span>Size</span>
              <button type="button" aria-label="Smaller subtitles" data-testid="subtitle-size-minus" disabled={scale <= MIN_SUBTITLE_SCALE} onClick={() => onScale(-SCALE_STEP)}>
                −
              </button>
              <output data-testid="subtitle-size">{Math.round(scale * 100)}%</output>
              <button type="button" aria-label="Larger subtitles" data-testid="subtitle-size-plus" disabled={scale >= MAX_SUBTITLE_SCALE} onClick={() => onScale(SCALE_STEP)}>
                +
              </button>
            </li>
          )}
          {text && (
            <li role="none">
              <button type="button" role="menuitem" data-testid="subtitle-remove" onClick={() => { close(true); onRemove(); }}>
                Remove subtitle file
              </button>
            </li>
          )}
          <li role="none">
            <button type="button" role="menuitem" data-testid="subtitle-load" onClick={() => { close(false); fileRef.current?.click(); }}>
              Load subtitle file…
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
