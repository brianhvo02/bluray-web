import type { ReactElement } from 'react';

export const NOT_FOUND_COPY = "This link is for a NAS this device isn't paired with. Ask its owner to send you an invite.";

interface NasNotFoundProps {
  /** This device is paired: the button goes back to the library instead of pairing. */
  readonly paired: boolean;
  /** Leaves the link's path: to the pair screen when unpaired, to the library when paired. */
  readonly onPair: () => void;
}

/** A NAS link this device can't open: it isn't paired, or the NAS has nothing at the link, or the title library is closed to it. */
export function NasNotFound({ paired, onPair }: NasNotFoundProps): ReactElement {
  return (
    <section className="nas-not-found" data-testid="nas-not-found">
      <p>{NOT_FOUND_COPY}</p>
      <button type="button" data-testid="nas-not-found-pair" onClick={onPair}>
        {paired ? 'Back to the library' : 'Pair with a NAS'}
      </button>
    </section>
  );
}
