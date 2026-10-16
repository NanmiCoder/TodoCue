use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    version: u8,
    data_home: PathBuf,
}

pub fn profile_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home).join("Library/Application Support/TodoCue/launch-home.json")
    })
}

fn valid_home(home: &Path) -> bool {
    home.is_absolute() && !home.as_os_str().to_string_lossy().contains('\0')
}

fn load(profile: &Path) -> Option<PathBuf> {
    let value: Profile = serde_json::from_slice(&fs::read(profile).ok()?).ok()?;
    (value.version == 1 && valid_home(&value.data_home)).then_some(value.data_home)
}

pub fn resolve_home(
    explicit: Option<PathBuf>,
    profile: Option<&Path>,
    preview_default: PathBuf,
) -> PathBuf {
    explicit
        .or_else(|| profile.and_then(load))
        .unwrap_or(preview_default)
}

/// Remember an explicit Preview selection so Finder and Dock launches use the same runtime.
/// This stores only a directory; connection credentials remain in that directory.
pub fn remember(profile: &Path, data_home: &Path) -> io::Result<()> {
    if !valid_home(data_home) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected an absolute data directory",
        ));
    }
    let parent = profile
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing profile directory"))?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)?;
    let bytes = serde_json::to_vec(&Profile {
        version: 1,
        data_home: data_home.into(),
    })
    .map_err(io::Error::other)?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = profile.with_extension(format!("{}.{}.tmp", std::process::id(), unique));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, profile)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "todocue-preview-home-{}-{sequence}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn profile(&self) -> PathBuf {
            self.0.join("config/launch-home.json")
        }
        fn fallback(&self) -> PathBuf {
            self.0.join("temporary-preview")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn finder_relaunch_reuses_explicit_home_with_spaces_and_chinese() {
        let fixture = Fixture::new();
        let selected = fixture.0.join("通用版 隔离测试/data");
        remember(&fixture.profile(), &selected).unwrap();
        assert_eq!(
            resolve_home(None, Some(&fixture.profile()), fixture.fallback()),
            selected
        );
    }

    #[test]
    fn explicit_selection_overrides_profile_without_changing_it() {
        let fixture = Fixture::new();
        let first = fixture.0.join("first");
        let second = fixture.0.join("second");
        remember(&fixture.profile(), &first).unwrap();
        assert_eq!(
            resolve_home(
                Some(second.clone()),
                Some(&fixture.profile()),
                fixture.fallback()
            ),
            second
        );
        assert_eq!(load(&fixture.profile()), Some(first));
        remember(&fixture.profile(), &second).unwrap();
        assert_eq!(
            resolve_home(None, Some(&fixture.profile()), fixture.fallback()),
            second
        );
    }

    #[test]
    fn missing_or_corrupt_profile_keeps_the_isolated_preview_default() {
        let fixture = Fixture::new();
        assert_eq!(
            resolve_home(None, Some(&fixture.profile()), fixture.fallback()),
            fixture.fallback()
        );
        fs::create_dir_all(fixture.profile().parent().unwrap()).unwrap();
        fs::write(fixture.profile(), b"{invalid").unwrap();
        assert_eq!(
            resolve_home(None, Some(&fixture.profile()), fixture.fallback()),
            fixture.fallback()
        );
    }

    #[test]
    fn invalid_or_unsupported_profiles_are_ignored() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.profile().parent().unwrap()).unwrap();
        for value in [
            serde_json::json!({ "version": 1, "dataHome": "" }),
            serde_json::json!({ "version": 1, "dataHome": "relative/data" }),
            serde_json::json!({ "version": 1, "dataHome": "/invalid\0path" }),
            serde_json::json!({ "version": 2, "dataHome": fixture.0 }),
            serde_json::json!({ "dataHome": fixture.0 }),
        ] {
            fs::write(fixture.profile(), serde_json::to_vec(&value).unwrap()).unwrap();
            assert_eq!(load(&fixture.profile()), None);
        }
    }

    #[test]
    fn invalid_selection_preserves_the_previous_profile() {
        let fixture = Fixture::new();
        let selected = fixture.0.join("selected");
        remember(&fixture.profile(), &selected).unwrap();
        assert!(remember(&fixture.profile(), Path::new("relative")).is_err());
        assert_eq!(load(&fixture.profile()), Some(selected));
    }

    #[test]
    fn profile_contains_no_credentials_and_is_private() {
        let fixture = Fixture::new();
        remember(&fixture.profile(), &fixture.0.join("selected")).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.profile()).unwrap()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 2);
        assert!(value.get("token").is_none());
        assert_eq!(
            fs::metadata(fixture.profile())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn unwritable_profile_does_not_prevent_an_explicit_launch() {
        let fixture = Fixture::new();
        let parent_file = fixture.0.join("file");
        fs::write(&parent_file, b"existing").unwrap();
        let profile = parent_file.join("launch-home.json");
        let selected = fixture.0.join("selected");
        assert!(remember(&profile, &selected).is_err());
        assert_eq!(
            resolve_home(Some(selected.clone()), Some(&profile), fixture.fallback()),
            selected
        );
        assert_eq!(fs::read(parent_file).unwrap(), b"existing");
    }
}
