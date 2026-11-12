//! Mobipocket e-books (`.mobi`): HTML in a Palm database, usually LZ77-packed.

use crate::ExtractError;
use crate::bytes::{codepage, decode, u8_at, u16be, u32be};
use crate::html::html_to_text;
use crate::limits::Budget;
use crate::sink::Sink;

/// The type and creator that mark a Palm database as a Mobipocket book.
pub(crate) const MAGIC: &[u8] = b"BOOKMOBI";
pub(crate) const MAGIC_AT: usize = 60;

const UNCOMPRESSED: u16 = 1;
const PALMDOC: u16 = 2;
const HUFFMAN: u16 = 17480;

pub(crate) fn mobi(bytes: &[u8], budget: &mut Budget, sink: &mut Sink) -> Result<(), ExtractError> {
    let short = || ExtractError::Malformed("short Mobipocket header".into());
    let count = usize::from(u16be(bytes, 76).ok_or_else(short)?);
    // Record `index` runs from its own offset to the next record's.
    let record = |index: usize| -> Option<&[u8]> {
        if index >= count {
            return None;
        }
        let start = u32be(bytes, 78 + 8 * index)? as usize;
        let end = if index + 1 < count {
            u32be(bytes, 78 + 8 * (index + 1))? as usize
        } else {
            bytes.len()
        };
        bytes.get(start..end.min(bytes.len()))
    };
    let first = record(0).ok_or_else(short)?;
    let compression = u16be(first, 0).ok_or_else(short)?;
    let text_records = usize::from(u16be(first, 8).ok_or_else(short)?);
    if u16be(first, 12).ok_or_else(short)? != 0 {
        return Err(ExtractError::Encrypted);
    }
    match compression {
        UNCOMPRESSED | PALMDOC => {}
        HUFFMAN => return Err(ExtractError::Unsupported("mobi-huffman")),
        _ => {
            return Err(ExtractError::Malformed("unknown Mobipocket compression".into()));
        }
    }
    let encoding = codepage(u32be(first, 28).unwrap_or(1252));
    // Newer headers say how much trailing bookkeeping follows each record's text.
    let header_len = u32be(first, 20).unwrap_or(0);
    let trailers = if header_len >= 0xE4 {
        u16be(first, 0xF2).unwrap_or(0)
    } else {
        0
    };
    let mut html = Vec::new();
    for index in 1..=text_records {
        let Some(data) = record(index) else {
            break;
        };
        let data = data
            .get(..data.len().saturating_sub(trailing(data, trailers)))
            .unwrap_or(data);
        let before = html.len();
        if compression == PALMDOC {
            unpack(data, &mut html, budget);
        } else {
            let allowed = budget.charge(data.len());
            html.extend_from_slice(data.get(..allowed).unwrap_or(data));
        }
        // The book is one part: its unpacked text is held in memory whole.
        let allowed = budget.part(html.len());
        html.truncate(allowed);
        if budget.exhausted() || (html.len() == before && !data.is_empty()) {
            break;
        }
    }
    html_to_text(&decode(&html, encoding), sink);
    Ok(())
}

/// The number of bytes of trailing entries at the end of a text record.
fn trailing(data: &[u8], flags: u16) -> usize {
    let mut size = 0usize;
    for bit in 1..16 {
        if flags & (1 << bit) != 0 {
            // Each entry ends with its own length as a backwards variable-width integer.
            let mut value = 0usize;
            let mut at = data.len().saturating_sub(size);
            for shift in [0, 7, 14, 21] {
                let Some(byte) = at.checked_sub(1).and_then(|index| u8_at(data, index)) else {
                    break;
                };
                at -= 1;
                value |= usize::from(byte & 0x7F) << shift;
                if byte & 0x80 != 0 {
                    break;
                }
            }
            size = size.saturating_add(value);
        }
    }
    if flags & 1 != 0 {
        // Bit 0: the tail of a multi-byte character split across records.
        let last = data
            .len()
            .saturating_sub(size)
            .checked_sub(1)
            .and_then(|index| u8_at(data, index));
        size = size.saturating_add(last.map_or(0, |byte| usize::from(byte & 0x03) + 1));
    }
    size.min(data.len())
}

