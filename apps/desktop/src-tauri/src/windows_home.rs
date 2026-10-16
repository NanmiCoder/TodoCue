#![cfg_attr(not(windows), allow(dead_code))]
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub fn home_id(home: &Path) -> String {
    let hash = Sha256::digest(path_key(home).as_bytes());
    hash[..6].iter().map(|byte| format!("{byte:02x}")).collect()
}
// Node's path.win32.resolve normalizes separators and dot segments before hashing.
// This is lexical: a newly selected data directory need not exist yet.
fn path_key(path: &Path) -> String {
    normalize_absolute(&path.to_string_lossy()).to_lowercase()
}
fn normalize_absolute(value: &str) -> String {
    let value = value.replace('/', "\\");
    let bytes = value.as_bytes();
    let (root, tail) = if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\'
    {
        (value[..3].to_owned(), &value[3..])
    } else if value.starts_with(r"\\?\") || value.starts_with(r"\\.\") {
        (value[..4].to_owned(), &value[4..])
    } else if let Some(unc) = value.strip_prefix(r"\\") {
        let mut parts = unc.split('\\').filter(|part| !part.is_empty());
        if let (Some(server), Some(share)) = (parts.next(), parts.next()) {
            let root = format!(r"\\{server}\{share}\");
            // Skip both components even when separators were repeated.
            let mut end = 2;
            for _ in 0..2 {
                while value.as_bytes().get(end) == Some(&b'\\') {
                    end += 1;
                }
                while value.as_bytes().get(end).is_some_and(|c| *c != b'\\') {
                    end += 1;
                }
            }
            (root, &value[end..])
        } else {
            return value;
        }
    } else {
        // Non-Windows test fixtures retain the host path contract.
        return value.replace('\\', "/");
    };
    let mut parts = Vec::new();
    for part in tail.split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    format!("{root}{}", parts.join("\\"))
}
#[cfg(windows)]
pub fn resolve_home(home: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(home).map_err(|e| e.to_string())?;
    Ok(PathBuf::from(normalize_absolute(
        &absolute.to_string_lossy(),
    )))
}
pub fn quote_argument(value: &str) -> String {
    let mut output = String::from("\"");
    let mut slashes = 0;
    for c in value.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        output.push_str(&"\\".repeat(if c == '"' { slashes * 2 + 1 } else { slashes }));
        output.push(c);
        slashes = 0;
    }
    output.push_str(&"\\".repeat(slashes * 2));
    output.push('"');
    output
}
pub fn startup_command(exe: &Path, home: &Path) -> String {
    format!(
        "{} --background --home {}",
        quote_argument(&exe.to_string_lossy()),
        quote_argument(&home.to_string_lossy())
    )
}
#[cfg(windows)]
pub fn correct_startup_command(home: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    windows_registry::CURRENT_USER
        .create(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run")
        .and_then(|key| {
            key.set_string(
                format!("TodoCue {}", home_id(home)),
                startup_command(&exe, home),
            )
        })
        .map_err(|e| e.to_string())
}
pub fn query_home(url: &url::Url) -> Result<Option<String>, ()> {
    if url.query().is_none() {
        return Ok(None);
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.len() != 1
        || pairs[0].0 != "home"
        || pairs[0].1.len() != 12
        || !pairs[0]
            .1
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    {
        return Err(());
    }
    Ok(Some(pairs[0].1.to_string()))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredHome {
    pub id: String,
    pub home: PathBuf,
    pub runtime_root: PathBuf,
}
pub fn homes_directory() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|value| PathBuf::from(value).join("TodoCue/homes"))
}
fn same_path(a: &Path, b: &Path) -> bool {
    path_key(a) == path_key(b)
}
pub fn registered_home(dir: &Path, id: &str, root: &Path) -> Result<PathBuf, String> {
    if id.len() != 12
        || !id
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    {
        return Err("Invalid TodoCue data directory identifier".into());
    }
    let bytes = std::fs::read(dir.join(format!("{id}.json")))
        .map_err(|_| "Unknown TodoCue data directory")?;
    let entry: RegisteredHome =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid TodoCue directory registration")?;
    if entry.id != id
        || home_id(&entry.home) != id
        || !same_path(root, &entry.runtime_root)
        || !entry.home.is_absolute()
    {
        return Err("TodoCue directory belongs to another installation".into());
    }
    Ok(entry.home)
}
pub fn launch_home(
    args: &[String],
    default: PathBuf,
    root: &Path,
    dir: &Path,
) -> Result<PathBuf, String> {
    let mut protocol = false;
    for argument in args {
        if let Ok(url) = url::Url::parse(argument) {
            if url.scheme() == "todocue" {
                protocol = true;
                let id = query_home(&url).map_err(|_| "Invalid TodoCue route")?;
                if let Some(id) = id {
                    return registered_home(dir, &id, root);
                }
            }
        }
    }
    if let Some(pair) = args
        .windows(2)
        .find(|pair| !protocol && pair[0] == "--home")
    {
        let home = PathBuf::from(&pair[1]);
        return if home.is_absolute() {
            Ok(home)
        } else {
            Err("TodoCue --home must be an absolute path".into())
        };
    }
    // Explorer and user startup have no temporary shell environment. Resume the
    // last registered home for this installation; protocol links above are explicit.
    let latest = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|file| {
            let id = file.path().file_stem()?.to_str()?.to_owned();
            let home = registered_home(dir, &id, root).ok()?;
            Some((file.metadata().ok()?.modified().ok()?, home))
        })
        .max_by_key(|(modified, _)| *modified);
    Ok(latest.map(|(_, home)| home).unwrap_or(default))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn resolving_new_homes_matches_node_without_requiring_existing_directories() {
        let root = format!("C:/TodoCue-absent-{}/", std::process::id());
        let first = resolve_home(Path::new(&format!("{root}other/../new/"))).unwrap();
        let second = resolve_home(Path::new(&format!("{root}new/.").replace('/', "\\"))).unwrap();
        assert_eq!(first, second);
        assert_eq!(home_id(&first), home_id(&second));
        assert!(!first.exists());
    }
    #[test]
    fn startup_keeps_paths_with_spaces_and_trailing_slashes_as_single_arguments() {
        assert_eq!(
            startup_command(
                Path::new(r"C:\Program Files\TodoCue\todocue-desktop.exe"),
                Path::new(r"C:\Custom data")
            ),
            r#""C:\Program Files\TodoCue\todocue-desktop.exe" --background --home "C:\Custom data""#
        );
        assert_eq!(quote_argument("C:\\"), "\"C:\\\\\"");
    }
    #[test]
    fn home_ids_match_the_node_windows_service_contract() {
        assert_eq!(
            home_id(Path::new(r"C:\Users\User\.todocue")),
            "b135982fc11b"
        );
        for home in [
            r"C:\Custom data",
            "C:/Custom data",
            "C:\\Custom data\\",
            r"C:\Custom data\.",
            r"C:\other\..\Custom data",
        ] {
            assert_eq!(home_id(Path::new(home)), "c2a4d1e3040d", "{home}");
        }
        for (home, id) in [
            (r"C:\", "3dc8472eaebe"),
            (r"C:\foo\bar\..\..\..", "3dc8472eaebe"),
            (r"\\server\share\foo\..\", "af69ebc65f06"),
            (r"\\server\share\..\..\after", "190d11be5e27"),
            (r"\\?\C:\foo\..\..", "284a6a0bf182"),
            (r"\\?\UNC\server\share\..\..", "3e01337bba34"),
            (r"\\.\pipe\foo\..", "58cf6af39b15"),
        ] {
            assert_eq!(home_id(Path::new(home)), id, "{home}");
        }
    }
    #[test]
    fn cold_and_warm_routes_select_the_registered_home_and_reject_unknown_namespaces() {
        let dir = std::env::temp_dir().join(format!("todocue-home-route-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let custom = dir.join("Custom data");
        let root = dir.join("runtime");
        let id = home_id(&custom);
        std::fs::write(
            dir.join(format!("{id}.json")),
            serde_json::to_vec(&serde_json::json!({"id": id,"home":custom,"runtimeRoot":root}))
                .unwrap(),
        )
        .unwrap();
        let default = dir.join("default");
        for target in [
            format!("todocue://task/t_123?home={id}"),
            format!("todocue://periodic/p_123?home={id}"),
        ] {
            assert_eq!(
                launch_home(&[target], default.clone(), &root, &dir).unwrap(),
                custom
            );
        }
        assert_eq!(
            launch_home(&[], default.clone(), &root, &dir).unwrap(),
            custom
        );
        assert_eq!(
            launch_home(
                &[
                    "todocue://open".into(),
                    "--home".into(),
                    dir.join("unexpected").to_string_lossy().into_owned()
                ],
                default.clone(),
                &root,
                &dir
            )
            .unwrap(),
            custom
        );
        assert!(launch_home(
            &["todocue://task/t_123?home=000000000000".into()],
            default.clone(),
            &root,
            &dir
        )
        .is_err());
        assert!(registered_home(&dir, &id, &dir.join("other-runtime")).is_err());
        for query in [
            "home=../../data",
            "home=0123456789ab&home=0123456789ab",
            "path=C:/data",
        ] {
            assert!(
                query_home(&url::Url::parse(&format!("todocue://open?{query}")).unwrap()).is_err()
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
