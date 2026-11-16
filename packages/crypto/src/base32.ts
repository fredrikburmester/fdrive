/** RFC 4648 base32 in lowercase without padding: safe on disks that ignore case. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Decodes lowercase unpadded base32; null for any other character or non-zero spare bits. */
export function decodeBase32(text: string): Uint8Array<ArrayBuffer> | null {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  if (bits >= 5 || (buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}
