//! OpenDocument: `.odt`, `.ods` and `.odp` all keep their text in `content.xml`.

use crate::ExtractError;
use crate::sink::Sink;
use crate::xml::{Flow, Node, attr_local, local};
use crate::zipdoc::Package;

/// Whether the manifest lists encrypted members.
pub(crate) fn is_encrypted(pkg: &mut Package<'_, '_>) -> bool {
    let mut encrypted = false;
    let _ = pkg.xml("META-INF/manifest.xml", |node| match node {
        Node::Open(element) if local(element) == "encryption-data" => {
            encrypted = true;
            Flow::Stop
        }
        _ => Flow::Continue,
    });
    encrypted
}

/// `sheet_names` writes each table's name before it, which suits spreadsheets
/// but would litter a text document with "Table1".
pub(crate) fn odf(pkg: &mut Package<'_, '_>, sheet_names: bool, sink: &mut Sink) -> Result<(), ExtractError> {
    // Depth inside paragraphs and headings; whitespace between them is layout.
    let mut in_paragraph = 0u32;
    // Depth inside tracked changes, which hold deleted text.
    let mut skipping = 0u32;
    let found = pkg.xml("content.xml", |node| {
        match node {
            Node::Open(_) if skipping > 0 => skipping += 1,
            Node::Close(_) if skipping > 0 => skipping -= 1,
            Node::Open(element) => match local(element) {
                "tracked-changes" => skipping = 1,
                "p" | "h" => in_paragraph += 1,
                "tab" => sink.tab(),
                "line-break" => sink.newline(),
                "s" => {
                    let count = attr_local(element, "c")
                        .and_then(|count| count.parse::<usize>().ok())
                        .unwrap_or(1);
                    for _ in 0..count.min(16) {
                        sink.push(' ');
                    }
                }
                "table-cell" => sink.cell_begin(),
                "table" if sheet_names => {
                    if let Some(name) = attr_local(element, "name") {
                        sink.newline();
                        sink.push_str(&name);
                        sink.newline();
                    }
                }
                _ => {}
            },
            Node::Close(name) => match name {
                "p" | "h" => {
                    in_paragraph = in_paragraph.saturating_sub(1);
                    sink.newline();
                }
                "table-cell" | "covered-table-cell" => sink.cell_end(),
                "table-row" => sink.row_end(),
                _ => {}
            },
            Node::Text(text) => {
                if in_paragraph > 0 {
                    sink.push_str(text);
                }
            }
        }
        if sink.is_full() { Flow::Stop } else { Flow::Continue }
    })?;
    if found {
        Ok(())
    } else {
        Err(ExtractError::Malformed("missing content.xml".into()))
    }
}
