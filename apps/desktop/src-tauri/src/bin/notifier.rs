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
/// Toast AppUserModelID. Must equal `identifier` in tauri.conf.json and the
/// `AppUserModelId\${BUNDLEID}` key written by windows-hooks.nsh
/// (guarded by scripts/tests/notifier-identity.test.mjs).
#[cfg(any(windows, test))]
const APP_USER_MODEL_ID: &str = "com.todocue.app";
#[cfg(any(windows, test))]
const APP_DISPLAY_NAME: &str = "TodoCue";
/// A reminder that nobody reacted to should not linger forever in the action centre.
#[cfg(windows)]
const TOAST_TTL_SECS: u64 = 24 * 60 * 60;
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
/// Stable toast tag (<= 64 chars) derived from the notification id, so re-delivery replaces.
#[cfg(any(windows, test))]
fn toast_tag(id: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut hash);
    format!("{:016x}", hash.finish())
}
/// Title, then subtitle (e.g. "提醒 · 09:30"), then body. Empty lines are skipped.
#[cfg(any(windows, test))]
fn toast_lines<'a>(title: &'a str, subtitle: &'a str, body: &'a str) -> Vec<&'a str> {
    let mut lines = Vec::with_capacity(3);
    lines.push(if title.trim().is_empty() { APP_DISPLAY_NAME } else { title });
    for line in [subtitle, body] {
        if !line.trim().is_empty() {
            lines.push(line);
        }
    }
    lines
}
/// Button captions for the reminder-style toast, chosen from the Windows UI language id.
#[cfg(any(windows, test))]
fn action_labels(ui_language: u16) -> (&'static str, &'static str) {
    // Primary language 0x04 = Chinese (all scripts / regions).
    if ui_language & 0x3ff == 0x04 {
        ("打开", "关闭")
    } else {
        ("Open", "Dismiss")
    }
}
#[cfg(any(windows, test))]
struct ToastContent<'a> {
    title: &'a str,
    subtitle: &'a str,
    body: &'a str,
    target: &'a str,
    sound: bool,
    open_label: &'a str,
    dismiss_label: &'a str,
}
/// `reminder = true` builds the persistent reminder style (scenario + Open/Dismiss buttons).
/// `reminder = false` is the plain toast used as a fallback when the richer XML is rejected.
#[cfg(any(windows, test))]
fn toast_xml(content: &ToastContent, reminder: bool) -> String {
    let target = escape(content.target);
    let texts: String = toast_lines(content.title, content.subtitle, content.body)
        .into_iter()
        .map(|line| format!("<text>{}</text>", escape(line)))
        .collect();
    let scenario = if reminder { " scenario=\"reminder\"" } else { "" };
    let actions = if reminder {
        format!(
            "<actions><action content=\"{}\" activationType=\"protocol\" arguments=\"{target}\"/><action content=\"{}\" activationType=\"system\" arguments=\"dismiss\"/></actions>",
            escape(content.open_label),
            escape(content.dismiss_label)
        )
    } else {
        String::new()
    };
    let audio = if content.sound { "" } else { "<audio silent=\"true\"/>" };
    format!("<toast{scenario} activationType=\"protocol\" launch=\"{target}\"><visual><binding template=\"ToastGeneric\">{texts}</binding></visual>{actions}{audio}</toast>")
}
/// WinRT DateTime ticks (100 ns since 1601-01-01 UTC) for `now + ttl`.
#[cfg(any(windows, test))]
fn expiration_ticks(now: std::time::SystemTime, ttl_secs: u64) -> i64 {
    const UNIX_TO_WINDOWS_SECS: u64 = 11_644_473_600;
    let unix = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    ((unix + UNIX_TO_WINDOWS_SECS + ttl_secs) * 10_000_000) as i64
}
#[cfg(windows)]
mod win {
    use super::*;
    use windows::{
        core::{Interface, HSTRING},
        Data::Xml::Dom::XmlDocument,
        Foundation::{DateTime, IReference, PropertyValue},
        UI::Notifications::{ToastNotification, ToastNotificationManager, ToastNotifier},
    };

