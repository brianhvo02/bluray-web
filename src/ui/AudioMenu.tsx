import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { AudioTrack } from '../engine/protocol';
import { trackLabel } from '../player/language';

interface AudioMenuProps {
  readonly tracks: readonly AudioTrack[];
  readonly selected: number | null;
  /** Set when the disc does not allow changing the audio here: the button is disabled with this tooltip. */
  readonly disabledReason?: string;
  onSelect(index: number): void;
  /** While open, the player keeps its controls up. */
  onOpenChange(open: boolean): void;
}

export function AudioMenu({ tracks, selected, disabledReason, onSelect, onOpenChange }: AudioMenuProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = tracks.length > 1;

  const playableItems = (): HTMLButtonElement[] => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!shown || disabledReason) setOpen(false);
  }, [shown, disabledReason]);

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
      <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open} data-testid="audio-menu" disabled={disabledReason !== undefined} title={disabledReason} onClick={() => setOpen((o) => !o)}>
        Audio
      </button>
      {open && (
        <ul ref={listRef} role="menu" className="audio-menu-list" onKeyDown={moveFocus}>
          {tracks.map((t) => (
            <li key={t.index} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={t.index === selected}
                disabled={!t.playable}
                title={t.playable ? undefined : `${t.codec} isn't supported`}
                data-testid={`audio-track-${t.index}`}
                data-codec={t.codec}
                onClick={() => {
                  close(true);
                  onSelect(t.index);
                }}
              >
                {trackLabel(t)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
