//! Excel 97-2003 workbooks (`.xls`), plus Excel 5/95.
//!
//! Cells are streamed straight from the BIFF records. A dense grid is never
//! built, so a sheet with one stray cell in its last row costs nothing.

use std::collections::HashMap;

use encoding_rs::Encoding;

use crate::ExtractError;
use crate::bytes::{codepage, decode, f64le, span, u8_at, u16le, u32le, utf16le};
use crate::dates::{is_date_format, serial_text};
use crate::limits::Budget;
use crate::ole::Ole;
use crate::sink::Sink;
use crate::strings::StringTable;

const BOF: u16 = 0x0809;
const EOF: u16 = 0x000A;
const FILEPASS: u16 = 0x002F;
const CODEPAGE: u16 = 0x0042;
const BOUNDSHEET: u16 = 0x0085;
const SST: u16 = 0x00FC;
const CONTINUE: u16 = 0x003C;
const LABELSST: u16 = 0x00FD;
const LABEL: u16 = 0x0204;
const RSTRING: u16 = 0x00D6;
const NUMBER: u16 = 0x0203;
const RK: u16 = 0x027E;
const MULRK: u16 = 0x00BD;
const FORMULA: u16 = 0x0006;
const STRING: u16 = 0x0207;
const BOOLERR: u16 = 0x0205;
const DATE_1904: u16 = 0x0022;
const FORMAT: u16 = 0x041E;
const XF: u16 = 0x00E0;

const MAX_SHEETS: usize = 65_536;

pub(crate) fn xls(ole: &mut Ole<'_>, budget: &mut Budget, sink: &mut Sink) -> Result<(), ExtractError> {
    let book = ole
        .stream("/Workbook", budget)
        .or_else(|| ole.stream("/Book", budget))
        .ok_or_else(|| ExtractError::Malformed("missing Workbook stream".into()))?;
    let mut state = Workbook {
        sink,
        wide: true,
        encoding: encoding_rs::WINDOWS_1252,
        strings: StringTable::default(),
        names: Vec::new(),
        depth: 0,
        sheet: 0,
        row: None,
        pending_formula: None,
        date1904: false,
        date_formats: HashMap::new(),
        cell_formats: Vec::new(),
    };
    let mut at = 0;
    let mut seen = false;
    while let (Some(id), Some(len)) = (u16le(&book, at), u16le(&book, at + 2)) {
        let Some(data) = span(&book, at + 4, usize::from(len)) else {
            break;
        };
        at += 4 + usize::from(len);
        if id == FILEPASS {
            return Err(ExtractError::Encrypted);
        }
        if id == SST {
            // The table runs on through the CONTINUE records that follow it.
            let mut chunks = vec![data];
            while u16le(&book, at) == Some(CONTINUE) {
                let Some(more) = u16le(&book, at + 2).and_then(|len| span(&book, at + 4, usize::from(len))) else {
                    break;
                };
                chunks.push(more);
                at += 4 + more.len();
            }
            state.strings = shared_strings(&chunks);
            continue;
        }
        seen |= id == BOF;
        state.record(id, data);
        if state.sink.is_full() {
            break;
        }
    }
    if !seen {
        return Err(ExtractError::Malformed("no workbook records".into()));
    }
    state.sink.row_end();
    Ok(())
}

struct Workbook<'s> {
    sink: &'s mut Sink,
    /// BIFF8 strings carry their own width flag; BIFF5 strings are code page bytes.
    wide: bool,
    encoding: &'static Encoding,
    strings: StringTable,
    names: Vec<String>,
    /// Substream nesting: charts embedded in a sheet open their own.
    depth: u32,
    /// Sheets seen so far, counting the one being read.
    sheet: usize,
    row: Option<u16>,
    /// The cell of a formula whose string result follows in a STRING record.
    pending_formula: Option<(u16, u16)>,
    /// Day numbers count from 1904 rather than 1900.
    date1904: bool,
    /// Whether each number format the workbook defines shows a date, by id.
    date_formats: HashMap<u16, bool>,
    /// The number format id of each cell format, by index.
    cell_formats: Vec<u16>,
}

