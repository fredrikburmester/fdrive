//! Rich Text Format.

use encoding_rs::Encoding;

use crate::bytes::{codepage, decode};
use crate::sink::Sink;

/// Destinations whose content is tables, binary data or field code, not text.
const SKIPPED: &[&str] = &[
    "fonttbl",
    "colortbl",
    "stylesheet",
    "info",
    "pict",
    "fldinst",
    "themedata",
    "colorschememapping",
    "latentstyles",
    "datastore",
    "listtable",
    "listoverridetable",
    "revtbl",
    "rsidtbl",
    "generator",
    "xmlnstbl",
    "filetbl",
    "pgdsctbl",
    "bkmkstart",
    "bkmkend",
    "objdata",
    "panose",
    "falt",
];

/// Group states remembered at most. Real documents nest a few dozen deep; a
/// file of nothing but braces must not grow the stack with it.
const MAX_DEPTH: usize = 4096;

/// What a group inherits from the group around it.
#[derive(Clone, Copy)]
struct Group {
    skip: bool,
    /// How many fallback characters follow each `\u`.
    fallback: usize,
}

pub(crate) fn rtf(bytes: &[u8], sink: &mut Sink) {
    let mut parser = Parser {
        sink,
        encoding: encoding_rs::WINDOWS_1252,
        pending: Vec::new(),
        surrogate: None,
        skip_fallback: 0,
        group: Group {
            skip: false,
            fallback: 1,
        },
        stack: Vec::new(),
        overflow: 0,
    };
    let mut at = 0;
    while let Some(&byte) = bytes.get(at) {
        if parser.sink.is_full() {
            break;
        }
        at += 1;
        match byte {
            b'{' => {
                parser.flush();
                if parser.stack.len() < MAX_DEPTH {
                    parser.stack.push(parser.group);
                } else {
                    parser.overflow += 1;
                }
            }
            b'}' => {
                parser.flush();
                if parser.overflow > 0 {
                    parser.overflow -= 1;
                } else {
                    parser.group = parser.stack.pop().unwrap_or(parser.group);
                }
            }
            b'\\' => at = parser.control(bytes, at),
            b'\r' | b'\n' => {}
            other => parser.byte(other),
        }
    }
    parser.flush();
    parser.sink.newline();
}

struct Parser<'s> {
    sink: &'s mut Sink,
    encoding: &'static Encoding,
    /// Code page bytes not yet decoded; multi-byte characters span escapes.
    pending: Vec<u8>,
    /// A `\u` high surrogate waiting for its low half.
    surrogate: Option<u16>,
    /// Fallback characters still to drop after a `\u`.
    skip_fallback: usize,
    group: Group,
    stack: Vec<Group>,
    /// Groups opened beyond `MAX_DEPTH`; they share the state of the deepest kept one.
    overflow: usize,
}

