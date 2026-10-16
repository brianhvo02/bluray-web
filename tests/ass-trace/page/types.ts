/** What tests/ass-trace/page exposes on window.assTrace for the Playwright specs. */
export interface AssTraceRun {
  /** Our layout in the trace format (formatTrace), all times. */
  readonly trace: string;
  /** Per time, when pixels were asked for: the 1920×1080 frame as base64 RGBA on #808080. */
  readonly frames: readonly string[];
  readonly missingFamilies: readonly string[];
}

export interface AssTracePage {
  run(scriptUrl: string, fontUrls: readonly string[], times: readonly number[], pixels: boolean, storage: readonly [number, number] | null): Promise<AssTraceRun>;
}