impl Workbook<'_> {
    fn record(&mut self, id: u16, data: &[u8]) {
        match id {
            BOF => {
                if self.depth == 0 {
                    if self.sheet == 0 && u16le(data, 0).is_some_and(|version| version < 0x0600) {
                        self.wide = false;
                    }
                    // The first substream is the workbook globals, the rest are sheets.
                    if u16le(data, 2) != Some(0x0005) {
                        self.begin_sheet();
                    }
                }
                self.depth += 1;
            }
            EOF => self.depth = self.depth.saturating_sub(1),
            CODEPAGE => {
                if let Some(page) = u16le(data, 0) {
                    self.encoding = codepage(u32::from(page));
                }
            }
            BOUNDSHEET => {
                // The format allows no more sheets than this; a longer list is noise.
                if self.names.len() < MAX_SHEETS
                    && let Some(name) = self.short_string(data, 6)
                {
                    self.names.push(name);
                }
            }
            DATE_1904 => self.date1904 = u16le(data, 0) == Some(1),
            FORMAT => {
                let code = if self.wide {
                    self.long_string(data, 2)
                } else {
                    self.short_string(data, 2)
                };
                if let (Some(id), Some(code)) = (u16le(data, 0), code) {
                    self.date_formats.insert(id, is_date_format(u32::from(id), Some(&code)));
                }
            }
            XF => self.cell_formats.extend(u16le(data, 2)),
            _ if self.depth != 1 || self.sheet == 0 => {}
            LABELSST => {
                let text = u32le(data, 6)
                    .and_then(|index| self.strings.get(index as usize))
                    .map(str::to_owned);
                self.cell(data, text);
            }
            LABEL | RSTRING => {
                let text = self.long_string(data, 6);
                self.cell(data, text);
            }
            NUMBER => {
                let text = f64le(data, 6).map(|value| self.number(value, u16le(data, 4)));
                self.cell(data, text);
            }
            RK => {
                let text = u32le(data, 6).map(|rk| self.number(rk_value(rk), u16le(data, 4)));
                self.cell(data, text);
            }
            MULRK => self.multiple_rk(data),
            BOOLERR => {
                // The second byte marks an error code rather than a boolean.
                let text = (u8_at(data, 7) == Some(0))
                    .then(|| u8_at(data, 6))
                    .flatten()
                    .map(|value| if value == 0 { "FALSE" } else { "TRUE" }.to_owned());
                self.cell(data, text);
            }
            FORMULA => self.formula(data),
            STRING => {
                if let Some((row, column)) = self.pending_formula.take() {
                    let text = self.long_string(data, 0);
                    self.cell_at(row, column, text);
                }
            }
            _ => {}
        }
    }

    fn begin_sheet(&mut self) {
        self.sink.row_end();
        if let Some(name) = self.names.get(self.sheet) {
            self.sink.push_str(name);
            self.sink.newline();
        }
        self.sheet += 1;
        self.row = None;
    }

    /// A cell record starts with its row and column.
    fn cell(&mut self, data: &[u8], text: Option<String>) {
        if let (Some(row), Some(column)) = (u16le(data, 0), u16le(data, 2)) {
            self.cell_at(row, column, text);
        }
    }

    fn cell_at(&mut self, row: u16, _column: u16, text: Option<String>) {
        let Some(text) = text.filter(|text| !text.is_empty()) else {
            return;
        };
        if self.row.is_some_and(|current| current != row) {
            self.sink.row_end();
        }
        self.row = Some(row);
        self.sink.push_str(&text);
        self.sink.tab();
    }

    fn multiple_rk(&mut self, data: &[u8]) {
        let (Some(row), Some(first)) = (u16le(data, 0), u16le(data, 2)) else {
            return;
        };
        // Six bytes per cell between the header and the closing last-column field.
        let cells = data.len().saturating_sub(6) / 6;
        for index in 0..cells {
            let column = first.saturating_add(u16::try_from(index).unwrap_or(u16::MAX));
            let format = u16le(data, 4 + 6 * index);
            let value = u32le(data, 4 + 6 * index + 2).map(|rk| self.number(rk_value(rk), format));
            self.cell_at(row, column, value);
        }
    }

    fn formula(&mut self, data: &[u8]) {
        let (Some(row), Some(column)) = (u16le(data, 0), u16le(data, 2)) else {
            return;
        };
        if u16le(data, 12) != Some(0xFFFF) {
            let text = f64le(data, 6).map(|value| self.number(value, u16le(data, 4)));
            self.cell_at(row, column, text);
            return;
        }
        match u8_at(data, 6) {
            Some(0) => self.pending_formula = Some((row, column)),
            Some(1) => {
                let value = if u8_at(data, 8) == Some(0) { "FALSE" } else { "TRUE" };
                self.cell_at(row, column, Some(value.to_owned()));
            }
            _ => {}
        }
    }

    /// A number as the cell shows it: a date when its format is one.
    fn number(&self, value: f64, cell_format: Option<u16>) -> String {
        let format = cell_format
            .and_then(|index| self.cell_formats.get(usize::from(index)))
            .copied();
        let is_date = format.is_some_and(|id| {
            self.date_formats
                .get(&id)
                .copied()
                .unwrap_or_else(|| is_date_format(u32::from(id), None))
        });
        is_date
            .then(|| serial_text(value, self.date1904))
            .flatten()
            .unwrap_or_else(|| number(value))
    }

    /// A string with a one-byte length, as in sheet names.
    fn short_string(&self, data: &[u8], at: usize) -> Option<String> {
        let chars = usize::from(u8_at(data, at)?);
        self.string_body(data, at + 1, chars)
    }

    /// A string with a two-byte length, as in cell records.
    fn long_string(&self, data: &[u8], at: usize) -> Option<String> {
        let chars = usize::from(u16le(data, at)?);
        self.string_body(data, at + 2, chars)
    }

    fn string_body(&self, data: &[u8], at: usize, chars: usize) -> Option<String> {
        if !self.wide {
            let bytes = data.get(at..)?;
            return Some(decode(bytes.get(..chars).unwrap_or(bytes), self.encoding));
        }
        let flags = u8_at(data, at)?;
        let mut body = at + 1;
        // Rich text run count and phonetic size sit between the flags and the text.
        if flags & 0x08 != 0 {
            body += 2;
        }
        if flags & 0x04 != 0 {
            body += 4;
        }
        let bytes = data.get(body..)?;
        Some(if flags & 0x01 != 0 {
            utf16le(bytes.get(..chars * 2).unwrap_or(bytes))
        } else {
            latin1(bytes.get(..chars).unwrap_or(bytes))
        })
    }
}

