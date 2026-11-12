//! The pooled blocking HTTP client every call to `ml` shares.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::blocking::Client;

pub fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

#[cfg(test)]
pub mod fake {
    //! A tiny HTTP server for tests: each route answers with a fixed status and body and
    //! records the requests it saw.

    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use axum::body::Bytes;
    use axum::extract::{Request, State};
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    #[derive(Clone, Debug)]
    pub struct Seen {
        pub method: String,
        pub path: String,
        pub headers: HashMap<String, String>,
        pub body: Vec<u8>,
    }

    type Responder = Arc<dyn Fn(&Seen) -> (u16, String) + Send + Sync>;

    #[derive(Clone)]
    struct Shared {
        routes: Arc<Mutex<HashMap<String, Responder>>>,
        seen: Arc<Mutex<Vec<Seen>>>,
    }

    pub struct Server {
        pub url: String,
        shared: Shared,
        _runtime: tokio::runtime::Runtime,
    }

    impl Server {
        pub fn start() -> Self {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .unwrap();
            let shared = Shared {
                routes: Arc::default(),
                seen: Arc::default(),
            };
            let app = axum::Router::new().fallback(handle).with_state(shared.clone());
            let listener = runtime.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            runtime.spawn(async move { axum::serve(listener, app).await });
            Self {
                url,
                shared,
                _runtime: runtime,
            }
        }

        pub fn route(&self, path: &str, status: u16, body: &str) -> &Self {
            let body = body.to_owned();
            self.respond(path, move |_| (status, body.clone()))
        }

        pub fn respond(&self, path: &str, responder: impl Fn(&Seen) -> (u16, String) + Send + Sync + 'static) -> &Self {
            self.shared
                .routes
                .lock()
                .unwrap()
                .insert(path.to_owned(), Arc::new(responder));
            self
        }

        pub fn seen(&self) -> Vec<Seen> {
            self.shared.seen.lock().unwrap().clone()
        }
    }

    async fn handle(State(shared): State<Shared>, request: Request) -> impl IntoResponse {
        let (parts, body) = request.into_parts();
        let body: Bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap_or_default();
        let seen = Seen {
            method: parts.method.to_string(),
            path: parts.uri.path().to_owned(),
            headers: parts
                .headers
                .iter()
                .map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap_or_default().to_owned()))
                .collect(),
            body: body.to_vec(),
        };
        shared.seen.lock().unwrap().push(seen.clone());
        let responder = shared.routes.lock().unwrap().get(&seen.path).cloned();
        match responder {
            Some(responder) => {
                let (status, body) = responder(&seen);
                (StatusCode::from_u16(status).unwrap(), body)
            }
            None => (StatusCode::NOT_FOUND, String::new()),
        }
    }
}
