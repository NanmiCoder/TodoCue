import { keepsNativeMenu } from "./menuModel.js";

const SELECTABLE = "[data-selectable]";
const EDITABLE = "input, textarea, [contenteditable=''], [contenteditable='true']";

/**
 * Stop the WebView's own context menu (WKWebView's Look Up / Translate, WebView2's Inspect /
 * Reload / Print). Registered on `document` in the bubble phase, so a row's own handler, which
 * runs first at the React root, has already claimed the event and opened the custom menu.
 */
export function installContextMenuGuard(development = import.meta.env.DEV) {
  const handler = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    if (keepsNativeMenu({
      editable: !!target?.closest(EDITABLE),
      // WebKit selects the word under the pointer on a right-click, so a bare selection says
      // nothing; only text inside a region marked `data-selectable` (details) is worth Copy.
      // (Computed `user-select` can't tell: WKWebView has no unprefixed property and reports
      // plain text as "text" too.)
      hasSelection: !!window.getSelection()?.toString() && !!target?.closest(SELECTABLE),
      development,
    })) return;
    event.preventDefault();
  };
  document.addEventListener("contextmenu", handler);
  return () => document.removeEventListener("contextmenu", handler);
}
