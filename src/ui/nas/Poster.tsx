import { useEffect, useRef, useState, type ReactElement } from 'react';
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

/** How far outside the viewport a poster starts loading. */
const NEAR_VIEWPORT = '200px';

/**
 * A lazy-loaded poster or banner from the NAS, or the title's initials when it has none. Its URL is made with the
 * session token current when it comes near the viewport (ruling T10h), not when it mounted; a failed load (a token
 * that lapsed meanwhile, say) is tried once more with a fresh token before the initials show.
 */
export function Poster({ nas, artId, name, size, className }: PosterProps): ReactElement {
  const [near, setNear] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  const holder = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setSrc(null);
    setFailed(false);
    retried.current = false;
  }, [nas, artId, size]);

  // waits until the poster is near the viewport; without IntersectionObserver, loads at once
  useEffect(() => {
    if (near || artId === null) return;
    const el = holder.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: NEAR_VIEWPORT },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, artId]);

  useEffect(() => {
    if (!near || artId === null) return;
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
  }, [nas, artId, size, near]);

  const onError = (): void => {
    if (artId === null || src === null || retried.current) {
      setFailed(true);
      return;
    }
    retried.current = true;
    nas.freshArtUrl(artId, size, src).then(setSrc, () => setFailed(true));
  };

  if (artId === null || failed) {
    return (
      <span className={`${className} poster-placeholder`} aria-hidden="true">
        {initials(name)}
      </span>
    );
  }
  return src === null ? (
    <span ref={holder} className={className} aria-hidden="true" />
  ) : (
    <img className={className} src={src} alt="" loading="lazy" decoding="async" onError={onError} />
  );
}
