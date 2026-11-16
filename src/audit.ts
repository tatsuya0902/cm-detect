/**
 * ロゴ材料の監査 (高度 AI への相談・第 2 報への回答で提案された設計の実装)。
 *
 * 大事な前提: 秒ごとのロゴスコア・点灯区間・無音・シーンチェンジ・総尺という
 * 今ある材料だけでは、ロゴの誤認を「誤認である」と確定する判定は作れない。
 * 本物と誤認が同じスコア列を作れば、材料だけを見る関数は同じ答えしか返せない。
 * ここでやるのは誤認の断定ではなく、次の 2 つだけ。
 *
 * - 材料の形式が成立しているかの検証 (欠損を 0 に化けさせない)
 * - 人手でフレームを確認すべき「要確認区間」の抽出
 *   (はっきりした立ち上がりのあと高スコアが平坦に続く所など)
 *
 * 監査フラグだけで CM 区間を延ばしたり、ロゴの点を 0 にしたりはしない。
 * 閾値はすべて未校正の初期値 (実測で拾うための監査条件であって分類精度の保証ではない)。
 */

import type { Range } from "./core/cm-decide";

export type { Range };

/** 監査に渡す材料。時刻はすべて録画先頭を 0 とした秒、区間は半開区間 [start, end) */
export interface AuditMaterial {
  duration: number;
  /** 秒ごとの代表ロゴスコア。scores[i] は [i, i+1) の代表値。長さは ceil(duration) */
  scores: readonly number[];
  /** ロゴの点灯区間 (秒) */
  logoOn: readonly Range[];
  /** 無音区間 (秒) */
  silences: readonly Range[];
  /** シーンチェンジ時刻 (秒) */
  scenes: readonly number[];
}

export interface LogoAudit {
  /** 材料の形式が成立したか (ロゴの正しさではない) */
  valid: boolean;
  /** ロゴの被覆率 (点灯区間の合計 / 尺)。材料不正なら null */
  coverage: number | null;
  /** 0.2 秒以上の無音の数 */
  silenceCount: number;
  silencesPerHour: number | null;
  /** 点灯開始のうち、無音かシーンチェンジが 1 秒以内に重なっていた割合 */
  onsetSupportRate: number | null;
  /** 要確認の立ち上がり (秒) */
  suspiciousOnsets: readonly number[];
  /** 要確認区間 (立ち上がりの前後を広げて結合したもの) */
  reviewWindows: readonly Range[];
  reasons: readonly string[];
}

export const AUDIT_DEFAULTS = Object.freeze({
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
  coverageHigh: 0.98,
});

/** 材料の形式を検証する。欠損を補完したり詰め直したりはしない */
export function validateMaterial(m: AuditMaterial): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(m.duration) || m.duration <= 0) return ["duration-invalid"];
  if (m.scores.length !== Math.ceil(m.duration)) errors.push("score-length-mismatch");
  // Array.from は疎な配列の穴も undefined として検査する
  // 範囲は [0,1] ではなく [-1,2]：denpa のロゴスコアは相関値で、実測では
  // 秒平均が -0.02 程度まで負になる (2026-11-16 はぐれ刑事の診断で確認)。
  // ここで弾きたいのは NaN や桁外れのゴミだけなので、有限性と大まかな範囲で見る
  if (Array.from(m.scores).some((x) => !Number.isFinite(x) || x < -1 || x > 2)) {
    errors.push("score-missing-or-out-of-range");
  }
  for (const [name, spans] of [
    ["logo", m.logoOn],
    ["silence", m.silences],
  ] as const) {
    if (
      Array.from(spans).some(
        (r) =>
          !r ||
          !Number.isFinite(r.start) ||
          !Number.isFinite(r.end) ||
          r.start < 0 ||
          r.end > m.duration ||
          r.end <= r.start,
      )
    ) {
      errors.push(`${name}-range-invalid`);
    }
  }
  if (Array.from(m.scenes).some((t) => !Number.isFinite(t) || t < 0 || t > m.duration)) {
    errors.push("scene-time-invalid");
  }
  return errors;
}

