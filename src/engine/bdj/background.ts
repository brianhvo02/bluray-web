/*
 * Original code for bluray-web: the HAVi background still a BD-J title shows under the video
 * (HStillImageBackgroundConfiguration.displayImage, natives/havi.ts). libbluray never draws one; a player does. Its
 * pixels are never visible to Java, so the browser decodes the encoded bytes (createImageBitmap in production).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/** An HScreenRectangle: part of the screen in normalised coordinates (0 to 1). */
export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A still that is shown: the decoded image and where on the screen it goes. */
export interface ShownStill {
  readonly image: ImageBitmap;
  readonly rect: ScreenRect;
}

/** Decodes an encoded image (PNG, JPEG, GIF); createImageBitmap in production. */
export type DecodeImage = (bytes: Uint8Array) => Promise<ImageBitmap>;

export interface BackgroundStillDeps {
  readonly decode: DecodeImage;
  /** The still to draw from now on (null: none); called before the previous one is closed. */
  readonly onChange: (still: ShownStill | null) => void;
  readonly onError?: (message: string) => void;
}

const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/**
 * The background still of one player: at most one decoded image is held, and it is closed (about 8 MB at 1920×1080)
 * as soon as a newer still replaces it or the background is cleared. A decode that finishes after a newer still or a
 * clear is closed at once and never shown.
 */
export class BackgroundStill {
  private generation = 0;
  private shown: ShownStill | null = null;

  constructor(private readonly deps: BackgroundStillDeps) {}

  get current(): ShownStill | null {
    return this.shown;
  }

  /** Decodes `bytes` and shows them in `rect`, replacing the current still; one that cannot be decoded clears it. */
  show(bytes: Uint8Array, rect: ScreenRect): void {
    const gen = ++this.generation;
    const r: ScreenRect = { x: finite(rect.x, 0), y: finite(rect.y, 0), width: finite(rect.width, 1), height: finite(rect.height, 1) };
    let decoding: Promise<ImageBitmap>;
    try {
      decoding = this.deps.decode(bytes);
    } catch (e) {
      decoding = Promise.reject(e);
    }
    decoding.then(
      (image) => {
        if (gen !== this.generation) image.close();
        else this.replace({ image, rect: r });
      },
      (e: unknown) => {
        if (gen !== this.generation) return;
        this.deps.onError?.(`a background image could not be decoded: ${e instanceof Error ? e.message : String(e)}`);
        this.replace(null);
      },
    );
  }

  /** Nothing is shown from now on, and no decode under way will be. */
  clear(): void {
    this.generation++;
    this.replace(null);
  }

  private replace(next: ShownStill | null): void {
    const prev = this.shown;
    if (prev === null && next === null) return;
    this.shown = next;
    this.deps.onChange(next);
    prev?.image.close();
  }
}
