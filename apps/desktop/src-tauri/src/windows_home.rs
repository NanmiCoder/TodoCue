#![cfg_attr(not(windows), allow(dead_code))]
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub fn home_id(home: &Path) -> String {
    let hash = Sha256::digest(home.to_string_lossy().to_lowercase().as_bytes());
    hash[..6].iter().map(|byte| format!("{byte:02x}")).collect()
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
                format!("TodoCue Preview {}", home_id(home)),
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
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
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
