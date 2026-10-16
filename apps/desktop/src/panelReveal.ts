import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.js";

/**
 * The host tells the panel when it appears and when it starts to leave. The tiles' own arrival is
 * the Motion reveal in Panel; this only drives the page-level fade Windows needs, since a
 * window-level fade is only possible on macOS. The phase lives on `<body data-panel-phase>`.
 */
export function installPanelReveal() {
  if (!native) return;
  const set = (phase: "reveal" | "hiding" | "") => {
    // Removing the attribute first restarts the animation when a reveal follows a reveal.
    delete document.body.dataset.panelPhase;
    void document.body.offsetWidth;
    if (phase) document.body.dataset.panelPhase = phase;
  };
  void listen<{ replay: boolean }>("panel:revealed", (event) => set(event.payload.replay ? "reveal" : ""));
  void listen("panel:hiding", () => set("hiding"));
}
