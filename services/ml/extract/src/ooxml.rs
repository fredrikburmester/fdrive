//! Office Open XML: `.docx`, `.xlsx`, `.pptx` and `.vsdx`.

use std::collections::HashMap;

use crate::ExtractError;
use crate::dates::{is_date_format, serial_text};
use crate::sink::Sink;
use crate::strings::StringTable;
use crate::xml::{Flow, Node, attr, attr_local, local};
use crate::zipdoc::{Package, resolve, trailing_number};

/// Relationships, slides and sheets kept per part at most. Real documents
/// stay far below; the cap keeps a hostile list from costing memory.
const MAX_ENTRIES: usize = 65_536;

/// One entry of a part's `_rels` file, with its target resolved to a part name.
pub(crate) struct Relationship {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) target: String,
}

/// The relationships of `part` (the package root when `part` is empty).
pub(crate) fn relationships(pkg: &mut Package<'_, '_>, part: &str) -> Vec<Relationship> {
    let (folder, file) = part.rsplit_once('/').unwrap_or(("", part));
    let rels = if folder.is_empty() {
        format!("_rels/{file}.rels")
    } else {
        format!("{folder}/_rels/{file}.rels")
    };
    let mut out = Vec::new();
    // A missing or broken relationship part only costs the ordering it describes.
    let _ = pkg.xml(&rels, |node| {
        if let Node::Open(element) = node
            && local(element) == "Relationship"
            && out.len() < MAX_ENTRIES
            && attr(element, "TargetMode").as_deref() != Some("External")
            && let (Some(id), Some(target)) = (attr(element, "Id"), attr(element, "Target"))
        {
            out.push(Relationship {
                id,
                kind: attr(element, "Type").unwrap_or_default(),
                target: resolve(part, &target),
            });
        }
        Flow::Continue
    });
    out
}

/// Relationship targets by id. Lookups run once per slide or sheet, so a
/// linear search would make a package with many of both quadratic.
fn by_id(rels: &[Relationship]) -> HashMap<&str, &str> {
    rels.iter().map(|rel| (rel.id.as_str(), rel.target.as_str())).collect()
}

/// The part the package's root relationships name as the document itself.
pub(crate) fn main_part(pkg: &mut Package<'_, '_>) -> Option<String> {
    relationships(pkg, "")
        .into_iter()
        .find(|rel| rel.kind.ends_with("/officeDocument"))
        .map(|rel| rel.target)
        .filter(|target| pkg.has(target))
}

/// Text of WordprocessingML and DrawingML, which share their shape: runs of
/// `t` inside paragraphs `p`, with tables of `tr` and `tc`.
#[derive(Default)]
pub(crate) struct FlowText {
    /// Depth inside a subtree whose text must not be collected.
    skipping: u32,
    in_text: bool,
    /// Depth inside a chart's cached labels, whose values are `v` elements.
    labels: u32,
}

impl FlowText {
    pub(crate) fn visit(&mut self, node: Node<'_>, sink: &mut Sink) -> Flow {
        match node {
            Node::Open(_) if self.skipping > 0 => self.skipping += 1,
            Node::Close(_) if self.skipping > 0 => self.skipping -= 1,
            Node::Open(element) => match local(element) {
                // Properties hold tab stops, not text; a fallback repeats its choice.
                "pPr" | "rPr" | "tblPr" | "sectPr" | "Fallback" => self.skipping = 1,
                "t" => self.in_text = true,
                "strCache" => self.labels += 1,
                "v" if self.labels > 0 => self.in_text = true,
                "tab" => sink.tab(),
                "br" | "cr" => sink.newline(),
                "noBreakHyphen" => sink.push('-'),
                "tc" => sink.cell_begin(),
                _ => {}
            },
            Node::Close(name) => match name {
                "t" => self.in_text = false,
                "strCache" => self.labels = self.labels.saturating_sub(1),
                "v" if self.labels > 0 => {
                    self.in_text = false;
                    sink.newline();
                }
                "p" => sink.newline(),
                "tc" => sink.cell_end(),
                "tr" => sink.row_end(),
                _ => {}
            },
            Node::Text(text) => {
                if self.in_text {
                    sink.push_str(text);
                }
            }
        }
        if sink.is_full() { Flow::Stop } else { Flow::Continue }
    }
}

