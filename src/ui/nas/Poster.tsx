import { useEffect, useState, type ReactElement } from 'react';
import type { NasClient } from './nas-client';
import { initials } from './title-model';

interface PosterProps {
  readonly nas: NasClient;
  /** The art id, or null when the title has none. */
  readonly artId: string | null;
  readonly name: string;
  readonly size: 'small' | 'large';
  readonly className: string;
}

/** A lazy-loaded poster or banner from the NAS, or the title's initials when it has none (or it fails to load). */
export function Poster({ nas, artId, name, size, className }: PosterProps): ReactElement {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setSrc(null);
    setFailed(false);
    if (artId === null) return;
    let live = true;
    nas.artUrl(artId, size).then(
      (url) => {
        if (live) setSrc(url);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [nas, artId, size]);

  if (artId === null || failed) {
    return (
      <span className={`${className} poster-placeholder`} aria-hidden="true">
        {initials(name)}
      </span>
    );
  }
  return src === null ? (
    <span className={className} aria-hidden="true" />
  ) : (
    <img className={className} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
  );
}
