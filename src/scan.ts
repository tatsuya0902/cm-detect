/**
 * CM 検出の材料を 1 回のデコードで取る (ffmpeg の起こし方と読み取り)。
 *
 * denpa (danything/denpa, AGPL-3.0) の server/cm-scan.ts の方式に倣った独自実装。
 * - 場面の切れ目: scdet の点を metadata=mode=print で一時ファイルへ
 * - 無音: 主音声の silencedetect を ametadata=mode=print で一時ファイルへ
 * - ロゴ枠: 切り出した白黒コマを標準出力へ流し、framer で 1 コマずつ渡す
 * 材料を標準エラーに出させないのは denpa と同じ理由 (行が落ちるため)。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Range } from "./core/cm-decide";
import { framer } from "./core/logo-detect";

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/** 無音とみなす音の大きさ。16 ビットで ±50 (denpa と同じ) */
const SILENCE_NOISE = 50 / 32768;
/** 検出する無音の最短 (秒)。短いものは判定側で捨てる */
const SILENCE_MIN = 0.15;

export interface ScanLogo {
  /** 枠を切り出すフィルタ (`crop=…`)。白黒化はこちらで足す */
  filter: string;
  /** 1 コマのバイト数 (枠の幅 × 高さ) */
  size: number;
  /** 1 コマ届くたびに呼ぶ */
  onFrame: (frame: Uint8Array, index: number) => void;
}

export interface ScanResult {
  code: number;
  stderr: string;
  /** コマごとの時刻 (秒) */
  times: number[];
  /** コマごとの場面の変わり方 (scdet。0〜100) */
  cuts: number[];
  silences: Range[];
  /** 届いたロゴ枠の数 */
  logoFrames: number;
}

const FRAME_TIME = /pts_time:\s*(-?[\d.]+)/;

/** metadata=mode=print の書き出しから、コマごとの時刻と scdet の点を読む */
export function parseCuts(text: string): { times: number[]; cuts: number[] } {
  const times: number[] = [];
  const cuts: number[] = [];
  let at = Number.NaN;
  for (const line of text.split("\n")) {
    const frame = FRAME_TIME.exec(line);
    if (frame !== null) {
      at = Number(frame[1]);
      continue;
    }
    if (line.startsWith("lavfi.scd.score=") && Number.isFinite(at)) {
      times.push(at);
      cuts.push(Number(line.slice("lavfi.scd.score=".length)));
      at = Number.NaN;
    }
  }
  return { times, cuts };
}

/** ametadata=mode=print の書き出しから無音区間を読む。終わりまで続いた無音は end で閉じる */
export function parseSilences(text: string, end: number): Range[] {
  const out: Range[] = [];
  let pending: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("lavfi.silence_start=")) {
      pending = Math.max(0, Number(line.slice("lavfi.silence_start=".length)));
    } else if (line.startsWith("lavfi.silence_end=") && pending !== null) {
      out.push({
        start: pending,
        end: Math.max(pending, Number(line.slice("lavfi.silence_end=".length))),
      });
      pending = null;
    }
  }
  if (pending !== null && Number.isFinite(end)) out.push({ start: pending, end });
  return out;
}

function readQuiet(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export interface ScanOptions {
  /** ロゴ枠。無ければ切れ目だけ取る */
  logo?: ScanLogo | null;
  /** 無音を取るか (既定 true) */
  audio?: boolean;
  /** 時間切れ (ms)。既定 30 分 */
  timeoutMs?: number;
}

/** 録画を 1 回デコードして材料を取る */
export async function scanFile(input: string, options: ScanOptions = {}): Promise<ScanResult> {
  const dir = mkdtempSync(join(tmpdir(), "cm-detect-scan-"));
  const cutsFile = join(dir, "cuts");
  const silencesFile = join(dir, "silences");
  const logo = options.logo ?? null;
  const audio = options.audio !== false;
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;

  const filters = [
    "scdet=threshold=100",
    `metadata=mode=print:key=lavfi.scd.score:file=${cutsFile}`,
  ];
  if (logo) filters.push(logo.filter, "format=gray");

  const args: string[] = [
    "-hide_banner", "-nostats", "-v", "error",
    "-i", input,
    "-an", "-sn", "-dn",
    "-fps_mode", "passthrough",
    "-vf", filters.join(","),
    ...(logo ? ["-f", "rawvideo", "pipe:1"] : ["-f", "null", "-"]),
  ];
  if (audio) {
    args.push(
      "-map", "0:a:0",
      "-af", `silencedetect=noise=${SILENCE_NOISE}:d=${SILENCE_MIN},ametadata=mode=print:file=${silencesFile}`,
      "-f", "null", "-",
    );
  }

  let logoFrames = 0;
  const feed = logo
    ? framer(logo.size, (bytes) => {
        logo.onFrame(bytes, logoFrames);
        logoFrames++;
      })
    : null;

  const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const proc = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    const errChunks: Buffer[] = [];
    let errBytes = 0;
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (chunk: Buffer) => {
      if (feed) feed(chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes < 64 * 1024) errChunks.push(chunk);
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: String(error) });
    });
    proc.on("close", (closeCode) => {
      clearTimeout(timer);
      resolve({ code: closeCode ?? -1, stderr: Buffer.concat(errChunks).toString("utf8") });
    });
  });

  const { times, cuts } = parseCuts(readQuiet(cutsFile));
  const end = times.length > 0 ? times[times.length - 1]! : Number.NaN;
  const silences = audio ? parseSilences(readQuiet(silencesFile), end) : [];
  rmSync(dir, { recursive: true, force: true });
  return { code, stderr: stderr.slice(-2000), times, cuts, silences, logoFrames };
}
