//! PowerPoint 97-2003 presentations (`.ppt`).

use std::collections::{HashMap, HashSet};

use crate::ExtractError;
use crate::bytes::{span, u16le, u32le, utf16le};
use crate::limits::Budget;
use crate::ole::Ole;
use crate::sink::Sink;

const DOCUMENT: u16 = 0x03E8;
const MAIN_MASTER: u16 = 0x03F8;
const SLIDE_PERSIST: u16 = 0x03F3;
const SLIDE_LIST: u16 = 0x0FF0;
const TEXT_CHARS: u16 = 0x0FA0;
const TEXT_BYTES: u16 = 0x0FA8;
const CSTRING: u16 = 0x0FBA;
const HEADERS_FOOTERS: u16 = 0x0FD9;
const COMMENT: u16 = 0x2EE0;
const CLIENT_TEXTBOX: u16 = 0xF00D;
const BINARY_TAG_DATA: u16 = 0x138B;
const USER_EDIT: u16 = 0x0FF5;
const PERSIST_DIRECTORY: u16 = 0x1772;

/// Persisted objects tracked at most: one per slide, note and master.
const MAX_PERSISTED: usize = 1 << 20;

/// `headerToken` of a "Current User" stream that belongs to an encrypted file.
const ENCRYPTED_TOKEN: u32 = 0xF3D1_C4DF;

pub(crate) fn ppt(ole: &mut Ole<'_>, budget: &mut Budget, sink: &mut Sink) -> Result<(), ExtractError> {
    let stream = ole
        .stream("/PowerPoint Document", budget)
        .ok_or_else(|| ExtractError::Malformed("missing PowerPoint Document stream".into()))?;
    let current = ole.stream("/Current User", budget).unwrap_or_default();
    if u32le(&current, 12) == Some(ENCRYPTED_TOKEN) {
        return Err(ExtractError::Encrypted);
    }
    // The stream keeps superseded records from earlier saves; only the
    // persist directory says which copy of each slide is live.
    let live = match u32le(&current, 16).map(|edit| persist_directory(&stream, edit as usize)) {
        Some(Err(error)) => return Err(error),
        Some(Ok(Some(directory))) => live_text(&stream, &directory, sink),
        _ => false,
    };
    if !live {
        // No usable directory: read every text record in stream order.
        for text in texts(&stream, 0, stream.len(), true) {
            line(sink, &text.text);
        }
    }
    Ok(())
}

/// Where the live copy of each persisted object starts, and which is the document.
struct Directory {
    offsets: HashMap<u32, u32>,
    document: u32,
}

/// Follows the chain of user edits from the newest back; earlier edits only
/// supply objects the newer ones did not rewrite.
fn persist_directory(stream: &[u8], newest: usize) -> Result<Option<Directory>, ExtractError> {
    let mut offsets = HashMap::new();
    let mut document = None;
    let mut edit = newest;
    // Each edit points at an earlier one; a cycle would otherwise never end.
    for _ in 0..4096 {
        let Some(record) = Record::at(stream, edit).filter(|record| record.kind == USER_EDIT) else {
            return Ok(None);
        };
        // An edit that carries an encryption session marks an encrypted document.
        if record.len >= 32 {
            return Err(ExtractError::Encrypted);
        }
        let body = record.body;
        let (Some(previous), Some(directory), Some(root)) = (
            u32le(stream, body + 8),
            u32le(stream, body + 12),
            u32le(stream, body + 16),
        ) else {
            return Ok(None);
        };
        document.get_or_insert(root);
        let Some(entries) = Record::at(stream, directory as usize)
            .filter(|record| record.kind == PERSIST_DIRECTORY)
            .and_then(|record| span(stream, record.body, record.len))
        else {
            return Ok(None);
        };
        let mut at = 0;
        while let Some(header) = u32le(entries, at) {
            let first = header & 0x000F_FFFF;
            let count = header >> 20;
            at += 4;
            for index in 0..count {
                let Some(offset) = u32le(entries, at) else {
                    break;
                };
                if offsets.len() < MAX_PERSISTED {
                    offsets.entry(first.wrapping_add(index)).or_insert(offset);
                }
                at += 4;
            }
        }
        if previous == 0 || previous as usize >= edit {
            break;
        }
        edit = previous as usize;
    }
    Ok(document.map(|document| Directory { offsets, document }))
}

