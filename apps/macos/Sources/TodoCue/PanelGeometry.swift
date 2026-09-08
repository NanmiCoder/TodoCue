import Foundation

/// Size preferences are independent of temporary constraints on a smaller display.
enum PanelGeometry {
    static func width(_ requested: CGFloat, available: CGFloat = Theme.panelMaxWidth) -> CGFloat {
        let value = requested.isFinite ? requested : Theme.panelWidth
        return min(max(0, available), min(Theme.panelMaxWidth, max(Theme.panelMinWidth, value)))
    }

    static func height(_ requested: CGFloat, available: CGFloat = Theme.panelMaxHeight) -> CGFloat {
        let value = requested.isFinite ? requested : Theme.panelHeight
        return min(max(0, available), min(Theme.panelMaxHeight, max(Theme.panelMinHeight, value)))
    }

    /// The bottom grip keeps the top edge and horizontal position in place.
    static func resizedVertically(_ frame: CGRect, to requested: CGFloat, in visibleFrame: CGRect) -> CGRect {
        let current = fitted(frame, in: visibleFrame)
        let available = current.maxY - visibleFrame.minY - Theme.panelMargin
        let newHeight = height(requested, available: available)
        return CGRect(x: current.minX, y: current.maxY - newHeight, width: current.width, height: newHeight)
    }

    static func fitted(_ frame: CGRect, in visibleFrame: CGRect) -> CGRect {
        let area = visibleFrame.insetBy(dx: Theme.panelMargin, dy: Theme.panelMargin)
        let size = CGSize(width: width(frame.width, available: area.width), height: height(frame.height, available: area.height))
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
