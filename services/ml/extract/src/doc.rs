//! Word 97-2003 binary documents (`.doc`, `.dot`), plus Word 6/95.

use crate::ExtractError;
use encoding_rs::Encoding;

use crate::bytes::{codepage, decode, span, u8_at, u16le, u32le, utf16le};
use crate::limits::Budget;
use crate::ole::Ole;
use crate::sink::Sink;

/// `nFib` of Word 97; older versions keep 8-bit text and a different header.
const WORD_97: u16 = 0x00C1;

pub(crate) fn doc(ole: &mut Ole<'_>, budget: &mut Budget, sink: &mut Sink) -> Result<(), ExtractError> {
    let main = ole
        .stream("/WordDocument", budget)
        .ok_or_else(|| ExtractError::Malformed("missing WordDocument stream".into()))?;
    let header = || ExtractError::Malformed("short Word file header".into());
    let version = u16le(&main, 2).ok_or_else(header)?;
    let flags = u16le(&main, 0x0A).ok_or_else(header)?;
    if flags & 0x0100 != 0 {
        return Err(ExtractError::Encrypted);
    }
    let mut text = WordText {
        sink,
        instruction_depth: 0,
        fields: Vec::new(),
        cell: false,
    };
    if version < WORD_97 {
        // Bit 12 marks 16-bit characters in files that predate Unicode Word.
        let kind = if flags & 0x1000 != 0 {
            LegacyText::Wide
        } else {
            LegacyText::Narrow(codepage(summary_codepage(ole, budget).unwrap_or(1252)))
        };
        return legacy(&main, flags, kind, &mut text);
    }
    // Bit 9 names the table stream; fall back to the other if it is absent.
    let (first, second) = if flags & 0x0200 != 0 {
        ("/1Table", "/0Table")
    } else {
        ("/0Table", "/1Table")
    };
    let table = ole
        .stream(first, budget)
        .or_else(|| ole.stream(second, budget))
        .ok_or_else(|| ExtractError::Malformed("missing Word table stream".into()))?;
    let clx_at = u32le(&main, 0x01A2).ok_or_else(header)? as usize;
    let clx_len = u32le(&main, 0x01A6).ok_or_else(header)? as usize;
    let clx = span(&table, clx_at, clx_len)
        .ok_or_else(|| ExtractError::Malformed("Word piece table is out of range".into()))?;
    let pieces = piece_table(clx).ok_or_else(|| ExtractError::Malformed("no Word piece table".into()))?;
    for piece in pieces {
        if text.sink.is_full() {
            break;
        }
        let chars = piece.chars as usize;
        if piece.position & 0x4000_0000 != 0 {
            // Compressed: one Windows-1252 byte per character at half the offset.
            let at = ((piece.position & 0x3FFF_FFFF) / 2) as usize;
            let bytes = main
                .get(at..)
                .map(|rest| rest.get(..chars).unwrap_or(rest))
                .unwrap_or(&[]);
            text.push_str(&decode(bytes, encoding_rs::WINDOWS_1252));
        } else {
            let at = (piece.position & 0x3FFF_FFFF) as usize;
            let wanted = chars.saturating_mul(2);
            let bytes = main
                .get(at..)
                .map(|rest| rest.get(..wanted).unwrap_or(rest))
                .unwrap_or(&[]);
            text.push_str(&utf16le(bytes));
        }
    }
    text.sink.newline();
    Ok(())
}

/// One run of the document: `chars` characters stored at `position`.
struct Piece {
    chars: u32,
    position: u32,
}

/// Reads the piece table out of a `Clx`: property blocks first, then one `Pcdt`.
fn piece_table(clx: &[u8]) -> Option<Vec<Piece>> {
    let mut at = 0;
    while u8_at(clx, at)? == 0x01 {
        at += 3 + usize::from(u16le(clx, at + 1)?);
    }
    if u8_at(clx, at)? != 0x02 {
        return None;
    }
    let len = u32le(clx, at + 1)? as usize;
    let table = span(clx, at + 5, len)?;
    // n + 1 character positions, then n eight-byte piece descriptors.
    let count = table.len().checked_sub(4)? / 12;
    let descriptors = 4 * (count + 1);
    let mut pieces = Vec::new();
    for index in 0..count {
        let start = u32le(table, 4 * index)?;
        let end = u32le(table, 4 * (index + 1))?;
        let position = u32le(table, descriptors + 8 * index + 2)?;
        pieces.push(Piece {
            chars: end.saturating_sub(start),
            position,
        });
    }
    Some(pieces)
}

