import TodoCueKit
import AppKit

/// A generous edge hit target without taking keyboard focus from a draft.
final class PanelResizeHandle: NSView {
    var onResize: ((CGFloat, Bool) -> Void)?
    private let vertical: Bool
    private var defaultSize: CGFloat { vertical ? Theme.panelHeight : Theme.panelWidth }
    private var currentSize: CGFloat { (vertical ? window?.frame.height : window?.frame.width) ?? defaultSize }
    private var dragStartCoordinate: CGFloat?
    private var startSize: CGFloat = 0
    private var hovered = false

    init(vertical: Bool = false) {
        self.vertical = vertical
        super.init(frame: .zero)
        updateLanguage()
        setAccessibilityElement(true)
        setAccessibilityRole(.slider)
        setAccessibilityMinValue(vertical ? Theme.panelMinHeight : Theme.panelMinWidth)
        setAccessibilityMaxValue(vertical ? Theme.panelMaxHeight : Theme.panelMaxWidth)
    }

    func updateLanguage() {
        toolTip = L10n.tr(vertical ? "拖动调整面板高度，双击恢复默认高度" : "拖动调整面板宽度，双击恢复默认宽度")
        setAccessibilityLabel(L10n.tr(vertical ? "面板高度" : "面板宽度"))
        setAccessibilityHelp(L10n.tr(vertical ? "拖动底边缘调整高度，双击恢复默认高度。" : "拖动左边缘调整宽度，双击恢复默认宽度。"))
    }

    required init?(coder: NSCoder) { nil }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() { addCursorRect(bounds, cursor: vertical ? .resizeUpDown : .resizeLeftRight) }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.secondaryLabelColor.withAlphaComponent(hovered || dragStartCoordinate != nil ? 0.65 : 0.24).setFill()
        let grip = vertical
            ? NSRect(x: bounds.midX - 22, y: 3, width: 44, height: 3)
            : NSRect(x: 3, y: bounds.midY - 22, width: 3, height: 44)
        NSBezierPath(roundedRect: grip, xRadius: 1.5, yRadius: 1.5).fill()
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { onResize?(defaultSize, true); return }
        guard let window else { return }
        let point = window.convertPoint(toScreen: event.locationInWindow)
        dragStartCoordinate = vertical ? point.y : point.x
        startSize = currentSize
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let dragStartCoordinate else { return }
        let point = window.convertPoint(toScreen: event.locationInWindow)
        let x = vertical ? point.y : point.x
        onResize?(startSize + dragStartCoordinate - x, false)
    }

    override func mouseUp(with event: NSEvent) {
        guard dragStartCoordinate != nil else { return }
        dragStartCoordinate = nil
        if window != nil { onResize?(currentSize, true) }
        needsDisplay = true
    }

    override func accessibilityValue() -> Any? { currentSize }
    override func setAccessibilityValue(_ value: Any?) {
        if let number = value as? NSNumber { onResize?(CGFloat(number.doubleValue), true) }
    }
    override func accessibilityPerformIncrement() -> Bool { onResize?((currentSize) + 20, true); return true }
    override func accessibilityPerformDecrement() -> Bool { onResize?((currentSize) - 20, true); return true }
}
