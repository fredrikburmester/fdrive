//! Outlook messages (`.msg`): MAPI properties stored one stream each.

use crate::ExtractError;
use encoding_rs::Encoding;

use crate::bytes::{codepage, decode, u32le, utf16le};
use crate::html::html_to_text;
use crate::limits::Budget;
use crate::ole::Ole;
use crate::sink::Sink;

const SUBJECT: &str = "0037";
const SENDER_NAME: &str = "0C1A";
const SENDER_ADDRESS: &str = "0C1F";
const SENDER_SMTP: &str = "5D01";
const DISPLAY_TO: &str = "0E04";
const DISPLAY_CC: &str = "0E03";
const DISPLAY_BCC: &str = "0E02";
const RECIPIENT_NAME: &str = "3001";
const RECIPIENT_SMTP: &str = "39FE";
const RECIPIENT_ADDRESS: &str = "3003";
const BODY: &str = "1000";
const HTML_BODY: &str = "1013";
const ATTACHMENT_NAME: &str = "3707";
const ATTACHMENT_SHORT_NAME: &str = "3704";

/// Recipients and attachments listed at most; each costs a walk of the directory.
const MAX_LISTED: usize = 256;

/// Whether the entries of a root storage are those of a message.
pub(crate) fn is_message(root: &[String]) -> bool {
    root.iter()
        .any(|name| name == "__properties_version1.0" || name.starts_with("__substg1.0_"))
}

pub(crate) fn msg(ole: &mut Ole<'_>, budget: &mut Budget, sink: &mut Sink) -> Result<(), ExtractError> {
    let encoding = message_encoding(ole, budget);
    let mut reader = Reader { ole, budget, encoding };
    header(sink, "Subject", reader.string("/", SUBJECT));
    let sender = match (reader.string("/", SENDER_NAME), reader.address()) {
        (Some(name), Some(address)) if name != address => Some(format!("{name} <{address}>")),
        (name, address) => name.or(address),
    };
    header(sink, "From", sender);
    header(sink, "To", reader.string("/", DISPLAY_TO));
    header(sink, "Cc", reader.string("/", DISPLAY_CC));
    header(sink, "Bcc", reader.string("/", DISPLAY_BCC));
    // The display lists above hold names only; the addresses are per recipient.
    for storage in reader.storages("__recip_version1.0_") {
        let folder = format!("/{storage}/");
        let address = reader
            .string(&folder, RECIPIENT_SMTP)
            .or_else(|| reader.string(&folder, RECIPIENT_ADDRESS));
        let recipient = match (reader.string(&folder, RECIPIENT_NAME), address) {
            (Some(name), Some(address)) if name != address => Some(format!("{name} <{address}>")),
            (name, address) => name.or(address),
        };
        header(sink, "Recipient", recipient);
    }
    sink.newline();
    match reader.string("/", BODY).filter(|body| !body.trim().is_empty()) {
        Some(body) => sink.push_str(&body),
        None => {
            if let Some(html) = reader.html() {
                html_to_text(&html, sink);
            }
        }
    }
    sink.newline();
    for storage in reader.storages("__attach_version1.0_") {
        let folder = format!("/{storage}/");
        let name = reader
            .string(&folder, ATTACHMENT_NAME)
            .or_else(|| reader.string(&folder, ATTACHMENT_SHORT_NAME));
        header(sink, "Attachment", name);
    }
    Ok(())
}

fn header(sink: &mut Sink, name: &str, value: Option<String>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        sink.push_str(name);
        sink.push_str(": ");
        sink.push_str(value.trim());
        sink.newline();
    }
}

/// `PR_MESSAGE_CODEPAGE` and `PR_INTERNET_CPID`, as tags in the property stream.
const MESSAGE_CODEPAGE: u32 = 0x3FFD_0003;
const INTERNET_CODEPAGE: u32 = 0x3FDE_0003;

/// The code page of the message's 8-bit strings, Windows-1252 when it names none.
fn message_encoding(ole: &Ole<'_>, budget: &mut Budget) -> &'static Encoding {
    let properties = ole.stream("/__properties_version1.0", budget).unwrap_or_default();
    // A 32-byte header, then 16-byte entries: tag, flags, value.
    let entries = properties.get(32..).unwrap_or(&[]);
    let find = |tag: u32| {
        entries
            .chunks(16)
            .find(|entry| u32le(entry, 0) == Some(tag))
            .and_then(|entry| u32le(entry, 8))
    };
    codepage(
        find(MESSAGE_CODEPAGE)
            .or_else(|| find(INTERNET_CODEPAGE))
            .unwrap_or(1252),
    )
}

struct Reader<'o, 'a, 'b> {
    ole: &'o mut Ole<'a>,
    budget: &'b mut Budget,
    encoding: &'static Encoding,
}

impl Reader<'_, '_, '_> {
    /// The root storages whose names start with `prefix`, up to the listing cap.
    fn storages(&self, prefix: &str) -> Vec<String> {
        let mut names: Vec<String> = self
            .ole
            .children("/")
            .into_iter()
            .filter(|name| name.starts_with(prefix))
            .collect();
        names.sort();
        names.truncate(MAX_LISTED);
        names
    }

    /// A string property: the Unicode stream if present, else the 8-bit one.
    fn string(&mut self, folder: &str, property: &str) -> Option<String> {
        let unicode = format!("{folder}__substg1.0_{property}001F");
        if let Some(bytes) = self.ole.stream(&unicode, self.budget) {
            return Some(clean(&utf16le(&bytes)));
        }
        let narrow = format!("{folder}__substg1.0_{property}001E");
        let bytes = self.ole.stream(&narrow, self.budget)?;
        Some(clean(&decode(&bytes, self.encoding)))
    }

    /// The sender's SMTP address, falling back to the transport address.
    fn address(&mut self) -> Option<String> {
        self.string("/", SENDER_SMTP)
            .or_else(|| self.string("/", SENDER_ADDRESS))
    }

    /// The HTML body, stored as bytes or occasionally as a string.
    fn html(&mut self) -> Option<String> {
        let binary = format!("/__substg1.0_{HTML_BODY}0102");
        match self.ole.stream(&binary, self.budget) {
            // The bytes are in the declared code page unless they are plainly UTF-8.
            Some(bytes) => Some(match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(error) => decode(error.as_bytes(), self.encoding),
            }),
            None => self.string("/", HTML_BODY),
        }
    }
}

/// Property strings are NUL-terminated and use CRLF.
fn clean(text: &str) -> String {
    text.trim_end_matches('\0').replace("\r\n", "\n").replace('\r', "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_message_storages() {
        assert!(is_message(&["__properties_version1.0".into()]));
        assert!(is_message(&["other".into(), "__substg1.0_0037001F".into()]));
        assert!(!is_message(&["WordDocument".into()]));
    }

    #[test]
    fn cleans_property_strings() {
        assert_eq!(clean("line one\r\nline two\rthree\0\0"), "line one\nline two\nthree");
    }
}
