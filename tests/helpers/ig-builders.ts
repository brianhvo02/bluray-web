import { ByteWriter } from './byte-writer';

// Segment payloads as they appear in a graphics PES packet: type, 16-bit length, body.

const PDS = 0x14;
const ODS = 0x15;
const ICS = 0x18;
const END = 0x80;
const MAX_SEGMENT_BODY = 0xffff;
const SEQ_FIRST = 0x80;
const SEQ_LAST = 0x40;

function segment(type: number, body: Uint8Array): Uint8Array {
  return new ByteWriter().u8(type).u16(body.length).bytes(body).toBytes();
}

/** Splits `blob` over segments of `maxBody` bytes: header, sequence descriptor, then a slice of the blob. */
function fragments(type: number, header: Uint8Array, blob: Uint8Array, maxBody: number): Uint8Array[] {
  const room = maxBody - header.length - 1;
  const out: Uint8Array[] = [];
  for (let at = 0; at < blob.length || at === 0; at += room) {
    const first = at === 0;
    const last = at + room >= blob.length;
    const sd = (first ? SEQ_FIRST : 0) | (last ? SEQ_LAST : 0);
    out.push(segment(type, new ByteWriter().bytes(header).u8(sd).bytes(blob.subarray(at, at + room)).toBytes()));
  }
  return out;
}

export function pdsSegment(
  id: number,
  version: number,
  entries: Array<[index: number, y: number, cr: number, cb: number, t: number]>,
): Uint8Array {
  const w = new ByteWriter().u8(id).u8(version);
  for (const [index, y, cr, cb, t] of entries) w.u8(index).u8(y).u8(cr).u8(cb).u8(t);
  return segment(PDS, w.toBytes());
}

/** Run-length encodes palette-index rows the way _decode_rle reads them, ending each row with the 00 00 marker. */
export function encodeRle(rows: number[][]): Uint8Array {
  const w = new ByteWriter();
  for (const row of rows) {
    for (let i = 0; i < row.length; ) {
      const color = row[i]!;
      let len = 1;
      while (i + len < row.length && row[i + len] === color && len < 16383) len++;
      i += len;
      if (color !== 0 && len === 1) {
        w.u8(color);
      } else {
        w.u8(0).bits(1, color !== 0 ? 1 : 0);
        if (len < 64) w.bits(1, 0).bits(6, len);
        else w.bits(1, 1).bits(14, len);
        if (color !== 0) w.u8(color);
      }
    }
    w.u8(0).u8(0); // end of line
  }
  return w.toBytes();
}

/** One segment, or several when the object does not fit `maxBody` bytes. */
export function odsSegment(
  id: number,
  version: number,
  width: number,
  height: number,
  rows: number[][],
  maxBody = MAX_SEGMENT_BODY,
): Uint8Array[] {
  const rle = encodeRle(rows);
  const dataLen = rle.length + 4;
  const blob = new ByteWriter().u8(dataLen >>> 16).u16(dataLen & 0xffff).u16(width).u16(height).bytes(rle).toBytes();
  return fragments(ODS, new ByteWriter().u16(id).u8(version).toBytes(), blob, maxBody);
}

export function endSegment(): Uint8Array {
  return segment(END, new Uint8Array(0));
}

export interface EffectSpec {
  windows: Array<[id: number, x: number, y: number, width: number, height: number]>;
  effects: Array<{ duration: number; paletteId: number; objects: Array<{ objectId: number; windowId: number; x: number; y: number }> }>;
}

export interface IcsSpec {
  width?: number;
  height?: number;
  frameRateCode?: number;
  compositionNumber?: number;
  compositionState: 'epochStart' | 'acquisition' | 'normal';
  uiModel: 'alwaysOn' | 'popup';
  userTimeout?: number;
  streamModel?: 0 | 1;
  compositionTimeout?: number;
  selectionTimeout?: number;
  pages: Array<{
    id: number;
    defaultSelected: number;
    defaultActivated?: number;
    animationFrameRateCode?: number;
    paletteId: number;
    uoMask?: Uint8Array;
    inEffects?: EffectSpec;
    outEffects?: EffectSpec;
    bogs: Array<{
      defaultValid: number;
      buttons: Array<{
        id: number;
        x: number;
        y: number;
        neighbours?: [up: number, down: number, left: number, right: number];
        normal: [start: number, end: number];
        selected: [start: number, end: number];
        activated: [start: number, end: number];
        selectedSound?: number;
        activatedSound?: number;
        normalRepeat?: boolean;
        selectedRepeat?: boolean;
        autoAction?: boolean;
        numericValue?: number;
        cmds: Uint8Array[];
      }>;
    }>;
  }>;
}

const STATE = { normal: 0, acquisition: 1, epochStart: 2 } as const;
const NONE = 0xffff;

