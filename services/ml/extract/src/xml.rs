//! A small event walk over XML, shared by every XML-based format.

use std::io::BufRead;

use quick_xml::escape::resolve_html5_entity;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};

/// One step of a document walk. An empty element yields `Open` then `Close`.
pub(crate) enum Node<'a> {
    Open(&'a BytesStart<'a>),
    /// The local name of the element that ended.
    Close(&'a str),
    /// Character data with entity references already resolved.
    Text(&'a str),
}

/// Whether the walk goes on after a node.
pub(crate) enum Flow {
    Continue,
    Stop,
}

/// Walks `input`, calling `visit` for each node until the end or `Flow::Stop`.
/// Element nesting is not tracked on the stack, so depth costs nothing.
pub(crate) fn walk<R: BufRead>(input: R, mut visit: impl FnMut(Node<'_>) -> Flow) -> Result<(), quick_xml::Error> {
    let mut reader = Reader::from_reader(input);
    let config = reader.config_mut();
    config.check_end_names = false;
    config.allow_unmatched_ends = true;
    config.allow_dangling_amp = true;
    let mut buf = Vec::new();
    loop {
        let flow = match reader.read_event_into(&mut buf)? {
            Event::Start(element) => visit(Node::Open(&element)),
            Event::Empty(element) => match visit(Node::Open(&element)) {
                Flow::Continue => visit(Node::Close(element.local_name().into_inner())),
                Flow::Stop => Flow::Stop,
            },
            Event::End(element) => visit(Node::Close(element.local_name().into_inner())),
            Event::Text(text) => visit(Node::Text(&text)),
            Event::CData(text) => visit(Node::Text(&text)),
            Event::GeneralRef(reference) => {
                let mut utf8 = [0u8; 4];
                match reference.resolve_char_ref() {
                    Ok(Some(c)) => visit(Node::Text(c.encode_utf8(&mut utf8))),
                    // XHTML in the wild uses HTML names such as `&nbsp;`.
                    _ => match resolve_html5_entity(&reference) {
                        Some(text) => visit(Node::Text(text)),
                        None => Flow::Continue,
                    },
                }
            }
            Event::Eof => return Ok(()),
            _ => Flow::Continue,
        };
        if matches!(flow, Flow::Stop) {
            return Ok(());
        }
        buf.clear();
    }
}

/// The element's name without its namespace prefix.
pub(crate) fn local<'a>(element: &'a BytesStart<'_>) -> &'a str {
    element.local_name().into_inner()
}

/// The value of the attribute whose qualified name is `name`, e.g. `r:id`.
pub(crate) fn attr(element: &BytesStart<'_>, name: &str) -> Option<String> {
    element
        .attributes()
        .with_checks(false)
        .flatten()
        .find(|attribute| attribute.key.0 == name)
        .map(|attribute| match attribute.normalized_value(XmlVersion::Implicit1_0) {
            Ok(value) => value.into_owned(),
            Err(_) => attribute.value.into_owned(),
        })
}

/// The value of the first attribute whose local name is `name`, whatever its prefix.
pub(crate) fn attr_local(element: &BytesStart<'_>, name: &str) -> Option<String> {
    element
        .attributes()
        .with_checks(false)
        .flatten()
        .find(|attribute| attribute.key.local_name().into_inner() == name)
        .map(|attribute| match attribute.normalized_value(XmlVersion::Implicit1_0) {
            Ok(value) => value.into_owned(),
            Err(_) => attribute.value.into_owned(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace(xml: &str) -> Vec<String> {
        let mut out = Vec::new();
        walk(xml.as_bytes(), |node| {
            out.push(match node {
                Node::Open(element) => format!("<{}", local(element)),
                Node::Close(name) => format!(">{name}"),
                Node::Text(text) => format!("'{text}"),
            });
            Flow::Continue
        })
        .unwrap();
        out
    }

    #[test]
    fn yields_elements_text_and_resolved_references() {
        assert_eq!(
            trace("<w:p><w:t>a &amp; b&#229;&nbsp;</w:t><w:br/><![CDATA[x<y]]></w:p>"),
            [
                "<p", "<t", "'a ", "'&", "' b", "'å", "'\u{a0}", ">t", "<br", ">br", "'x<y", ">p"
            ]
        );
    }

    #[test]
    fn skips_unknown_references_and_declarations() {
        assert_eq!(
            trace("<?xml version=\"1.0\"?><!-- c --><a>&bogus;x</a>"),
            ["<a", "'x", ">a"]
        );
    }

    #[test]
    fn stops_when_asked() {
        let mut seen = 0;
        walk("<a><b/><c/></a>".as_bytes(), |node| {
            seen += 1;
            match node {
                Node::Open(element) if local(element) == "b" => Flow::Stop,
                _ => Flow::Continue,
            }
        })
        .unwrap();
        assert_eq!(seen, 2);
    }

    #[test]
    fn reports_broken_markup() {
        assert!(walk("<a><b attr=></a".as_bytes(), |_| Flow::Continue).is_err());
    }

    #[test]
    fn reads_attributes_by_qualified_and_local_name() {
        walk(r#"<sldId id="256" r:id="rId2" name="A &amp; B"/>"#.as_bytes(), |node| {
            if let Node::Open(element) = node {
                assert_eq!(attr(element, "r:id").as_deref(), Some("rId2"));
                assert_eq!(attr(element, "id").as_deref(), Some("256"));
                assert_eq!(attr_local(element, "id").as_deref(), Some("256"));
                assert_eq!(attr(element, "name").as_deref(), Some("A & B"));
                assert_eq!(attr(element, "missing"), None);
                assert_eq!(attr_local(element, "missing"), None);
            }
            Flow::Continue
        })
        .unwrap();
    }
}
