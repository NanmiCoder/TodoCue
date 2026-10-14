import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { native } from "./bridge.js";
import { Panel } from "./Panel.js";
import { Notch } from "./Notch.js";
import "./style.css";

const notch = new URLSearchParams(location.search).get("surface") === "notch";
document.body.dataset.native = String(native);
document.body.dataset.surface = notch ? "notch" : "panel";
createRoot(document.getElementById("root")!).render(
  <MotionConfig reducedMotion="user">
    {notch ? <Notch /> : <Panel />}
  </MotionConfig>,
);
