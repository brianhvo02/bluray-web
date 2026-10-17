/** Types shared by the NAS server and the app. No runtime code. */

export interface DiscEntry {
  readonly id: string;
  readonly name: string;
  /** Root-relative, e.g. 'drv5/[250226] きみの色'. This is the key: names can repeat across roots. */
  readonly path: string;
  readonly kind: 'folder' | 'iso';
  readonly sizeBytes: number;
}

export interface FolderEntry {
  readonly name: string;
  readonly path: string;
  /** Discs below it. */
  readonly discs: number;
}

export interface LibraryListing {
  readonly folders: FolderEntry[];
  readonly discs: DiscEntry[];
  readonly scanning: boolean;
}
