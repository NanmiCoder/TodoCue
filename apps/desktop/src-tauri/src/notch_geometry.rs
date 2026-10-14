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
#[cfg(test)]
mod tests {
    use super::*;
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
