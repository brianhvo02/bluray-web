/**
 * Discs served by the development disc server (tools/disc-server). The page learns about one from its own URL:
 * `?disc=<disc URL>&token=<token>` names one disc, `?token=<token>` alone lists the discs of the server the page
 * was loaded from (the server serves the built player too).
 */

export interface ServerLink {
  readonly token: string;
  /** The disc's URL (`…/discs/<id>`), or null to offer every disc in the list. */
  readonly disc: string | null;
  /** The server's disc list (`…/discs`). */
  readonly listUrl: string;
}

export interface ServerDisc {
  readonly name: string;
  readonly baseUrl: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DISC_PATH = /^(.*\/discs)\/([^/]+)\/?$/;

/**
 * `sameOrigin` refuses a `disc` URL on another origin than the page, so the token is only ever sent back to the server
 * that served the page (the probe page uses it). The player allows other origins: `npm run dev` opens discs on the
 * disc server across origins (tools/disc-server/README.md, CORS).
 */
export function serverLinkFromLocation(href: string, options: { readonly sameOrigin?: boolean } = {}): ServerLink | null {
  const page = new URL(href);
  const token = page.searchParams.get('token');
  if (!token) return null;
  const discParam = page.searchParams.get('disc');
  if (discParam === null) return { token, disc: null, listUrl: `${page.origin}/discs` };
  let disc: URL;
  try {
    disc = new URL(discParam, page);
  } catch {
    return null;
  }
  if (disc.protocol !== 'https:' && disc.protocol !== 'http:') return null;
  if (options.sameOrigin && disc.origin !== page.origin) return null;
  const m = DISC_PATH.exec(disc.pathname);
  if (!m) return null;
  const base = `${disc.origin}${m[0].replace(/\/$/, '')}`;
  return { token, disc: base, listUrl: `${disc.origin}${m[1]}` };
}

/** The discs a link offers, named from the server's list. A linked disc is offered even when the list fails. */
export async function listServerDiscs(link: ServerLink, fetchFn: FetchLike = (url, init) => fetch(url, init)): Promise<ServerDisc[]> {
  const listed = fetchFn(link.listUrl, { headers: { Authorization: `Bearer ${link.token}` }, cache: 'no-store' }).then(async (response) => {
    if (!response.ok) throw new Error(`The disc server answered ${response.status}${response.status === 401 ? ' (the token is from an earlier run of the server)' : ''}.`);
    const body = (await response.json()) as Array<{ id: string; name: string }>;
    return body.map((d) => ({ name: d.name, baseUrl: `${link.listUrl}/${encodeURIComponent(d.id)}` }));
  });
  if (link.disc === null) return listed;
  const disc = link.disc;
  const id = decodeURIComponent(disc.slice(disc.lastIndexOf('/') + 1));
  const named = await listed.catch(() => [] as ServerDisc[]);
  return [{ name: named.find((d) => d.baseUrl === disc)?.name ?? id, baseUrl: disc }];
}