/// How Word 6/95 stored its characters.
#[derive(Clone, Copy)]
enum LegacyText {
    /// One byte per character in the document's code page.
    Narrow(&'static Encoding),
    /// Two bytes per character, as the Far East and bidirectional editions wrote.
    Wide,
}

impl LegacyText {
    /// Decodes `chars` characters at `at`, or as many as the stream holds.
    fn decode(self, main: &[u8], at: usize, chars: usize) -> String {
        let rest = main.get(at..).unwrap_or(&[]);
        match self {
            Self::Narrow(encoding) => decode(rest.get(..chars).unwrap_or(rest), encoding),
            Self::Wide => utf16le(rest.get(..chars.saturating_mul(2)).unwrap_or(rest)),
        }
    }
}

/// Word 6/95: text between two offsets of the main stream, or in pieces when
/// the file was fast-saved.
fn legacy(main: &[u8], flags: u16, kind: LegacyText, text: &mut WordText<'_>) -> Result<(), ExtractError> {
    let header = || ExtractError::Malformed("short Word file header".into());
    let complex = flags & 0x0004 != 0;
    let pieces = complex
        .then(|| {
            let at = u32le(main, 0x0160)? as usize;
            let len = u32le(main, 0x0164)? as usize;
            piece_table(span(main, at, len)?)
        })
        .flatten();
    match pieces {
        Some(pieces) => {
            for piece in pieces {
                text.push_str(&kind.decode(main, piece.position as usize, piece.chars as usize));
            }
        }
        None => {
            let start = u32le(main, 0x18).ok_or_else(header)? as usize;
            let end = u32le(main, 0x1C).ok_or_else(header)? as usize;
            if start > end.min(main.len()) {
                return Err(ExtractError::Malformed("Word text is out of range".into()));
            }
            let width = if matches!(kind, LegacyText::Wide) { 2 } else { 1 };
            text.push_str(&kind.decode(main, start, (end.min(main.len()) - start) / width));
        }
    }
    text.sink.newline();
    Ok(())
}

/// The code page a document's summary properties declare. Word 6/95 files
/// say nowhere else which 8-bit encoding their text is in.
fn summary_codepage(ole: &Ole<'_>, budget: &mut Budget) -> Option<u32> {
    let summary = ole.stream("/\u{5}SummaryInformation", budget)?;
    // The first property set starts where the header says; its entries are
    // (id, offset) pairs, and property 1 is the code page as a 16-bit integer.
    let section = u32le(&summary, 44)? as usize;
    let count = u32le(&summary, section.checked_add(4)?)? as usize;
    for index in 0..count.min(256) {
        let entry = section.checked_add(8 + 8 * index)?;
        if u32le(&summary, entry)? == 1 {
            let value = section.checked_add(u32le(&summary, entry + 4)? as usize)?;
            return Some(u32::from(u16le(&summary, value.checked_add(4)?)?));
        }
    }
    None
}

/// Turns Word's in-band control characters into plain text structure.
struct WordText<'s> {
    sink: &'s mut Sink,
    /// How many enclosing fields are still in their instruction part.
    instruction_depth: usize,
    /// For each open field, whether its instruction part is still being read.
    fields: Vec<bool>,
    /// The previous character was a cell mark; a second one ends the row.
    cell: bool,
}

impl WordText<'_> {
    fn push_str(&mut self, text: &str) {
        for c in text.chars() {
            if self.sink.is_full() {
                return;
            }
            self.push(c);
        }
    }

    fn push(&mut self, c: char) {
        let was_cell = std::mem::take(&mut self.cell);
        match c {
            // Field begin, separator, end: keep the result, drop the instruction.
            '\u{13}' => {
                self.fields.push(true);
                self.instruction_depth += 1;
            }
            '\u{14}' => {
                if let Some(instruction) = self.fields.last_mut()
                    && std::mem::take(instruction)
                {
                    self.instruction_depth -= 1;
                }
            }
            '\u{15}' => {
                if self.fields.pop() == Some(true) {
                    self.instruction_depth -= 1;
                }
            }
            _ if self.instruction_depth > 0 => {}
            '\u{07}' => {
                if was_cell {
                    self.sink.row_end();
                } else {
                    self.sink.tab();
                    self.cell = true;
                }
            }
            '\r' | '\n' | '\u{0B}' | '\u{0C}' => self.sink.newline(),
            '\t' => self.sink.tab(),
            '\u{1E}' => self.sink.push('-'),
            c if c < ' ' => {}
            c => self.sink.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(input: &str) -> String {
        let mut sink = Sink::new(10_000);
        let mut text = WordText {
            sink: &mut sink,
            instruction_depth: 0,
            fields: Vec::new(),
            cell: false,
        };
        text.push_str(input);
        sink.finish()
    }

    #[test]
    fn turns_control_characters_into_structure() {
        assert_eq!(
            clean("One\rTwo\u{0B}Three\u{0C}Four\tFive"),
            "One\nTwo\nThree\nFour\tFive"
        );
        assert_eq!(clean("a\u{07}b\u{07}\u{07}c\u{07}\u{07}after"), "a\tb\nc\nafter");
        assert_eq!(
            clean("non\u{1E}breaking soft\u{1F}hyphen\u{01}\u{08}"),
            "non-breaking softhyphen"
        );
    }

    #[test]
    fn keeps_field_results_and_drops_instructions() {
        assert_eq!(clean("See \u{13}HYPERLINK \"x\"\u{14}the link\u{15}."), "See the link.");
        assert_eq!(clean("a\u{13}PAGE\u{15}b"), "ab");
        assert_eq!(
            clean("\u{13}IF \u{13}DATE\u{14}today\u{15} = x\u{14}shown\u{15}!"),
            "shown!"
        );
        assert_eq!(clean("\u{14}\u{15}stray"), "stray");
    }

    #[test]
    fn rejects_piece_tables_that_do_not_parse() {
        assert!(piece_table(&[]).is_none());
        assert!(piece_table(&[0x03]).is_none());
        assert!(piece_table(&[0x01, 0xFF, 0xFF]).is_none());
        assert!(piece_table(&[0x02, 0x10, 0, 0, 0]).is_none());
        assert!(piece_table(&[0x02, 0x02, 0, 0, 0, 0, 0]).is_none());
        // A property block, then a table with one piece of three characters.
        let clx = [
            0x01, 0x01, 0x00, 0xAA, 0x02, 0x10, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0x10, 0, 0, 0x40, 0, 0,
        ];
        let pieces = piece_table(&clx).unwrap();
        assert_eq!(pieces.len(), 1);
        assert_eq!(pieces[0].chars, 3);
        assert_eq!(pieces[0].position, 0x4000_0010);
    }
}
