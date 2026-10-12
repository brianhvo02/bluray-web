import type { ReactElement } from 'react';
import type { PlaylistSummary } from '../engine/disc/open-disc';
import { formatTime } from './format';

interface PlaylistPickerProps {
  readonly playlists: readonly PlaylistSummary[];
  readonly usesBdj: boolean;
  onPick(playlistId: string): void;
  readonly onClose?: () => void;
  onCloseDisc(): void;
}

export function PlaylistPicker({ playlists, usesBdj, onPick, onClose, onCloseDisc }: PlaylistPickerProps): ReactElement {
  const mainId = playlists.find((p) => p.playable)?.id;
  return (
    <div className="picker-backdrop">
      <div className="picker" role="dialog" aria-label="Choose a playlist" data-testid="playlist-picker">
        <h2>Choose what to play</h2>
        {usesBdj && <p className="hint">This disc uses BD-J menus, which aren't supported. The longest playlist is usually the main feature.</p>}
        <ul>
          {playlists.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="playlist"
                disabled={!p.playable}
                title={p.playable ? undefined : `Missing: ${p.missingPaths.join(', ')}`}
                data-testid={`playlist-${p.id}`}
                onClick={() => onPick(p.id)}
              >
                <span className="playlist-id">{p.id}</span>
                <span>{formatTime(p.durationUs)}</span>
                <span>{p.chapterCount} chapters</span>
                {p.id === mainId && <span className="badge">Main feature</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="picker-actions">
          <button type="button" onClick={onCloseDisc}>
            Open another disc
          </button>
          {onClose && (
            <button type="button" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
