/**
 * ロゴが使えないときの、字幕の空白を使った CM 判定 (独自実装)。
 *
 * 字幕が長く途切れている所を候補にし、端を近くの無音に寄せて、長さが
 * 15 秒の倍数に近いものだけを CM とする。本編にも台詞の無い場面はあるので、
 * 字幕の空白だけでは決めず、無音と CM の尺 (15 秒の倍数) と組み合わせる。
 * denpa の byLength (尺だけ) より条件が強いぶん、誤検出を抑える狙い。
 */

import { totalLength, type Range } from "./core/cm-decide";
import { captionAbsent } from "./captions";

/** CM ブロックとして採る最短 (秒)。denpa の byLength と同じ */
const BLOCK_MIN = 30;
/** 端を無音へ寄せる距離 (秒)。字幕の端は数秒曖昧なのでこのくらい見る */
const SNAP = 7;
/** 端の寄せで、字幕の空白の外側へ出てよい距離 (秒) */
const SNAP_OUT = 2;
/** 15 秒の倍数への合致とみなす誤差 (秒)。字幕の端が曖昧なぶんロゴ判定より緩い */
const FIT_TOLERANCE = 2.5;
/** この秒数未満の間隔で並んだ候補は 1 つにまとめる (提供・予告の島) */
const MERGE_WITHIN = 12;

export function decideByCaptions(args: {
  duration: number;
  silences: Range[];
  active: Range[];
}): Range[] {
  const { duration, silences, active } = args;
  const coveredRatio = totalLength(active) / Math.max(1, duration);
  // 字幕がほぼ全編に流れている録画では、空白が合図にならない
  if (coveredRatio > 0.9) return [];
  // 字幕がほぼ無い録画 (管理パケットのみ等) でも、空白は合図にならない
  if (coveredRatio < 0.05) return [];

  // 境目の候補: 無音 (0.2 秒以上) の真ん中
  const edges = silences
    .filter((s) => s.end - s.start >= 0.2)
    .map((s) => (s.start + s.end) / 2)
    .sort((a, b) => a - b);
  /** 空白の始まり側の端: 空白の少し手前から、先の無音へ寄せる */
  const snapStart = (t: number) => {
    let best = t;
    let distance = Number.POSITIVE_INFINITY;
    for (const e of edges) {
      if (e < t - SNAP_OUT || e > t + SNAP) continue;
      const d = Math.abs(e - t);
      if (d < distance) { distance = d; best = e; }
    }
    return best;
  };
  /** 空白の終わり側の端: 手前の無音から、空白の少し先までで寄せる */
  const snapEnd = (t: number) => {
    let best = t;
    let distance = Number.POSITIVE_INFINITY;
    for (const e of edges) {
      if (e < t - SNAP || e > t + SNAP_OUT) continue;
      const d = Math.abs(e - t);
      if (d < distance) { distance = d; best = e; }
    }
    return best;
  };

  const blocks: Range[] = [];
  for (const gap of captionAbsent(active, duration)) {
    const start = snapStart(gap.start);
    const end = snapEnd(gap.end);
    const length = end - start;
    if (length < 15 - FIT_TOLERANCE) continue;
    const units = Math.round(length / 15);
    if (units < 1 || Math.abs(length - units * 15) > FIT_TOLERANCE) continue;
    blocks.push({ start, end });
  }
  const merged: Range[] = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last !== undefined && b.start - last.end < MERGE_WITHIN) last.end = b.end;
    else merged.push({ ...b });
  }
  return merged.filter((b) => b.end - b.start >= BLOCK_MIN);
}
