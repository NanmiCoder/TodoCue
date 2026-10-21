use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    #[default]
    Top,
    Left,
    Right,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Selection {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
    pub has_notch: bool,
    #[serde(skip)]
    pub safe_top: f64,
    #[serde(skip)]
    pub camera_height: f64,
    #[serde(skip)]
    pub camera_width: f64,
    /// Height of the visible menu bar in points; 0 when it auto-hides, the screen has none, or on
    /// Windows, whose top taskbar is not a menu bar.
    #[serde(skip)]
    pub menu_height: f64,
    #[serde(skip)]
    pub monitor: tauri::Monitor,
}

/// A successful read replaces `cache`; a failed one falls back to the last success so a transient
/// failure (a main thread busy with a display reconfiguration) does not abort placing the notch.
/// With nothing cached yet the error stands.
pub fn or_last_known<T: Clone>(
    read: Result<Vec<T>, String>,
    cache: &std::sync::Mutex<Option<Vec<T>>>,
) -> Result<Vec<T>, String> {
    let mut cache = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match read {
        Ok(value) => {
            *cache = Some(value.clone());
            Ok(value)
        }
        Err(error) => cache.clone().ok_or(error),
    }
}

pub fn list(window: &WebviewWindow) -> Result<Vec<Display>, String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let primary = window.primary_monitor().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let native = crate::platform::display_details(window)?;
    Ok(monitors
        .into_iter()
        .enumerate()
        .map(|(index, monitor)| {
            let scale = monitor.scale_factor();
            let name = monitor
                .name()
                .cloned()
                .unwrap_or_else(|| format!("Display {}", index + 1));
            let id = name.clone();
            let safe_top = 0.0;
            let has_notch = false;
            let camera_height = 0.0;
            let camera_width = 0.0;
            // The work area is NSScreen.visibleFrame: it starts below a visible menu bar.
            #[cfg(target_os = "macos")]
            let menu_height = ((monitor.work_area().position.y - monitor.position().y) as f64 / scale).max(0.0);
            #[cfg(not(target_os = "macos"))]
            let menu_height = 0.0;
            #[cfg(target_os = "macos")]
            let (id, name, safe_top, has_notch, camera_height, camera_width) = native
                .iter()
                .find(|item| {
                    (item.x - monitor.position().x as f64 / scale).abs() < 1.0
                        && (item.y - monitor.position().y as f64 / scale).abs() < 1.0
                })
                .map(|item| {
                    (
                        item.id.clone(),
                        item.name.clone(),
                        item.safe_top,
                        item.has_notch,
                        item.camera_height,
                        item.camera_width,
                    )
                })
                .unwrap_or((id, name, safe_top, has_notch, camera_height, camera_width));
            Display {
                id,
                name,
                safe_top,
                has_notch,
                camera_height,
                camera_width,
                menu_height,
                width: (monitor.size().width as f64 / scale).round() as u32,
                height: (monitor.size().height as f64 / scale).round() as u32,
                primary: primary
                    .as_ref()
                    .is_some_and(|p| p.position() == monitor.position()),
                monitor,
            }
        })
        .collect())
}

/// A disconnected preference stays saved; use the primary display until it returns.
pub fn selected_index(
    ids: &[&str],
    selected: Option<&str>,
    current: Option<usize>,
    primary: Option<usize>,
) -> Option<usize> {
    selected
        .and_then(|id| ids.iter().position(|item| *item == id))
        .or_else(|| if selected.is_none() { current } else { None })
        .or(primary)
        .or_else(|| (!ids.is_empty()).then_some(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_pinned_screen_survives_reordering_disconnect_and_reconnect() {
        assert_eq!(
            selected_index(
                &["external", "built-in"],
                Some("external"),
                Some(1),
                Some(1)
            ),
            Some(0)
        );
        assert_eq!(
            selected_index(&["built-in"], Some("external"), None, Some(0)),
            Some(0)
        );
        assert_eq!(
            selected_index(
                &["built-in", "external"],
                Some("external"),
                Some(0),
                Some(0)
            ),
            Some(1)
        );
        assert_eq!(selected_index(&[], Some("external"), None, None), None);
    }
    #[test]
    fn a_failed_display_read_falls_back_to_the_last_complete_one() {
        let cache = std::sync::Mutex::new(None);
        assert_eq!(or_last_known::<u8>(Err("busy".into()), &cache), Err("busy".into()));
        assert_eq!(or_last_known(Ok(vec![1_u8, 2]), &cache), Ok(vec![1, 2]));
        assert_eq!(or_last_known(Err("busy".into()), &cache), Ok(vec![1, 2]));
        assert_eq!(or_last_known(Ok(vec![3_u8]), &cache), Ok(vec![3]));
        assert_eq!(or_last_known(Err("busy".into()), &cache), Ok(vec![3]));
    }
    #[test]
    fn follow_mode_keeps_the_current_screen_and_recovers_if_it_disappears() {
        assert_eq!(selected_index(&["a", "b"], None, Some(1), Some(0)), Some(1));
        assert_eq!(selected_index(&["a"], None, None, Some(0)), Some(0));
    }
}
