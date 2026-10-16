#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(any(windows, test))]
#[path = "../windows_home.rs"]
mod windows_home;
#[cfg(any(windows, test))]
fn notification_target(task: &str, periodic: &str, home: &std::path::Path) -> String {
    let mut url = url::Url::parse("todocue://open").unwrap();
    if !task.is_empty() {
        url.set_host(Some("task")).unwrap();
        url.set_path(task);
    } else if !periodic.is_empty() {
        url.set_host(Some("periodic")).unwrap();
        url.set_path(periodic);
    }
    url.query_pairs_mut()
        .append_pair("home", &windows_home::home_id(home));
    url.into()
}
#[cfg(any(windows, test))]
fn escape(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t' | '\r'))
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
#[cfg(windows)]
fn run() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    use std::{os::windows::process::CommandExt, process::Command};
    use windows::{
        core::HSTRING,
        Data::Xml::Dom::XmlDocument,
        UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
    };
    let args: Vec<_> = std::env::args().skip(1).collect();
    unsafe {
        windows::Win32::System::WinRT::RoInitialize(
            windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
        )?;
    }
    let value = |flag: &str| {
        args.windows(2)
            .find(|pair| pair[0] == flag)
            .map(|pair| pair[1].as_str())
            .unwrap_or("")
    };
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from("com.todocue.app"))?;
    let enabled = notifier.Setting()? == NotificationSetting::Enabled;
    match args.first().map(String::as_str) {
        Some("status" | "request") => Ok(
            serde_json::json!({"ok":true,"authorization":if enabled {"authorized"} else {"denied"},"needsSystemSettings":!enabled,"alertStyle":"Windows app notifications"}),
        ),
        Some("open-settings") => {
            let status = Command::new("explorer.exe")
                .arg("ms-settings:notifications")
                .creation_flags(0x08000000)
                .status()?;
            Ok(serde_json::json!({"ok":status.success(),"url":"ms-settings:notifications"}))
        }
        Some("deliver") => {
            if !enabled {
                return Err("Windows notifications are disabled; enable TodoCue in Settings > Notifications".into());
            }
            let home = if !value("--home").is_empty() {
                std::path::PathBuf::from(value("--home"))
            } else {
                std::path::PathBuf::from(
                    std::env::var_os("TODOCUE_HOME")
                        .ok_or("Notification data directory is missing")?,
                )
            };
            let target = notification_target(value("--task-id"), value("--periodic-id"), &home);
            let xml = XmlDocument::new()?;
            xml.LoadXml(&HSTRING::from(format!("<toast activationType=\"protocol\" launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>{}</toast>", escape(&target), escape(value("--title")), escape(value("--body")), if args.iter().any(|arg| arg == "--sound") { "" } else { "<audio silent=\"true\"/>" })))?;
            let toast = ToastNotification::CreateToastNotification(&xml)?;
            use std::hash::{Hash, Hasher};
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            value("--id").hash(&mut hash);
            toast.SetTag(&HSTRING::from(format!("{:016x}", hash.finish())))?;
            notifier.Show(&toast)?;
            Ok(serde_json::json!({"ok":true,"channel":"windows-toast"}))
        }
        _ => Err("Expected status, request, deliver or open-settings".into()),
    }
}
fn main() {
    #[cfg(windows)]
    let result = run();
    #[cfg(not(windows))]
    let result: Result<serde_json::Value, Box<dyn std::error::Error>> =
        Err("Windows notifier is only available on Windows".into());
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            println!(
                "{}",
                serde_json::json!({"ok":false,"error":error.to_string()})
            );
            std::process::exit(1);
        }
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn toast_content_is_xml_escaped() {
        assert_eq!(super::escape("<x>&\"\u{0}"), "&lt;x&gt;&amp;&quot;");
    }
    #[test]
    fn notification_links_include_the_originating_data_namespace_without_a_path_or_token() {
        let home = std::env::temp_dir().join("custom data");
        let target = super::notification_target("t_123", "", &home);
        assert!(target.starts_with("todocue://task/t_123?home="));
        assert!(target.ends_with(&super::windows_home::home_id(&home)));
        assert!(!target.contains("custom"));
    }
}
