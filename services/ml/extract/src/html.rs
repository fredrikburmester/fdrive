//! HTML to text, lenient enough for mail bodies and e-book chapters.

use quick_xml::escape::resolve_html5_entity;

use crate::sink::Sink;

/// Elements that end the current line.
const BLOCKS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "body",
    "br",
    "caption",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "html",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "title",
    "tr",
    "ul",
];

/// Elements whose content is code or styling, never text.
const RAW: &[&str] = &["script", "style"];

/// Appends the visible text of `html` to `sink`. Never fails: markup that
/// does not parse is read as best it can be.
pub(crate) fn html_to_text(html: &str, sink: &mut Sink) {
    let mut writer = Writer { sink, space: false };
    let mut rest = html;
    while !rest.is_empty() && !writer.sink.is_full() {
        let Some(open) = rest.find('<') else {
            writer.text(rest);
            break;
        };
        let (before, tag) = rest.split_at(open);
        writer.text(before);
        rest = if let Some(after) = tag.strip_prefix("<!--") {
            after.split_once("-->").map_or("", |(_, after)| after)
        } else if let Some(after) = tag.strip_prefix("<![CDATA[") {
            let (data, after) = after.split_once("]]>").unwrap_or((after, ""));
            writer.raw(data);
            after
        } else if tag.starts_with("<!") || tag.starts_with("<?") {
            tag.split_once('>').map_or("", |(_, after)| after)
        } else {
            writer.tag(tag)
        };
    }
    writer.sink.newline();
}

struct Writer<'s> {
    sink: &'s mut Sink,
    /// A whitespace run is pending; it becomes one space before the next word.
    space: bool,
}

impl Writer<'_> {
    fn raw(&mut self, text: &str) {
        for c in text.chars() {
            if c.is_whitespace() {
                self.space = true;
            } else {
                if self.space && !self.sink.at_cell_start() {
                    self.sink.push(' ');
                }
                self.space = false;
                self.sink.push(c);
            }
        }
    }

    /// Text between tags, with character references resolved.
    fn text(&mut self, text: &str) {
        let mut rest = text;
        while let Some(amp) = rest.find('&') {
            let (before, reference) = rest.split_at(amp);
            self.raw(before);
            let body = reference.get(1..).unwrap_or("");
            // A reference is short; a stray ampersand far from any `;` is text.
            let resolved = body
                .char_indices()
                .take(33)
                .find(|&(_, c)| c == ';')
                .and_then(|(end, _)| Some((entity(body.get(..end)?)?, end)));
            match resolved {
                Some((value, end)) => {
                    self.raw(&value);
                    rest = body.get(end + 1..).unwrap_or("");
                }
                None => {
                    self.raw("&");
                    rest = body;
                }
            }
        }
        self.raw(rest);
    }

    /// Handles the tag at the start of `input` and returns what follows it.
    fn tag<'a>(&mut self, input: &'a str) -> &'a str {
        // `<` that opens no tag, as in `a < b`; decided before looking for the end.
        let opens = input
            .chars()
            .nth(1)
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '/');
        if !opens {
            self.raw("<");
            return input.get(1..).unwrap_or("");
        }
        let Some(end) = tag_end(input) else {
            return "";
        };
        let inner = input.get(1..end).unwrap_or("");
        let after = input.get(end + 1..).unwrap_or("");
        let closing = inner.starts_with('/');
        let name: String = inner
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_lowercase())
            .collect();
        if name.is_empty() {
            return after;
        }
        if !closing && RAW.contains(&name.as_str()) {
            return skip_raw(after, &name);
        }
        if closing && name == "tr" {
            self.sink.row_end();
            self.space = false;
        } else if BLOCKS.contains(&name.as_str()) {
            self.sink.newline();
            self.space = false;
        } else if closing && matches!(name.as_str(), "td" | "th") {
            self.sink.tab();
            self.space = false;
        }
        after
    }
}

/// The index of the `>` that closes the tag starting `input`, skipping any
/// inside quoted attribute values.
fn tag_end(input: &str) -> Option<usize> {
    let mut quote = None;
    for (index, c) in input.char_indices().skip(1) {
        match (quote, c) {
            (None, '>') => return Some(index),
            (None, '"' | '\'') => quote = Some(c),
            (Some(open), _) if open == c => quote = None,
            _ => {}
        }
    }
    None
}

/// What follows the end tag of raw element `name`; nothing when it never ends.
fn skip_raw<'a>(input: &'a str, name: &str) -> &'a str {
    let mut rest = input;
    while let Some(at) = rest.find("</") {
        let candidate = rest.get(at + 2..).unwrap_or("");
        let matches = candidate
            .get(..name.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(name));
        if matches {
            return candidate.split_once('>').map_or("", |(_, after)| after);
        }
        rest = candidate;
    }
    ""
}

/// The text a character reference stands for, without its `&` and `;`.
fn entity(body: &str) -> Option<String> {
    if let Some(number) = body.strip_prefix('#') {
        let code = match number.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => number.parse().ok()?,
        };
        return char::from_u32(code).map(String::from);
    }
    resolve_html5_entity(body).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(html: &str) -> String {
        let mut sink = Sink::new(10_000);
        html_to_text(html, &mut sink);
        sink.finish()
    }

    #[test]
    fn keeps_text_and_breaks_lines_at_blocks() {
        assert_eq!(
            text(
                "<html><head><title>T</title><style>p { x: y }</style></head>\n<body><h1>Head</h1><p>One\n  two <b>bold</b>.</p><p>Three<br>four</p></body></html>"
            ),
            "T\nHead\nOne two bold.\nThree\nfour"
        );
    }

    #[test]
    fn drops_scripts_comments_and_declarations() {
        assert_eq!(
            text(
                "<!DOCTYPE html><?xml version=\"1.0\"?><!-- hidden --><SCRIPT>var a = '<p>no</p>';</SCRIPT><p>yes</p><![CDATA[raw <b>]]>"
            ),
            "yes\nraw <b>"
        );
        assert_eq!(text("a<script>never closed"), "a");
        assert_eq!(text("a<!-- never closed"), "a");
        assert_eq!(text("a<!DOCTYPE never closed"), "a");
    }

    #[test]
    fn resolves_character_references() {
        assert_eq!(
            text("a&amp;b &lt;c&gt; &#229;&#xE4;&ouml; R&D &bogus; &#xZZ; &"),
            "a&b <c> åäö R&D &bogus; &#xZZ; &"
        );
        assert_eq!(text("x&nbsp;y"), "x y");
    }

    #[test]
    fn separates_table_cells_with_tabs() {
        assert_eq!(
            text("<table><tr><td>a</td> <th>b</th></tr>\n<tr><td>c</td></tr></table>"),
            "a\tb\nc"
        );
    }

    #[test]
    fn tolerates_stray_brackets_and_quoted_attributes() {
        assert_eq!(text("a < b and <a title=\"x > y\" href='z'>link</a>"), "a < b and link");
        assert_eq!(text("tail <p unterminated"), "tail");
        assert_eq!(text("</>x"), "x");
        assert_eq!(text("1 <2 and 3<4<"), "1 <2 and 3<4<");
        assert_eq!(text("<style>a</b></STYLE >shown"), "shown");
    }

    #[test]
    fn stops_at_the_character_limit() {
        let mut sink = Sink::new(3);
        html_to_text("<p>abcdef</p><p>ghi</p>", &mut sink);
        assert_eq!(sink.finish(), "abc");
    }
}