/// Writes slide text in presentation order, then notes and footers.
/// `false` when the directory does not lead to any slide.
fn live_text(stream: &[u8], directory: &Directory, sink: &mut Sink) -> bool {
    let container = |id: u32, kind: Option<u16>| {
        let offset = *directory.offsets.get(&id)? as usize;
        let record = Record::at(stream, offset)
            .filter(|record| record.container && kind.is_none_or(|kind| kind == record.kind))?;
        Some((record.body, record.body.checked_add(record.len)?.min(stream.len())))
    };
    let Some((start, end)) = container(directory.document, Some(DOCUMENT)) else {
        return false;
    };
    // Each slide and notes page owns its own stretch of the stream. A
    // directory that points many of them at one stretch would have every one
    // scan it again, so the total scanned is held to a few times the stream.
    let mut allowance = stream.len().saturating_mul(4);
    let mut scan = |start: usize, end: usize| {
        let wanted = end.saturating_sub(start);
        if wanted > allowance {
            allowance = 0;
            return Vec::new();
        }
        allowance -= wanted;
        texts(stream, start, end, false)
    };
    // Slide lists come as instance 0 (slides), 1 (masters) and 2 (notes).
    // Each slide's placeholder text sits in the list, after its persist entry.
    let mut slides: Vec<(u32, Vec<String>)> = Vec::new();
    let mut notes = Vec::new();
    let mut loose = Vec::new();
    for text in scan(start, end) {
        match (text.list, text.slide) {
            (Some(0), Some(id)) if text.starts_slide => slides.push((id, Vec::new())),
            (Some(0), _) => {
                if let Some((_, outline)) = slides.last_mut() {
                    outline.push(text.text);
                }
            }
            (Some(2), Some(id)) if text.starts_slide => notes.push(id),
            (Some(_), _) => {}
            (None, _) => loose.push(text.text),
        }
    }
    if slides.is_empty() {
        return false;
    }
    for (id, outline) in &slides {
        if sink.is_full() {
            break;
        }
        for text in outline {
            line(sink, text);
        }
        // The slide's own shapes hold the text boxes that are not placeholders.
        if let Some((start, end)) = container(*id, None) {
            let known: HashSet<&str> = outline.iter().map(String::as_str).collect();
            for text in scan(start, end) {
                if !known.contains(text.text.as_str()) {
                    line(sink, &text.text);
                }
            }
        }
    }
    for id in notes {
        if sink.is_full() {
            break;
        }
        if let Some((start, end)) = container(id, None) {
            for text in scan(start, end) {
                line(sink, &text.text);
            }
        }
    }
    for text in &loose {
        line(sink, text);
    }
    true
}

fn line(sink: &mut Sink, text: &str) {
    // A lone asterisk is the slide number placeholder of a notes page.
    if !text.is_empty() && text != "*" {
        sink.push_str(text);
        sink.newline();
    }
}

/// One text record and where in the document's slide lists it sits.
struct Text {
    text: String,
    /// The instance of the enclosing slide list, when there is one.
    list: Option<u16>,
    /// The persist id of the slide the text belongs to, inside a slide list.
    slide: Option<u32>,
    /// Not text but the list entry that introduces `slide`.
    starts_slide: bool,
}

