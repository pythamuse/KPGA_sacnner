/**
 * Deterministic ordering for a batch of loose photo files selected in one
 * `<input type="file" multiple>` pick (Task/PHOTO_BATCH_ORDER_2026-09-09.md
 * §3 item A). Pure and DOM-light on purpose -- no React, so it is directly
 * unit-testable and reusable from the review-list UI in ImageUploadPanel.
 *
 * FileList order is whatever the OS file picker or camera-roll multi-select
 * produced, which is not reliably capture order on every platform. JPEG EXIF
 * `DateTimeOriginal` (tag 0x9003, inside the Exif sub-IFD pointed to by tag
 * 0x8769 in IFD0) is the actual capture clock when present; `File.lastModified`
 * and a number embedded in the filename are the fallbacks, in that order.
 */

/** Only the first ~128 KB of a JPEG is read -- EXIF lives in the leading
 *  APP1 segment, long before any scan/compressed data starts. */
const EXIF_SCAN_BYTES = 131072;

const JPEG_SOI = 0xffd8;
const MARKER_PREFIX = 0xff;
const APP1_MARKER = 0xe1;
const SOS_MARKER = 0xda;
const EOI_MARKER = 0xd9;

const TIFF_LITTLE_ENDIAN = 0x4949; // 'II'
const TIFF_BIG_ENDIAN = 0x4d4d; // 'MM'
const TIFF_MAGIC = 0x002a;

const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Absolute byte offset (into the DataView) of the 4-byte value/offset field. */
  valueFieldOffset: number;
}

function readIfdEntries(view: DataView, tiffStart: number, ifdAddr: number, little: boolean): IfdEntry[] {
  if (ifdAddr < 0 || ifdAddr + 2 > view.byteLength) return [];
  const count = view.getUint16(ifdAddr, little);
  const entries: IfdEntry[] = [];
  let cursor = ifdAddr + 2;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 12 > view.byteLength) break;
    entries.push({
      tag: view.getUint16(cursor, little),
      type: view.getUint16(cursor + 2, little),
      count: view.getUint32(cursor + 4, little),
      valueFieldOffset: cursor + 8,
    });
    cursor += 12;
  }
  return entries;
}

function readLongTagValue(
  view: DataView,
  tiffStart: number,
  ifdAddr: number,
  tag: number,
  little: boolean,
): number | null {
  const entry = readIfdEntries(view, tiffStart, ifdAddr, little).find((candidate) => candidate.tag === tag);
  if (!entry) return null;
  if (entry.valueFieldOffset + 4 > view.byteLength) return null;
  return view.getUint32(entry.valueFieldOffset, little);
}

