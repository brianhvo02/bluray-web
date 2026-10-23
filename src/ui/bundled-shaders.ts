/** Shader files that ship with the app, fetched only when a mode that uses them is applied. */
export interface BundledShaders {
  readonly names: ReadonlySet<string>;
  load(name: string): Promise<string>;
}

/**
 * Anime4K's shaders (`./anime4k/shaders/`, see the README there) as build asset URLs. `no-inline` keeps even the small
 * files out of the bundle as data URLs, so nothing is downloaded until a mode is picked; the service worker caches what
 * was fetched for offline use.
 */
const ANIME4K_URLS: Readonly<Record<string, string>> = import.meta.glob<string>('./anime4k/shaders/*.glsl', {
  query: '?url&no-inline',
  import: 'default',
  eager: true,
});

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export function bundledAnime4k(fetchFn: (url: string) => Promise<Response> = (url) => fetch(url)): BundledShaders {
  const urls = new Map(Object.entries(ANIME4K_URLS).map(([path, url]) => [baseName(path), url]));
  return {
    names: new Set(urls.keys()),
    async load(name) {
      const url = urls.get(name);
      if (url === undefined) throw new Error(`${name} is not bundled`);
      const response = await fetchFn(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
  };
}
