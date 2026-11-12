//! Environment-derived configuration. Parsing takes a lookup function so it
//! is tested without touching the process environment.

use std::path::PathBuf;
use std::time::Duration;

use crate::lifecycle::UnitKind;

pub const DEFAULT_FEATURES_URL: &str = "http://api:3001/api/v1/internal/features";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateConfig {
    /// Development only: these units are always on and no feature document
    /// is consulted.
    Static(Vec<UnitKind>),
    /// Follow the API's feature document, failing closed without it.
    Features {
        url: String,
        token: String,
        poll: Duration,
        stale: Duration,
        unreachable: Duration,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub port: u16,
    pub models_dir: PathBuf,
    pub hub_endpoint: String,
    /// CPU threads shared by every model, not per model.
    pub threads: usize,
    pub max_document_bytes: usize,
    pub gate: GateConfig,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        // Compose passes `${VAR:-}` through as an empty string, so blank means unset.
        let get = |key: &str| {
            lookup(key)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let number = |key: &str, default: u64| match get(key) {
            None => Ok(default),
            Some(raw) => raw.parse::<u64>().map_err(|_| format!("{key} must be a whole number")),
        };
        let positive = |key: &str, default: u64| match number(key, default)? {
            0 => Err(format!("{key} must be positive")),
            value => Ok(value),
        };

        let port = u16::try_from(positive("FDRIVE_ML_PORT", 8080)?).map_err(|_| "FDRIVE_ML_PORT is not a port")?;
        let megabytes = usize::try_from(positive("FDRIVE_ML_MAX_DOCUMENT_MB", 64)?).unwrap_or(usize::MAX);

        let gate = match get("FDRIVE_ML_STATIC_UNITS") {
            Some(raw) => {
                let mut units = Vec::new();
                for name in raw.split(',').map(str::trim).filter(|name| !name.is_empty()) {
                    let kind = UnitKind::parse(name)
                        .ok_or_else(|| format!("FDRIVE_ML_STATIC_UNITS has an unknown unit: {name}"))?;
                    if !units.contains(&kind) {
                        units.push(kind);
                    }
                }
                GateConfig::Static(units)
            }
            None => {
                let poll = positive("FDRIVE_RUNTIME_POLL_SECONDS", 3)?;
                let stale = number("FDRIVE_RUNTIME_STALE_SECONDS", 9)?;
                let unreachable = number("FDRIVE_RUNTIME_UNREACHABLE_SECONDS", 60)?;
                if stale < poll {
                    return Err("FDRIVE_RUNTIME_STALE_SECONDS must be at least the poll interval".into());
                }
                if unreachable < stale {
                    return Err("FDRIVE_RUNTIME_UNREACHABLE_SECONDS must be at least the stale window".into());
                }
                GateConfig::Features {
                    url: get("FDRIVE_FEATURES_URL").unwrap_or_else(|| DEFAULT_FEATURES_URL.into()),
                    // An empty token is kept: the gate then fails closed with a
                    // reason instead of the server refusing to start.
                    token: get("FDRIVE_WORKER_TOKEN").unwrap_or_default(),
                    poll: Duration::from_secs(poll),
                    stale: Duration::from_secs(stale),
                    unreachable: Duration::from_secs(unreachable),
                }
            }
        };

        Ok(Self {
            port,
            models_dir: get("FDRIVE_ML_MODELS_DIR").unwrap_or_else(|| "/models".into()).into(),
            hub_endpoint: get("HF_ENDPOINT")
                .unwrap_or_else(|| "https://huggingface.co".into())
                .trim_end_matches('/')
                .to_owned(),
            threads: usize::try_from(positive("FDRIVE_ML_THREADS", 4)?).unwrap_or(usize::MAX),
            max_document_bytes: megabytes.saturating_mul(1024 * 1024),
            gate,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config(env: &[(&str, &str)]) -> Result<Config, String> {
        let env: HashMap<String, String> = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        Config::from_lookup(|key| env.get(key).cloned())
    }

    #[test]
    fn defaults_follow_the_feature_document() {
        let parsed = config(&[]).unwrap();
        assert_eq!(parsed.port, 8080);
        assert_eq!(parsed.models_dir, PathBuf::from("/models"));
        assert_eq!(parsed.hub_endpoint, "https://huggingface.co");
        assert_eq!(parsed.threads, 4);
        assert_eq!(parsed.max_document_bytes, 64 * 1024 * 1024);
        assert_eq!(
            parsed.gate,
            GateConfig::Features {
                url: DEFAULT_FEATURES_URL.into(),
                token: String::new(),
                poll: Duration::from_secs(3),
                stale: Duration::from_secs(9),
                unreachable: Duration::from_secs(60),
            }
        );
    }

    #[test]
    fn reads_overrides_and_treats_blank_as_unset() {
        let parsed = config(&[
            ("FDRIVE_ML_PORT", "9000"),
            ("FDRIVE_ML_MODELS_DIR", "/data/models"),
            ("HF_ENDPOINT", "https://mirror.example/"),
            ("FDRIVE_ML_THREADS", " 8 "),
            ("FDRIVE_ML_MAX_DOCUMENT_MB", ""),
            ("FDRIVE_WORKER_TOKEN", "secret"),
            ("FDRIVE_FEATURES_URL", "http://localhost:3001/features"),
            ("FDRIVE_RUNTIME_POLL_SECONDS", "1"),
            ("FDRIVE_RUNTIME_STALE_SECONDS", "2"),
            ("FDRIVE_RUNTIME_UNREACHABLE_SECONDS", "5"),
        ])
        .unwrap();
        assert_eq!(parsed.port, 9000);
        assert_eq!(parsed.models_dir, PathBuf::from("/data/models"));
        assert_eq!(parsed.hub_endpoint, "https://mirror.example");
        assert_eq!(parsed.threads, 8);
        assert_eq!(parsed.max_document_bytes, 64 * 1024 * 1024);
        assert_eq!(
            parsed.gate,
            GateConfig::Features {
                url: "http://localhost:3001/features".into(),
                token: "secret".into(),
                poll: Duration::from_secs(1),
                stale: Duration::from_secs(2),
                unreachable: Duration::from_secs(5),
            }
        );
    }

    #[test]
    fn static_units_turn_the_gate_off() {
        let parsed = config(&[("FDRIVE_ML_STATIC_UNITS", "text, extract,text")]).unwrap();
        assert_eq!(parsed.gate, GateConfig::Static(vec![UnitKind::Text, UnitKind::Extract]));
    }

    #[test]
    fn rejects_values_that_cannot_work() {
        let cases: [&[(&str, &str)]; 8] = [
            &[("FDRIVE_ML_PORT", "0")],
            &[("FDRIVE_ML_PORT", "70000")],
            &[("FDRIVE_ML_PORT", "http")],
            &[("FDRIVE_ML_THREADS", "0")],
            &[("FDRIVE_ML_STATIC_UNITS", "text,ocr")],
            &[("FDRIVE_RUNTIME_POLL_SECONDS", "0")],
            &[("FDRIVE_RUNTIME_POLL_SECONDS", "10")],
            &[("FDRIVE_RUNTIME_UNREACHABLE_SECONDS", "5")],
        ];
        for env in cases {
            assert!(config(env).is_err(), "{env:?} should be rejected");
        }
    }
}
