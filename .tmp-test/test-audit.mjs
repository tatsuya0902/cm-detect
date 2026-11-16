// src/audit.ts
var AUDIT_DEFAULTS = Object.freeze({
  /** 高スコアとみなす下限 (監査用。ロゴ ON の閾値とは別) */
  highScore: 0.75,
  /** 立ち上がり前の低スコアの上限 */
  lowScore: 0.25,
  /** 立ち上がり前に低スコアが続く秒数 */
  lowSeconds: 3,
  /** 高スコアの持続を見る秒数 */
  flatSeconds: 20,
  /** 平坦とみなすスコアの幅 (最大 - 最小) */
  flatRange: 0.04,
  /** 要確認区間を立ち上がりの前後に広げる秒数 */
  reviewBefore: 5,
  reviewAfter: 60,
  /** 点灯開始と他材料が「重なった」とみなす距離 (秒) */
  supportDistance: 1,
  /** 数える無音の最短 (秒) */
  silenceMin: 0.2,
  /** 無音不足とみなす 1 時間あたりの件数 */
  sparsePerHour: 30,
  /** 被覆率の要確認範囲 (この外側は異常候補の表示だけ。自動破棄には使わない) */
  coverageLow: 0.1,
  coverageHigh: 0.98
});
function validateMaterial(m) {
  const errors = [];
  if (!Number.isFinite(m.duration) || m.duration <= 0) return ["duration-invalid"];
  if (m.scores.length !== Math.ceil(m.duration)) errors.push("score-length-mismatch");
  if (Array.from(m.scores).some((x) => !Number.isFinite(x) || x < -1 || x > 2)) {
    errors.push("score-missing-or-out-of-range");
  }
  for (const [name, spans] of [
    ["logo", m.logoOn],
    ["silence", m.silences]
  ]) {
    if (Array.from(spans).some(
      (r) => !r || !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end > m.duration || r.end <= r.start
    )) {
      errors.push(`${name}-range-invalid`);
    }
  }
  if (Array.from(m.scenes).some((t) => !Number.isFinite(t) || t < 0 || t > m.duration)) {
    errors.push("scene-time-invalid");
  }
  return errors;
}
function mergeRanges(spans) {
  const sorted = spans.map((r) => ({ ...r })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}
function auditLogoEvidence(m) {
  const errors = validateMaterial(m);
  if (errors.length > 0) {
    return {
      valid: false,
      coverage: null,
      silenceCount: 0,
      silencesPerHour: null,
      onsetSupportRate: null,
      suspiciousOnsets: [],
      reviewWindows: [],
      reasons: errors
    };
  }
  const on = mergeRanges(m.logoOn);
  const quiet = mergeRanges(m.silences).filter((r) => r.end - r.start >= AUDIT_DEFAULTS.silenceMin);
  const coverage = on.reduce((s, r) => s + r.end - r.start, 0) / m.duration;
  const silencesPerHour = quiet.length * 3600 / m.duration;
  const reasons = [];
  if (silencesPerHour < AUDIT_DEFAULTS.sparsePerHour) reasons.push("sparse-silence");
  if (coverage < AUDIT_DEFAULTS.coverageLow || coverage > AUDIT_DEFAULTS.coverageHigh) {
    reasons.push("coverage-needs-review");
  }
  const starts = on.map((r) => r.start).filter((t) => t > 0);
  const d = AUDIT_DEFAULTS.supportDistance;
  const supported = starts.filter(
    (t) => m.scenes.some((c) => Math.abs(c - t) <= d) || quiet.some((r) => r.start - d <= t && t <= r.end + d)
  ).length;
  const onsetSupportRate = starts.length > 0 ? supported / starts.length : null;
  const suspiciousOnsets = [];
  for (let i = AUDIT_DEFAULTS.lowSeconds; i + AUDIT_DEFAULTS.flatSeconds <= Math.floor(m.duration); i++) {
    let lowBefore = true;
    for (let j = i - AUDIT_DEFAULTS.lowSeconds; j < i; j++) {
      if (m.scores[j] > AUDIT_DEFAULTS.lowScore) lowBefore = false;
    }
    if (!lowBefore) continue;
    let lo = 1;
    let hi = 0;
    for (let j = i; j < i + AUDIT_DEFAULTS.flatSeconds; j++) {
      lo = Math.min(lo, m.scores[j]);
      hi = Math.max(hi, m.scores[j]);
    }
    if (lo >= AUDIT_DEFAULTS.highScore && hi - lo <= AUDIT_DEFAULTS.flatRange + 1e-12) {
      suspiciousOnsets.push(i);
    }
  }
  if (suspiciousOnsets.length > 0) reasons.push("high-flat-onset-not-proof-of-error");
  const reviewWindows = mergeRanges(
    suspiciousOnsets.map((t) => ({
      start: Math.max(0, t - AUDIT_DEFAULTS.reviewBefore),
      end: Math.min(m.duration, t + AUDIT_DEFAULTS.reviewAfter)
    }))
  );
  return {
    valid: true,
    coverage,
    silenceCount: quiet.length,
    silencesPerHour,
    onsetSupportRate,
    suspiciousOnsets,
    reviewWindows,
    reasons
  };
}
function perSecondScores(times, scores, duration) {
  const size = Math.ceil(duration);
  const sums = new Float64Array(size);
  const counts = new Uint32Array(size);
  for (let i = 0; i < times.length; i++) {
    const s = Math.floor(times[i]);
    if (s < 0 || s >= size) continue;
    sums[s] += scores[i] ?? 0;
    counts[s]++;
  }
  let last = -1;
  for (let s = 0; s < size; s++) if (counts[s] > 0) last = s;
  if (last < 0) return null;
  const out = new Array(last + 1);
  for (let s = 0; s <= last; s++) {
    if (counts[s] === 0) return null;
    out[s] = sums[s] / counts[s];
  }
  return out;
}

// .tmp-test/test-audit.ts
var failures = 0;
var check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
};
{
  const scores = new Array(3600).fill(0.1);
  for (let i = 227; i < 600; i++) scores[i] = i % 2 === 0 ? 0.84 : 0.86;
  const audit = auditLogoEvidence({
    duration: 3600,
    scores,
    logoOn: [{ start: 227.2, end: 590 }],
    silences: [{ start: 226.83, end: 227.26 }],
    scenes: [227.21]
  });
  check("hagure valid", audit.valid);
  check("hagure onset 227", audit.suspiciousOnsets.includes(227));
  check(
    "hagure window covers 250",
    audit.reviewWindows.some((r) => r.start <= 250 && r.end >= 250)
  );
  check("hagure sparse-silence", audit.reasons.includes("sparse-silence"));
}
{
  const scores = new Array(120).fill(0.5);
  scores[10] = Number.NaN;
  const errors = validateMaterial({ duration: 120, scores, logoOn: [], silences: [], scenes: [] });
  check("nan invalid", errors.includes("score-missing-or-out-of-range"));
}
{
  const scores = new Array(120).fill(-0.02);
  const errors = validateMaterial({ duration: 120, scores, logoOn: [], silences: [], scenes: [] });
  check("negative correlation scores ok", !errors.includes("score-missing-or-out-of-range"));
}
{
  const errors = validateMaterial({
    duration: 3600,
    scores: new Array(100).fill(0.5),
    logoOn: [],
    silences: [],
    scenes: []
  });
  check("length mismatch", errors.includes("score-length-mismatch"));
}
{
  const audit = auditLogoEvidence({
    duration: 1e3,
    scores: new Array(1e3).fill(0.9),
    logoOn: [{ start: 0, end: 490 }],
    silences: Array.from({ length: 40 }, (_, i) => ({ start: i * 25, end: i * 25 + 0.5 })),
    scenes: []
  });
  check("coverage 0.49 no flag", audit.valid && !audit.reasons.includes("coverage-needs-review"));
  check("coverage value", audit.coverage !== null && Math.abs(audit.coverage - 0.49) < 1e-9);
}
{
  const audit = auditLogoEvidence({
    duration: 100,
    scores: new Array(100).fill(0.9),
    logoOn: [
      { start: 0, end: 50 },
      { start: 25, end: 75 }
    ],
    silences: Array.from({ length: 10 }, (_, i) => ({ start: i * 10, end: i * 10 + 0.5 })),
    scenes: []
  });
  check("overlap merged coverage 0.75", audit.coverage !== null && Math.abs(audit.coverage - 0.75) < 1e-9);
}
{
  const ok = perSecondScores([0, 0.5, 1, 1.5, 2, 2.5], [0.2, 0.4, 0.6, 0.8, 1, 1], 3);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  check("perSecond means", ok !== null && near(ok[0], 0.3) && near(ok[1], 0.7) && near(ok[2], 1));
  const gap = perSecondScores([0, 0.5, 2, 2.5], [0.2, 0.4, 1, 1], 3);
  check("perSecond gap null", gap === null);
  const tail = perSecondScores([0, 0.5, 1, 1.5], [0.2, 0.4, 0.6, 0.8], 3);
  check("perSecond trailing trimmed", tail !== null && tail.length === 2);
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
