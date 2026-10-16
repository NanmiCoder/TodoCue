//! What the menu-bar / tray entry says. The menu is rebuilt from `TrayState`, which the notch
//! WebView pushes whenever the board, connection or language changes. Everything here is pure so
//! it can be tested on any platform; `lib.rs` turns the entries into native menu items.

use serde::Deserialize;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayState {
    pub language: String,
    pub remaining: u32,
    pub online: bool,
    pub next_title: Option<String>,
    pub next_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    Item {
        id: &'static str,
        label: String,
        enabled: bool,
        /// `Some` makes it a check item (open at login).
        checked: Option<bool>,
    },
    Separator,
}

fn pick(language: &str, zh: &str, en: &str) -> String {
    if language == "en" { en } else { zh }.to_string()
}

/// Titles longer than this are cut so one long task never widens the menu.
const TITLE_LIMIT: usize = 36;

pub fn shorten(title: &str) -> String {
    let flat: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= TITLE_LIMIT {
        return flat;
    }
    let mut cut: String = flat.chars().take(TITLE_LIMIT - 1).collect();
    cut.push('…');
    cut
}

/// Menu text treats `&` as a mnemonic marker (macOS drops it, Windows underlines the next letter);
/// `&&` shows a literal one. Anything a person wrote goes through here before it becomes a label.
pub fn escape_menu_text(text: &str) -> String {
    text.replace('&', "&&")
}

fn item(id: &'static str, label: String, enabled: bool) -> Entry {
    Entry::Item { id, label, enabled, checked: None }
}

/// The menu before the first push (the WebView is still loading): open and quit only.
pub fn startup_entries(language: &str) -> Vec<Entry> {
    vec![
        item("open", pick(language, "打开面板", "Open panel"), true),
        Entry::Separator,
        item("quit", pick(language, "退出 TodoCue", "Quit TodoCue"), true),
    ]
}

pub fn entries(state: &TrayState, login_enabled: bool) -> Vec<Entry> {
    let l = state.language.as_str();
    let mut list = vec![
        item("open", pick(l, "打开面板", "Open panel"), true),
        item(
            "remaining",
            if l == "en" {
                format!("{} left today", state.remaining)
            } else {
                format!("今日剩余 {} 项", state.remaining)
            },
            false,
        ),
    ];
    if let (Some(title), Some(_)) = (&state.next_title, &state.next_id) {
        let title = escape_menu_text(&shorten(title));
        list.push(item(
            "next",
            if l == "en" { format!("Next: {title}") } else { format!("下一项：{title}") },
            true,
        ));
    }
    if !state.online {
        list.push(item("offline", pick(l, "后台服务未连接", "Runtime offline"), false));
    }
    list.push(Entry::Separator);
    list.push(item("new_task", pick(l, "新建任务", "New task"), state.online));
    list.push(item(
        "new_periodic",
        pick(l, "新建周期提醒", "New periodic reminder"),
        state.online,
    ));
    list.push(item("periodic", pick(l, "周期提醒…", "Periodic reminders…"), true));
    list.push(item("reconnect", pick(l, "重新连接", "Reconnect"), true));
    list.push(item("settings", pick(l, "设置…", "Settings…"), true));
    list.push(Entry::Item {
        id: "login",
        label: pick(l, "登录时启动", "Open at login"),
        enabled: true,
        checked: Some(login_enabled),
    });
    list.push(Entry::Separator);
    list.push(item("quit", pick(l, "退出 TodoCue", "Quit TodoCue"), true));
    list
}

pub fn tooltip(state: &TrayState) -> String {
    let l = state.language.as_str();
    if !state.online {
        return format!("TodoCue · {}", pick(l, "后台服务未连接", "Runtime offline"));
    }
    if l == "en" {
        format!("{} left today", state.remaining)
    } else {
        format!("今日剩余 {} 项", state.remaining)
    }
}

/// Text next to the macOS menu-bar icon; empty when nothing is left. Windows has no such text.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn title(state: &TrayState) -> String {
    if state.online && state.remaining > 0 {
        format!(" {}", state.remaining)
    } else {
        String::new()
    }
}

/// A double-click on the Windows tray icon delivers two left-button releases. Only the first one
/// toggles the panel; otherwise it would open and close again straight away.
pub const DOUBLE_CLICK: Duration = Duration::from_millis(500);

