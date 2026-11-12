//! EPUB: XHTML chapters in a ZIP, read in the order the package spine gives.

use std::collections::HashMap;

use crate::ExtractError;
use crate::html::html_to_text;
use crate::sink::Sink;
use crate::xml::{Flow, Node, attr, local};
use crate::zipdoc::{Package, resolve};

/// Manifest items and spine entries kept at most; real books have hundreds.
const MAX_ENTRIES: usize = 65_536;

pub(crate) fn epub(pkg: &mut Package<'_, '_>, sink: &mut Sink) -> Result<(), ExtractError> {
    // Adobe's rights file marks DRM; the chapters are then ciphertext.
    if pkg.has("META-INF/rights.xml") {
        return Err(ExtractError::Encrypted);
    }
    let mut chapters = match package_document(pkg) {
        Some(opf) => spine(pkg, &opf, sink)?,
        None => Vec::new(),
    };
    if chapters.is_empty() {
        // No readable spine: take every chapter-like member in name order.
        chapters = pkg
            .names()
            .iter()
            .filter(|name| {
                let lower = name.to_ascii_lowercase();
                [".xhtml", ".html", ".htm"].iter().any(|ext| lower.ends_with(ext))
            })
            .cloned()
            .collect();
        chapters.sort();
    }
    if chapters.is_empty() {
        return Err(ExtractError::Malformed("no chapters".into()));
    }
    for chapter in chapters {
        if sink.is_full() {
            break;
        }
        if let Some(bytes) = pkg.bytes(&chapter) {
            html_to_text(&String::from_utf8_lossy(&bytes), sink);
        }
    }
    Ok(())
}

/// The package document path that `META-INF/container.xml` points at.
fn package_document(pkg: &mut Package<'_, '_>) -> Option<String> {
    let mut path = None;
    let _ = pkg.xml("META-INF/container.xml", |node| match node {
        Node::Open(element) if local(element) == "rootfile" => {
            path = attr(element, "full-path");
            Flow::Stop
        }
        _ => Flow::Continue,
    });
    path
}

/// Writes the title and author, and returns the chapter parts in reading order.
fn spine(pkg: &mut Package<'_, '_>, opf: &str, sink: &mut Sink) -> Result<Vec<String>, ExtractError> {
    let mut items: HashMap<String, String> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut in_metadata = false;
    pkg.xml(opf, |node| {
        match node {
            Node::Open(element) => match local(element) {
                "item" if items.len() < MAX_ENTRIES => {
                    if let (Some(id), Some(href)) = (attr(element, "id"), attr(element, "href")) {
                        items.insert(id, href);
                    }
                }
                "itemref" if order.len() < MAX_ENTRIES => order.extend(attr(element, "idref")),
                "title" | "creator" => in_metadata = true,
                _ => {}
            },
            Node::Close("title" | "creator") => {
                in_metadata = false;
                sink.newline();
            }
            Node::Text(text) if in_metadata => sink.push_str(text),
            _ => {}
        }
        Flow::Continue
    })?;
    Ok(order
        .iter()
        .filter_map(|id| items.get(id))
        .map(|href| {
            let path = href.split('#').next().unwrap_or(href);
            resolve(opf, &percent_decode(path))
        })
        .collect())
}

/// Decodes `%XX` escapes; manifest hrefs are URLs, member names are not.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        let escaped = (byte == b'%')
            .then(|| input.get(index + 1..index + 3))
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match escaped {
            Some(value) => {
                out.push(value);
                index += 3;
            }
            None => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("text/ch%201.xhtml"), "text/ch 1.xhtml");
        assert_eq!(percent_decode("a%C3%A5b"), "aåb");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
    }
}
