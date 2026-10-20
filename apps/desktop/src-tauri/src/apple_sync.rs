//! Apple Calendar / Reminders sync (macOS only). The work is done by `TodoCueAppleSync`, the SwiftUI
//! app's sync engine packaged without its UI (`apps/macos/Sources/TodoCueAppleSync`). This module starts
//! it, restarts it when it dies, relays the settings page's commands to it as JSON lines and pushes
//! its status to the panel as `apple-sync:status`.
//!
//! The helper is a child of this process, so macOS attributes Calendar and Reminders access to
//! TodoCue.app (whose Info.plist carries the usage descriptions). It exits when its stdin closes,
//! which happens whenever this process ends.
// Elsewhere the module only answers "unavailable"; the helper side is never started.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

/// Commands the settings page may send. Anything else is refused before it reaches the helper.
const COMMANDS: [&str; 6] = [
    "status",
    "setEnabled",
    "syncNow",
    "removeData",
    "refreshAccess",
    "openPrivacySettings",
];
/// A permission prompt waits for the user; a round can take a while on a large list.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(600);

type Reply = Result<Option<String>, String>;

/// One line from the helper.
#[derive(Debug, PartialEq)]
pub enum HelperLine {
    Status(Value),
    Result {
        id: u64,
        message: Option<String>,
        error: Option<String>,
    },
}

pub fn parse_line(line: &str) -> Option<HelperLine> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    match value.get("type")?.as_str()? {
        "status" => Some(HelperLine::Status(value.get("status")?.clone())),
        "result" => Some(HelperLine::Result {
            id: value.get("id")?.as_u64()?,
            message: value.get("message").and_then(Value::as_str).map(str::to_owned),
            error: value.get("error").and_then(Value::as_str).map(str::to_owned),
        }),
        _ => None,
    }
}

/// The line to write for a command from the settings page, with the id its result will carry.
pub fn command_line(id: u64, command: &Value) -> Result<String, String> {
    let object = command.as_object().ok_or("Invalid Apple sync command")?;
    let name = object
        .get("command")
        .and_then(Value::as_str)
        .ok_or("Invalid Apple sync command")?;
    if !COMMANDS.contains(&name) {
        return Err(format!("Unknown Apple sync command: {name}"));
    }
    let mut line = Map::new();
    line.insert("id".into(), json!(id));
    line.insert("command".into(), json!(name));
    for key in ["kind", "enabled"] {
        if let Some(value) = object.get(key) {
            line.insert(key.into(), value.clone());
        }
    }
    Ok(Value::Object(line).to_string())
}

/// Wait before the next start after `failures` exits in a row that each came soon after starting.
pub fn restart_delay(failures: u32) -> Duration {
    Duration::from_secs(2u64.saturating_pow(failures.min(6)).min(60))
}

/// The bundled helper sits in `Contents/Helpers`, beside the `Contents/MacOS` executable.
/// `TODOCUE_APPLE_SYNC_HELPER` points a development build at `apps/macos/.build/*/TodoCueAppleSync`.
pub fn helper_path(executable: &Path, override_path: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(path) = override_path.filter(|path| !path.as_os_str().is_empty()) {
        return path.is_file().then_some(path);
    }
    let contents = executable.parent()?.parent()?;
    let path = contents.join("Helpers/TodoCueAppleSync");
    path.is_file().then_some(path)
}

#[derive(Default)]
struct Inner {
    /// The helper was found; false on Windows/Linux and in a dev build without one.
    available: bool,
    stdin: Option<ChildStdin>,
    status: Option<Value>,
    pending: HashMap<u64, oneshot::Sender<Reply>>,
    next_id: u64,
    language: String,
}

#[derive(Default)]
pub struct AppleSync {
    inner: Mutex<Inner>,
    emit: Mutex<Option<Arc<dyn Fn(Value) + Send + Sync>>>,
}

impl AppleSync {
    /// What the settings page renders: whether sync exists here, whether the helper is up, and its
    /// last status (null until the first one arrives).
    pub fn snapshot(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        json!({
            "available": inner.available,
            "running": inner.stdin.is_some(),
            "status": inner.status.clone().unwrap_or(Value::Null),
        })
    }

