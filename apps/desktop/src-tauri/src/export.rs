//! File helpers for the host commands: the JSON export, attachment save-as and opening the data
//! folder. Everything that decides a path or a name lives here so it can be tested on any platform.

use std::path::{Path, PathBuf};

/// The only file name the export may use: `todocue-export-YYYY-MM-DD.json`. Nothing else is written.
pub fn valid_name(name: &str) -> bool {
    let Some(date) = name
        .strip_prefix("todocue-export-")
        .and_then(|rest| rest.strip_suffix(".json"))
    else {
        return false;
    };
    let bytes = date.as_bytes();
    bytes.len() == 10
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() })
}

/// Largest export accepted over IPC.
pub const MAX_BYTES: usize = 256 * 1024 * 1024;

pub fn save(directory: &Path, name: &str, contents: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("Invalid export file name".into());
    }
    if contents.len() > MAX_BYTES {
        return Err("Export is too large".into());
    }
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let target = directory.join(name);
    let temporary = directory.join(format!(".{name}.tmp"));
    std::fs::write(&temporary, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &target).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        e.to_string()
    })?;
    Ok(target)
}

/// `save` off the caller's thread: a large export is written without holding up the window.
pub async fn save_async(directory: PathBuf, name: String, contents: String) -> Result<PathBuf, String> {
    tauri::async_runtime::spawn_blocking(move || save(&directory, &name, &contents))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Os {
    Mac,
    Windows,
    Other,
}

pub fn current_os() -> Os {
    if cfg!(target_os = "macos") {
        Os::Mac
    } else if cfg!(windows) {
        Os::Windows
    } else {
        Os::Other
    }
}

/// Program and arguments that show `path` selected in the platform's file manager.
pub fn reveal_command(os: Os, path: &Path) -> (&'static str, Vec<String>) {
    let text = path.to_string_lossy().into_owned();
    match os {
        Os::Mac => ("open", vec!["-R".into(), text]),
        // explorer wants one argument, `/select,"path"`, with the quotes part of it.
        Os::Windows => ("explorer", vec![format!("/select,\"{text}\"")]),
        Os::Other => (
            "xdg-open",
            vec![path
                .parent()
                .map(|parent| parent.to_string_lossy().into_owned())
                .unwrap_or(text)],
        ),
    }
}


/// Ids the runtime hands out: letters, digits, `_` and `-`. Anything else never reaches a URL.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Longest file name offered, in characters, and the longest extension worth protecting from the cut.
const NAME_LIMIT: usize = 180;
const EXTENSION_LIMIT: usize = 16;

/// Windows device names (`CON`, `NUL`, `COM1`…): they are devices whatever follows them, an
/// extension, spaces or dots, so `CON .txt` is as reserved as `CON`.
fn is_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("");
    let stem = stem.trim_end_matches([' ', '.']).to_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str()) {
        return true;
    }
    let mut chars = stem.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    matches!(prefix.as_str(), "COM" | "LPT")
        && matches!(chars.next(), Some(c) if c.is_ascii_digit() || matches!(c, '¹' | '²' | '³'))
        && chars.next().is_none()
}

/// Cut `name` to `limit` characters, keeping a short extension, and leave no space or dot at the
/// end of what is left of the stem.
fn truncate_keeping_extension(name: &str, limit: usize) -> String {
    if name.chars().count() <= limit {
        return name.to_string();
    }
    let (stem, extension) = match name.rfind('.') {
        Some(index) if index > 0 && name[index..].chars().count() <= EXTENSION_LIMIT => {
            name.split_at(index)
        }
        _ => (name, ""),
    };
    let budget = limit - extension.chars().count();
    let stem: String = stem.chars().take(budget).collect();
    let stem = stem.trim_end_matches([' ', '.']);
    if stem.is_empty() {
        format!("attachment{extension}")
    } else {
        format!("{stem}{extension}")
    }
}

/// A file name that is safe to offer in a save dialog: no directory parts, no control characters
/// or characters Windows rejects, no trailing dots or spaces, no reserved device names. The person
/// still confirms the final path in the dialog; this is only the suggestion.
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == ' ' || c == '.');
    let named = if trimmed.is_empty() {
        "attachment".to_string()
    } else if is_device_name(trimmed) {
        format!("attachment-{trimmed}")
    } else {
        trimmed.to_string()
    };
    truncate_keeping_extension(&named, NAME_LIMIT)
}

