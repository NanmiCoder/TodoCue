import TodoCueKit
import AppKit

/// A generous left-edge hit target without taking keyboard focus from a draft.
final class PanelResizeHandle: NSView {
    var onResize: ((CGFloat, Bool) -> Void)?
    private var dragStartX: CGFloat?
    private var startWidth: CGFloat = 0
    private var hovered = false

    init() {
        super.init(frame: .zero)
        updateLanguage()
        setAccessibilityElement(true)
        setAccessibilityRole(.slider)

        setAccessibilityMinValue(Theme.panelMinWidth)
        setAccessibilityMaxValue(Theme.panelMaxWidth)
    }

    func updateLanguage() {
        toolTip = L10n.tr("拖动调整面板宽度，双击恢复默认宽度")
        setAccessibilityLabel(L10n.tr("面板宽度"))
        setAccessibilityHelp(L10n.tr("拖动左边缘调整宽度，双击恢复默认宽度。"))
    }

    required init?(coder: NSCoder) { nil }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.secondaryLabelColor.withAlphaComponent(hovered || dragStartX != nil ? 0.65 : 0.24).setFill()
        NSBezierPath(roundedRect: NSRect(x: 3, y: bounds.midY - 22, width: 3, height: 44), xRadius: 1.5, yRadius: 1.5).fill()
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { onResize?(Theme.panelWidth, true); return }
        guard let window else { return }
        dragStartX = window.convertPoint(toScreen: event.locationInWindow).x
        startWidth = window.frame.width
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let dragStartX else { return }
        let x = window.convertPoint(toScreen: event.locationInWindow).x
        onResize?(startWidth + dragStartX - x, false)
    }

    override func mouseUp(with event: NSEvent) {
        guard dragStartX != nil else { return }
        dragStartX = nil
        if let window { onResize?(window.frame.width, true) }
        needsDisplay = true
    }

    override func accessibilityValue() -> Any? { window?.frame.width ?? Theme.panelWidth }
    override func setAccessibilityValue(_ value: Any?) {
        if let number = value as? NSNumber { onResize?(CGFloat(number.doubleValue), true) }
    }
    override func accessibilityPerformIncrement() -> Bool { onResize?((window?.frame.width ?? Theme.panelWidth) + 20, true); return true }
    override func accessibilityPerformDecrement() -> Bool { onResize?((window?.frame.width ?? Theme.panelWidth) - 20, true); return true }
}
