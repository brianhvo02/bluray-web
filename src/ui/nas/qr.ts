import qrcode from 'qrcode-generator';

/** The quiet zone around the symbol, in modules (the QR standard asks for four). */
const MARGIN = 4;

/**
 * A QR of `text` for an SVG: `size` is the side in modules (quiet zone included), for the viewBox;
 * `path` draws each dark module as a 1×1 square.
 */
export function qrSvg(text: string): { size: number; path: string } {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) path += `M${col + MARGIN} ${row + MARGIN}h1v1h-1z`;
    }
  }
  return { size: modules + 2 * MARGIN, path };
}
