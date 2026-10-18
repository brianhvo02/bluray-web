import type { ParsedName } from './parse-name';

/**
 * Synthetic folder names and disc titles, one or more per naming style in the library (spec §3), with what the parser
 * must read from them. Every title here is made up: the repo is public, and the real listing stays in
 * fixtures/local/library-paths.txt.
 */
export const NAME_CORPUS: readonly { readonly text: string; readonly expected: Partial<ParsedName> }[] = [
  // Japanese release
  { text: '[BDMV][220629][Kumo no Ue no Tenshi][Vol.4]', expected: { candidates: ['Kumo no Ue no Tenshi'], volume: 4, disc: null, bonus: false, music: false } },
  { text: '[BDMV][アニメ][140319] 鋼の城塞 Vol.9 特典DISC', expected: { candidates: ['鋼の城塞'], volume: 9, bonus: true, music: false } },
  { text: '[BDMV][アニメ][赤い森の少女][Vol.1-Vol.12 Fin]', expected: { candidates: ['赤い森の少女'], volume: null } },
  { text: '赤い森の少女 Vol.3', expected: { candidates: ['赤い森の少女'], volume: 3 } },
  { text: '【BDMV】【210414】風車の街 第2期 Vol.1', expected: { candidates: ['風車の街'], season: 2, volume: 1 } },
  { text: '[BDMV][230118] 夜明けの約束 BOX2 Disc3', expected: { candidates: ['夜明けの約束'], box: 2, disc: 3 } },
  { text: '[BDMV] 青い港 [第13話]', expected: { candidates: ['青い港'], episodes: [13, 13] } },
  { text: '[BDMV][190925] 白銀の騎士団 第二期 第三巻 (ABCD-12345)', expected: { candidates: ['白銀の騎士団'], season: 2, volume: 3 } },
  { text: '[BDMV][250101] 雪解けの歌 初回生産限定版 DISC2', expected: { candidates: ['雪解けの歌'], disc: 2 } },

  // The user's tidy layout
  { text: 'Starfall Wanderer (星降りの旅人)', expected: { candidates: ['Starfall Wanderer', '星降りの旅人'], season: null, volume: null } },
  { text: 'Volume 2', expected: { candidates: [], volume: 2 } },
  { text: 'Season 3', expected: { candidates: [], season: 3 } },
  { text: 'Disc 7', expected: { candidates: [], disc: 7 } },
  { text: '[Bonus] Volume 3', expected: { candidates: [], volume: 3, bonus: true } },
  { text: 'Paper Lanterns (紙灯籠) (2024)', expected: { candidates: ['Paper Lanterns', '紙灯籠'], year: 2024 } },

  // Disc titles (bdmt di:name)
  { text: '月影の教室 2nd Season VOL.1', expected: { candidates: ['月影の教室'], season: 2, volume: 1 } },
  { text: '盤上の風 第8巻 DISC2', expected: { candidates: ['盤上の風'], volume: 8, disc: 2 } },
  { text: 'Silent Archive Act.2 下巻', expected: { volume: 2 } },
  { text: 'Silent Archive 上巻', expected: { candidates: ['Silent Archive'], volume: 1 } },
  { text: '星降りの旅人 2', expected: { candidates: ['星降りの旅人'], volume: 2 } },
  { text: 'Orbit Patrol: The Long Watch Season 2 Disc 2', expected: { candidates: ['Orbit Patrol: The Long Watch'], season: 2, disc: 2 } },
  { text: 'IRONWOOD Blu-ray Box Season3 Disc3', expected: { candidates: ['IRONWOOD'], season: 3, disc: 3 } },

  // Scene
  { text: 'Ink.and.Iron.S05.1080p.JPN.Blu-ray.AVC.LPCM.2.0-GRP', expected: { candidates: ['Ink and Iron'], season: 5, year: null } },
  { text: 'Lantern.Road.2025.2160p.USA.UHD.Blu-ray.HEVC-GRP', expected: { candidates: ['Lantern Road'], year: 2025 } },
  { text: 'Quiet.Harbor.S02E05.1080p.Blu-ray.REMUX.AVC.FLAC.2.0-GRP', expected: { candidates: ['Quiet Harbor'], season: 2, music: false } },
  { text: 'Crimson.Gale.Fleet.Vol.3.1080p.BluRay.AVC-GRP', expected: { candidates: ['Crimson Gale Fleet'], volume: 3 } },
  { text: 'BDROM_22', expected: { candidates: ['BDROM 22'] } },

  // Loose
  { text: 'RIVERSIDE S02 VOL.2', expected: { candidates: ['RIVERSIDE'], season: 2, volume: 2 } },
  { text: 'BD', expected: { candidates: [] } },
  { text: '遠い空の色', expected: { candidates: ['遠い空の色'] } },
  { text: 'Harbor Quake 8.0', expected: { candidates: ['Harbor Quake 8.0'], volume: null } },
  { text: 'Spirit Blade Season 14 - The Long Night (266-316)', expected: { candidates: ['Spirit Blade'], season: 14, episodes: [266, 316] } },
  { text: 'Night Courier D3', expected: { candidates: ['Night Courier'], disc: 3 } },
  { text: 'Night Courier VOL_3', expected: { candidates: ['Night Courier'], volume: 3 } },
  { text: '灯台守 第2シリーズ', expected: { candidates: ['灯台守'], season: 2 } },
  { text: 'Moss Garden Box 02', expected: { candidates: ['Moss Garden'], box: 2 } },

  // Bonus discs
  { text: '潮騒の島 映像特典', expected: { candidates: ['潮騒の島'], bonus: true } },
  { text: 'Reading&Live Event', expected: { bonus: true } },

  // Music
  { text: '[2025.03.26] 架空バンド - Morning Signal [CD][FLAC+CUE+LOG+BK+BDMV][XXCL-1234~5]', expected: { candidates: ['架空バンド - Morning Signal'], music: true } },
  { text: '[2024.11.06] Paper Kite Orchestra - Blue Hours [FLAC][BDMV]', expected: { candidates: ['Paper Kite Orchestra - Blue Hours'], music: true } },

  // Full-width and mixed-script numbers (Review Focus 4)
  { text: '風車の街 第２期', expected: { candidates: ['風車の街'], season: 2 } },
  { text: 'Ｖｏｌ．３', expected: { candidates: [], volume: 3 } },
  { text: '盤上の風 ＤＩＳＣ２', expected: { candidates: ['盤上の風'], disc: 2 } },
  { text: '夜明けの約束（よあけのやくそく）　第８巻', expected: { candidates: ['夜明けの約束', 'よあけのやくそく'], volume: 8 } },
];