/// Collects one flow-text part; a missing part is not an error.
fn flow_part(pkg: &mut Package<'_, '_>, name: &str, sink: &mut Sink) -> Result<(), ExtractError> {
    let mut text = FlowText::default();
    pkg.xml(name, |node| text.visit(node, sink))?;
    sink.newline();
    Ok(())
}

/// Collects the text of parts that hang off the main content: charts,
/// diagrams, drawings and comments, named `{root}/{kind}{n}.xml`. They are
/// extras, so one that does not parse is left out rather than failing the
/// document.
fn attached(pkg: &mut Package<'_, '_>, main: &str, kinds: &[&str], sink: &mut Sink) {
    let root = main.split('/').next().unwrap_or("");
    for kind in kinds {
        for part in numbered_parts(pkg, &format!("{root}/{kind}")) {
            if sink.is_full() {
                return;
            }
            let _ = flow_part(pkg, &part, sink);
        }
    }
}

pub(crate) fn docx(pkg: &mut Package<'_, '_>, main: &str, sink: &mut Sink) -> Result<(), ExtractError> {
    flow_part(pkg, main, sink)?;
    let folder = main.rsplit_once('/').map_or("", |(folder, _)| folder);
    let mut extras: Vec<String> = pkg
        .names()
        .iter()
        .filter(|name| {
            name.strip_prefix(folder)
                .and_then(|rest| rest.strip_prefix('/'))
                .is_some_and(|file| {
                    ["header", "footer", "footnotes", "endnotes", "comments"]
                        .iter()
                        .any(|kind| file.starts_with(kind))
                        && file.ends_with(".xml")
                })
        })
        .cloned()
        .collect();
    extras.sort();
    for extra in extras {
        if sink.is_full() {
            break;
        }
        flow_part(pkg, &extra, sink)?;
    }
    attached(pkg, main, &["charts/chart", "diagrams/data"], sink);
    Ok(())
}

pub(crate) fn pptx(pkg: &mut Package<'_, '_>, main: &str, sink: &mut Sink) -> Result<(), ExtractError> {
    let rels = relationships(pkg, main);
    let mut order = Vec::new();
    pkg.xml(main, |node| {
        if let Node::Open(element) = node
            && local(element) == "sldId"
            && order.len() < MAX_ENTRIES
            && let Some(id) = attr(element, "r:id")
        {
            order.push(id);
        }
        Flow::Continue
    })?;
    let targets = by_id(&rels);
    let mut slides: Vec<String> = order
        .iter()
        .filter_map(|id| targets.get(id.as_str()))
        .map(|target| (*target).to_owned())
        .collect();
    if slides.is_empty() {
        // No usable slide list: fall back to the numbering in the part names.
        slides = numbered_parts(pkg, "ppt/slides/slide");
    }
    for slide in slides {
        if sink.is_full() {
            break;
        }
        flow_part(pkg, &slide, sink)?;
        let notes = relationships(pkg, &slide)
            .into_iter()
            .find(|rel| rel.kind.ends_with("/notesSlide"));
        if let Some(notes) = notes {
            flow_part(pkg, &notes.target, sink)?;
        }
    }
    attached(pkg, main, &["charts/chart", "diagrams/data"], sink);
    Ok(())
}

/// Parts named `{prefix}{n}.xml`, in numeric order.
fn numbered_parts(pkg: &Package<'_, '_>, prefix: &str) -> Vec<String> {
    let mut parts: Vec<String> = pkg
        .names()
        .iter()
        .filter(|name| {
            let lower = name.to_ascii_lowercase();
            lower.starts_with(&prefix.to_ascii_lowercase()) && lower.ends_with(".xml")
        })
        .cloned()
        .collect();
    parts.sort_by_key(|name| trailing_number(name));
    parts
}

