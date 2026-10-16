//! Saving the JSON export to the system Downloads folder and revealing it in the file manager.

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

pub fn reveal(path: &Path) {
    let (program, arguments) = reveal_command(current_os(), path);
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for argument in &arguments {
            command.raw_arg(argument);
        }
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    command.args(&arguments);
    // Explorer reports failure for a successful reveal; the file is saved either way.
    let _ = command.spawn();
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
}