/// PalmDoc LZ77: literals, runs, back references and space-plus-character pairs.
fn unpack(data: &[u8], out: &mut Vec<u8>, budget: &mut Budget) {
    let start = out.len();
    let mut at = 0;
    while let Some(&byte) = data.get(at) {
        at += 1;
        let before = out.len();
        match byte {
            0x01..=0x08 => {
                let literal = data
                    .get(at..)
                    .map(|rest| rest.get(..usize::from(byte)).unwrap_or(rest))
                    .unwrap_or(&[]);
                out.extend_from_slice(literal);
                at += usize::from(byte);
            }
            0x00 | 0x09..=0x7F => out.push(byte),
            0x80..=0xBF => {
                let Some(&low) = data.get(at) else {
                    break;
                };
                at += 1;
                let pair = u16::from_be_bytes([byte, low]);
                let distance = usize::from((pair >> 3) & 0x07FF);
                let length = usize::from(pair & 0x07) + 3;
                // References reach back within this record's own output only.
                if distance == 0 || distance > out.len() - start {
                    break;
                }
                for _ in 0..length {
                    let Some(&copied) = out.get(out.len() - distance) else {
                        break;
                    };
                    out.push(copied);
                }
            }
            0xC0..=0xFF => {
                out.push(b' ');
                out.push(byte ^ 0x80);
            }
        }
        let produced = out.len() - before;
        let allowed = budget.charge(produced);
        if allowed < produced {
            out.truncate(before + allowed);
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::Limits;

    fn budget(total: usize) -> Budget {
        Budget::new(&Limits {
            max_part_bytes: total,
            max_total_bytes: total,
            max_text_chars: 1000,
        })
    }

    #[test]
    fn unpacks_literals_references_and_space_pairs() {
        let mut out = Vec::new();
        // "abc", a reference copying 3 bytes from 3 back, a space pair, a 2-byte run.
        unpack(
            &[b'a', b'b', b'c', 0x80, 0x18, 0xC0 | b'd', 0x02, 0xC3, 0xA5, 0x00],
            &mut out,
            &mut budget(100),
        );
        assert_eq!(out, b"abcabc d\xC3\xA5\0");
    }

    #[test]
    fn stops_unpacking_at_bad_references_and_the_budget() {
        let mut out = Vec::new();
        unpack(&[b'a', 0x80, 0x48, b'z'], &mut out, &mut budget(100));
        assert_eq!(out, b"a");
        let mut out = Vec::new();
        unpack(&[b'a', 0x80], &mut out, &mut budget(100));
        assert_eq!(out, b"a");
        let mut out = Vec::new();
        let mut small = budget(4);
        unpack(&[b'a', b'b', b'c', 0x80, 0x18, b'x'], &mut out, &mut small);
        assert_eq!(out, b"abca");
        assert!(small.exhausted());
        let mut out = Vec::new();
        unpack(&[0x05, b'a'], &mut out, &mut budget(100));
        assert_eq!(out, b"a");
    }

    #[test]
    fn measures_trailing_entries() {
        assert_eq!(trailing(b"text", 0), 0);
        // Bit 1: one entry whose size, itself included, is 3.
        assert_eq!(trailing(&[b't', 9, 9, 0x83], 0b10), 3);
        // Bit 0: two more bytes of a split character, plus the count byte.
        assert_eq!(trailing(&[b't', 0xC3, 0xA5, 0x02], 0b01), 3);
        // Both: the entry is measured first, the split character before it.
        assert_eq!(trailing(&[b't', 0x00, 9, 0x82], 0b11), 3);
        assert_eq!(trailing(&[0x7F], 0b10), 1);
        assert_eq!(trailing(&[], 0b11), 0);
        // A two-byte size reads 128, more than the record holds; it is capped.
        assert_eq!(trailing(&[0x81, 0x00], 0b10), 2);
    }
}