impl Parser<'_> {
    fn flush(&mut self) {
        self.skip_fallback = 0;
        self.surrogate = None;
        if !self.pending.is_empty() {
            let text = decode(&self.pending, self.encoding);
            self.sink.push_str(&text);
            self.pending.clear();
        }
    }

    /// One byte of document text in the current code page.
    fn byte(&mut self, byte: u8) {
        if self.skip_fallback > 0 {
            self.skip_fallback -= 1;
        } else if !self.group.skip {
            self.pending.push(byte);
        }
    }

    fn char(&mut self, c: char) {
        if !self.group.skip {
            self.flush();
            self.sink.push(c);
        }
    }

    /// Handles the control after a backslash at `at` and returns where to go on.
    fn control(&mut self, bytes: &[u8], at: usize) -> usize {
        let Some(&first) = bytes.get(at) else {
            return at;
        };
        if !first.is_ascii_alphabetic() {
            self.symbol(bytes, at, first);
            // `\'hh` carries two hex digits after the quote.
            return if first == b'\'' { at + 3 } else { at + 1 };
        }
        let mut end = at;
        while bytes.get(end).is_some_and(u8::is_ascii_alphabetic) {
            end += 1;
        }
        let word = bytes
            .get(at..end)
            .and_then(|word| std::str::from_utf8(word).ok())
            .unwrap_or("");
        let mut digits = end;
        if bytes.get(digits) == Some(&b'-') {
            digits += 1;
        }
        while bytes.get(digits).is_some_and(u8::is_ascii_digit) {
            digits += 1;
        }
        let parameter = bytes
            .get(end..digits)
            .and_then(|number| std::str::from_utf8(number).ok())
            .and_then(|number| number.parse::<i32>().ok());
        // One space after a control word is its delimiter, not text.
        let mut next = if bytes.get(digits) == Some(&b' ') {
            digits + 1
        } else {
            digits
        };
        if word == "bin" {
            next = next.saturating_add(usize::try_from(parameter.unwrap_or(0)).unwrap_or(0));
        }
        self.word(word, parameter);
        next
    }

    fn symbol(&mut self, bytes: &[u8], at: usize, symbol: u8) {
        match symbol {
            b'\'' => {
                let value = bytes
                    .get(at + 1..at + 3)
                    .and_then(|hex| std::str::from_utf8(hex).ok())
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok());
                if let Some(value) = value {
                    self.byte(value);
                }
            }
            // An ignorable destination: readers that do not know it skip it.
            b'*' => self.group.skip = true,
            b'~' => self.char(' '),
            b'_' => self.char('-'),
            b'{' | b'}' | b'\\' => self.byte(symbol),
            b'\r' | b'\n' => self.line(),
            _ => {}
        }
    }

    fn line(&mut self) {
        if !self.group.skip {
            self.flush();
            self.sink.newline();
        }
    }

    fn word(&mut self, word: &str, parameter: Option<i32>) {
        match word {
            "par" | "line" | "sect" | "page" => self.line(),
            "row" => {
                if !self.group.skip {
                    self.flush();
                    self.sink.row_end();
                }
            }
            "tab" => self.char('\t'),
            // A row definition opens a row; the paragraph mark before a cell mark is the cell's own.
            "trowd" => {
                if !self.group.skip {
                    self.flush();
                    self.sink.cell_begin();
                }
            }
            "cell" => {
                if !self.group.skip {
                    self.flush();
                    self.sink.cell_end();
                }
            }
            "u" => self.unicode(parameter.unwrap_or(0)),
            "uc" => self.group.fallback = usize::try_from(parameter.unwrap_or(1)).unwrap_or(1),
            "ansicpg" => {
                self.flush();
                self.encoding = codepage(u32::try_from(parameter.unwrap_or(1252)).unwrap_or(1252));
            }
            "emdash" => self.char('—'),
            "endash" => self.char('–'),
            "bullet" => self.char('•'),
            "lquote" => self.char('‘'),
            "rquote" => self.char('’'),
            "ldblquote" => self.char('“'),
            "rdblquote" => self.char('”'),
            "emspace" | "enspace" | "qmspace" => self.char(' '),
            // Text boxes sit inside an ignorable shape group but are document text.
            "shptxt" => self.group.skip = false,
            _ if SKIPPED.contains(&word) => self.group.skip = true,
            _ => {}
        }
    }

    /// `\uN`: a UTF-16 code unit as a signed 16-bit number, then fallback characters.
    fn unicode(&mut self, value: i32) {
        let unit = (value & 0xFFFF) as u16;
        if !self.group.skip {
            let pair = self.surrogate.take();
            // Only pending code page bytes are flushed; a waiting surrogate must survive.
            if !self.pending.is_empty() {
                let text = decode(&self.pending, self.encoding);
                self.sink.push_str(&text);
                self.pending.clear();
            }
            match (pair, unit) {
                (Some(high), 0xDC00..=0xDFFF) => {
                    let decoded = char::decode_utf16([high, unit]).next().and_then(Result::ok);
                    self.sink.push(decoded.unwrap_or(char::REPLACEMENT_CHARACTER));
                }
                (_, 0xD800..=0xDBFF) => self.surrogate = Some(unit),
                _ => self
                    .sink
                    .push(char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER)),
            }
        }
        self.skip_fallback = self.group.fallback;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(rtf_source: &str) -> String {
        let mut sink = Sink::new(10_000);
        rtf(rtf_source.as_bytes(), &mut sink);
        sink.finish()
    }

    #[test]
    fn reads_paragraphs_and_skips_tables_of_definitions() {
        assert_eq!(
            text(
                r"{\rtf1\ansi\ansicpg1252{\fonttbl{\f0 Helvetica;}}{\colortbl;\red0\green0\blue0;}{\info{\title Hidden}}\f0\fs24 First line\par Second \b bold\b0  line\par}"
            ),
            "First line\nSecond bold line"
        );
    }

    #[test]
    fn decodes_hex_escapes_in_the_declared_code_page() {
        assert_eq!(text(r"{\rtf1\ansicpg1252 r\'e4ksm\'f6rg\'e5s}"), "räksmörgås");
        assert_eq!(text(r"{\rtf1\ansicpg1251 \'cf\'f0\'e8\'e2\'e5\'f2}"), "Привет");
        assert_eq!(text(r"{\rtf1\ansicpg932 \'93\'fa\'96\'7b}"), "日本");
    }

    #[test]
    fn decodes_unicode_escapes_and_drops_their_fallback() {
        assert_eq!(text(r"{\rtf1 \u229?\u228?\u246? and \uc0\u8364 5}"), "åäö and €5");
        assert_eq!(text(r"{\rtf1 \uc1\u-10179?\u-8704? ok}"), "😀 ok");
        assert_eq!(text(r"{\rtf1 \uc2\u229\'e5\'e5x}"), "åx");
    }

    #[test]
    fn maps_symbols_and_special_characters() {
        assert_eq!(
            text(r"{\rtf1 a\~b\_c\-d \{x\} \\ \emdash\endash\bullet\lquote\rquote\ldblquote\rdblquote\tab end}"),
            "a b-cd {x} \\ —–•‘’“”\tend"
        );
    }

    #[test]
    fn shapes_tables_and_keeps_field_results() {
        assert_eq!(
            text(r"{\rtf1 A\cell B\cell\row C\cell\row{\field{\*\fldinst HYPERLINK x}{\fldrslt link}}}"),
            "A\tB\nC\nlink"
        );
    }

    #[test]
    fn skips_ignorable_groups_binary_data_but_keeps_text_boxes() {
        assert_eq!(text("{\\rtf1 a{\\*\\unknown hidden}b{\\pict\\bin5 {}{}}}c}"), "abc");
        assert_eq!(text(r"{\rtf1 {\shp{\*\shpinst\shpleft1{\shptxt boxed\par}}}}"), "boxed");
        assert_eq!(text("{\\rtf1 line\\\none\\\rtwo}"), "line\none\ntwo");
    }

    #[test]
    fn nesting_beyond_the_remembered_depth_still_balances() {
        let deep = format!(
            "{{\\rtf1 {}inner{} outer}}",
            "{".repeat(MAX_DEPTH + 50),
            "}".repeat(MAX_DEPTH + 50)
        );
        assert_eq!(text(&deep), "inner outer");
        let hidden = format!(
            "{{\\rtf1 {{\\fonttbl {}x{}}}shown}}",
            "{".repeat(MAX_DEPTH + 50),
            "}".repeat(MAX_DEPTH + 50)
        );
        assert_eq!(text(&hidden), "shown");
    }

    #[test]
    fn survives_truncated_controls() {
        assert_eq!(text(r"{\rtf1 ok\"), "ok");
        assert_eq!(text(r"{\rtf1 ok\'e"), "ok");
        assert_eq!(text(r"{\rtf1 ok\u"), "ok");
        assert_eq!(text(r"}}}} ok \bin99999 x"), "ok");
        assert_eq!(text(r"{\rtf1 ok\bin99999999999 x}"), "okx");
        assert_eq!(text(r"{\rtf1 ok\bin-5 yes}"), "okyes");
    }
}
