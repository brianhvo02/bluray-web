import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { AudioTrack } from '../engine/protocol';
import { trackLabel } from './language';

interface AudioMenuProps {
  readonly tracks: readonly AudioTrack[];
  readonly selected: number | null;
  onSelect(index: number): void;
  /** While open, the player keeps its controls up. */
  onOpenChange(open: boolean): void;
}

export function AudioMenu({ tracks, selected, onSelect, onOpenChange }: AudioMenuProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const shown = tracks.length > 1;

  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  useEffect(() => onOpenChange(open), [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (!shown) return null;
  return (
    <div className="audio-menu" ref={rootRef}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} data-testid="audio-menu" onClick={() => setOpen((o) => !o)}>
        Audio
      </button>
      {open && (
        <ul role="menu" className="audio-menu-list">
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
                  setOpen(false);
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