#[cfg_attr(target_os = "macos", allow(dead_code))]
#[derive(Debug, Default)]
pub struct ClickGate {
    last: Option<Instant>,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
impl ClickGate {
    /// A left-button release on the tray icon at `now`: true when it should toggle the panel.
    pub fn release(&mut self, now: Instant) -> bool {
        if self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) < DOUBLE_CLICK)
        {
            return false;
        }
        self.last = Some(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> TrayState {
        TrayState {
            language: "zh-CN".into(),
            remaining: 3,
            online: true,
            next_title: Some("写周报".into()),
            next_id: Some("t_1".into()),
        }
    }
    fn ids(list: &[Entry]) -> Vec<&'static str> {
        list.iter()
            .map(|entry| match entry {
                Entry::Item { id, .. } => *id,
                Entry::Separator => "-",
            })
            .collect()
    }
    fn label<'a>(list: &'a [Entry], wanted: &str) -> &'a str {
        list.iter()
            .find_map(|entry| match entry {
                Entry::Item { id, label, .. } if *id == wanted => Some(label.as_str()),
                _ => None,
            })
            .unwrap()
    }

    #[test]
    fn online_menu_matches_the_original_status_item() {
        let list = entries(&state(), true);
        assert_eq!(
            ids(&list),
            [
                "open", "remaining", "next", "-", "new_task", "new_periodic", "periodic",
                "reconnect", "settings", "login", "-", "quit"
            ]
        );
        assert_eq!(label(&list, "remaining"), "今日剩余 3 项");
        assert_eq!(label(&list, "next"), "下一项：写周报");
        assert!(matches!(
            list.iter().find(|e| matches!(e, Entry::Item { id: "login", .. })),
            Some(Entry::Item { checked: Some(true), .. })
        ));
    }

    #[test]
    fn offline_disables_writes_and_says_why() {
        let mut offline = state();
        offline.online = false;
        let list = entries(&offline, false);
        assert!(ids(&list).contains(&"offline"));
        for wanted in ["new_task", "new_periodic"] {
            assert!(list.iter().any(|e| matches!(e, Entry::Item { id, enabled: false, .. } if *id == wanted)));
        }
        assert_eq!(tooltip(&offline), "TodoCue · 后台服务未连接");
        assert_eq!(title(&offline), "");
    }

    #[test]
    fn english_and_missing_next_task() {
        let mut english = state();
        english.language = "en".into();
        english.next_title = None;
        let list = entries(&english, false);
        assert!(!ids(&list).contains(&"next"));
        assert_eq!(label(&list, "remaining"), "3 left today");
        assert_eq!(label(&list, "quit"), "Quit TodoCue");
        assert_eq!(tooltip(&english), "3 left today");
    }

    #[test]
    fn title_shows_only_a_positive_count() {
        let mut s = state();
        assert_eq!(title(&s), " 3");
        s.remaining = 0;
        assert_eq!(title(&s), "");
    }

    #[test]
    fn long_and_multiline_titles_are_cut_without_splitting_characters() {
        let long = "很长的任务标题".repeat(10);
        let cut = shorten(&long);
        assert_eq!(cut.chars().count(), TITLE_LIMIT);
        assert!(cut.ends_with('…'));
        assert_eq!(shorten("a\n  b"), "a b");
    }

    /// What muda does with menu text: `&x` is a mnemonic (dropped on macOS, underlined on Windows)
    /// and `&&` is a literal ampersand.
    fn displayed(text: &str) -> String {
        let mut out = String::new();
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '&' {
                if chars.peek() == Some(&'&') {
                    chars.next();
                    out.push('&');
                }
            } else {
                out.push(c);
            }
        }
        out
    }

    #[test]
    fn ampersands_in_task_titles_survive_the_menu() {
        for (title, shown) in [
            ("Q&A 复盘", "Q&A 复盘"),
            ("a&&b", "a&&b"),
            ("&开头与结尾&", "&开头与结尾&"),
            ("R&D & Q&A", "R&D & Q&A"),
        ] {
            let mut s = state();
            s.next_title = Some(title.into());
            let list = entries(&s, false);
            assert_eq!(displayed(label(&list, "next")), format!("下一项：{shown}"), "{title}");
        }
        // The cut happens on what the person sees, and never leaves a lone `&` behind.
        let mut s = state();
        s.language = "en".into();
        s.next_title = Some(format!("{}&{}", "x".repeat(TITLE_LIMIT - 2), "tail"));
        let list = entries(&s, false);
        let shown = displayed(label(&list, "next"));
        assert_eq!(shown, format!("Next: {}&…", "x".repeat(TITLE_LIMIT - 2)));
        s.next_title = Some(format!("{}&{}", "x".repeat(TITLE_LIMIT - 1), "tail"));
        let shown = displayed(label(&entries(&s, false), "next"));
        assert_eq!(shown, format!("Next: {}…", "x".repeat(TITLE_LIMIT - 1)));
    }

    #[test]
    fn a_double_click_toggles_once_and_a_later_click_toggles_again() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut gate = ClickGate::default();
        assert!(gate.release(at(0)));
        // The second release of a double-click arrives well inside the system interval.
        assert!(!gate.release(at(120)));
        assert!(!gate.release(at(499)));
        // A separate click after the interval is a new toggle.
        assert!(gate.release(at(500)));
        assert!(!gate.release(at(700)));
        // The interval is measured from the click that was accepted, not from the ignored ones.
        assert!(gate.release(at(1000)));
        // A clock that steps back never wedges the gate shut.
        assert!(!gate.release(at(900)));
        assert!(gate.release(at(1600)));
    }

    #[test]
    fn startup_menu_can_always_open_and_quit() {
        assert_eq!(ids(&startup_entries("en")), ["open", "-", "quit"]);
    }
}
