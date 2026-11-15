/**
 * 録画 1 本の CM 検出の統括。
 *
 * denpa (danything/denpa, AGPL-3.0) の server/cm.ts の decideFromMaterial の
 * 流れに倣った独自実装: ロゴで決め、使えなければ無音と CM の尺だけで決め直す。
 * どちらも番組の半分以上が CM になったら結果を捨てる。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

import { decideCm, missingVideo, totalLength, type Range } from "./core/cm-decide";
import { LogoSession } from "./logo";
import { scanFile } from "./scan";

const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export interface Probe {
  width: number;
  height: number;
  duration: number;
  fps: number;
}

/** ffprobe で映像の大きさ・尺・フレームレートを取る */
export async function probe(input: string): Promise<Probe> {
  const json = await new Promise<string>((resolve, reject) => {
    const proc = spawn(
      FFPROBE,
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate,duration",
        "-show_entries", "format=duration",
        "-of", "json",
        input,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`ffprobe が失敗しました (code ${code})`));
    });
  });
  const data = JSON.parse(json) as {
    streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const stream = data.streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error("映像ストリームが見つかりませんでした");
  let fps = Number.NaN;
  const rate = /^(\d+)\/(\d+)$/.exec(stream.avg_frame_rate ?? "");
  if (rate) fps = Number(rate[1]) / Math.max(1, Number(rate[2]));
  else fps = Number(stream.avg_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0) fps = 29.97;
  // 尺は映像ストリームのものを優先する。フル TS ではデータ放送などの別ストリームの
  // 時間軸で format の尺が化けることがある (実測で 30 分の録画が 93257 秒になった)
  const duration = Number(stream.duration ?? data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("尺が分かりませんでした");
  return { width: stream.width, height: stream.height, duration, fps };
}

export interface DetectOptions {
  /** ロゴの型の置き場 (この下にチャンネルごとのフォルダを作る) */
  modelsDir: string;
  /** チャンネルキー (型のフォルダ名に使う) */
  channelKey: string;
  /** 番組の尺 (番組表。秒) */
  programLength?: number;
  /** 番組が始まる秒 (録画の先頭から) */
  programStart?: number;
  timeoutMs?: number;
}

export interface DetectResult {
  cm: Range[];
  duration: number;
  /** どう決めたか */
  note: string;
  /** ロゴ判定の覚え書き (失敗理由を含む) */
  logoNote: string;
}

export async function detect(input: string, options: DetectOptions): Promise<DetectResult> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const probed = await probe(input);
  const video = { width: probed.width, height: probed.height, duration: probed.duration };
  const repo = join(options.modelsDir, options.channelKey);

  let logo: { spans: Array<{ start: number; end: number }>; scores: Float32Array } | null = null;
  let logoNote = "";
  const session = await LogoSession.open(input, video, repo, timeoutMs);
  let found;
  if (typeof session === "string") {
    logoNote = `ロゴを覚えられませんでした: ${session}`;
    found = await scanFile(input, { logo: null, timeoutMs });
  } else {
    found = await scanFile(input, { logo: session.scanLogo(), timeoutMs });
    if (found.times.length > 0 && found.logoFrames === found.times.length) {
      const result = await session.finish(probed.fps, async (again) => {
        const rescan = await scanFile(input, { logo: again, audio: false, timeoutMs });
        return rescan.code;
      });
      if (result.code === 0) {
        logo = { spans: result.spans, scores: result.scores };
        logoNote = result.note;
      } else {
        logoNote = `ロゴ判定に失敗: ${result.note}`;
      }
    } else {
      logoNote = `ロゴの枠の数 (${found.logoFrames}) とコマの数 (${found.times.length}) が合いません`;
    }
  }

  const { times } = found;
  const duration = probed.duration;
  const at = (frame: number) => (frame < times.length ? times[frame]! : duration);
  const missing = missingVideo(Float64Array.from(times), duration);
  const share = (cm: Range[]) => totalLength(cm) / Math.max(1, duration - totalLength(missing));
  const base = {
    duration,
    silences: found.silences,
    times: Float64Array.from(times),
    cuts: Float64Array.from(found.cuts),
    ...(options.programLength !== undefined ? { programLength: options.programLength } : {}),
    ...(options.programStart !== undefined ? { programStart: options.programStart } : {}),
  };

  let cm: Range[] = [];
  let note = "";
  if (logo !== null) {
    const withLogo = decideCm({
      ...base,
      logo: logo.spans.map((s) => ({ start: at(s.start), end: at(s.end + 1) })),
      logoScores: logo.scores,
    });
    if (withLogo.length > 0 && share(withLogo) < 0.5) {
      cm = withLogo;
      note = `ロゴで判定 (${logoNote})`;
    } else {
      note =
        withLogo.length === 0
          ? `ロゴの消えている所がありませんでした (${logoNote})`
          : `番組の ${Math.round(share(withLogo) * 100)}% が CM と判定されたためロゴの結果を捨てました (${logoNote})`;
    }
  }
  if (cm.length === 0) {
    const plain = decideCm(base);
    if (plain.length > 0 && share(plain) < 0.5) {
      cm = plain;
      note = `${note}${note ? " / " : ""}無音と尺で判定`;
    } else if (plain.length > 0) {
      note = `${note}${note ? " / " : ""}尺だけの判定も CM の割合が過半のため捨てました`;
    } else {
      note = `${note}${note ? " / " : ""}CM は見つかりませんでした`;
    }
    if (logo === null && logoNote) note = `${logoNote} / ${note}`;
  }
  return { cm, duration, note, logoNote };
}
