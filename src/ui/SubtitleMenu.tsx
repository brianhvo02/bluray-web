import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { UoOp } from '../engine/hdmv/uo-mask';
import type { Chapter } from '../engine/nav/timeline';
import type { SubtitleChoice } from '../engine/protocol';
import { languageName } from '../player/language';
import { formatSubtitleOffset, MAX_SUBTITLE_SCALE, MIN_SUBTITLE_SCALE, type SubtitlesState } from '../player/player-controller';
import { FONT_EXTENSIONS, SUBTITLE_EXTENSIONS } from '../player/drop-files';
import { startChoices, startLabel } from './subtitle-starts';

const OFFSET_STEP_MS = 100;
const SCALE_STEP = 0.1;
const MASKED_TOOLTIP = "The disc doesn't allow this here";
const PICK_ACCEPT = [...SUBTITLE_EXTENSIONS, ...FONT_EXTENSIONS].join(',');

interface SubtitleMenuProps {
  readonly subtitles: SubtitlesState | null;
  /** The disc's UO mask: picks it does not allow here are disabled with a tooltip. */
  isMasked(op: UoOp): boolean;
  /** The playlist's chapters and the playback time, for the start picker. */
  readonly chapters: readonly Chapter[];
  readonly nowUs: number;
  /** Index of the set's file showing now, or null. */
  readonly showingFile: number | null;
  onSelect(choice: SubtitleChoice): void;
  onLoadFiles(files: readonly File[]): void;
  onAddFonts(files: readonly File[]): void;
  onShift(file: number, deltaMs: number): void;
  onStart(file: number, startUs: number | null): void;
  onScale(delta: number): void;
  onRemove(): void;
  /** While open, the player keeps its controls up. */
  onOpenChange(open: boolean): void;
}

/**
 * Disc PG tracks, the user's subtitle files (each placed at an episode start, with its own timing), size, fonts,
 * Off, and loading files. Keyboard handling as AudioMenu.
 */
export function SubtitleMenu({ subtitles, chapters, nowUs, showingFile, isMasked, onSelect, onLoadFiles, onAddFonts, onShift, onStart, onScale, onRemove, onOpenChange }: SubtitleMenuProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fontRef = useRef<HTMLInputElement>(null);
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
  const { pg, text, selected, scale } = subtitles;
  const hasAss = text?.files.some((f) => f.format === 'ass') ?? false;
  // file 0 keeps the single-file test ids
  const tid = (name: string, i: number): string => (i === 0 ? name : `${name}-${i}`);
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
        accept={PICK_ACCEPT}
        multiple
        hidden
        data-testid="subtitle-file-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = ''; // the same files can be picked again
          if (files.length) onLoadFiles(files);
        }}
      />
      <input
        ref={fontRef}
        type="file"
        accept={FONT_EXTENSIONS.join(',')}
        multiple
        hidden
        data-testid="subtitle-font-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onAddFonts(files);
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
              <button type="button" role="menuitemradio" aria-checked={selected === 'text'} data-testid="subtitle-text" disabled={offMasked} title={offMasked ? MASKED_TOOLTIP : `${text.files.reduce((n, f) => n + f.cues, 0)} subtitles`} onClick={() => choose({ kind: 'text' })}>
                {text.files.length === 1 ? text.files[0]!.name : `${text.files.length} subtitle files`}
              </button>
            </li>
          )}
          {text?.files.map((f, i) => (
            <li key={`${i}:${f.name}`} role="none" className="subtitle-file" aria-current={showingFile === i ? 'true' : undefined} data-testid={`subtitle-file-${i}`}>
              <span className="subtitle-file-name">{showingFile === i ? '▶ ' : ''}{f.name}</span>
              <select
                aria-label={`Start of ${f.name}`}
                data-testid={`subtitle-start-${i}`}
                value={f.startUs === null ? '' : String(f.startUs)}
                onChange={(e) => onStart(i, e.target.value === '' ? null : Number(e.target.value))}
              >
                {f.startUs !== null && !startChoices(text.episodeStarts, chapters, nowUs).some((c) => c.startUs === f.startUs) && (
                  <option value={String(f.startUs)}>{startLabel(f.startUs, text.episodeStarts, chapters)}</option>
                )}
                {startChoices(text.episodeStarts, chapters, nowUs).map((c) => (
                  <option key={c.label} value={c.startUs === null ? '' : String(c.startUs)}>{c.label}</option>
                ))}
              </select>
              <span className="subtitle-adjust">
                <button type="button" aria-label={`Show ${f.name} earlier`} data-testid={tid('subtitle-offset-minus', i)} onClick={() => onShift(i, -OFFSET_STEP_MS)}>
                  −
                </button>
                <output data-testid={tid('subtitle-offset', i)}>{formatSubtitleOffset(f.offsetMs)}</output>
                <button type="button" aria-label={`Show ${f.name} later`} data-testid={tid('subtitle-offset-plus', i)} onClick={() => onShift(i, OFFSET_STEP_MS)}>
                  +
                </button>
              </span>
            </li>
          ))}
          {text && text.missingFonts.length > 0 && (
            <li role="none" className="subtitle-warning" data-testid="subtitle-missing-fonts">
              Missing fonts: {text.missingFonts.join(', ')}
            </li>
          )}
          {hasAss && (
            <li role="none">
              <button type="button" role="menuitem" data-testid="subtitle-add-fonts" onClick={() => { close(false); fontRef.current?.click(); }}>
                Add fonts…
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
                Remove subtitle files
              </button>
            </li>
          )}
          <li role="none">
            <button type="button" role="menuitem" data-testid="subtitle-load" onClick={() => { close(false); fileRef.current?.click(); }}>
              Load subtitle files…
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
