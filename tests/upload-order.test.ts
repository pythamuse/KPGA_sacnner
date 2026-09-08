import { describe, it, expect } from 'vitest';
import { readCaptureTime, sortBatchImages } from '../src/lib/uploadOrder';

/** Attaches a tracking id to a File so a test can read back which physical
 *  input landed where after sorting, independent of name/lastModified. */
function makeFile(name: string, lastModified: number, testId: string): File {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg', lastModified });
  (file as unknown as { _testId: string })._testId = testId;
  return file;
}

const idsOf = (items: Array<{ file: File }>) => items.map((item) => (item.file as unknown as { _testId: string })._testId);

describe('sortBatchImages', () => {
  it('orders by capture time, overriding the FileList (input array) order', () => {
    const a = { file: makeFile('a.jpg', 1000, 'a'), captureTime: 3000 };
    const b = { file: makeFile('b.jpg', 1000, 'b'), captureTime: 1000 };
    const c = { file: makeFile('c.jpg', 1000, 'c'), captureTime: 2000 };
    // Input order a, b, c; capture-time order is b, c, a.
    expect(idsOf(sortBatchImages([a, b, c]))).toEqual(['b', 'c', 'a']);
  });

  it('falls back to File.lastModified when no item has a capture time', () => {
    const a = { file: makeFile('a.jpg', 3000, 'a'), captureTime: null };
    const b = { file: makeFile('b.jpg', 1000, 'b'), captureTime: null };
    const c = { file: makeFile('c.jpg', 2000, 'c'), captureTime: null };
    expect(idsOf(sortBatchImages([a, b, c]))).toEqual(['b', 'c', 'a']);
  });

  it('falls back to the first integer in the filename when capture time and lastModified tie', () => {
    const a = { file: makeFile('img10.jpg', 5000, 'a'), captureTime: null };
    const b = { file: makeFile('img2.jpg', 5000, 'b'), captureTime: null };
    const c = { file: makeFile('img1.jpg', 5000, 'c'), captureTime: null };
    // Numeric order (1, 2, 10), not lexicographic ("1", "10", "2").
    expect(idsOf(sortBatchImages([a, b, c]))).toEqual(['c', 'b', 'a']);
  });

  it('is stable: items tied on every tier keep their original relative order', () => {
    const a = { file: makeFile('same.jpg', 5000, 'a'), captureTime: null };
    const b = { file: makeFile('same.jpg', 5000, 'b'), captureTime: null };
    const c = { file: makeFile('same.jpg', 5000, 'c'), captureTime: null };
    expect(idsOf(sortBatchImages([a, b, c]))).toEqual(['a', 'b', 'c']);
    // Different input order -> different (still stable) output order.
    expect(idsOf(sortBatchImages([c, a, b]))).toEqual(['c', 'a', 'b']);
  });

  it('lets a known capture time win over an unknown one via the lastModified tie-break', () => {
    // Both captureTime null vs one known: tier 1 keys are Infinity vs a
    // finite number, so the finite one sorts first regardless of lastModified.
    const known = { file: makeFile('known.jpg', 9000, 'known'), captureTime: 500 };
    const unknown = { file: makeFile('unknown.jpg', 1000, 'unknown'), captureTime: null };
    expect(idsOf(sortBatchImages([unknown, known]))).toEqual(['known', 'unknown']);
  });
});

// --- Hand-built minimal JPEG + Exif APP1 segment -----------------------

/**
 * Builds a minimal JPEG (SOI, one APP1/Exif segment carrying only
 * IFD0 -> Exif IFD -> DateTimeOriginal, EOI) in the given TIFF byte order.
 * No image data -- readCaptureTime stops walking markers at EOI/SOS, so
 * none is needed to exercise the EXIF parser.
 */
