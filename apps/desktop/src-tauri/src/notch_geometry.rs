#[derive(Clone, Copy)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
}
pub struct Layout {
    pub x: i32,
    pub y: i32,
    pub band_height: f64,
}
pub fn layout(screen: Rect, work: Rect, width: u32, scale: f64, macos: bool) -> Layout {
    let area = if macos { screen } else { work };
    let inset = (work.y - screen.y).max(0) as f64 / scale;
    Layout {
        x: area.x + (area.width as i64 - width as i64) as i32 / 2,
        y: area.y,
        band_height: if macos && inset.is_finite() && inset >= 18.0 {
            inset
        } else {
            24.0
        },
    }
}

/// An axis-aligned rectangle with a top-left origin and a size, in one consistent unit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Whether `window` is a fullscreen window of `screen` (NotchLayout.coversScreen). It must span the
/// screen's width and reach its bottom edge; its top may sit up to `top_inset` below the screen top,
/// because fullscreen windows can start below the camera or menu-bar safe area. Tolerance is 2.
pub fn covers_screen(window: Frame, screen: Frame, top_inset: f64) -> bool {
    let tolerance = 2.0;
    let top_gap = window.y - screen.y;
    (window.x - screen.x).abs() <= tolerance
        && (window.width - screen.width).abs() <= tolerance
        && (window.y + window.height - (screen.y + screen.height)).abs() <= tolerance
        && top_gap >= -tolerance
        && top_gap <= top_inset.max(0.0) + tolerance
}

/// Whether a point lies inside a frame (left/top inclusive, right/bottom exclusive).
pub fn contains(frame: Frame, x: f64, y: f64) -> bool {
    x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(x: f64, y: f64, width: f64, height: f64) -> Frame {
        Frame { x, y, width, height }
    }
    #[test]
    fn fullscreen_windows_cover_their_screen_even_below_the_camera_area() {
        let screen = frame(0.0, 0.0, 1728.0, 1117.0);
        assert!(covers_screen(frame(0.0, 0.0, 1728.0, 1117.0), screen, 0.0));
        assert!(covers_screen(frame(0.0, 32.0, 1728.0, 1085.0), screen, 32.0));
        assert!(covers_screen(frame(1.0, 1.0, 1727.0, 1116.0), screen, 0.0));
        // A top gap beyond the inset, a short window or a narrow window is not fullscreen.
        assert!(!covers_screen(frame(0.0, 40.0, 1728.0, 1077.0), screen, 32.0));
        assert!(!covers_screen(frame(0.0, 0.0, 1728.0, 1000.0), screen, 32.0));
        assert!(!covers_screen(frame(0.0, 0.0, 1200.0, 1117.0), screen, 0.0));
        // Windows reaching above the screen by more than the tolerance do not count either.
        assert!(!covers_screen(frame(0.0, -10.0, 1728.0, 1127.0), screen, 0.0));
    }
    #[test]
    fn fullscreen_uses_the_screens_own_origin() {
        let screen = frame(-1920.0, 0.0, 1920.0, 1080.0);
        assert!(covers_screen(frame(-1920.0, 0.0, 1920.0, 1080.0), screen, 0.0));
        assert!(!covers_screen(frame(0.0, 0.0, 1920.0, 1080.0), screen, 0.0));
    }
    #[test]
    fn pointer_containment_is_half_open() {
        let area = frame(10.0, 20.0, 100.0, 30.0);
        assert!(contains(area, 10.0, 20.0));
        assert!(contains(area, 109.9, 49.9));
        assert!(!contains(area, 110.0, 30.0));
        assert!(!contains(area, 50.0, 50.0));
        assert!(!contains(area, 9.9, 30.0));
    }
    #[test]
    fn mac_virtual_notch_occupies_the_menu_bar_at_the_screen_top() {
        let result = layout(
            Rect {
                x: 0,
                y: 0,
                width: 3024,
            },
            Rect {
                x: 0,
                y: 60,
                width: 3024,
            },
            546,
            2.0,
            true,
        );
        assert_eq!((result.x, result.y, result.band_height), (1239, 0, 30.0));
        let hidden = layout(
            Rect {
                x: -1920,
                y: -1080,
                width: 1920,
            },
            Rect {
                x: -1920,
                y: -1080,
                width: 1920,
            },
            273,
            1.0,
            true,
        );
        assert_eq!((hidden.y, hidden.band_height), (-1080, 24.0));
    }
    #[test]
    fn windows_uses_the_work_area_with_top_and_side_taskbars() {
        let top = layout(
            Rect {
                x: -1920,
                y: 0,
                width: 1920,
            },
            Rect {
                x: -1920,
                y: 48,
                width: 1920,
            },
            273,
            1.0,
            false,
        );
        assert_eq!((top.x, top.y, top.band_height), (-1097, 48, 24.0));
        let side = layout(
            Rect {
                x: 0,
                y: 0,
                width: 1920,
            },
            Rect {
                x: 60,
                y: 0,
                width: 1860,
            },
            546,
            2.0,
            false,
        );
        assert_eq!((side.x, side.y, side.band_height), (717, 0, 24.0));
    }
}