    /// Makes sure `HKCU\Software\Classes\AppUserModelId\<AUMID>` exists. The NSIS hook normally
    /// writes it, but upgrade mode, `/NS` installs and dev runs skip that. No IconUri is written:
    /// the installer ships no image file, and an .exe path is not a valid toast icon.
    /// Returns whether the registration is present afterwards.
    pub fn ensure_registered() -> bool {
        let path = format!(r"Software\Classes\AppUserModelId\{APP_USER_MODEL_ID}");
        let present = windows_registry::CURRENT_USER
            .open(&path)
            .ok()
            .is_some_and(|key| key.get_string("DisplayName").is_ok());
        present
            || windows_registry::CURRENT_USER
                .create(&path)
                .and_then(|key| key.set_string("DisplayName", APP_DISPLAY_NAME))
                .is_ok()
    }
    pub fn notifier() -> windows::core::Result<ToastNotifier> {
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_USER_MODEL_ID))
    }
    pub fn ui_language() -> u16 {
        unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() }
    }
    #[derive(Debug, PartialEq)]
    pub enum Shown {
        Confirmed,
        /// The history API could not answer; Show() succeeded, so do not claim failure.
        Unverified,
        /// History was readable and does not contain the toast.
        Missing,
    }
    fn prepare(xml: &str, tag: &str) -> windows::core::Result<ToastNotification> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        toast.SetTag(&HSTRING::from(tag))?;
        // Best effort: an expiration failure must not stop the toast from being shown.
        let _ = (|| -> windows::core::Result<()> {
            let when = DateTime {
                UniversalTime: expiration_ticks(std::time::SystemTime::now(), TOAST_TTL_SECS),
            };
            let value = PropertyValue::CreateDateTime(when)?.cast::<IReference<DateTime>>()?;
            toast.SetExpirationTime(&value)
        })();
        Ok(toast)
    }
    fn history_has(tag: &str) -> windows::core::Result<bool> {
        let history = ToastNotificationManager::History()?;
        let items = history.GetHistoryWithId(&HSTRING::from(APP_USER_MODEL_ID))?;
        for index in 0..items.Size()? {
            if items.GetAt(index)?.Tag()?.to_string_lossy() == tag {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// Show() only means the platform accepted the call (it also returns S_OK for toasts that are
    /// silently dropped), so look for the tag in the action-centre history. Toasts are written to
    /// history asynchronously, hence a short poll. Only a successful read that lacks the tag is
    /// reported as Missing; any API error stays Unverified.
    fn confirm(tag: &str) -> Shown {
        for attempt in 0..8 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            match history_has(tag) {
                Ok(true) => return Shown::Confirmed,
                Ok(false) => {}
                Err(_) => return Shown::Unverified,
            }
        }
        Shown::Missing
    }
    /// Shows one toast; Err when XML/Show fails or the toast is demonstrably not in history.
    pub fn show(notifier: &ToastNotifier, xml: &str, tag: &str) -> Result<Shown, String> {
        let toast = prepare(xml, tag).map_err(|e| format!("toast XML rejected: {e}"))?;
        notifier.Show(&toast).map_err(|e| format!("Show failed: {e}"))?;
        match confirm(tag) {
            Shown::Missing => Err("toast was accepted but never appeared in the notification history (notifications may be suppressed for TodoCue)".into()),
            shown => Ok(shown),
        }
    }
}
#[cfg(windows)]
fn run() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    use std::{os::windows::process::CommandExt, process::Command};
    use windows::UI::Notifications::NotificationSetting;
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
    let command = args.first().map(String::as_str);
    if matches!(command, Some("status" | "request" | "deliver")) {
        // Self-heal before creating the notifier. Failure is reported, not fatal.
        let registered = win::ensure_registered();
        let notifier = win::notifier()?;
        let enabled = notifier.Setting()? == NotificationSetting::Enabled;
        if command != Some("deliver") {
            return Ok(
                serde_json::json!({"ok":true,"authorization":if enabled {"authorized"} else {"denied"},"needsSystemSettings":!enabled,"alertStyle":"Windows app notifications","registered":registered,"visible":enabled && registered}),
            );
        }
        if !enabled {
            return Err("Windows notifications are disabled; enable TodoCue in Settings > Notifications".into());
        }
        let home = if !value("--home").is_empty() {
            std::path::PathBuf::from(value("--home"))
        } else {
            std::path::PathBuf::from(
                std::env::var_os("TODOCUE_HOME").ok_or("Notification data directory is missing")?,
            )
        };
        let target = notification_target(value("--task-id"), value("--periodic-id"), &home);
        let (open_label, dismiss_label) = action_labels(win::ui_language());
        let content = ToastContent {
            title: value("--title"),
            subtitle: value("--subtitle"),
            body: value("--body"),
            target: &target,
            sound: args.iter().any(|arg| arg == "--sound"),
            open_label,
            dismiss_label,
        };
        let tag = toast_tag(value("--id"));
        // Reminder style first; if the platform rejects it, fall back to the plain toast.
        let mut failures = Vec::new();
        for (reminder, style) in [(true, "reminder"), (false, "basic")] {
            match win::show(&notifier, &toast_xml(&content, reminder), &tag) {
                Ok(shown) => {
                    return Ok(serde_json::json!({
                        "ok":true,"channel":"windows-toast","style":style,
                        "history":if shown == win::Shown::Confirmed {"confirmed"} else {"unverified"},
                        "registered":registered
                    }))
                }
                Err(error) => failures.push(format!("{style}: {error}")),
            }
        }
        return Err(failures.join("; ").into());
    }
    match command {
        Some("open-settings") => {
            let status = Command::new("explorer.exe")
                .arg("ms-settings:notifications")
                .creation_flags(0x08000000)
                .status()?;
            Ok(serde_json::json!({"ok":status.success(),"url":"ms-settings:notifications"}))
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
    fn content<'a>(sound: bool) -> super::ToastContent<'a> {
        super::ToastContent {
            title: "写 <周报> & \"复盘\"",
            subtitle: "提醒 · 09:30",
            body: "第三行",
            target: "todocue://task/t_1?home=abc&x='y'",
            sound,
            open_label: "打开",
            dismiss_label: "关闭",
        }
    }
    #[test]
    fn aumid_matches_the_default_identifier_literal() {
        assert_eq!(super::APP_USER_MODEL_ID, "com.todocue.app");
    }
    #[test]
    fn reminder_toast_has_scenario_two_buttons_and_merged_lines() {
        let xml = super::toast_xml(&content(true), true);
        assert!(xml.starts_with("<toast scenario=\"reminder\" activationType=\"protocol\" launch=\"todocue://task/t_1?home=abc&amp;x=&apos;y&apos;\">"));
        let texts: Vec<_> = xml.match_indices("<text>").collect();
        assert_eq!(texts.len(), 3);
        assert!(xml.contains("<text>写 &lt;周报&gt; &amp; &quot;复盘&quot;</text><text>提醒 · 09:30</text><text>第三行</text>"));
        assert!(xml.contains("<action content=\"打开\" activationType=\"protocol\" arguments=\"todocue://task/t_1?home=abc&amp;x=&apos;y&apos;\"/>"));
        assert!(xml.contains("<action content=\"关闭\" activationType=\"system\" arguments=\"dismiss\"/>"));
        assert!(!xml.contains("<audio"));
        assert!(xml.ends_with("</actions></toast>"));
    }
    #[test]
    fn silent_toast_keeps_audio_silent_after_actions() {
        let xml = super::toast_xml(&content(false), true);
        assert!(xml.ends_with("</actions><audio silent=\"true\"/></toast>"));
    }
    #[test]
    fn fallback_toast_is_plain_but_keeps_all_text_and_the_launch_target() {
        let xml = super::toast_xml(&content(false), false);
        assert!(!xml.contains("scenario"));
        assert!(!xml.contains("<actions>"));
        assert!(xml.contains("launch=\"todocue://task/t_1?home=abc&amp;x=&apos;y&apos;\""));
        assert!(xml.contains("<text>提醒 · 09:30</text><text>第三行</text>"));
        assert!(xml.ends_with("<audio silent=\"true\"/></toast>"));
    }
    #[test]
    fn empty_subtitle_and_body_are_skipped_and_empty_title_gets_a_default() {
        assert_eq!(super::toast_lines("a", "", "  "), vec!["a"]);
        assert_eq!(super::toast_lines("", "", "b"), vec!["TodoCue", "b"]);
    }
    #[test]
    fn labels_follow_the_windows_ui_language() {
        assert_eq!(super::action_labels(0x0804), ("打开", "关闭")); // zh-CN
        assert_eq!(super::action_labels(0x0404), ("打开", "关闭")); // zh-TW
        assert_eq!(super::action_labels(0x0409), ("Open", "Dismiss")); // en-US
    }
    #[test]
    fn expiration_is_ttl_after_now_in_windows_ticks() {
        let epoch = std::time::UNIX_EPOCH;
        assert_eq!(super::expiration_ticks(epoch, 0), 116_444_736_000_000_000);
        assert_eq!(super::expiration_ticks(epoch, 86_400), 116_444_736_000_000_000 + 864_000_000_000);
    }
    #[test]
    fn toast_tag_is_stable_and_short() {
        assert_eq!(super::toast_tag("n1"), super::toast_tag("n1"));
        assert_ne!(super::toast_tag("n1"), super::toast_tag("n2"));
        assert_eq!(super::toast_tag("n1").len(), 16);
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