/// Collects the text records in `stream[start..end]`, and the slide list
/// entries among them so slides without placeholder text are still listed.
fn texts(stream: &[u8], start: usize, end: usize, skip_masters: bool) -> Vec<Text> {
    let mut out = Vec::new();
    // Open containers as (kind, instance, end offset). The enclosing slide
    // lists and masters are tracked beside it, so a deeply nested stream
    // does not make every record rescan the whole stack.
    let mut open: Vec<(u16, u16, usize)> = Vec::new();
    let mut lists: Vec<u16> = Vec::new();
    let mut masters = 0usize;
    let mut slide = None;
    let mut at = start;
    while at < end {
        let Some(record) = Record::at(stream, at) else {
            break;
        };
        while open.last().is_some_and(|&(_, _, close)| at >= close) {
            match open.pop() {
                Some((SLIDE_LIST, _, _)) => {
                    lists.pop();
                    slide = None;
                }
                Some((MAIN_MASTER, _, _)) => masters = masters.saturating_sub(1),
                _ => {}
            }
        }
        if record.container {
            let close = record.body.saturating_add(record.len).min(end);
            open.push((record.kind, record.instance, close));
            match record.kind {
                SLIDE_LIST => lists.push(record.instance),
                MAIN_MASTER => masters += 1,
                _ => {}
            }
            at = record.body;
            continue;
        }
        at = record.body.saturating_add(record.len);
        let list = lists.first().copied();
        let in_master = masters > 0 || list == Some(1);
        let parent = open.last().map(|&(kind, _, _)| kind);
        let body = span(stream, record.body, record.len).unwrap_or(&[]);
        let starts_slide = record.kind == SLIDE_PERSIST && list.is_some();
        let text = match record.kind {
            SLIDE_PERSIST if starts_slide => {
                slide = u32le(body, 0);
                Some(String::new())
            }
            _ if skip_masters && in_master => None,
            TEXT_CHARS => Some(clean(&utf16le(body))),
            TEXT_BYTES => Some(clean(&body.iter().map(|&byte| char::from(byte)).collect::<String>())),
            // Free-standing strings are mostly internal names; these two parents hold prose.
            CSTRING if matches!(parent, Some(HEADERS_FOOTERS | COMMENT)) => Some(clean(&utf16le(body))),
            _ => None,
        };
        if let Some(text) = text.filter(|text| starts_slide || !text.is_empty()) {
            out.push(Text {
                text,
                list,
                slide: slide.filter(|_| list.is_some()),
                starts_slide,
            });
        }
    }
    out
}

/// Paragraph and line marks become newlines; other control characters go.
fn clean(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            '\r' | '\u{0B}' => Some('\n'),
            '\t' => Some('\t'),
            c if c < ' ' => None,
            c => Some(c),
        })
        .collect::<String>()
        .trim()
        .to_owned()
}

/// A record header: version and instance, type, and body length.
struct Record {
    kind: u16,
    instance: u16,
    container: bool,
    body: usize,
    len: usize,
}

impl Record {
    fn at(stream: &[u8], at: usize) -> Option<Self> {
        let version = u16le(stream, at)?;
        let kind = u16le(stream, at.checked_add(2)?)?;
        let len = u32le(stream, at.checked_add(4)?)? as usize;
        Some(Self {
            kind,
            instance: version >> 4,
            // Text boxes and extension blobs hold records whichever version they declare.
            container: version & 0x000F == 0x000F || matches!(kind, CLIENT_TEXTBOX | BINARY_TAG_DATA),
            body: at.checked_add(8)?,
            len,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_control_characters() {
        assert_eq!(clean("Title\rSecond\u{0B}Third\u{01}\t."), "Title\nSecond\nThird\t.");
        assert_eq!(clean("\r\r"), "");
    }

    #[test]
    fn reads_record_headers() {
        let bytes = [0x0F, 0x00, 0xE8, 0x03, 0x10, 0, 0, 0];
        let record = Record::at(&bytes, 0).unwrap();
        assert_eq!(record.kind, DOCUMENT);
        assert!(record.container);
        assert_eq!((record.instance, record.body, record.len), (0, 8, 16));
        assert!(Record::at(&bytes, 1).is_none());
        assert!(Record::at(&bytes, usize::MAX).is_none());
    }
}