/** 区間を時刻順に並べ、重なり・接触を結合する。入力は変更しない */
export function mergeRanges(spans: readonly Range[]): Range[] {
  const sorted = spans.map((r) => ({ ...r })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** 既存材料から「要確認区間」を抽出する。誤認の二値分類器ではない */
export function auditLogoEvidence(m: AuditMaterial): LogoAudit {
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
      reasons: errors,
    };
  }
  const on = mergeRanges(m.logoOn);
  const quiet = mergeRanges(m.silences).filter((r) => r.end - r.start >= AUDIT_DEFAULTS.silenceMin);
  const coverage = on.reduce((s, r) => s + r.end - r.start, 0) / m.duration;
  const silencesPerHour = (quiet.length * 3600) / m.duration;
  const reasons: string[] = [];
  if (silencesPerHour < AUDIT_DEFAULTS.sparsePerHour) reasons.push("sparse-silence");
  if (coverage < AUDIT_DEFAULTS.coverageLow || coverage > AUDIT_DEFAULTS.coverageHigh) {
    reasons.push("coverage-needs-review");
  }
  // 先頭に接する区間は「録画中の点灯開始」ではない
  const starts = on.map((r) => r.start).filter((t) => t > 0);
  const d = AUDIT_DEFAULTS.supportDistance;
  const supported = starts.filter(
    (t) =>
      m.scenes.some((c) => Math.abs(c - t) <= d) ||
      quiet.some((r) => r.start - d <= t && t <= r.end + d),
  ).length;
  const onsetSupportRate = starts.length > 0 ? supported / starts.length : null;

  const suspiciousOnsets: number[] = [];
  for (let i = AUDIT_DEFAULTS.lowSeconds; i + AUDIT_DEFAULTS.flatSeconds <= Math.floor(m.duration); i++) {
    let lowBefore = true;
    for (let j = i - AUDIT_DEFAULTS.lowSeconds; j < i; j++) {
      if (m.scores[j]! > AUDIT_DEFAULTS.lowScore) lowBefore = false;
    }
    if (!lowBefore) continue;
    let lo = 1;
    let hi = 0;
    for (let j = i; j < i + AUDIT_DEFAULTS.flatSeconds; j++) {
      lo = Math.min(lo, m.scores[j]!);
      hi = Math.max(hi, m.scores[j]!);
    }
    if (lo >= AUDIT_DEFAULTS.highScore && hi - lo <= AUDIT_DEFAULTS.flatRange + 1e-12) {
      suspiciousOnsets.push(i);
    }
  }
  if (suspiciousOnsets.length > 0) reasons.push("high-flat-onset-not-proof-of-error");
  const reviewWindows = mergeRanges(
    suspiciousOnsets.map((t) => ({
      start: Math.max(0, t - AUDIT_DEFAULTS.reviewBefore),
      end: Math.min(m.duration, t + AUDIT_DEFAULTS.reviewAfter),
    })),
  );
  return {
    valid: true,
    coverage,
    silenceCount: quiet.length,
    silencesPerHour,
    onsetSupportRate,
    suspiciousOnsets,
    reviewWindows,
    reasons,
  };
}

/**
 * コマごとのロゴスコアを秒ごとの代表値 (平均) に直す。
 * 途中の秒にコマが無ければ null (欠損を埋めて監査に渡さない)。
 * 末尾のコマの無い秒は「録画がその秒の途中で終わった」だけなので切り捨て、
 * 返る配列の長さがそのまま「コマが実在した秒数」になる。
 */
export function perSecondScores(
  times: ArrayLike<number>,
  scores: ArrayLike<number>,
  duration: number,
): number[] | null {
  const size = Math.ceil(duration);
  const sums = new Float64Array(size);
  const counts = new Uint32Array(size);
  for (let i = 0; i < times.length; i++) {
    const s = Math.floor(times[i]!);
    if (s < 0 || s >= size) continue;
    sums[s] += scores[i] ?? 0;
    counts[s]!++;
  }
  let last = -1;
  for (let s = 0; s < size; s++) if (counts[s]! > 0) last = s;
  if (last < 0) return null;
  const out = new Array<number>(last + 1);
  for (let s = 0; s <= last; s++) {
    if (counts[s] === 0) return null;
    out[s] = sums[s]! / counts[s]!;
  }
  return out;
}
