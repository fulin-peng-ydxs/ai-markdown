/**
 * Counts UTF-8 bytes without allocating a second full-size byte buffer.
 * Both editor adapters use this before or during large-document work.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Counts Han characters individually and groups Latin/digit runs as words.
 * It is presentation metadata only; Markdown content remains the sole source.
 */
export function countDocumentWords(value: string): number {
  const matches = value.match(/[\p{Script=Han}]|[\p{L}\p{N}_]+/gu);
  return matches?.length ?? 0;
}
