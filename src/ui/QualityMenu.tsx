import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { LevelId, LevelInfo } from '../engine/disc/nas-api';
import { REASON_COPY, levelRateMbps } from './nas/level-model';
import type { LevelState } from './nas/level-session';

interface QualityMenuProps {
  readonly state: LevelState;
  onPick(level: LevelId): void;
  /** While open, the player keeps its controls up. */
  onOpenChange(open: boolean): void;
}

/** `1080p · 10 Mbps`; Original has no rate. */
export function levelItemLabel(l: LevelInfo): string {
  return l.level === 'original' ? l.label : `${l.label} · ${Math.round(levelRateMbps(l, 0))} Mbps`;
}

export function QualityMenu({ state, onPick, onOpenChange }: QualityMenuProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = state.levels.filter((l) => l.available).length > 1;

  const playableItems = (): HTMLButtonElement[] => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  useEffect(() => onOpenChange(open), [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const items = playableItems();
    (items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
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
    const items = playableItems();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    items[(next + items.length) % items.length].focus();
  };

  if (!shown) return null;
  return (
    <div className="audio-menu" ref={rootRef}>
      <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open} data-testid="quality-menu" onClick={() => setOpen((o) => !o)}>
        Quality
      </button>
      {open && (
        <ul ref={listRef} role="menu" className="audio-menu-list" onKeyDown={moveFocus}>
          {state.levels.map((l) => (
            <li key={l.level} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={l.level === state.at.level}
                disabled={!l.available}
                title={l.available ? undefined : (l.reason ? REASON_COPY[l.reason] : 'not available')}
                data-level={l.level}
                onClick={() => {
                  close(true);
                  if (l.level !== state.at.level) onPick(l.level);
                }}
              >
                {levelItemLabel(l)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
