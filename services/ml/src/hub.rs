//! Fetches model files from the Hugging Face hub into a local directory.
//!
//! Every file is pinned to a repository revision and a SHA-256, so a changed
//! or tampered upstream file is refused instead of loaded. A file is only
//! given its final name after its checksum matched, which is why a file that
//! exists is trusted without hashing gigabytes on every start.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct ModelFile {
    pub path: &'static str,
    pub sha256: &'static str,
}

pub struct ModelSpec {
    /// The id this server reports. The indexer stores it next to each image
    /// vector, so it names the model, not the repository the files came from.
    pub id: &'static str,
    pub repo: &'static str,
    pub revision: &'static str,
    pub files: &'static [ModelFile],
}

pub const TEXT_MODEL: ModelSpec = ModelSpec {
    id: "intfloat/multilingual-e5-small",
    repo: "intfloat/multilingual-e5-small",
    revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
    files: &[
        ModelFile {
            path: "tokenizer.json",
            sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
        },
        ModelFile {
            path: "onnx/model.onnx",
            sha256: "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665",
        },
    ],
};

/// The ONNX export of `google/siglip2-large-patch16-256`, split into its two
/// towers.
///
/// The vision tower is the 8-bit quantized file: it embeds an image about
/// 2.8 times faster than the full-precision one for about one point of
/// first-hit rate, and its vectors rank correctly in an index that also holds
/// full-precision vectors, so the model id stays the same and no library is
/// re-embedded. The text tower stays full precision because its quantized
/// file loses most non-English queries. `docs/plans/ML-SERVER.md` has the
/// measurements.
pub const IMAGE_MODEL: ModelSpec = ModelSpec {
    id: "google/siglip2-large-patch16-256",
    repo: "onnx-community/siglip2-large-patch16-256-ONNX",
    revision: "c03fb63ddd5fe363212cbd08110f92a35250db6a",
    files: &[
        ModelFile {
            path: "tokenizer.json",
            sha256: "cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322",
        },
        ModelFile {
            path: "onnx/vision_model_quantized.onnx",
            sha256: "eac0705a7810a6518359899788c54e5be911be5b06591b47c1a9bfff9996c932",
        },
        ModelFile {
            path: "onnx/text_model.onnx",
            sha256: "49caa52593fd81dadbcf235db6df97e15ea0b2c481ab3f45574ebd2f94b0a81b",
        },
        ModelFile {
            path: "onnx/text_model.onnx_data",
            sha256: "e96fc7fc9137be54768ec23ae0c3e9576f7cee4da7d0616b4c30bd0a4cc62477",
        },
    ],
};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum HubError {
    #[error("download of {path} failed: {detail}")]
    Http { path: String, detail: String },
    #[error("download of {path} returned status {status}")]
    Status { path: String, status: u16 },
    #[error("{path} does not match its pinned checksum")]
    Checksum { path: String },
    #[error("{path}: {detail}")]
    Io { path: String, detail: String },
}

pub struct Hub {
    client: reqwest::Client,
    endpoint: String,
    models_dir: PathBuf,
}

impl Hub {
    pub fn new(endpoint: &str, models_dir: &Path) -> Result<Self, reqwest::Error> {
        // No total timeout: a multi-gigabyte file takes as long as it takes.
        // A stalled connection is still cut by the read timeout.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(60))
            .build()?;
        Ok(Self {
            client,
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            models_dir: models_dir.to_owned(),
        })
    }

    /// Where a model's files live: one directory per repository revision.
    pub fn model_dir(&self, spec: &ModelSpec) -> PathBuf {
        self.models_dir.join(spec.repo.replace('/', "--")).join(spec.revision)
    }

    /// Makes every file of `spec` present and verified, downloading what is
    /// missing, and returns the model's directory.
    pub async fn ensure(&self, spec: &ModelSpec) -> Result<PathBuf, HubError> {
        let dir = self.model_dir(spec);
        for file in spec.files {
            let target = dir.join(file.path);
            if fs::try_exists(&target).await.unwrap_or(false) {
                continue;
            }
            let url = format!(
                "{}/{}/resolve/{}/{}",
                self.endpoint, spec.repo, spec.revision, file.path
            );
            tracing::info!(model = spec.id, file = file.path, "downloading");
            let bytes = self.download(&url, &target, file).await?;
            tracing::info!(model = spec.id, file = file.path, bytes, "downloaded");
        }
        Ok(dir)
    }