/// Pull the file name and bytes out of the runtime's attachment response
/// (`{ status, body: { attachment: { name }, dataBase64 } }`).
pub fn decode_attachment(response: &serde_json::Value) -> Result<(String, Vec<u8>), String> {
    use base64::Engine;
    if response["status"].as_u64() != Some(200) {
        return Err(response["body"]["error"]["message"]
            .as_str()
            .unwrap_or("The attachment could not be read")
            .to_string());
    }
    let body = &response["body"];
    let encoded = body["dataBase64"].as_str().ok_or("The attachment has no content")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "The attachment content is damaged".to_string())?;
    let name = safe_file_name(body["attachment"]["name"].as_str().unwrap_or(""));
    Ok((name, bytes))
}

/// Program and arguments that open a directory in the platform's file manager.
pub fn open_directory_command(os: Os, path: &Path) -> (&'static str, Vec<String>) {
    let text = path.to_string_lossy().into_owned();
    match os {
        Os::Mac => ("open", vec![text]),
        // One argument with the quotes inside it keeps paths with spaces intact.
        Os::Windows => ("explorer", vec![format!("\"{text}\"")]),
        Os::Other => ("xdg-open", vec![text]),
    }
}

fn spawn_child(program: &str, arguments: &[String]) -> std::io::Result<std::process::Child> {
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for argument in arguments {
            command.raw_arg(argument);
        }
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    command.args(arguments);
    command.spawn()
}

/// Start `program` and collect its exit status on a helper thread, so a short-lived `open`,
/// `explorer` or `xdg-open` never lingers as a zombie. Returns the process id and the helper.
fn spawn_reaped(
    program: &str,
    arguments: &[String],
) -> std::io::Result<(u32, std::thread::JoinHandle<()>)> {
    let mut child = spawn_child(program, arguments)?;
    let pid = child.id();
    let reaper = std::thread::Builder::new()
        .name("file-manager-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        })?;
    Ok((pid, reaper))
}

fn spawn(program: &str, arguments: &[String]) -> std::io::Result<()> {
    spawn_reaped(program, arguments).map(|_| ())
}

/// Open `path` (the data directory itself) in the file manager.
pub fn open_directory(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err("The data folder does not exist yet".into());
    }
    let (program, arguments) = open_directory_command(current_os(), path);
    spawn(program, &arguments).map_err(|e| e.to_string())
}

