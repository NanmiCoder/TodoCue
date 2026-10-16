import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import {
  edgeEnabled,
  nextEnabled,
  placeMenu,
  type MenuItem,
  type MenuPlacement,
  type Point,
} from "./menuModel.js";
import { Icon } from "./icons.js";
import { isCompositionKey } from "./quickAdd.js";
import { motionTokens } from "./tokens.js";
import { useReducedMotion } from "./useReducedMotion.js";

export interface MenuAnchor extends Point {
  /** A keyboard-opened menu focuses its first item; a pointer-opened one leaves focus alone. */
  source: "pointer" | "keyboard";
  /** Where focus returns when the menu is dismissed with Esc. */
  returnFocus?: HTMLElement | null;
}

/**
 * The menu's box in CSS pixels of its own window, or null while closed.
 *
 * The panel and the notch are separate native windows and a menu cannot leave its window. The
 * panel's window is fixed, so the menu only has to stay inside it. The notch window is sized to
 * its content, which does not include a floating menu: a notch host must grow its window to at
 * least `extent.bottom` (and `extent.right`) while this is non-null, then let it shrink back.
 */
export interface ContextMenuExtent {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

interface OpenMenu {
  id: number;
  anchor: MenuAnchor;
  items: MenuItem[];
  label?: string;
}

export interface ContextMenuApi {
  open(anchor: MenuAnchor, items: MenuItem[], label?: string): void;
  close(): void;
  isOpen: boolean;
  extent: ContextMenuExtent | null;
  /** Render this once somewhere in the host's tree; it portals to `document.body`. */
  node: ReactNode;
}

/**
 * One menu at a time per host. Opening a second replaces the first. The menu closes on Esc,
 * Tab, a press outside it, scrolling, resizing and window blur.
 */
export function useContextMenu(): ContextMenuApi {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [extent, setExtent] = useState<ContextMenuExtent | null>(null);
  const counter = useRef(0);
  const extentOwner = useRef(-1);
  const current = useRef<OpenMenu | null>(null);
  current.current = menu;
  const open = useCallback((anchor: MenuAnchor, items: MenuItem[], label?: string) => {
    setMenu({ id: ++counter.current, anchor, items, label });
  }, []);
  const dismiss = useCallback((restoreFocus: boolean) => {
    const focus = restoreFocus ? current.current?.anchor.returnFocus : null;
    setMenu(null);
    if (focus?.isConnected) focus.focus({ preventScroll: true });
  }, []);
  const close = useCallback(() => dismiss(false), [dismiss]);
  // A replaced menu fades out while its successor mounts; only the owner may clear the extent.
  const report = useCallback((id: number, value: ContextMenuExtent | null) => {
    if (value) { extentOwner.current = id; setExtent(value); }
    else if (extentOwner.current === id) { extentOwner.current = -1; setExtent(null); }
  }, []);
  return {
    open,
    close,
    isOpen: menu !== null,
    extent,
    node: (
      <AnimatePresence>
        {menu && (
          <ContextMenuSurface key={menu.id} menu={menu} onDismiss={dismiss} onExtent={report} />
        )}
      </AnimatePresence>
    ),
  };
}

function ContextMenuSurface({ menu, onDismiss, onExtent }: {
  menu: OpenMenu;
  onDismiss: (restoreFocus: boolean) => void;
  onExtent: (id: number, extent: ContextMenuExtent | null) => void;
}) {
  const { items } = menu;
  const element = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const present = useIsPresent();
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const [active, setActive] = useState(() =>
    menu.anchor.source === "keyboard" ? edgeEnabled(items, "first") : -1,
  );
  const activeRef = useRef(active);
  activeRef.current = active;
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const report = useRef(onExtent);
  report.current = onExtent;

  // Measure with layout sizes, which an in-flight scale animation does not distort, and place
  // before the first paint so the menu never shows at the wrong spot.
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const placed = placeMenu(
      menu.anchor,
      { width: node.offsetWidth, height: node.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPlacement(placed);
    const height = placed.maxHeight ?? node.offsetHeight;
    report.current(menu.id, {
      left: placed.left,
      top: placed.top,
      right: placed.left + node.offsetWidth,
      bottom: placed.top + height,
    });
    return () => report.current(menu.id, null);
  }, [menu]);

  useEffect(() => {
    // A hidden (not yet placed) element cannot take focus.
    if (active < 0 || !placement) return;
    element.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[
      items.slice(0, active).filter((item) => item.kind === "item").length
    ]?.focus({ preventScroll: false });
  }, [active, items, placement]);

  // A menu that is fading out must not keep focus, or it would hold it against whatever the
  // chosen item opened (a confirmation, a form) until the fade ends.
  useEffect(() => {
    if (present) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && element.current?.contains(focused)) focused.blur();
  }, [present]);
  useEffect(() => {
    // A menu that is fading out (replaced by another) must not answer keys or presses.
    if (!present) return;
    const select = (index: number) => {
      const item = items[index];
      if (!item || item.kind !== "item" || item.disabled) return;
      dismiss.current(false);
      item.onSelect();
    };
    const key = (event: KeyboardEvent) => {
      if (isCompositionKey(event)) return;
      const swallow = () => { event.preventDefault(); event.stopImmediatePropagation(); };
      const index = activeRef.current;
      if (event.key === "Escape") { swallow(); dismiss.current(true); }
      else if (event.key === "ArrowDown") { swallow(); setActive(nextEnabled(items, index < 0 ? -1 : index, 1)); }
      else if (event.key === "ArrowUp") { swallow(); setActive(nextEnabled(items, index < 0 ? items.length : index, -1)); }
      else if (event.key === "Home") { swallow(); setActive(edgeEnabled(items, "first")); }
      else if (event.key === "End") { swallow(); setActive(edgeEnabled(items, "last")); }
      else if ((event.key === "Enter" || event.key === " ") && index >= 0) { swallow(); select(index); }
      else if (event.key === "Tab" || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        if (event.key !== "Tab") swallow();
        dismiss.current(false);
      }
    };
    // A press anywhere else dismisses and still reaches its target, so one click both closes the
    // menu and operates whatever was clicked. On Windows `contextmenu` follows the button release,
    // so a right-press elsewhere closes this menu here and the new one opens afterwards.
    const press = (event: PointerEvent) => {
      if (!element.current?.contains(event.target as Node)) dismiss.current(false);
    };
    const scroll = (event: Event) => {
      if (!element.current?.contains(event.target as Node)) dismiss.current(false);
    };
    const leave = () => dismiss.current(false);
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", press, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", leave);
    window.addEventListener("blur", leave);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", press, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", leave);
      window.removeEventListener("blur", leave);
    };
  }, [items, present]);

  const origin = placement
    ? `${placement.flippedX ? "right" : "left"} ${placement.flippedY ? "bottom" : "top"}`
    : "left top";
  return createPortal(
    <motion.div
      ref={element}
      role="menu"
      aria-label={menu.label}
      className="context-menu"
      data-context-menu=""
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        maxHeight: placement?.maxHeight,
        transformOrigin: origin,
        visibility: placement ? "visible" : "hidden",
        pointerEvents: present ? "auto" : "none",
      }}
      onContextMenu={(event) => event.preventDefault()}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
      transition={reduced ? { duration: 0.12 } : motionTokens.snap}
    >
      {items.map((item, index) =>
        item.kind === "separator" ? (
          <div key={`separator:${index}`} role="separator" className="context-menu-separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`context-menu-item ${item.danger ? "danger" : ""}`}
            data-active={active === index ? "true" : undefined}
            aria-disabled={item.disabled ? "true" : undefined}
            onPointerMove={() => { if (!item.disabled && activeRef.current !== index) setActive(index); }}
            onClick={() => {
              if (item.disabled) return;
              dismiss.current(false);
              item.onSelect();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={14} /> : <span className="context-menu-icon" />}
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && <kbd className="context-menu-shortcut">{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </motion.div>,
    document.body,
  );
}

/** Keyboard-opened menus can be followed by the platform's own `contextmenu` event. */
let lastKeyboardOpen = 0;
const EDITABLE = "input, textarea, [contenteditable=''], [contenteditable='true']";

/**
 * Event handlers that open a menu from a row: right-click, Ctrl+click on macOS and a touch
 * long-press (all dispatch `contextmenu`), and the ContextMenu key or Shift+F10 from the keyboard.
 * Spread them on the element: `<div {...menuTriggers((anchor) => menu.open(anchor, items))}>`.
 *
 * Fields keep their own system menu. Only the secondary button opens a menu, so the primary
 * button's click and drag (`pointerdown` with `button === 0`) are unaffected.
 */
export function menuTriggers(open: (anchor: MenuAnchor) => void) {
  return {
    onContextMenu(event: ReactMouseEvent<HTMLElement>) {
      if ((event.target as Element).closest(EDITABLE)) return;
      event.preventDefault();
      if (Date.now() - lastKeyboardOpen < 400) return;
      open({
        x: event.clientX,
        y: event.clientY,
        source: "pointer",
        returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      });
    },
    onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      if ((event.target as Element).closest(EDITABLE)) return;
      event.preventDefault();
      lastKeyboardOpen = Date.now();
      const box = event.currentTarget.getBoundingClientRect();
      open({
        x: box.left + 24,
        y: box.bottom - 6,
        source: "keyboard",
        returnFocus: event.target instanceof HTMLElement ? event.target : null,
      });
    },
  };
}
