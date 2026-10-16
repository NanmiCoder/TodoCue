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

/// How far below the top of its screen a fullscreen window may start: the camera housing's safe
/// area (0 on a screen without one). It must not come from the work area: with the menu bar hidden
/// in fullscreen the work area reaches the top of the screen while the window still starts below
/// the camera, and a zoomed (not fullscreen) window starts below the menu bar.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn fullscreen_top_inset(safe_area_top: f64) -> f64 {
    if safe_area_top.is_finite() && safe_area_top > 0.0 {
        safe_area_top
    } else {
        0.0
    }
}

/// Unit used to compare positions on one machine. macOS reports every position as points times the
/// scale of *some* screen (the pointer: the main screen's; a window: its own screen's; a monitor:
/// its own), so each is divided by its own scale to get points. Windows reports virtual-desktop
/// pixels throughout and needs no conversion.
fn common_unit(value: (f64, f64), scale: f64, per_screen_scale: bool) -> (f64, f64) {
    if per_screen_scale && scale.is_finite() && scale > 0.0 {
        (value.0 / scale, value.1 / scale)
    } else {
        value
    }
}

/// Whether the pointer is over a window. `cursor_scale` is the scale the pointer position was
/// reported with, `window_scale` the one of the window's own screen.
pub fn pointer_in_window(
    cursor: (f64, f64),
    cursor_scale: f64,
    origin: (f64, f64),
    size: (f64, f64),
    window_scale: f64,
    per_screen_scale: bool,
) -> bool {
    let cursor = common_unit(cursor, cursor_scale, per_screen_scale);
    let origin = common_unit(origin, window_scale, per_screen_scale);
    let size = common_unit(size, window_scale, per_screen_scale);
    contains(Frame { x: origin.0, y: origin.1, width: size.0, height: size.1 }, cursor.0, cursor.1)
}

/// Whether the pointer is on a monitor (`position` and `size` as the monitor reports them).
pub fn pointer_on_monitor(
    cursor: (f64, f64),
    cursor_scale: f64,
    position: (f64, f64),
    size: (f64, f64),
    monitor_scale: f64,
    per_screen_scale: bool,
) -> bool {
    pointer_in_window(cursor, cursor_scale, position, size, monitor_scale, per_screen_scale)
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
    fn a_camera_screen_in_fullscreen_is_covered_although_the_work_area_gap_is_zero() {
        let screen = frame(0.0, 0.0, 1728.0, 1117.0);
        // Fullscreen on a notched screen: the menu bar is hidden, so the work area starts at the
        // very top (gap 0), while the window starts under the 32-point camera area.
        let window = frame(0.0, 32.0, 1728.0, 1085.0);
        let work_area_gap = 0.0;
        assert!(!covers_screen(window, screen, work_area_gap), "the work area cannot decide this");
        assert!(covers_screen(window, screen, fullscreen_top_inset(32.0)));
        // A zoomed window under a visible menu bar is not fullscreen on a screen without a camera.
        let zoomed = frame(0.0, 24.0, 1728.0, 1093.0);
        assert!(!covers_screen(zoomed, screen, fullscreen_top_inset(0.0)));
        assert_eq!(fullscreen_top_inset(f64::NAN), 0.0);
        assert_eq!(fullscreen_top_inset(-4.0), 0.0);
    }

    // Main screen: 1512 x 982 points at 2x. An external 1920 x 1080 screen at 1x to its right.
    // The pointer is reported with the main screen's scale, the notch window with its own screen's.
    #[test]
    fn the_pointer_is_compared_with_a_window_in_the_same_unit_on_mixed_density_screens() {
        // The notch sits on the external screen: x = 1512 + (1920 - 273) / 2, 1x, 273 x 24.
        let origin = (2335.0, 0.0);
        let size = (273.0, 24.0);
        // Pointer over the notch at point (2400, 5) is reported as (4800, 10).
        assert!(pointer_in_window((4800.0, 10.0), 2.0, origin, size, 1.0, true));
        // Pointer at point (1170, 5), on the main screen, is reported as (2340, 10) and used to
        // look like it was over the notch.
        assert!(!pointer_in_window((2340.0, 10.0), 2.0, origin, size, 1.0, true));
        // The same notch on the main screen: origin and size are in 2x pixels.
        assert!(pointer_in_window((1000.0, 20.0), 2.0, (800.0, 0.0), (546.0, 74.0), 2.0, true));
        assert!(!pointer_in_window((1000.0, 90.0), 2.0, (800.0, 0.0), (546.0, 74.0), 2.0, true));
    }

    #[test]
    fn monitors_are_looked_up_by_the_pointer_in_the_same_unit() {
        let main = ((0.0, 0.0), (3024.0, 1964.0), 2.0);
        let external = ((1512.0, 0.0), (1920.0, 1080.0), 1.0);
        let on = |cursor: (f64, f64), monitor: ((f64, f64), (f64, f64), f64)| {
            pointer_on_monitor(cursor, 2.0, monitor.0, monitor.1, monitor.2, true)
        };
        // Point (2000, 500) is on the external screen; it is reported as (4000, 1000).
        assert!(on((4000.0, 1000.0), external));
        assert!(!on((4000.0, 1000.0), main));
        // Point (700, 300) is on the main screen.
        assert!(on((1400.0, 600.0), main));
        assert!(!on((1400.0, 600.0), external));
        // A screen left of the main one has negative coordinates.
        let left = ((-1920.0, 0.0), (1920.0, 1080.0), 1.0);
        assert!(pointer_on_monitor((-1000.0, 1000.0), 2.0, left.0, left.1, left.2, true));
    }

    #[test]
    fn windows_positions_are_already_in_one_unit_and_are_not_scaled() {
        // Per-monitor DPI aware: everything is virtual-desktop pixels. A 150% screen at x = 1920.
        assert!(pointer_in_window((2100.0, 10.0), 1.5, (2000.0, 0.0), (410.0, 36.0), 1.5, false));
        assert!(!pointer_in_window((2500.0, 10.0), 1.5, (2000.0, 0.0), (410.0, 36.0), 1.5, false));
        assert!(pointer_on_monitor((2100.0, 10.0), 1.0, (1920.0, 0.0), (2560.0, 1440.0), 1.5, false));
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