/// BIFF8 "compressed" strings hold the low byte of each UTF-16 unit.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&byte| char::from(byte)).collect()
}

/// An RK number: 30 bits of integer or the top of a double, optionally divided by 100.
fn rk_value(rk: u32) -> f64 {
    let value = if rk & 0x02 != 0 {
        f64::from((rk as i32) >> 2)
    } else {
        f64::from_bits(u64::from(rk & 0xFFFF_FFFC) << 32)
    };
    if rk & 0x01 != 0 { value / 100.0 } else { value }
}

/// Whole numbers print without a fraction, as a spreadsheet shows them.
fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

/// Reads over an SST record and its continuations as one stream of fields.
struct Chunks<'a> {
    chunks: &'a [&'a [u8]],
    chunk: usize,
    at: usize,
}

impl Chunks<'_> {
    /// The unread rest of the current chunk, moving to the next once it is spent.
    fn rest(&mut self) -> Option<&[u8]> {
        loop {
            let current = self.chunks.get(self.chunk)?;
            if self.at < current.len() {
                return current.get(self.at..);
            }
            self.chunk += 1;
            self.at = 0;
        }
    }

    fn u8(&mut self) -> Option<u8> {
        let value = u8_at(self.rest()?, 0)?;
        self.at += 1;
        Some(value)
    }

    fn u16(&mut self) -> Option<u16> {
        let value = u16le(self.rest()?, 0)?;
        self.at += 2;
        Some(value)
    }

    fn u32(&mut self) -> Option<u32> {
        let value = u32le(self.rest()?, 0)?;
        self.at += 4;
        Some(value)
    }

    fn skip(&mut self, mut bytes: usize) -> Option<()> {
        while bytes > 0 {
            let step = self.rest()?.len().min(bytes);
            self.at += step;
            bytes -= step;
        }
        Some(())
    }

    /// `chars` characters; a string split across records restates its width
    /// in a flags byte at the start of each continuation.
    fn text(&mut self, mut chars: usize, mut wide: bool) -> Option<String> {
        let mut out = String::new();
        while chars > 0 {
            let current = self.chunks.get(self.chunk)?;
            let Some(rest) = current.get(self.at..).filter(|rest| !rest.is_empty()) else {
                self.chunk += 1;
                self.at = 0;
                wide = self.u8()? & 0x01 != 0;
                continue;
            };
            let width = if wide { 2 } else { 1 };
            let take = (rest.len() / width).min(chars);
            if take == 0 {
                return None;
            }
            let bytes = rest.get(..take * width)?;
            out.push_str(&if wide { utf16le(bytes) } else { latin1(bytes) });
            self.at += take * width;
            chars -= take;
        }
        Some(out)
    }
}

