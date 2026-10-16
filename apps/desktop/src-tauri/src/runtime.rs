use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub base_url: String,
    pub token: String,
    pub pid: u32,
    pub started_at: String,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub online: bool,
    pub message: Option<String>,
    pub generation: Option<String>,
}

pub struct Runtime {
    pub home: PathBuf,
    client: reqwest::Client,
    status: Arc<RwLock<Status>>,
    started: AtomicBool,
    bootstrap_error: RwLock<Option<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub method: String,
    pub path: String,
    pub body: Option<Value>,
    pub idempotency_key: Option<String>,
}

pub fn validate_connection(value: &Connection) -> Result<(), String> {
    let url = url::Url::parse(&value.base_url).map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || value.token.len() < 20
    {
        return Err("Invalid local runtime connection".into());
    }
    Ok(())
}

pub fn validate_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['\\', '#'])
        || path
            .split('?')
            .next()
            .unwrap_or("")
            .split('/')
            .any(|segment| segment == "." || segment == ".." || segment.contains('%'))
    {
        return Err("Invalid API path".into());
    }
    let allowed = [
        "health",
        "board",
        "context",
        "today",
        "next",
        "tasks",
        "projects",
        "series",
        "reminders",
        "periodic-reminders",
        "ordering",
        "doctor",
        "notifications",
        "export",
    ];
    if !allowed.contains(
        &path
            .trim_start_matches('/')
            .split(['/', '?'])
            .next()
            .unwrap_or(""),
    ) {
        return Err("Unknown API resource".into());
    }
    Ok(())
}

