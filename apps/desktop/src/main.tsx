import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { native, platform } from "./bridge.js";
import { installPanelReveal } from "./panelReveal.js";
import { Panel } from "./Panel.js";
import { Notch } from "./Notch.js";
import "./style.css";

const notch = new URLSearchParams(location.search).get("surface") === "notch";
document.body.dataset.native = String(native);
document.body.dataset.surface = notch ? "notch" : "panel";
document.body.dataset.platform = platform;
if (!notch) installPanelReveal();
createRoot(document.getElementById("root")!).render(
  // Spatial motion uses our live media hook; Motion's user flag is a mount-time snapshot.
  <MotionConfig reducedMotion="never">
    {notch ? <Notch /> : <Panel />}
  </MotionConfig>,
);