    /// Streams `url` to `<target>.part`, resuming a partial file when the
    /// server allows it, then renames it into place once the checksum matches.
    async fn download(&self, url: &str, target: &Path, file: &ModelFile) -> Result<u64, HubError> {
        let io = |error: std::io::Error| HubError::Io {
            path: file.path.to_owned(),
            detail: error.to_string(),
        };
        let http = |error: reqwest::Error| HubError::Http {
            path: file.path.to_owned(),
            detail: error.without_url().to_string(),
        };

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).await.map_err(io)?;
        }
        let mut part = target.as_os_str().to_owned();
        part.push(".part");
        let part = PathBuf::from(part);
        let existing = fs::metadata(&part).await.map(|meta| meta.len()).unwrap_or(0);

        let mut request = self.client.get(url);
        if existing > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
        }
        let mut response = request.send().await.map_err(http)?;

        let mut hasher = Sha256::new();
        let mut written = 0u64;
        let mut output = match response.status().as_u16() {
            206 if existing > 0 => {
                // The bytes already on disk are part of the checksum.
                let mut partial = File::open(&part).await.map_err(io)?;
                let mut buffer = vec![0u8; 1024 * 1024];
                loop {
                    let read = partial.read(&mut buffer).await.map_err(io)?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&buffer[..read]);
                    written += read as u64;
                }
                OpenOptions::new().append(true).open(&part).await.map_err(io)?
            }
            200 => File::create(&part).await.map_err(io)?,
            status => {
                // 416 means the partial file is not a prefix the server can
                // continue; starting over next time is the only safe answer.
                let _ = fs::remove_file(&part).await;
                return Err(HubError::Status {
                    path: file.path.to_owned(),
                    status,
                });
            }
        };

        while let Some(chunk) = response.chunk().await.map_err(http)? {
            hasher.update(&chunk);
            output.write_all(&chunk).await.map_err(io)?;
            written += chunk.len() as u64;
        }
        output.flush().await.map_err(io)?;
        output.sync_all().await.map_err(io)?;
        drop(output);

        if hex(&hasher.finalize()) != file.sha256 {
            let _ = fs::remove_file(&part).await;
            return Err(HubError::Checksum {
                path: file.path.to_owned(),
            });
        }
        fs::rename(&part, target).await.map_err(io)?;
        Ok(written)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::response::IntoResponse;
    use axum::routing::get;

    use super::*;

    const CONTENT: &[u8] = b"model bytes, long enough to be split in two";

    #[derive(Clone)]
    struct Upstream {
        requests: Arc<AtomicUsize>,
        honor_range: bool,
    }

    async fn serve_file(State(upstream): State<Upstream>, headers: HeaderMap) -> impl IntoResponse {
        upstream.requests.fetch_add(1, Ordering::SeqCst);
        let range = headers
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("bytes="))
            .and_then(|value| value.strip_suffix('-'))
            .and_then(|value| value.parse::<usize>().ok());
        match range {
            Some(start) if upstream.honor_range && start < CONTENT.len() => {
                (StatusCode::PARTIAL_CONTENT, CONTENT[start..].to_vec())
            }
            Some(_) if upstream.honor_range => (StatusCode::RANGE_NOT_SATISFIABLE, Vec::new()),
            _ => (StatusCode::OK, CONTENT.to_vec()),
        }
    }

    async fn upstream(honor_range: bool) -> (String, Arc<AtomicUsize>) {
        let requests = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/acme/model/resolve/rev1/onnx/model.onnx", get(serve_file))
            .with_state(Upstream {
                requests: Arc::clone(&requests),
                honor_range,
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (endpoint, requests)
    }

    fn spec(sha256: &'static str) -> ModelSpec {
        let files: &'static [ModelFile] = Box::leak(Box::new([ModelFile {
            path: "onnx/model.onnx",
            sha256,
        }]));
        ModelSpec {
            id: "acme/model",
            repo: "acme/model",
            revision: "rev1",
            files,
        }
    }

    fn content_sha() -> &'static str {
        Box::leak(hex(&Sha256::digest(CONTENT)).into_boxed_str())
    }

    #[tokio::test]
    async fn downloads_verifies_and_then_reuses_the_file() {
        let (endpoint, requests) = upstream(true).await;
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(&endpoint, dir.path()).unwrap();
        let spec = spec(content_sha());

        let model_dir = hub.ensure(&spec).await.unwrap();
        assert_eq!(model_dir, dir.path().join("acme--model").join("rev1"));
        assert_eq!(std::fs::read(model_dir.join("onnx/model.onnx")).unwrap(), CONTENT);
        assert!(!model_dir.join("onnx/model.onnx.part").exists());

        hub.ensure(&spec).await.unwrap();
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn refuses_a_file_that_does_not_match_its_checksum() {
        let (endpoint, _) = upstream(true).await;
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(&endpoint, dir.path()).unwrap();
        let spec = spec("0000000000000000000000000000000000000000000000000000000000000000");

        let error = hub.ensure(&spec).await.unwrap_err();
        assert_eq!(
            error,
            HubError::Checksum {
                path: "onnx/model.onnx".into()
            }
        );
        let onnx = hub.model_dir(&spec).join("onnx");
        assert!(!onnx.join("model.onnx").exists());
        assert!(!onnx.join("model.onnx.part").exists());
    }

    #[tokio::test]
    async fn resumes_a_partial_download() {
        let (endpoint, requests) = upstream(true).await;
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(&endpoint, dir.path()).unwrap();
        let spec = spec(content_sha());
        let onnx = hub.model_dir(&spec).join("onnx");
        std::fs::create_dir_all(&onnx).unwrap();
        std::fs::write(onnx.join("model.onnx.part"), &CONTENT[..10]).unwrap();

        hub.ensure(&spec).await.unwrap();
        assert_eq!(std::fs::read(onnx.join("model.onnx")).unwrap(), CONTENT);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn starts_over_when_the_server_ignores_the_range() {
        let (endpoint, _) = upstream(false).await;
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(&endpoint, dir.path()).unwrap();
        let spec = spec(content_sha());
        let onnx = hub.model_dir(&spec).join("onnx");
        std::fs::create_dir_all(&onnx).unwrap();
        std::fs::write(onnx.join("model.onnx.part"), b"stale bytes from another file").unwrap();

        hub.ensure(&spec).await.unwrap();
        assert_eq!(std::fs::read(onnx.join("model.onnx")).unwrap(), CONTENT);
    }

    #[tokio::test]
    async fn drops_a_partial_file_the_server_cannot_continue() {
        let (endpoint, _) = upstream(true).await;
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(&endpoint, dir.path()).unwrap();
        let spec = spec(content_sha());
        let onnx = hub.model_dir(&spec).join("onnx");
        std::fs::create_dir_all(&onnx).unwrap();
        std::fs::write(onnx.join("model.onnx.part"), vec![0u8; CONTENT.len() + 5]).unwrap();

        let error = hub.ensure(&spec).await.unwrap_err();
        assert_eq!(
            error,
            HubError::Status {
                path: "onnx/model.onnx".into(),
                status: 416
            }
        );
        assert!(!onnx.join("model.onnx.part").exists());
        // The next attempt starts clean and succeeds.
        hub.ensure(&spec).await.unwrap();
    }

    #[tokio::test]
    async fn reports_a_missing_file_and_an_unreachable_hub() {
        let (endpoint, _) = upstream(true).await;
        let dir = tempfile::tempdir().unwrap();
        let files: &'static [ModelFile] = Box::leak(Box::new([ModelFile {
            path: "missing.bin",
            sha256: "",
        }]));
        let missing = ModelSpec {
            id: "acme/model",
            repo: "acme/model",
            revision: "rev1",
            files,
        };
        let error = Hub::new(&endpoint, dir.path())
            .unwrap()
            .ensure(&missing)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            HubError::Status {
                path: "missing.bin".into(),
                status: 404
            }
        );

        let closed = Hub::new("http://127.0.0.1:1", dir.path()).unwrap();
        assert!(matches!(
            closed.ensure(&spec(content_sha())).await,
            Err(HubError::Http { .. })
        ));
    }

    #[test]
    fn pinned_models_name_complete_checksums() {
        for spec in [&TEXT_MODEL, &IMAGE_MODEL] {
            assert_eq!(spec.revision.len(), 40);
            for file in spec.files {
                assert_eq!(file.sha256.len(), 64, "{}", file.path);
            }
        }
    }
}