function buildExifJpeg(byteOrder: 'II' | 'MM', dateTimeOriginal: string): Uint8Array {
  const little = byteOrder === 'II';
  const dateBytes = new TextEncoder().encode(`${dateTimeOriginal}\0`);

  // TIFF layout (offsets relative to the TIFF header start):
  //   0  byte-order mark (2) + magic 0x002A (2) + IFD0 offset (4) = 8
  //   8  IFD0: count(2) + one 12-byte entry (Exif IFD pointer) + next-IFD(4) = 18 bytes -> ends at 26
  //   26 Exif IFD: count(2) + one 12-byte entry (DateTimeOriginal) + next-IFD(4) = 18 bytes -> ends at 44
  //   44 DateTimeOriginal ASCII data
  const ifd0Offset = 8;
  const exifIfdOffset = 26;
  const dateDataOffset = 44;
  const tiffLength = dateDataOffset + dateBytes.length;

  const tiff = new Uint8Array(tiffLength);
  const view = new DataView(tiff.buffer);

  tiff[0] = little ? 0x49 : 0x4d;
  tiff[1] = little ? 0x49 : 0x4d;
  view.setUint16(2, 0x002a, little);
  view.setUint32(4, ifd0Offset, little);

  view.setUint16(ifd0Offset, 1, little); // 1 entry
  const ifd0Entry = ifd0Offset + 2;
  view.setUint16(ifd0Entry, 0x8769, little); // tag: Exif IFD pointer
  view.setUint16(ifd0Entry + 2, 4, little); // type: LONG
  view.setUint32(ifd0Entry + 4, 1, little); // count: 1
  view.setUint32(ifd0Entry + 8, exifIfdOffset, little); // value: offset to Exif IFD
  view.setUint32(ifd0Entry + 12, 0, little); // next IFD: none

  view.setUint16(exifIfdOffset, 1, little); // 1 entry
  const exifEntry = exifIfdOffset + 2;
  view.setUint16(exifEntry, 0x9003, little); // tag: DateTimeOriginal
  view.setUint16(exifEntry + 2, 2, little); // type: ASCII
  view.setUint32(exifEntry + 4, dateBytes.length, little); // count
  view.setUint32(exifEntry + 8, dateDataOffset, little); // offset to string data
  view.setUint32(exifEntry + 12, 0, little); // next IFD: none

  tiff.set(dateBytes, dateDataOffset);

  const exifHeader = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
  const app1Payload = new Uint8Array(exifHeader.length + tiff.length);
  app1Payload.set(exifHeader, 0);
  app1Payload.set(tiff, exifHeader.length);

  const app1Segment = new Uint8Array(4 + app1Payload.length);
  app1Segment[0] = 0xff;
  app1Segment[1] = 0xe1; // APP1
  new DataView(app1Segment.buffer).setUint16(2, app1Payload.length + 2, false); // segment length is always big-endian
  app1Segment.set(app1Payload, 4);

  const full = new Uint8Array(2 + app1Segment.length + 2); // SOI + APP1 + EOI
  full.set([0xff, 0xd8], 0);
  full.set(app1Segment, 2);
  full.set([0xff, 0xd9], 2 + app1Segment.length);
  return full;
}

describe('readCaptureTime', () => {
  it('reads DateTimeOriginal from a little-endian ("II") Exif segment', async () => {
    const bytes = buildExifJpeg('II', '2026:09:09 10:30:00');
    const file = new File([bytes.buffer as ArrayBuffer], 'photo.jpg', { type: 'image/jpeg' });
    expect(await readCaptureTime(file)).toBe(Date.UTC(2026, 8, 9, 10, 30, 0));
  });

  it('reads DateTimeOriginal from a big-endian ("MM") Exif segment', async () => {
    const bytes = buildExifJpeg('MM', '2026:01:02 08:15:45');
    const file = new File([bytes.buffer as ArrayBuffer], 'photo.jpg', { type: 'image/jpeg' });
    expect(await readCaptureTime(file)).toBe(Date.UTC(2026, 0, 2, 8, 15, 45));
  });

  it('returns null for a non-JPEG file', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'photo.png', { type: 'image/png' });
    expect(await readCaptureTime(file)).toBeNull();
  });

  it('returns null for a JPEG with no Exif APP1 segment', async () => {
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'photo.jpg', { type: 'image/jpeg' });
    expect(await readCaptureTime(file)).toBeNull();
  });

  it('never throws on garbage bytes claiming to be a JPEG', async () => {
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    await expect(readCaptureTime(file)).resolves.toBeNull();
  });
});
