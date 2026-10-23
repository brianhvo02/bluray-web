import type { MouseEvent, ReactElement, ReactNode } from 'react';
import type { NasHistory } from '../nas/nas-history';

/** A plain click on an app link: not a new tab or window, not a download. */
export function isPlainClick(e: MouseEvent): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

interface AppLinkProps {
  readonly history: NasHistory;
  /** A path in the app, such as `/help` or `/help/nas#pairing`. */
  readonly to: string;
  readonly className?: string;
  readonly testId?: string;
  readonly current?: boolean;
  readonly children: ReactNode;
}

/** A real link (it opens in a new tab as one) that a plain click follows through the app's history. */
export function AppLink({ history, to, className, testId, current, children }: AppLinkProps): ReactElement {
  return (
    <a
      href={to}
      className={className}
      data-testid={testId}
      aria-current={current ? 'page' : undefined}
      onClick={(e) => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        history.pushPath(to);
      }}
    >
      {children}
    </a>
  );
}