/// The shared string table; reading stops quietly at the first damaged entry.
fn shared_strings(chunks: &[&[u8]]) -> StringTable {
    let mut reader = Chunks {
        chunks,
        chunk: 0,
        at: 0,
    };
    let mut strings = StringTable::default();
    let Some(()) = reader.skip(8) else {
        return strings;
    };
    while let Some(string) = shared_string(&mut reader) {
        strings.push(&string);
    }
    strings
}

fn shared_string(reader: &mut Chunks<'_>) -> Option<String> {
    let chars = usize::from(reader.u16()?);
    let flags = reader.u8()?;
    let runs = if flags & 0x08 != 0 {
        usize::from(reader.u16()?)
    } else {
        0
    };
    let phonetic = if flags & 0x04 != 0 { reader.u32()? as usize } else { 0 };
    let text = reader.text(chars, flags & 0x01 != 0)?;
    // Formatting runs and phonetic data follow the text; a short tail is fine.
    let _ = reader.skip(runs * 4 + phonetic);
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_rk_numbers() {
        assert_eq!(rk_value((42 << 2) | 0x02), 42.0);
        assert_eq!(rk_value((1234 << 2) | 0x03), 12.34);
        assert_eq!(rk_value(((-7i32 as u32) << 2) | 0x02), -7.0);
        assert_eq!(rk_value(0x3FF0_0000), 1.0);
        assert_eq!(rk_value(0x4059_0001), 1.0);
    }

    #[test]
    fn prints_numbers_like_a_spreadsheet() {
        assert_eq!(number(42.0), "42");
        assert_eq!(number(-3.0), "-3");
        assert_eq!(number(12.34), "12.34");
        assert_eq!(number(1e20), "100000000000000000000");
    }

    #[test]
    fn reads_shared_strings_across_continue_records() {
        // total, unique, then "ab" (compressed), "åä" (wide), and "hello" split
        // after "he" with the continuation switching to wide characters.
        let first: &[u8] = &[
            3, 0, 0, 0, 3, 0, 0, 0, 2, 0, 0, b'a', b'b', 2, 0, 1, 0xE5, 0, 0xE4, 0, 5, 0, 0, b'h', b'e',
        ];
        let second: &[u8] = &[1, b'l', 0, b'l', 0, b'o', 0];
        assert_eq!(shared_strings(&[first, second]).to_vec(), ["ab", "åä", "hello"]);
    }

    #[test]
    fn skips_rich_text_runs_and_phonetic_data() {
        let data: &[u8] = &[
            2, 0, 0, 0, 2, 0, 0, 0, // counts
            2, 0, 0x0C, 1, 0, 3, 0, 0, 0, b'h', b'i', 9, 9, 9, 9, 7, 7, 7, // rich + phonetic
            1, 0, 0, b'x',
        ];
        assert_eq!(shared_strings(&[data]).to_vec(), ["hi", "x"]);
    }

    #[test]
    fn stops_at_a_damaged_string_table() {
        assert!(shared_strings(&[]).to_vec().is_empty());
        assert!(shared_strings(&[&[1, 2, 3]]).to_vec().is_empty());
        let cut: &[u8] = &[1, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, b'a'];
        assert!(shared_strings(&[cut]).to_vec().is_empty());
        let cut_wide: &[u8] = &[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, b'a'];
        assert!(shared_strings(&[cut_wide]).to_vec().is_empty());
    }
}