function writeEffects(w: ByteWriter, e: EffectSpec | undefined): void {
  w.u8(e?.windows.length ?? 0);
  for (const [id, x, y, width, height] of e?.windows ?? []) w.u8(id).u16(x).u16(y).u16(width).u16(height);
  w.u8(e?.effects.length ?? 0);
  for (const fx of e?.effects ?? []) {
    w.u8(fx.duration >>> 16).u16(fx.duration & 0xffff).u8(fx.paletteId).u8(fx.objects.length);
    for (const o of fx.objects) w.u16(o.objectId).u8(o.windowId).bits(8, 0).u16(o.x).u16(o.y); // crop_flag = forced_on = 0
  }
}

export function icsSegment(spec: IcsSpec, maxBody = MAX_SEGMENT_BODY): Uint8Array[] {
  const body = new ByteWriter();
  const streamModel = spec.streamModel ?? 0;
  body.bits(1, streamModel).bits(1, spec.uiModel === 'popup' ? 1 : 0).bits(6, 0);
  if (streamModel === 0) {
    body.bits(7, 0).bits(33, spec.compositionTimeout ?? 0).bits(7, 0).bits(33, spec.selectionTimeout ?? 0);
  }
  const timeout = spec.userTimeout ?? 0;
  body.u8(timeout >>> 16).u16(timeout & 0xffff).u8(spec.pages.length);
  for (const page of spec.pages) {
    body.u8(page.id).u8(0).bytes(page.uoMask ?? new Uint8Array(8));
    writeEffects(body, page.inEffects);
    writeEffects(body, page.outEffects);
    body
      .u8(page.animationFrameRateCode ?? 0)
      .u16(page.defaultSelected)
      .u16(page.defaultActivated ?? NONE)
      .u8(page.paletteId)
      .u8(page.bogs.length);
    for (const bog of page.bogs) {
      body.u16(bog.defaultValid).u8(bog.buttons.length);
      for (const b of bog.buttons) {
        const [up, down, left, right] = b.neighbours ?? [NONE, NONE, NONE, NONE];
        body
          .u16(b.id)
          .u16(b.numericValue ?? NONE)
          .bits(1, b.autoAction ? 1 : 0).bits(7, 0)
          .u16(b.x).u16(b.y)
          .u16(up).u16(down).u16(left).u16(right)
          .u16(b.normal[0]).u16(b.normal[1]).bits(1, b.normalRepeat ? 1 : 0).bits(7, 0)
          .u8(b.selectedSound ?? 0xff).u16(b.selected[0]).u16(b.selected[1]).bits(1, b.selectedRepeat ? 1 : 0).bits(7, 0)
          .u8(b.activatedSound ?? 0xff).u16(b.activated[0]).u16(b.activated[1])
          .u16(b.cmds.length);
        for (const c of b.cmds) body.bytes(c);
      }
    }
  }
  const data = body.toBytes();
  const blob = new ByteWriter().u8(data.length >>> 16).u16(data.length & 0xffff).bytes(data).toBytes();
  const header = new ByteWriter()
    .u16(spec.width ?? 1920).u16(spec.height ?? 1080).bits(4, spec.frameRateCode ?? 1).bits(4, 0) // video descriptor, frame_rate code (default 1)
    .u16(spec.compositionNumber ?? 0).bits(2, STATE[spec.compositionState]).bits(6, 0) // composition descriptor
    .toBytes();
  return fragments(ICS, header, blob, maxBody);
}

/** The segments (one per PES) of a menu with `buttons` stacked buttons on page 0 (ids 1..n, 1 selected), objects 10n..10n+2 (normal, selected, activated), one palette. */
export function simpleMenuSegments(opts: { buttons?: number; compositionState?: IcsSpec['compositionState']; width?: number; height?: number; cmds?: Uint8Array[]; activatedSound?: number } = {}): Uint8Array[] {
  const n = opts.buttons ?? 2;
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const spec: IcsSpec = {
    width: opts.width,
    height: opts.height,
    compositionState: opts.compositionState ?? 'epochStart',
    uiModel: 'alwaysOn',
    pages: [{
      id: 0, defaultSelected: 1, paletteId: 0,
      bogs: ids.map((id) => ({
        defaultValid: id,
        buttons: [{ id, x: 100, y: 100 * id, neighbours: [Math.max(1, id - 1), Math.min(n, id + 1), id, id] as [number, number, number, number], normal: [id * 10, id * 10] as [number, number], selected: [id * 10 + 1, id * 10 + 1] as [number, number], activated: [id * 10 + 2, id * 10 + 2] as [number, number], activatedSound: opts.activatedSound, cmds: opts.cmds ?? [] }],
      })),
    }],
  };
  const objects = ids.flatMap((id) => [0, 1, 2].flatMap((k) => odsSegment(id * 10 + k, 0, 8, 4, Array.from({ length: 4 }, () => new Array<number>(8).fill(1)))));
  return [...icsSegment(spec), pdsSegment(0, 0, [[1, 100, 128, 128, 255]]), ...objects, endSegment()];
}
