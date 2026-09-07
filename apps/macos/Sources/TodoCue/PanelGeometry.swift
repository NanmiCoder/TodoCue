import Foundation

/// Width preferences are independent of temporary constraints on a smaller display.
enum PanelGeometry {
    static func width(_ requested: CGFloat, available: CGFloat = Theme.panelMaxWidth) -> CGFloat {
        let value = requested.isFinite ? requested : Theme.panelWidth
        return min(max(0, available), min(Theme.panelMaxWidth, max(Theme.panelMinWidth, value)))
    }

    static func fitted(_ frame: CGRect, in visibleFrame: CGRect) -> CGRect {
        let area = visibleFrame.insetBy(dx: Theme.panelMargin, dy: Theme.panelMargin)
        let size = CGSize(width: width(frame.width, available: area.width), height: min(frame.height, area.height))
        return CGRect(x: min(max(frame.minX, area.minX), area.maxX - size.width),
                      y: min(max(frame.minY, area.minY), area.maxY - size.height),
                      width: size.width, height: size.height)
    }

    /// The left grip changes width while keeping the right edge and top in place.
    static func resized(_ frame: CGRect, to requested: CGFloat, in visibleFrame: CGRect) -> CGRect {
        let current = fitted(frame, in: visibleFrame)
        let available = current.maxX - visibleFrame.minX - Theme.panelMargin
        let newWidth = width(requested, available: available)
        return CGRect(x: current.maxX - newWidth, y: current.minY, width: newWidth, height: current.height)
    }
}