impl Runtime {
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client"),
            status: Arc::default(),
            started: AtomicBool::new(false),
            bootstrap_error: RwLock::new(None),
        }
    }
    pub async fn bootstrap_failed(&self, app: &AppHandle, message: String) {
        *self.bootstrap_error.write().await = Some(message.clone());
        self.publish(
            app,
            Status {
                message: Some(message),
                ..Status::default()
            },
        )
        .await;
    }
    async fn connection(&self) -> Result<Connection, String> {
        let bytes = tokio::fs::read(self.home.join("connection.json"))
            .await
            .map_err(|_| {
                "Runtime unavailable. Reopen TodoCue to start its background service.".to_string()
            })?;
        let connection: Connection = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        validate_connection(&connection)?;
        Ok(connection)
    }
    pub async fn request(&self, input: Request) -> Result<Value, String> {
        validate_path(&input.path)?;
        if !["GET", "POST", "PATCH", "DELETE"].contains(&input.method.as_str()) {
            return Err("Unsupported API method".into());
        }
        let connection = self.connection().await?;
        let method =
            reqwest::Method::from_bytes(input.method.as_bytes()).map_err(|e| e.to_string())?;
        let mut request = self
            .client
            .request(
                method,
                format!(
                    "{}/v1{}",
                    connection.base_url.trim_end_matches('/'),
                    input.path
                ),
            )
            .bearer_auth(connection.token)
            .timeout(Duration::from_secs(15));
        if let Some(body) = input.body {
            request = request.json(&body);
        }
        if let Some(key) = input.idempotency_key {
            request = request.header("Idempotency-Key", key);
        }
        let response = request.send().await.map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        Ok(json!({ "status": status, "body": body }))
    }
    pub async fn subscribe(self: &Arc<Self>, app: AppHandle) -> Status {
        if !self.started.swap(true, Ordering::SeqCst) {
            let runtime = Arc::clone(self);
            tauri::async_runtime::spawn(async move {
                runtime.stream(app).await;
            });
        }
        self.status.read().await.clone()
    }
    async fn publish(&self, app: &AppHandle, status: Status) {
        *self.status.write().await = status.clone();
        let _ = app.emit("runtime:state", &status);
    }
    async fn stream(&self, app: AppHandle) {
        let mut identity: Option<Connection> = None;
        let mut last_seq = 0_i64;
        loop {
            let connection = match self.connection().await {
                Ok(value) => value,
                Err(message) => {
                    self.publish(
                        &app,
                        Status {
                            message: Some(
                                self.bootstrap_error.read().await.clone().unwrap_or(message),
                            ),
                            ..Status::default()
                        },
                    )
                    .await;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };
            if identity.as_ref() != Some(&connection) {
                last_seq = 0;
                identity = Some(connection.clone());
            }
            let generation = format!("{}:{}", connection.pid, connection.started_at);
            let response = self
                .client
                .get(format!(
                    "{}/v1/events",
                    connection.base_url.trim_end_matches('/')
                ))
                .bearer_auth(&connection.token)
                .header("Accept", "text/event-stream")
                .header("Last-Event-ID", last_seq)
                .send()
                .await;
            if let Ok(response) = response {
                if response.status().is_success() {
                    *self.bootstrap_error.write().await = None;
                    self.publish(
                        &app,
                        Status {
                            online: true,
                            message: None,
                            generation: Some(generation.clone()),
                        },
                    )
                    .await;
                    let mut stream = response.bytes_stream();
                    let mut parser = SseParser::default();
                    loop {
                        tokio::select! {
                            bytes = stream.next() => match bytes {
                                Some(Ok(bytes)) => {
                                    for event in parser.feed(&bytes) {
                                        if let Some(seq) = event.get("seq").and_then(Value::as_i64) {
                                            if seq > 0 && seq <= last_seq { continue; }
                                            if seq > 0 { last_seq = seq; }
                                        }
                                        let _ = app.emit("runtime:event", event);
                                    }
                                },
                                _ => break,
                            },
                            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                                if self.connection().await.ok().as_ref() != Some(&connection) { break; }
                            }
                        }
                    }
                }
            }
            self.publish(
                &app,
                Status {
                    online: false,
                    message: Some("Runtime disconnected".into()),
                    generation: Some(generation),
                },
            )
            .await;
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

#[derive(Default)]
pub struct SseParser {
    bytes: Vec<u8>,
    data: Vec<String>,
    data_size: usize,
}
impl SseParser {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Value> {
        self.bytes.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(end) = self.bytes.iter().position(|byte| *byte == b'\n') {
            let line = self.bytes.drain(..=end).collect::<Vec<_>>();
            let line = String::from_utf8_lossy(&line)
                .trim_end_matches(['\r', '\n'])
                .to_string();
            if line.is_empty() {
                if let Ok(value) = serde_json::from_str::<Value>(&self.data.join("\n")) {
                    events.push(value);
                }
                self.data.clear();
                self.data_size = 0;
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data_size += data.len();
                if self.data_size <= 1_048_576 {
                    self.data
                        .push(data.strip_prefix(' ').unwrap_or(data).to_string());
                } else {
                    self.data.clear();
                }
            }
        }
        // Events are tiny. Bound a malformed connection without retaining unbounded bytes.
        if self.bytes.len() > 1_048_576 {
            self.bytes.clear();
            self.data.clear();
            self.data_size = 0;
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_remote_and_credentialed_urls() {
        for base_url in [
            "https://127.0.0.1:47831",
            "http://evil.test:47831",
            "http://user@127.0.0.1:47831",
            "http://127.0.0.1:47831/x",
        ] {
            assert!(validate_connection(&Connection {
                base_url: base_url.into(),
                token: "a".repeat(32),
                pid: 1,
                started_at: "now".into()
            })
            .is_err());
        }
    }
    #[test]
    fn rejects_path_escape() {
        for path in [
            "//evil.test",
            "/tasks/../doctor",
            "/tasks/%2e%2e/doctor",
            "/tasks\\evil",
            "/events",
            "/tasks#evil",
        ] {
            assert!(validate_path(path).is_err());
        }
        assert!(validate_path("/tasks/t_123?status=todo").is_ok());
    }
    #[test]
    fn incremental_utf8_and_crlf() {
        let input = "event: task.created\r\ndata: {\"seq\":1,\"title\":\"中文\"}\r\n\r\n: ping\n\ndata: bad\n\ndata: {\"seq\":2}\n\n";
        let mut parser = SseParser::default();
        let mut results = Vec::new();
        for byte in input.as_bytes() {
            results.extend(parser.feed(&[*byte]));
        }
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["title"], "中文");
        assert_eq!(results[1]["seq"], 2);
    }
}
