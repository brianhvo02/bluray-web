import type { ReactElement } from 'react';
import type { PlaylistSummary } from '../engine/disc/open-disc';
import { formatTime } from './format';

interface PlaylistPickerProps {
  readonly playlists: readonly PlaylistSummary[];
  readonly usesBdj: boolean;
  /** Current error and unsupported-* messages, shown inline so the backdrop can't hide them. */
  readonly messages?: readonly string[];
  onPick(playlistId: string): void;
  readonly onClose?: () => void;
  onCloseDisc(): void;
}

export function PlaylistPicker({ playlists, usesBdj, messages = [], onPick, onClose, onCloseDisc }: PlaylistPickerProps): ReactElement {
  const mainId = playlists.find((p) => p.playable)?.id;
  const missing = playlists.length > 0 && !mainId ? [...new Set(playlists.flatMap((p) => p.missingPaths))] : [];
  return (
    <div className="picker-backdrop">
      <div className="picker" role="dialog" aria-label="Choose a playlist" data-testid="playlist-picker">
        <h2>Choose what to play</h2>
        {messages.length > 0 && (
          <div className="picker-error" role="alert" data-testid="picker-error">
            {messages.map((m) => (
              <p key={m}>{m}</p>
            ))}
          </div>
        )}
        {missing.length > 0 && (
          <div className="picker-error" role="alert" data-testid="missing-files">
            <p>This disc can't be played because these files are missing. Choose the whole disc folder, including BDMV/STREAM and BDMV/CLIPINF.</p>
            <ul className="missing-list">
              {missing.slice(0, 10).map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            {missing.length > 10 && <p>…and {missing.length - 10} more</p>}
          </div>
        )}
        {usesBdj && <p className="hint">This disc uses BD-J menus, which aren't supported. Choose a playlist; the likely main feature is marked.</p>}
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
              {!p.playable && p.missingPaths.length > 0 && <small className="playlist-missing">Missing: {p.missingPaths.join(', ')}</small>}
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
