import { describe, expect, it } from 'vitest';
import type { StoredSubtitle } from '../../engine/disc/nas-api';
import { FONTS_LIMIT_BYTES, LANGUAGES, SUBTITLE_LIMIT_BYTES, forPlaylist, sameLanguage, startFor, tagsByEpisode, validateUpload } from './subtitle-model';

const file = (name: string, size = 10): File => new File([new Uint8Array(size)], name);

function sub(id: string, language: string, attachment: StoredSubtitle['attachment']): StoredSubtitle {
  return { id, name: id, language, offsetMs: 0, fileName: `${id}.srt`, fileSize: 1, fonts: [], attachment, uploaderPersonId: 'p', uploadedAt: 1 };
}
const ep = (episode: number, seasonId = 's1', playlistId = '00001'): StoredSubtitle['attachment'] => ({
  kind: 'episode', discKey: 'd.1', playlistId, titleId: 't', seasonId, episode,
});
const ch = (chapter: number, playlistId = '00001', discKey = 'd.1'): StoredSubtitle['attachment'] => ({ kind: 'chapter', discKey, playlistId, chapter });

describe('LANGUAGES', () => {
  it('lists the offered languages', () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(['en', 'ja', 'zh-Hans', 'zh-Hant', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'ru']);
  });
});

describe('validateUpload', () => {
  it('takes one subtitle and its fonts', () => {
    const sub = file('a.ASS');
    const font = file('f.ttf');
    expect(validateUpload([font, sub])).toEqual({ subtitle: sub, fonts: [font] });
  });
  it('refuses two subtitle files', () => {
    expect(validateUpload([file('a.srt'), file('b.ass')])).toEqual({ error: 'Pick one subtitle file (SRT or ASS) at a time.' });
  });
  it('refuses a pick with no subtitle file, fonts only included', () => {
    expect(validateUpload([file('f.ttf')])).toEqual({ error: 'Pick a subtitle file (SRT, ASS or SSA).' });
    expect(validateUpload([])).toEqual({ error: 'Pick a subtitle file (SRT, ASS or SSA).' });
  });
  it('refuses files that are neither', () => {
    expect(validateUpload([file('a.srt'), file('notes.txt')])).toEqual({ error: 'notes.txt is neither a subtitle file nor a font.' });
  });
  it('refuses an empty subtitle file', () => {
    expect(validateUpload([file('a.srt', 0)])).toEqual({ error: 'a.srt is empty.' });
  });
  it('limits the subtitle file to 5 MB', () => {
    expect('subtitle' in validateUpload([file('a.srt', SUBTITLE_LIMIT_BYTES)])).toBe(true);
    expect(validateUpload([file('a.srt', SUBTITLE_LIMIT_BYTES + 1)])).toEqual({ error: 'a.srt is over 5 MB.' });
  });
  it('limits the fonts to 50 MB together', () => {
    const half = FONTS_LIMIT_BYTES / 2;
    expect('subtitle' in validateUpload([file('a.srt'), file('a.ttf', half), file('b.otf', half)])).toBe(true);
    expect(validateUpload([file('a.srt'), file('a.ttf', half), file('b.otf', half + 1)])).toEqual({ error: 'The fonts are over 50 MB together.' });
  });
});

describe('tagsByEpisode', () => {
  it('maps episodes to sorted, unique languages of the season', () => {
    const subs = [sub('a', 'ja', ep(1)), sub('b', 'en', ep(1)), sub('c', 'en', ep(1)), sub('d', 'fr', ep(2)), sub('e', 'de', ep(1, 's2')), sub('f', 'ko', ch(1))];
    expect(tagsByEpisode(subs, 's1')).toEqual(new Map([[1, ['en', 'ja']], [2, ['fr']]]));
  });
});

describe('forPlaylist', () => {
  it('keeps the subtitles of a disc and playlist', () => {
    const a = sub('a', 'en', ep(1));
    const b = sub('b', 'en', ch(2, '00002'));
    const c = sub('c', 'en', ch(2, '00001', 'd.2'));
    expect(forPlaylist([a, b, c], 'd.1', '00001')).toEqual([a]);
  });
});

describe('startFor', () => {
  const chapters = [{ startUs: 0 }, { startUs: 90e6 }];
  it('starts an episode subtitle at 0', () => {
    expect(startFor(sub('a', 'en', ep(1)), chapters)).toBe(0);
  });
  it('starts a chapter subtitle at its chapter', () => {
    expect(startFor(sub('a', 'en', ch(1)), chapters)).toBe(90e6);
  });
  it('is null when the chapter is not there', () => {
    expect(startFor(sub('a', 'en', ch(2)), chapters)).toBeNull(); // the third of two
    expect(startFor(sub('a', 'en', ch(-1)), chapters)).toBeNull();
  });
});

describe('sameLanguage', () => {
  it('finds the first of a language, case-insensitively', () => {
    const a = sub('a', 'ja', ep(1));
    const b = sub('b', 'en', ep(1));
    expect(sameLanguage([a, b], 'EN')).toBe(b);
    expect(sameLanguage([a, b], 'fr')).toBeNull();
  });
});
