import { useRef, type PointerEvent, type ReactElement } from 'react';

interface AlphabetRailProps {
  /** Every key, in order; those not in `present` show dimmed and do nothing. */
  readonly keys: readonly string[];
  readonly present: ReadonlySet<string>;
  /** This bar's order is the one the list is in. */
  readonly active: boolean;
  readonly side: 'left' | 'right';
  readonly label: string;
  readonly lang?: string;
  readonly onPick: (key: string) => void;
}

/**
 * A bar of index keys down one side of the library: a tap jumps to a key, and a finger or pointer dragged along the bar
 * jumps through the keys it passes, as on a phone's contacts list.
 */
export function AlphabetRail({ keys, present, active, side, label, lang, onPick }: AlphabetRailProps): ReactElement {
  /** The key the current drag last jumped to, so a drag within one key jumps once. */
  const last = useRef<string | null>(null);

  const keyAt = (e: PointerEvent): string | null => {
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-rail-key]');
    const key = hit?.dataset.railKey ?? null;
    return key !== null && present.has(key) ? key : null;
  };
  const pick = (key: string | null): void => {
    if (key === null || key === last.current) return;
    last.current = key;
    onPick(key);
  };

  return (
    <nav
      className={`alphabet-rail alphabet-rail-${side}${active ? ' active' : ''}`}
      aria-label={label}
      data-testid={`alphabet-rail-${side}`}
      lang={lang}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = null;
        pick(keyAt(e));
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(keyAt(e));
      }}
      onPointerUp={() => (last.current = null)}
      onPointerCancel={() => (last.current = null)}
    >
      {keys.map((key) => (
        <button
          key={key}
          type="button"
          className="alphabet-rail-key"
          data-rail-key={key}
          // aria-disabled, not disabled: some browsers send no pointer events from a disabled button, so a drag
          // starting on a missing key would never reach the bar
          aria-disabled={!present.has(key)}
          tabIndex={present.has(key) ? 0 : -1}
          aria-label={`Jump to ${key}`}
          // pointer taps jump on pointerdown; a click from the keyboard (Enter, Space) has no pointer before it
          onClick={(e) => {
            if (e.detail === 0 && present.has(key)) onPick(key);
          }}
        >
          {key}
        </button>
      ))}
    </nav>
  );
}
