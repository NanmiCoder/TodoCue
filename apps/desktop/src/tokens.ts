/** Source: the production Theme/DialKit, in logical pixels and seconds. */
export const dial = {
  orange: "#F26A2E",
  graphite: "#1C1D20",
  frost: "#EEF0F2",
  panelWidth: 340,
  panelMinWidth: 300,
  panelMaxWidth: 600,
  panelHeight: 680,
  tileRadius: 28,
  shellInset: 14,
  shellRadius: 42,
  gap: 10,
  notchWidth: 185,
  notchHeight: 24,
  notchExpandedWidth: 560,
  notchMaxHeight: 560,
  hoverDelay: 200,
  leaveDelay: 350,
  featureDuration: 6000,
  screenDwell: 1500,
} as const;

/** Convert Swift spring response/damping to a mass-one physical spring. */
export function spring(response: number, damping: number) {
  const frequency = (2 * Math.PI) / response;
  return {
    type: "spring" as const,
    mass: 1,
    stiffness: frequency ** 2,
    damping: 2 * damping * frequency,
  };
}
export const motionTokens = {
  snap: spring(0.26, 0.82),
  settle: spring(0.42, 0.84),
  pop: spring(0.34, 0.58),
  list: spring(0.36, 1),
  expand: spring(0.32, 0.86),
};