function readAsciiTagValue(
  view: DataView,
  tiffStart: number,
  ifdAddr: number,
  tag: number,
  little: boolean,
): string | null {
  const entry = readIfdEntries(view, tiffStart, ifdAddr, little).find((candidate) => candidate.tag === tag);
  if (!entry) return null;

  // ASCII type is 1 byte/component; a value <= 4 bytes is stored inline in
  // the value field itself, otherwise the field holds an offset to it.
  const byteCount = entry.count;
  let dataStart: number;
  if (byteCount <= 4) {
    dataStart = entry.valueFieldOffset;
  } else {
    if (entry.valueFieldOffset + 4 > view.byteLength) return null;
    dataStart = tiffStart + view.getUint32(entry.valueFieldOffset, little);
  }
  if (dataStart < 0 || dataStart + byteCount > view.byteLength) return null;

  let text = '';
  for (let i = 0; i < byteCount; i += 1) {
    const code = view.getUint8(dataStart + i);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text.length > 0 ? text : null;
}

/** "YYYY:MM:DD HH:MM:SS" (EXIF has no timezone field) -> epoch ms, via
 *  `Date.UTC` so the result does not depend on the host's local timezone. */
function parseExifDateTime(value: string): number | null {
  const match = /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if ([year, month, day, hour, minute, second].some((n) => !Number.isFinite(n))) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(ms) ? ms : null;
}

function parseTiffForDateTimeOriginal(view: DataView, tiffStart: number): number | null {
  if (tiffStart + 8 > view.byteLength) return null;

  const byteOrderMark = view.getUint16(tiffStart, false);
  let little: boolean;
  if (byteOrderMark === TIFF_LITTLE_ENDIAN) little = true;
  else if (byteOrderMark === TIFF_BIG_ENDIAN) little = false;
  else return null;

  const magic = view.getUint16(tiffStart + 2, little);
  if (magic !== TIFF_MAGIC) return null;

  const ifd0Offset = view.getUint32(tiffStart + 4, little);
  const ifd0Addr = tiffStart + ifd0Offset;

  const exifIfdOffset = readLongTagValue(view, tiffStart, ifd0Addr, TAG_EXIF_IFD_POINTER, little);
  if (exifIfdOffset == null) return null;
  const exifIfdAddr = tiffStart + exifIfdOffset;

  const dateTimeOriginal = readAsciiTagValue(view, tiffStart, exifIfdAddr, TAG_DATE_TIME_ORIGINAL, little);
  if (!dateTimeOriginal) return null;

  return parseExifDateTime(dateTimeOriginal);
}

/**
 * Parses `file`'s JPEG EXIF `DateTimeOriginal` and returns it as epoch ms, or
 * `null` when the file is not a JPEG, carries no EXIF, or the segment is
 * malformed. Never throws -- a bad photo file must not break the batch pick.
 */
export async function readCaptureTime(file: File): Promise<number | null> {
  try {
    if (file.type && file.type !== 'image/jpeg' && file.type !== 'image/jpg') {
      return null;
    }

    const head = await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer();
    if (head.byteLength < 4) return null;
    const view = new DataView(head);

    if (view.getUint16(0, false) !== JPEG_SOI) return null;

    let offset = 2;
    while (offset + 2 <= view.byteLength) {
      if (view.getUint8(offset) !== MARKER_PREFIX) break;
      const marker = view.getUint8(offset + 1);
      offset += 2;

      // Markers with no payload/length field.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === EOI_MARKER || marker === SOS_MARKER) break;
      if (offset + 2 > view.byteLength) break;

      const segmentLength = view.getUint16(offset, false);
      if (segmentLength < 2) break;

      if (marker === APP1_MARKER) {
        const segStart = offset + 2;
        if (segStart + 6 <= view.byteLength) {
          const isExif = view.getUint8(segStart) === 0x45 // E
            && view.getUint8(segStart + 1) === 0x78 // x
            && view.getUint8(segStart + 2) === 0x69 // i
            && view.getUint8(segStart + 3) === 0x66 // f
            && view.getUint8(segStart + 4) === 0x00
            && view.getUint8(segStart + 5) === 0x00;

          if (isExif) {
            const result = parseTiffForDateTimeOriginal(view, segStart + 6);
            if (result != null) return result;
          }
        }
      }

      offset += segmentLength;
    }

    return null;
  } catch {
    return null;
  }
}

function extractFirstInt(name: string): number | null {
  const match = name.match(/\d+/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/** [captureTime, lastModified, filename-number, filename], missing numeric
 *  tiers pushed to +Infinity so they sort after every known value in that
 *  tier and fall through to the next one. */
export type OrderKey = [number, number, number, string];

/**
 * The sortable key for one file: capture time, then `lastModified`, then the
 * first integer found in the filename, then the filename itself. A tier a
 * file has no value for sorts after every file that does, so it falls
 * through to the next tier instead of the whole file being ordered
 * arbitrarily against sibling files that DO have that value.
 */
export function orderKeyFor(file: File, captureTime: number | null): OrderKey {
  const captureTimeKey = captureTime != null && Number.isFinite(captureTime)
    ? captureTime
    : Number.POSITIVE_INFINITY;
  const lastModifiedKey = Number.isFinite(file.lastModified) ? file.lastModified : Number.POSITIVE_INFINITY;
  const filenameInt = extractFirstInt(file.name);
  const filenameIntKey = filenameInt != null ? filenameInt : Number.POSITIVE_INFINITY;
  return [captureTimeKey, lastModifiedKey, filenameIntKey, file.name];
}

function compareOrderKey(a: OrderKey, b: OrderKey): number {
  for (let i = 0; i < 3; i += 1) {
    // Not a subtraction: two missing (Infinity) values on the same tier
    // must compare equal so the sort falls through to the next tier --
    // `Infinity - Infinity` is NaN, which `Array.prototype.sort` does not
    // treat as "equal" and silently leaves the whole comparison broken.
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return a[3].localeCompare(b[3], undefined, { numeric: true, sensitivity: 'base' });
}

export interface OrderableBatchItem {
  file: File;
  captureTime: number | null;
}

/**
 * Orders `items` by `orderKeyFor`, stably: two items with an identical key
 * keep their original relative (FileList) order rather than being shuffled
 * by however the underlying `Array.prototype.sort` happens to behave.
 */
export function sortBatchImages<T extends OrderableBatchItem>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index, key: orderKeyFor(item.file, item.captureTime) }))
    .sort((a, b) => {
      const cmp = compareOrderKey(a.key, b.key);
      return cmp !== 0 ? cmp : a.index - b.index;
    })
    .map(({ item }) => item);
}
