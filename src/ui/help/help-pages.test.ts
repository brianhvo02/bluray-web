import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { marked, type Token } from 'marked';
import { describe, expect, it } from 'vitest';
import { githubSlug, HELP_PAGES, helpHref, helpPath, parseHelpPath, uniqueSlugger } from './help-pages';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file: string): string => readFileSync(repo + file, 'utf8');

function tokensOf(file: string): Token[] {
  const all: Token[] = [];
  marked.walkTokens(marked.lexer(read(file)), (t) => void all.push(t));
  return all;
}

const isAbsolute = (href: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');

/** The heading ids a page gets, as the site (and GitHub) make them. */
function anchorsOf(file: string): Set<string> {
  const slug = uniqueSlugger();
  return new Set(tokensOf(file).flatMap((t) => (t.type === 'heading' ? [slug(t.text.replace(/[`*_]/g, ''))] : [])));
}

describe('help pages', () => {
  it('lists the five pages, each titled by its own heading', () => {
    expect(HELP_PAGES.map((p) => p.slug)).toEqual(['getting-started', 'playing-discs', 'nas', 'troubleshooting', 'self-hosting']);
    for (const page of HELP_PAGES) {
      expect(read(page.file).split('\n')[0]).toBe(`# ${page.title}`);
    }
  });

  it('every relative .md link resolves', () => {
    for (const page of HELP_PAGES) {
      for (const t of tokensOf(page.file)) {
        if (t.type !== 'link' && t.type !== 'image') continue;
        const href = (t as { href: string }).href;
        if (isAbsolute(href) || href.startsWith('#')) continue;
        const target = new URL(href, `https://repo.invalid/${page.file}`);
        const path = decodeURIComponent(target.pathname.slice(1));
        expect(existsSync(repo + path), `${page.file} links to ${href}`).toBe(true);
        const hash = decodeURIComponent(target.hash.slice(1));
        const linked = HELP_PAGES.find((p) => p.file === path);
        if (hash && linked) expect(anchorsOf(linked.file).has(hash), `${page.file} links to ${href}`).toBe(true);
      }
    }
  });

  it('no page references an external image', () => {
    for (const page of HELP_PAGES) {
      for (const t of tokensOf(page.file)) {
        if (t.type === 'image') expect(isAbsolute((t as { href: string }).href), `${page.file}: ${t.raw}`).toBe(false);
        if (t.type === 'html') expect(t.raw, `${page.file}: ${t.raw}`).not.toMatch(/<(img|script|iframe|link|video|audio|source)\b/i);
      }
    }
  });
});

describe('helpHref', () => {
  it('help links map to /help', () => {
    expect(helpHref('nas.md#pairing', 'docs/getting-started.md')).toBe('/help/nas#pairing');
    expect(helpHref('troubleshooting.md', 'docs/nas.md')).toBe('/help/troubleshooting');
    expect(helpHref('./self-hosting.md', 'docs/nas.md')).toBe('/help/self-hosting');
    expect(helpHref('docs/nas.md', 'README.md')).toBe('/help/nas');
  });

  it('repo-only links go to GitHub', () => {
    expect(helpHref('contributing.md', 'docs/nas.md')).toBe('https://github.com/brianhvo02/bluray-web/blob/main/docs/contributing.md');
    expect(helpHref('../CLAUDE.md', 'docs/nas.md')).toBe('https://github.com/brianhvo02/bluray-web/blob/main/CLAUDE.md');
    expect(helpHref('../server/deploy/compose.yaml#L3', 'docs/self-hosting.md')).toBe(
      'https://github.com/brianhvo02/bluray-web/blob/main/server/deploy/compose.yaml#L3',
    );
    expect(helpHref('/LICENSE', 'docs/nas.md')).toBe('https://github.com/brianhvo02/bluray-web/blob/main/LICENSE');
  });

  it('leaves absolute URLs and in-page anchors unchanged', () => {
    expect(helpHref('https://bluray-web.pages.dev', 'docs/nas.md')).toBe('https://bluray-web.pages.dev');
    expect(helpHref('mailto:someone@example.com', 'docs/nas.md')).toBe('mailto:someone@example.com');
    expect(helpHref('#pairing', 'docs/nas.md')).toBe('#pairing');
  });
});

describe('help paths', () => {
  it('parses /help and /help/<slug>', () => {
    expect(parseHelpPath('/help')).toEqual({ slug: null });
    expect(parseHelpPath('/help/')).toEqual({ slug: null });
    expect(parseHelpPath('/help/nas')).toEqual({ slug: 'nas' });
    expect(parseHelpPath('/help/troubleshooting/')).toEqual({ slug: 'troubleshooting' });
  });

  it('an unknown slug shows the index', () => {
    expect(parseHelpPath('/help/no-such-page')).toEqual({ slug: null });
    expect(parseHelpPath('/help/nas/extra')).toEqual({ slug: null });
  });

  it('is not a help path outside /help', () => {
    expect(parseHelpPath('/')).toBeNull();
    expect(parseHelpPath('/nas')).toBeNull();
    expect(parseHelpPath('/helpful')).toBeNull();
  });

  it('builds paths', () => {
    expect(helpPath(null)).toBe('/help');
    expect(helpPath('nas')).toBe('/help/nas');
  });
});

describe('githubSlug', () => {
  it('makes heading ids as GitHub does', () => {
    expect(githubSlug('Pairing')).toBe('pairing');
    expect(githubSlug('Audio, subtitles & text')).toBe('audio-subtitles--text');
    expect(githubSlug('What "no picture" means')).toBe('what-no-picture-means');
    expect(githubSlug('BD-J menus')).toBe('bd-j-menus');
    expect(githubSlug('日本語 タイトル')).toBe('日本語-タイトル');
  });

  it('numbers repeated headings', () => {
    const slug = uniqueSlugger();
    expect([slug('Notes'), slug('Notes'), slug('Notes')]).toEqual(['notes', 'notes-1', 'notes-2']);
  });
});