pub(crate) fn vsdx(pkg: &mut Package<'_, '_>, sink: &mut Sink) -> Result<(), ExtractError> {
    // Shapes without text of their own show their master's, so masters follow the pages.
    let mut parts = numbered_parts(pkg, "visio/pages/page");
    parts.extend(numbered_parts(pkg, "visio/masters/master"));
    for page in parts {
        if sink.is_full() {
            break;
        }
        // Shape text is the character data of `Text`, around formatting markers.
        let mut depth = 0u32;
        pkg.xml(&page, |node| {
            match node {
                Node::Open(element) if local(element) == "Text" => depth += 1,
                Node::Close("Text") => {
                    depth = depth.saturating_sub(1);
                    sink.newline();
                }
                Node::Text(text) if depth > 0 => sink.push_str(text),
                _ => {}
            }
            if sink.is_full() { Flow::Stop } else { Flow::Continue }
        })?;
    }
    Ok(())
}

pub(crate) fn xlsx(pkg: &mut Package<'_, '_>, main: &str, sink: &mut Sink) -> Result<(), ExtractError> {
    let rels = relationships(pkg, main);
    let targets = by_id(&rels);
    let mut sheets: Vec<(String, String)> = Vec::new();
    let mut date1904 = false;
    pkg.xml(main, |node| {
        if let Node::Open(element) = node {
            match local(element) {
                "sheet" => {
                    if sheets.len() < MAX_ENTRIES
                        && let Some(id) = attr(element, "r:id")
                        && let Some(target) = targets.get(id.as_str())
                    {
                        let name = attr_local(element, "name").unwrap_or_default();
                        sheets.push((name, (*target).to_owned()));
                    }
                }
                "workbookPr" => date1904 = matches!(attr(element, "date1904").as_deref(), Some("1" | "true")),
                _ => {}
            }
        }
        Flow::Continue
    })?;
    if sheets.is_empty() {
        sheets = numbered_parts(pkg, "xl/worksheets/sheet")
            .into_iter()
            .map(|part| (String::new(), part))
            .collect();
    }
    let strings_part = rels
        .iter()
        .find(|rel| rel.kind.ends_with("/sharedStrings"))
        .map_or_else(|| resolve(main, "sharedStrings.xml"), |rel| rel.target.clone());
    let strings = shared_strings(pkg, &strings_part)?;
    let styles_part = rels
        .iter()
        .find(|rel| rel.kind.ends_with("/styles"))
        .map_or_else(|| resolve(main, "styles.xml"), |rel| rel.target.clone());
    let book = Book {
        strings,
        dates: date_styles(pkg, &styles_part),
        date1904,
    };
    for (name, part) in sheets {
        if sink.is_full() {
            break;
        }
        if !name.is_empty() {
            sink.push_str(&name);
            sink.newline();
        }
        sheet(pkg, &part, &book, sink)?;
    }
    attached(pkg, main, &["comments", "drawings/drawing", "charts/chart"], sink);
    Ok(())
}

/// The shared string table: one entry per `si`, phonetic guides left out.
fn shared_strings(pkg: &mut Package<'_, '_>, part: &str) -> Result<StringTable, ExtractError> {
    let mut strings = StringTable::default();
    let mut current = String::new();
    let mut in_text = false;
    let mut phonetic = 0u32;
    pkg.xml(part, |node| {
        match node {
            Node::Open(_) if phonetic > 0 => phonetic += 1,
            Node::Close(_) if phonetic > 0 => phonetic -= 1,
            Node::Open(element) => match local(element) {
                "rPh" => phonetic = 1,
                "t" => in_text = true,
                _ => {}
            },
            Node::Close("t") => in_text = false,
            Node::Close("si") => {
                strings.push(&current);
                current.clear();
            }
            Node::Text(text) if in_text => current.push_str(text),
            _ => {}
        }
        Flow::Continue
    })?;
    Ok(strings)
}

