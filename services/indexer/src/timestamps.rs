//! Timestamps the indexer reports over HTTP and in the database, in the shape the API reads.

use chrono::{DateTime, SecondsFormat, Utc};

/// ISO 8601 with a `+00:00` offset, as Python's `datetime.isoformat` writes it.
pub fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::AutoSi, false)
}

pub fn iso_now() -> String {
    iso(Utc::now())
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
}
