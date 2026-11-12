//! The text collector every parser writes into.

/// Collects extracted text up to a character limit and keeps its line shape
/// tidy: no leading blank lines, no runs of empty lines.
pub(crate) struct Sink {
    text: String,
    chars: usize,
    max: usize,
    /// Where the current table cell began; text before it is never rewritten.
    cell_start: usize,
}

impl Sink {
    pub(crate) fn new(max_chars: usize) -> Self {
        Self {
            text: String::new(),
            chars: 0,
            max: max_chars,
            cell_start: 0,
        }
    }

    /// Whether the character limit is reached; parsers stop reading then.
    pub(crate) fn is_full(&self) -> bool {
        self.chars >= self.max
    }

    /// Whether anything other than whitespace was collected.
    pub(crate) fn has_text(&self) -> bool {
        !self.text.trim().is_empty()
    }

    /// Whether the next character would start a line.
    pub(crate) fn at_line_start(&self) -> bool {
        self.text.is_empty() || self.text.ends_with('\n')
    }

    /// Whether the next character would start a line or a table cell.
    pub(crate) fn at_cell_start(&self) -> bool {
        self.at_line_start() || self.text.ends_with('\t')
    }

    pub(crate) fn push(&mut self, c: char) {
        if c == '\n' {
            return self.newline();
        }
        if matches!(c, '\0' | '\r') || self.is_full() {
            return;
        }
        self.text.push(c);
        self.chars += 1;
    }

    pub(crate) fn push_str(&mut self, s: &str) {
        for c in s.chars() {
            if self.is_full() {
                return;
            }
            self.push(c);
        }
    }

    /// Ends the current line, unless it is already ended.
    pub(crate) fn newline(&mut self) {
        if !self.at_line_start() && !self.is_full() {
            self.text.push('\n');
            self.chars += 1;
        }
    }

    pub(crate) fn tab(&mut self) {
        self.push('\t');
    }

    /// Marks the start of a table cell.
    pub(crate) fn cell_begin(&mut self) {
        self.cell_start = self.text.len();
    }

    /// Ends a table cell: the paragraph break inside it becomes the separator.
    pub(crate) fn cell_end(&mut self) {
        if self.text.len() > self.cell_start && self.text.ends_with('\n') {
            self.text.pop();
            self.chars -= 1;
        }
        self.tab();
        self.cell_start = self.text.len();
    }

    /// Ends a table row, dropping the separator after its last cell.
    pub(crate) fn row_end(&mut self) {
        while self.text.ends_with('\t') {
            self.text.pop();
            self.chars -= 1;
        }
        self.newline();
        self.cell_start = self.text.len();
    }

    pub(crate) fn finish(self) -> String {
        self.text.trim().to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stops_at_the_character_limit() {
        let mut sink = Sink::new(5);
        sink.push_str("åäö");
        assert!(!sink.is_full());
        sink.push_str("abcdef");
        assert!(sink.is_full());
        sink.push('x');
        sink.newline();
        assert_eq!(sink.finish(), "åäöab");
    }

    #[test]
    fn collapses_blank_lines_and_drops_nul() {
        let mut sink = Sink::new(100);
        sink.newline();
        sink.push_str("a\0b\r\n\n\n");
        sink.newline();
        sink.push('c');
        assert!(sink.has_text());
        assert_eq!(sink.finish(), "ab\nc");
    }

    #[test]
    fn cells_and_rows_shape_a_table() {
        let mut sink = Sink::new(100);
        sink.push_str("before");
        sink.newline();
        sink.cell_begin();
        sink.cell_end();
        sink.cell_begin();
        sink.push_str("a");
        sink.newline();
        sink.cell_end();
        sink.push_str("b");
        sink.cell_end();
        sink.row_end();
        sink.cell_end();
        sink.push_str("c");
        sink.cell_end();
        sink.row_end();
        assert_eq!(sink.finish(), "before\n\ta\tb\n\tc");
    }

    #[test]
    fn whitespace_alone_is_not_text() {
        let mut sink = Sink::new(100);
        sink.tab();
        sink.push(' ');
        assert!(!sink.has_text());
        assert_eq!(sink.finish(), "");
    }
}