/// What a sheet needs from the rest of the workbook to print its cells.
struct Book {
    strings: StringTable,
    /// For each cell style, whether its number format is a date.
    dates: Vec<bool>,
    date1904: bool,
}

/// Reads which cell styles show dates. Styles are optional; a broken part
/// only means dates print as day numbers.
fn date_styles(pkg: &mut Package<'_, '_>, part: &str) -> Vec<bool> {
    let mut formats: HashMap<u32, bool> = HashMap::new();
    let mut dates = Vec::new();
    let mut in_cell_styles = false;
    let _ = pkg.xml(part, |node| {
        match node {
            Node::Open(element) => match local(element) {
                "numFmt" => {
                    let id = attr(element, "numFmtId").and_then(|id| id.parse().ok());
                    if let (Some(id), Some(code)) = (id, attr(element, "formatCode")) {
                        formats.insert(id, is_date_format(id, Some(&code)));
                    }
                }
                "cellXfs" => in_cell_styles = true,
                "xf" if in_cell_styles => {
                    let id: u32 = attr(element, "numFmtId").and_then(|id| id.parse().ok()).unwrap_or(0);
                    dates.push(formats.get(&id).copied().unwrap_or_else(|| is_date_format(id, None)));
                }
                _ => {}
            },
            Node::Close("cellXfs") => in_cell_styles = false,
            _ => {}
        }
        Flow::Continue
    });
    dates
}

/// How a cell's `v` is to be read, from its `t` attribute.
enum CellKind {
    Shared,
    Bool,
    Literal,
    /// A number whose style shows it as a date.
    Date,
}

fn sheet(pkg: &mut Package<'_, '_>, part: &str, book: &Book, sink: &mut Sink) -> Result<(), ExtractError> {
    let mut kind = CellKind::Literal;
    let mut value = String::new();
    // `v` holds a stored value, `t` inside `is` an inline string.
    let mut in_value = false;
    let mut in_inline = false;
    pkg.xml(part, |node| {
        match node {
            Node::Open(element) => match local(element) {
                "c" => {
                    let style = attr(element, "s").and_then(|style| style.parse::<usize>().ok());
                    kind = match attr(element, "t").as_deref() {
                        Some("s") => CellKind::Shared,
                        Some("b") => CellKind::Bool,
                        None | Some("n") if style.is_some_and(|style| book.dates.get(style) == Some(&true)) => {
                            CellKind::Date
                        }
                        _ => CellKind::Literal,
                    };
                    value.clear();
                }
                "v" => in_value = true,
                "is" => in_inline = true,
                "t" if in_inline => in_value = true,
                _ => {}
            },
            Node::Close(name) => match name {
                "v" | "t" => in_value = false,
                "is" => in_inline = false,
                "c" => {
                    let date = matches!(kind, CellKind::Date)
                        .then(|| value.trim().parse().ok())
                        .flatten()
                        .and_then(|serial| serial_text(serial, book.date1904));
                    let text = match kind {
                        CellKind::Shared => value
                            .trim()
                            .parse::<usize>()
                            .ok()
                            .and_then(|index| book.strings.get(index))
                            .unwrap_or(""),
                        CellKind::Bool if value.trim() == "1" => "TRUE",
                        CellKind::Bool => "FALSE",
                        CellKind::Literal | CellKind::Date => date.as_deref().unwrap_or(&value),
                    };
                    if !text.is_empty() {
                        sink.push_str(text);
                        sink.tab();
                    }
                }
                "row" => sink.row_end(),
                _ => {}
            },
            Node::Text(text) if in_value => value.push_str(text),
            Node::Text(_) => {}
        }
        if sink.is_full() { Flow::Stop } else { Flow::Continue }
    })?;
    sink.row_end();
    Ok(())
}
