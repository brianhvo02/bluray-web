import { describe, expect, it } from 'vitest';
import { normalizeTitle, titleMatches } from './title-text';

describe('normalizeTitle', () => {
  it('does not transliterate romaji', () => {
    expect(normalizeTitle('Starfall Wanderer') === normalizeTitle('sutāfōru wandarā')).toBe(false);
  });

  it('lower-cases and removes spaces and punctuation', () => {
    expect(normalizeTitle('Hoshifuri no Tabibito')).toBe('hoshifurinotabibito');
    expect(normalizeTitle("Starfall: Wanderer's End!")).toBe('starfallwanderersend');
  });

  it('folds long vowels', () => {
    expect(normalizeTitle('Tōkyō Kūsō')).toBe(normalizeTitle('Tokyo Kuso'));
    expect(normalizeTitle('Toukyou Kuusou')).toBe(normalizeTitle('Tokyo Kuso'));
    expect(normalizeTitle('Ookami')).toBe('okami');
  });

  it('folds katakana to hiragana', () => {
    expect(normalizeTitle('ヴェルミナ')).toBe(normalizeTitle('ゔぇるみな'));
    expect(normalizeTitle('ﾎｼﾌﾘ')).toBe(normalizeTitle('ほしふり'));
  });

  it('applies NFKC to full-width text', () => {
    expect(normalizeTitle('Ｓｔａｒｆａｌｌ　２')).toBe('starfall2');
  });
});

describe('titleMatches', () => {
  it('matches a normalised substring of any name', () => {
    expect(titleMatches('starfall', ['Starfall Wanderer'])).toBe(true);
    expect(titleMatches('星降り', ['星降りの旅人'])).toBe(true);
    expect(titleMatches('ホシフリ', ['Starfall Wanderer', 'ほしふりのたびびと'])).toBe(true);
    expect(titleMatches('wanderer end', ["Starfall Wanderer: End"])).toBe(true);
  });

  it('is false when no name contains the query', () => {
    expect(titleMatches('moonrise', ['Starfall Wanderer', '星降りの旅人'])).toBe(false);
    expect(titleMatches('starfall', [])).toBe(false);
  });
});
