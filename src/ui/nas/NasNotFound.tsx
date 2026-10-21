import type { ReactElement } from 'react';

export const NOT_FOUND_COPY = "This link is for a NAS this device isn't paired with. Ask its owner to send you an invite.";

interface NasNotFoundProps {
  /** Leaves the link's path and opens the pair screen. */
  readonly onPair: () => void;
}

/** A NAS link this device can't open: it isn't paired, or the NAS has nothing at the link, or the title library is closed to it. */
export function NasNotFound({ onPair }: NasNotFoundProps): ReactElement {
  return (
    <section className="nas-not-found" data-testid="nas-not-found">
      <p>{NOT_FOUND_COPY}</p>
      <button type="button" data-testid="nas-not-found-pair" onClick={onPair}>
        Pair with a NAS
      </button>
    </section>
  );
}