    fn publish(&self) {
        let emit = self.emit.lock().unwrap().clone();
        if let Some(emit) = emit {
            emit(self.snapshot());
        }
    }

    /// Start the helper and keep it running for the life of this process.
    pub fn start(
        self: &Arc<Self>,
        helper: PathBuf,
        home: PathBuf,
        language: String,
        emit: impl Fn(Value) + Send + Sync + 'static,
    ) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.available = true;
            inner.language = language;
        }
        *self.emit.lock().unwrap() = Some(Arc::new(emit));
        let sync = self.clone();
        std::thread::spawn(move || sync.supervise(helper, home));
    }

    fn supervise(self: Arc<Self>, helper: PathBuf, home: PathBuf) {
        let mut failures = 0;
        loop {
            let started = Instant::now();
            let language = self.inner.lock().unwrap().language.clone();
            let child = Command::new(&helper)
                .env("TODOCUE_HOME", &home)
                .env("TODOCUE_APPLE_SYNC_LANGUAGE", language)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn();
            match child {
                Ok(mut child) => {
                    let stdout = child.stdout.take();
                    self.inner.lock().unwrap().stdin = child.stdin.take();
                    self.publish();
                    if let Some(stdout) = stdout {
                        for line in BufReader::new(stdout).lines() {
                            let Ok(line) = line else { break };
                            self.receive(&line);
                        }
                    }
                    let status = child.wait();
                    eprintln!("Apple sync helper exited: {status:?}");
                }
                Err(error) => eprintln!("Apple sync helper failed to start: {error}"),
            }
            let pending = {
                let mut inner = self.inner.lock().unwrap();
                inner.stdin = None;
                inner.status = None;
                std::mem::take(&mut inner.pending)
            };
            for (_, reply) in pending {
                let _ = reply.send(Err("Apple sync stopped unexpectedly".into()));
            }
            self.publish();
            failures = if started.elapsed() > Duration::from_secs(60) {
                0
            } else {
                failures + 1
            };
            std::thread::sleep(restart_delay(failures));
        }
    }

    fn receive(&self, line: &str) {
        match parse_line(line) {
            Some(HelperLine::Status(status)) => {
                self.inner.lock().unwrap().status = Some(status);
                self.publish();
            }
            Some(HelperLine::Result { id, message, error }) => {
                let reply = self.inner.lock().unwrap().pending.remove(&id);
                if let Some(reply) = reply {
                    let _ = reply.send(match error {
                        Some(error) => Err(error),
                        None => Ok(message),
                    });
                }
            }
            None => eprintln!("Apple sync helper: unreadable line: {line}"),
        }
    }

    fn write(inner: &mut Inner, line: &str) -> Result<(), String> {
        let stdin = inner.stdin.as_mut().ok_or("Apple sync is not running")?;
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|error| error.to_string())
    }

    /// Send a command and wait for its result: the message the SwiftUI settings showed, if any.
    pub async fn command(&self, command: &Value) -> Reply {
        let receiver = {
            let mut inner = self.inner.lock().unwrap();
            if !inner.available {
                return Err("Apple sync is only available in the macOS app".into());
            }
            inner.next_id += 1;
            let id = inner.next_id;
            let line = command_line(id, command)?;
            Self::write(&mut inner, &line)?;
            let (sender, receiver) = oneshot::channel();
            inner.pending.insert(id, sender);
            receiver
        };
        match tokio::time::timeout(COMMAND_TIMEOUT, receiver).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("Apple sync stopped unexpectedly".into()),
            Err(_) => Err("Apple sync did not answer".into()),
        }
    }

    /// Follow the app's language for the messages the helper writes. Also applied at every restart.
    pub fn set_language(&self, language: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.language = language.to_owned();
        if inner.stdin.is_some() {
            let line = json!({ "command": "setLanguage", "language": language }).to_string();
            let _ = Self::write(&mut inner, &line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_status_and_result_lines() {
        assert_eq!(
            parse_line(r#"{"type":"status","status":{"syncing":true}}"#),
            Some(HelperLine::Status(json!({ "syncing": true })))
        );
        assert_eq!(
            parse_line(r#"{"error":null,"id":7,"message":"未获得权限","type":"result"}"#),
            Some(HelperLine::Result {
                id: 7,
                message: Some("未获得权限".into()),
                error: None
            })
        );
        assert_eq!(parse_line("TodoCueAppleSync: noise"), None);
        assert_eq!(parse_line(r#"{"type":"result"}"#), None);
    }

    #[test]
    fn forwards_only_known_commands_and_fields() {
        assert_eq!(
            command_line(
                3,
                &json!({ "command": "setEnabled", "kind": "reminder", "enabled": true, "token": "x" })
            )
            .unwrap(),
            r#"{"command":"setEnabled","enabled":true,"id":3,"kind":"reminder"}"#
        );
        assert!(command_line(1, &json!({ "command": "setLanguage", "language": "en" })).is_err());
        assert!(command_line(1, &json!({ "command": "rm" })).is_err());
        assert!(command_line(1, &json!("syncNow")).is_err());
    }

    #[test]
    fn restarts_back_off_to_a_minute() {
        assert_eq!(restart_delay(0), Duration::from_secs(1));
        assert_eq!(restart_delay(1), Duration::from_secs(2));
        assert_eq!(restart_delay(5), Duration::from_secs(32));
        assert_eq!(restart_delay(40), Duration::from_secs(60));
    }

    #[test]
    fn finds_the_helper_beside_the_app_executable() {
        let root = std::env::temp_dir().join(format!("todocue-helper-path-{}", std::process::id()));
        let executable = root.join("TodoCue.app/Contents/MacOS/todocue-desktop");
        let helper = root.join("TodoCue.app/Contents/Helpers/TodoCueAppleSync");
        std::fs::create_dir_all(helper.parent().unwrap()).unwrap();
        assert_eq!(helper_path(&executable, None), None);
        std::fs::write(&helper, "").unwrap();
        assert_eq!(helper_path(&executable, None), Some(helper.clone()));
        assert_eq!(
            helper_path(&executable, Some(root.join("missing"))),
            None,
            "an explicit override never falls back to another helper"
        );
        assert_eq!(helper_path(&executable, Some(PathBuf::new())), Some(helper));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn relays_commands_and_status_through_a_running_helper() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("todocue-helper-relay-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("helper.sh");
        // Echoes its environment in a status line, then answers each command with its own id.
        std::fs::write(
            &script,
            r#"#!/bin/sh
printf '{"type":"status","status":{"home":"%s","language":"%s"}}\n' "$TODOCUE_HOME" "$TODOCUE_APPLE_SYNC_LANGUAGE"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  [ -n "$id" ] && printf '{"type":"result","id":%s,"message":"ok %s","error":null}\n' "$id" "$id"
done
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let sync = Arc::new(AppleSync::default());
        let (sender, statuses) = std::sync::mpsc::channel();
        sync.start(script, dir.join("home"), "en".into(), move |value| {
            let _ = sender.send(value);
        });
        let status = loop {
            let value = statuses.recv_timeout(Duration::from_secs(5)).unwrap();
            if !value["status"].is_null() {
                break value;
            }
        };
        assert_eq!(status["available"], json!(true));
        assert_eq!(status["running"], json!(true));
        assert_eq!(status["status"]["language"], json!("en"));
        assert!(status["status"]["home"].as_str().unwrap().ends_with("home"));

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let first = runtime.block_on(sync.command(&json!({ "command": "syncNow" })));
        let second = runtime.block_on(sync.command(&json!({ "command": "refreshAccess" })));
        assert_eq!(first, Ok(Some("ok 1".into())));
        assert_eq!(second, Ok(Some("ok 2".into())));
        assert!(runtime
            .block_on(sync.command(&json!({ "command": "nope" })))
            .is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unavailable_without_a_helper() {
        let sync = AppleSync::default();
        assert_eq!(sync.snapshot()["available"], json!(false));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        assert!(runtime
            .block_on(sync.command(&json!({ "command": "syncNow" })))
            .is_err());
    }
}