pub fn reveal(path: &Path) {
    let (program, arguments) = reveal_command(current_os(), path);
    // Explorer reports failure for a successful reveal; the file is saved either way.
    let _ = spawn(program, &arguments);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_dated_export_name_is_accepted() {
        assert!(valid_name("todocue-export-2026-10-17.json"));
        for bad in [
            "todocue.json",
            "todocue-export-2026-10-1.json",
            "todocue-export-2026-10-17.json.exe",
            "../todocue-export-2026-10-17.json",
            "todocue-export-2026/10/17.json",
            "todocue-export-abcd-ef-gh.json",
            "",
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn saves_atomically_and_overwrites_the_same_day() {
        let directory = std::env::temp_dir().join(format!("todocue-export-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let path = save(&directory, "todocue-export-2026-10-17.json", "{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");
        save(&directory, "todocue-export-2026-10-17.json", "{\"a\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":2}");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        assert!(save(&directory, "evil.json", "x").is_err());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn reveal_commands_per_platform() {
        let path = Path::new("/Users/me/Downloads/todocue-export-2026-10-17.json");
        assert_eq!(
            reveal_command(Os::Mac, path),
            ("open", vec!["-R".to_string(), path.to_string_lossy().into_owned()])
        );
        let windows = Path::new("C:\\Users\\me\\Downloads\\todocue-export-2026-10-17.json");
        let (program, arguments) = reveal_command(Os::Windows, windows);
        assert_eq!(program, "explorer");
        assert_eq!(
            arguments,
            vec!["/select,\"C:\\Users\\me\\Downloads\\todocue-export-2026-10-17.json\"".to_string()]
        );
        let (program, arguments) = reveal_command(Os::Other, path);
        assert_eq!(program, "xdg-open");
        assert_eq!(arguments, vec!["/Users/me/Downloads".to_string()]);
    }

    #[test]
    fn ids_and_file_names_are_confined() {
        assert!(valid_id("t_abc-123"));
        for bad in ["", "a/b", "..", "a b", "t%2e", &"x".repeat(129)] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert_eq!(safe_file_name("报告 final.pdf"), "报告 final.pdf");
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("C:\\Windows\\system.ini"), "system.ini");
        assert_eq!(safe_file_name("a<b>:c|d?.txt"), "a_b__c_d_.txt");
        assert_eq!(safe_file_name("  ..  "), "attachment");
        assert_eq!(safe_file_name("CON.txt"), "attachment-CON.txt");
        assert_eq!(safe_file_name("lpt1"), "attachment-lpt1");
        assert_eq!(safe_file_name(&"长".repeat(400)).chars().count(), 180);
    }

    #[cfg(unix)]
    #[test]
    fn a_finished_file_manager_process_is_collected_not_left_as_a_zombie() {
        let (pid, reaper) = spawn_reaped("true", &[]).unwrap();
        reaper.join().unwrap();
        let listing = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&listing.stdout).trim(), "", "process {pid} is still listed");
    }

    #[test]
    fn spawning_a_missing_program_reports_the_error() {
        assert!(spawn("todocue-no-such-program-xyz", &[]).is_err());
    }

    #[test]
    fn the_async_save_writes_the_same_file_and_reports_the_same_errors() {
        let directory = std::env::temp_dir().join(format!("todocue-export-async-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let name = "todocue-export-2026-10-17.json".to_string();
        let path = tauri::async_runtime::block_on(save_async(directory.clone(), name.clone(), "{\"a\":3}".into())).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":3}");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        let refused = tauri::async_runtime::block_on(save_async(directory.clone(), "../x.json".into(), "x".into()));
        assert_eq!(refused.unwrap_err(), "Invalid export file name");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn long_names_keep_their_extension_and_never_end_in_space_or_dot() {
        let long = format!("{}.pdf", "长".repeat(400));
        let cleaned = safe_file_name(&long);
        assert_eq!(cleaned.chars().count(), 180);
        assert!(cleaned.ends_with(".pdf"), "{cleaned}");
        // Cutting lands on a space: it must not be left at the end of the stem.
        let spaced = format!("{} {}.txt", "a".repeat(175), "b".repeat(20));
        let cleaned = safe_file_name(&spaced);
        assert!(cleaned.ends_with(".txt"), "{cleaned}");
        assert!(!cleaned.trim_end_matches(".txt").ends_with([' ', '.']), "{cleaned}");
        assert!(cleaned.chars().count() <= 180);
        // No extension at all: a cut that ends on a dot or space is trimmed.
        let bare = format!("{}. {}", "a".repeat(178), "z".repeat(10));
        assert!(!safe_file_name(&bare).ends_with([' ', '.']));
        // An absurd "extension" is not worth keeping over the name.
        let odd = format!("name.{}", "x".repeat(300));
        assert_eq!(safe_file_name(&odd).chars().count(), 180);
        assert!(safe_file_name(&odd).starts_with("name."));
    }

    #[test]
    fn windows_device_names_are_caught_with_trailing_spaces_dots_and_superscripts() {
        for name in ["CON .txt", "NUL.", "nul . ", "aux  .tar.gz", "COM1 .log", "LPT9.", "COM¹", "lpt².txt", "CONIN$", "conout$.txt", "COM0"] {
            let cleaned = safe_file_name(name);
            assert!(cleaned.starts_with("attachment-"), "{name} -> {cleaned}");
        }
        for name in ["CONSOLE.txt", "COM10.txt", "console", "com.txt", "LPT.txt", "aux-1.txt", "my CON.txt", "COMX"] {
            assert_eq!(safe_file_name(name), name, "{name}");
        }
    }

    #[test]
    fn attachment_responses_decode_or_explain() {
        let ok = serde_json::json!({ "status": 200, "body": {
            "attachment": { "name": "../a.txt" }, "dataBase64": "aGVsbG8=" } });
        assert_eq!(decode_attachment(&ok).unwrap(), ("a.txt".to_string(), b"hello".to_vec()));
        let missing = serde_json::json!({ "status": 404, "body": { "error": { "message": "Attachment not found" } } });
        assert_eq!(decode_attachment(&missing).unwrap_err(), "Attachment not found");
        let empty = serde_json::json!({ "status": 200, "body": { "attachment": { "name": "a" } } });
        assert!(decode_attachment(&empty).is_err());
        let broken = serde_json::json!({ "status": 200, "body": { "dataBase64": "***" } });
        assert!(decode_attachment(&broken).is_err());
    }

    #[test]
    fn data_folder_open_commands_quote_paths_with_spaces() {
        let mac = Path::new("/Users/me/My Data/.todocue");
        assert_eq!(open_directory_command(Os::Mac, mac), ("open", vec!["/Users/me/My Data/.todocue".to_string()]));
        let windows = Path::new("C:\\Users\\我 的\\.todocue");
        assert_eq!(
            open_directory_command(Os::Windows, windows),
            ("explorer", vec!["\"C:\\Users\\我 的\\.todocue\"".to_string()])
        );
        assert_eq!(open_directory_command(Os::Other, mac).0, "xdg-open");
        // A path that is not an existing directory is refused before anything is spawned.
        assert!(open_directory(Path::new("/definitely/not/here")).is_err());
        assert!(open_directory(&std::env::temp_dir().join("todocue-no-such-dir-xyz")).is_err());
    }
}
