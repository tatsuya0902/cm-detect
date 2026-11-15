/**
 * 字幕 (ARIB) のパケットの出方から「字幕が流れている区間」を作る。
 *
 * テキストのデコードはしない (ffmpeg に ARIB 字幕のデコーダが無い環境でも
 * 使えるように)。本編では字幕パケットが密に届くが、CM の間は細い管理
 * パケットが約 15 秒間隔で届くだけになることを使う。2026-11-15 に
 * ABC「相棒」の録画で実測し、ロゴ判定で得た CM 区間と「字幕の長い空白」が
 * ほぼ一致することを確認した。
 */

import { spawn } from "node:child_process";

import type { Range } from "./core/cm-decide";

const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/** この間隔 (秒) 以内で届いたパケット同士は「流れが続いている」とみなす */
const MERGE_GAP = 6;
/** 活動区間とみなす最短 (秒)。単発のパケット (管理パケット等) は除く */
const ACTIVE_MIN = 3;

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`ffprobe が失敗しました (code ${code})`));
    });
  });
}

/** パケット時刻の並びから、字幕が流れている区間を作る */
export function activityFromPackets(times: number[]): Range[] {
  const spans: Range[] = [];
  for (const t of times) {
    const last = spans[spans.length - 1];
    if (last !== undefined && t - last.end <= MERGE_GAP) last.end = t;
    else spans.push({ start: t, end: t });
  }
  return spans.filter((s) => s.end - s.start >= ACTIVE_MIN);
}

/**
 * 録画の字幕が流れている区間を返す (録画の先頭を 0 とした秒)。
 * 字幕ストリームが無い・取れない場合は null。
 * 時刻の起点は format の start_time (映像・無音と同じ TS の時計)。
 */
export async function captionActivity(input: string): Promise<Range[] | null> {
  let base = Number.NaN;
  try {
    const head = await run([
      "-v", "error",
      "-show_entries", "format=start_time",
      "-of", "csv=p=0",
      input,
    ]);
    base = Number(head.trim().replace(/,$/, ""));
  } catch {
    return null;
  }
  if (!Number.isFinite(base)) return null;

  let text: string;
  try {
    text = await run([
      "-v", "error",
      "-select_streams", "s:0",
      "-show_entries", "packet=pts_time,size",
      "-of", "csv=p=0",
      input,
    ]);
  } catch {
    return null;
  }
  const packets: Array<{ at: number; size: number }> = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().replace(/,$/, "").split(",");
    if (parts.length < 2) continue;
    const at = Number(parts[0]);
    const size = Number(parts[1]);
    if (Number.isFinite(at) && Number.isFinite(size)) {
      packets.push({ at: at - base, size });
    }
  }
  if (packets.length === 0) return null;
  packets.sort((a, b) => a.at - b.at);
  /*
   * 字幕の無い番組でも、細い管理パケットだけは流れ続けることがある
   * (中京テレビ「キャッチ！」で実測: パケットの 97% が 20 バイトの管理分で、
   * 実字幕はほぼ無かった)。最も多いサイズが過半を占める場合はそれを管理分と
   * みなし、それより大きいパケットだけを「字幕が流れている」材料にする
   */
  const counts = new Map<number, number>();
  for (const p of packets) counts.set(p.size, (counts.get(p.size) ?? 0) + 1);
  let modeSize = -1;
  let modeCount = 0;
  for (const [size, count] of counts) {
    if (count > modeCount) { modeSize = size; modeCount = count; }
  }
  const real = modeCount / packets.length >= 0.5
    ? packets.filter((p) => p.size > modeSize)
    : packets;
  if (real.length === 0) return null;
  return activityFromPackets(real.map((p) => p.at));
}

/** 区間の中で字幕が流れている割合 (0〜1) */
export function captionCoverage(active: Range[], range: Range): number {
  let covered = 0;
  for (const span of active) {
    const start = Math.max(span.start, range.start);
    const end = Math.min(span.end, range.end);
    if (end > start) covered += end - start;
  }
  return covered / Math.max(1, range.end - range.start);
}

/** 字幕が途切れている区間 (長いものだけ) を返す */
export function captionAbsent(active: Range[], duration: number, min = 20): Range[] {
  const out: Range[] = [];
  let cursor = 0;
  for (const span of active) {
    if (span.start - cursor >= min) out.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (duration - cursor >= min) out.push({ start: cursor, end: duration });
  return out;
}
