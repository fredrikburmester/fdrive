//! Mail messages (`.eml`).

use mail_parser::{AddressList, MessageParser};

use crate::ExtractError;
use crate::sink::Sink;

/// Header names that mark a text file as a mail message.
const KNOWN_HEADERS: &[&str] = &[
    "from",
    "to",
    "cc",
    "subject",
    "date",
    "received",
    "message-id",
    "mime-version",
    "return-path",
    "delivered-to",
    "content-type",
    "reply-to",
    "x-mailer",
    "sender",
];

/// How much of the input the header check reads.
const SNIFF_BYTES: usize = 64 * 1024;

/// Whether `bytes` open with a well-formed header block naming at least two
/// mail headers. There is no magic number, so this is deliberately strict.
pub(crate) fn looks_like_mail(bytes: &[u8]) -> bool {
    let window = bytes.get(..SNIFF_BYTES).unwrap_or(bytes);
    let complete = window.len() == bytes.len();
    let mut known = 0;
    let mut lines = window.split(|&byte| byte == b'\n').peekable();
    let mut first = true;
    while let Some(line) = lines.next() {
        // The last piece of a cut window is a partial line; do not judge it.
        if lines.peek().is_none() && !complete {
            break;
        }
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            break;
        }
        let mbox_separator = first && line.starts_with(b"From ");
        first = false;
        if mbox_separator || line.starts_with(b" ") || line.starts_with(b"\t") {
            continue;
        }
        let Some(colon) = line.iter().position(|&byte| byte == b':') else {
            return false;
        };
        let name = line.get(..colon).unwrap_or(line);
        if name.is_empty() || !name.iter().all(|byte| byte.is_ascii_graphic()) {
            return false;
        }
        if KNOWN_HEADERS
            .iter()
            .any(|known| name.eq_ignore_ascii_case(known.as_bytes()))
        {
            known += 1;
        }
    }
    known >= 2
}

pub(crate) fn eml(bytes: &[u8], sink: &mut Sink) -> Result<(), ExtractError> {
    let message = MessageParser::new()
        .parse(bytes)
        .ok_or_else(|| ExtractError::Malformed("not a mail message".into()))?;
    header(sink, "Subject", message.subject().map(str::to_owned));
    header(sink, "From", message.from().map(|list| addresses(&list)));
    header(sink, "To", message.to().map(|list| addresses(&list)));
    header(sink, "Cc", message.cc().map(|list| addresses(&list)));
    for body in message.text_bodies() {
        sink.newline();
        sink.push_str(&body);
    }
    sink.newline();
    for attachment in message.attachments() {
        header(sink, "Attachment", attachment.attachment_name().map(str::to_owned));
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

fn addresses(list: &AddressList<'_>) -> String {
    list.mailboxes()
        .map(|mailbox| match (mailbox.name(), mailbox.address()) {
            (Some(name), Some(address)) => format!("{name} <{address}>"),
            (Some(only), None) | (None, Some(only)) => only.to_owned(),
            (None, None) => String::new(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(source: &str) -> String {
        let mut sink = Sink::new(10_000);
        eml(source.as_bytes(), &mut sink).unwrap();
        sink.finish()
    }

    #[test]
    fn recognizes_header_blocks_only() {
        assert!(looks_like_mail(b"From: a@example.com\r\nTo: b@example.com\r\n\r\nhi"));
        assert!(looks_like_mail(
            b"From sender Mon Jan 1 00:00:00 2024\nReceived: by x\n\twith y\nSubject: s\n\nbody"
        ));
        assert!(looks_like_mail(b"Subject: s\nDate: now"));
        assert!(!looks_like_mail(b"Subject: only one known header\n\nbody"));
        assert!(!looks_like_mail(b"Just some prose.\nFrom: a\nTo: b\n"));
        assert!(!looks_like_mail(b"Bad Name: x\nFrom: a\nTo: b\n\n"));
        assert!(!looks_like_mail(b": empty\nFrom: a\nTo: b\n\n"));
        assert!(!looks_like_mail(b""));
    }

    #[test]
    fn judges_only_whole_lines_of_a_long_header_block() {
        let mut long = b"From: a@example.com\nTo: b@example.com\n".to_vec();
        while long.len() < SNIFF_BYTES + 10 {
            long.extend_from_slice(
                b"X-Filler: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
            );
        }
        assert!(looks_like_mail(&long));
    }

    #[test]
    fn writes_headers_then_the_text_body() {
        assert_eq!(
            text(
                "From: Art Vandelay <art@vandelay.com>\r\nTo: jane@example.com, Bob <bob@example.com>\r\nCc: \r\nSubject: =?utf-8?B?UsOka3Ntw7ZyZ8Olcw==?=\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHej p=E5 dig.\r\n"
            ),
            "Subject: Räksmörgås\nFrom: Art Vandelay <art@vandelay.com>\nTo: jane@example.com, Bob <bob@example.com>\nHej på dig."
        );
    }

    #[test]
    fn converts_an_html_only_body_and_names_attachments() {
        let source = "From: a@example.com\r\nTo: b@example.com\r\nSubject: Report\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>Quarterly <b>numbers</b></p></body></html>\r\n--b\r\nContent-Type: application/pdf; name=\"q3.pdf\"\r\nContent-Disposition: attachment; filename=\"q3.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b--\r\n";
        let out = text(source);
        assert!(
            out.starts_with("Subject: Report\nFrom: a@example.com\nTo: b@example.com\n"),
            "{out}"
        );
        assert!(out.contains("Quarterly numbers"), "{out}");
        assert!(out.ends_with("Attachment: q3.pdf"), "{out}");
    }
}
