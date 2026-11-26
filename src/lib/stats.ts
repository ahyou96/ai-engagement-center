/** Two-proportion z-test (two-sided) with Wilson-ish normal CI on the difference. */
export function twoProportionTest(s1: number, n1: number, s2: number, n2: number) {
  if (!n1 || !n2) return { p1: 0, p2: 0, diff: 0, z: 0, pValue: 1, ciLow: 0, ciHigh: 0 };
  const p1 = s1 / n1, p2 = s2 / n2;
  const p = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)) || 1e-9;
  const z = (p2 - p1) / se;
  const pValue = 2 * (1 - normCdf(Math.abs(z)));
  const seDiff = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return { p1, p2, diff: p2 - p1, z, pValue, ciLow: p2 - p1 - 1.96 * seDiff, ciHigh: p2 - p1 + 1.96 * seDiff };
}
export function normCdf(x: number) {
  // Abramowitz-Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
export function wilson(s: number, n: number) {
  if (!n) return [0, 0];
  const z = 1.96, p = s / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [c - h, c + h];
}
