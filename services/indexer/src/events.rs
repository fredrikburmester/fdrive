//! Change event payloads, published on `NOTIFY idx_events` and stored in `idx.events`.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Created,
    Changed,
    Deleted,
    Moved,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Changed => "changed",
            Self::Deleted => "deleted",
            Self::Moved => "moved",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Event {
    pub kind: EventKind,
    pub root: String,
    pub path: String,
    pub target_path: Option<String>,
    pub at: String,
}

/// ISO 8601 with a `+00:00` offset, as Python's `datetime.isoformat` writes it.
pub fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::AutoSi, false)
}

pub fn iso_now() -> String {
    iso(Utc::now())
}

pub fn build(kind: EventKind, root: &str, path: &str, target_path: Option<&str>) -> Event {
    Event {
        kind,
        root: root.to_owned(),
        path: path.to_owned(),
        target_path: target_path.map(str::to_owned),
        at: iso_now(),
    }
}

pub fn to_json(event: &Event) -> String {
    serde_json::to_string(event).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[test]
    fn timestamps_use_an_offset() {
        let at = Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        assert_eq!(iso(at), "2026-01-02T03:04:05+00:00");
        assert!(iso_now().ends_with("+00:00"));
    }

    #[test]
    fn payload_shape() {
        let event = build(EventKind::Moved, "r", "a", Some("b"));
        let json: serde_json::Value = serde_json::from_str(&to_json(&event)).unwrap();
        assert_eq!(json["kind"], "moved");
        assert_eq!(json["target_path"], "b");
        let event = build(EventKind::Created, "r", "a", None);
        assert!(to_json(&event).starts_with(r#"{"kind":"created","root":"r","path":"a","target_path":null,"at":""#));
        assert_eq!(
            [
                EventKind::Created,
                EventKind::Changed,
                EventKind::Deleted,
                EventKind::Moved
            ]
            .map(EventKind::as_str),
            ["created", "changed", "deleted", "moved"]
        );
    }
}
