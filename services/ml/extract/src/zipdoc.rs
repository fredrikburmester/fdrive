//! Bounded access to the members of a ZIP-based document.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Cursor, Read};

use zip::ZipArchive;

use crate::ExtractError;
use crate::limits::Budget;
use crate::xml::{self, Flow, Node};

/// A ZIP container whose members are only ever read through the byte budget.
pub(crate) struct Package<'a, 'b> {
    archive: ZipArchive<Cursor<&'a [u8]>>,
    /// Member names with `/` separators; some writers store backslashes.
    names: Vec<String>,
    /// The names as stored, index for index with `names`.
    stored: Vec<String>,
    /// Lowercased name to index; part names compare case-insensitively.
    index: HashMap<String, usize>,
    budget: &'b mut Budget,
}

impl<'a, 'b> Package<'a, 'b> {
    pub(crate) fn open(bytes: &'a [u8], budget: &'b mut Budget) -> Result<Self, ExtractError> {
        let archive =
            ZipArchive::new(Cursor::new(bytes)).map_err(|error| ExtractError::Malformed(format!("zip: {error}")))?;
        let stored: Vec<String> = archive.file_names().flatten().map(|name| name.into_owned()).collect();
        let names: Vec<String> = stored.iter().map(|name| name.replace('\\', "/")).collect();
        let mut index = HashMap::with_capacity(names.len());
        for (position, name) in names.iter().enumerate() {
            index.entry(name.to_ascii_lowercase()).or_insert(position);
        }
        Ok(Self {
            archive,
            names,
            stored,
            index,
            budget,
        })
    }

    pub(crate) fn names(&self) -> &[String] {
        &self.names
    }

    /// The stored spelling of `name`.
    fn stored(&self, name: &str) -> Option<&str> {
        let position = *self.index.get(&name.to_ascii_lowercase())?;
        self.stored.get(position).map(String::as_str)
    }

    pub(crate) fn has(&self, name: &str) -> bool {
        self.stored(name).is_some()
    }

    /// A reader over one member, `None` when it is missing or unreadable.
    pub(crate) fn member(&mut self, name: &str) -> Option<impl BufRead + '_> {
        let stored = self.stored(name)?.to_owned();
        let file = self.archive.by_name(&stored).ok()?;
        Some(BufReader::new(self.budget.limit(file)))
    }

    /// A whole member in memory, cut at the limits.
    pub(crate) fn bytes(&mut self, name: &str) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        // A read error part way leaves what was read, which is still worth using.
        let _ = self.member(name)?.read_to_end(&mut out);
        Some(out)
    }

    /// Walks an XML member. `Ok(false)` means the member does not exist.
    pub(crate) fn xml(&mut self, name: &str, visit: impl FnMut(Node<'_>) -> Flow) -> Result<bool, ExtractError> {
        let Some(reader) = self.member(name) else {
            return Ok(false);
        };
        xml::walk(reader, visit)
            .map(|()| true)
            .map_err(|error| ExtractError::Malformed(format!("{name}: {error}")))
    }
}

/// Resolves a relative `target` against the folder of `base`, the way
/// relationship and manifest references are written.
pub(crate) fn resolve(base: &str, target: &str) -> String {
    let mut parts: Vec<&str> = match target.strip_prefix('/') {
        Some(_) => Vec::new(),
        None => {
            let mut folder: Vec<&str> = base.split('/').collect();
            folder.pop();
            folder
        }
    };
    for segment in target.trim_start_matches('/').split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// The number at the end of a part name such as `slide12.xml`, for ordering.
pub(crate) fn trailing_number(name: &str) -> u32 {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let digits = stem.len() - stem.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    stem.get(stem.len() - digits..)
        .and_then(|number| number.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_and_absolute_targets() {
        assert_eq!(
            resolve("ppt/presentation.xml", "slides/slide1.xml"),
            "ppt/slides/slide1.xml"
        );
        assert_eq!(
            resolve("ppt/slides/slide1.xml", "../notesSlides/notesSlide1.xml"),
            "ppt/notesSlides/notesSlide1.xml"
        );
        assert_eq!(
            resolve("xl/workbook.xml", "/xl/worksheets/sheet1.xml"),
            "xl/worksheets/sheet1.xml"
        );
        assert_eq!(resolve("content.opf", "./text/ch1.xhtml"), "text/ch1.xhtml");
        assert_eq!(resolve("a.xml", "../../b.xml"), "b.xml");
    }

    #[test]
    fn orders_parts_by_their_number() {
        assert_eq!(trailing_number("ppt/slides/slide12.xml"), 12);
        assert_eq!(trailing_number("word/header.xml"), 0);
        assert_eq!(trailing_number("sheet3"), 3);
        assert_eq!(trailing_number("x99999999999999999999.xml"), 0);
    }
}
