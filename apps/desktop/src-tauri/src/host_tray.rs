//! What the menu-bar / tray entry says. The menu is rebuilt from `TrayState`, which the notch
//! WebView pushes whenever the board, connection or language changes. Everything here is pure so
//! it can be tested on any platform; `lib.rs` turns the entries into native menu items.

use serde::Deserialize;

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
        let title = shorten(title);
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

    #[test]
    fn startup_menu_can_always_open_and_quit() {
        assert_eq!(ids(&startup_entries("en")), ["open", "-", "quit"]);
    }
}
