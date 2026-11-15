/**
 * 局ロゴの学習と照合の統括。
 *
 * denpa (danything/denpa, AGPL-3.0) の server/logo-own.ts の流れに倣った独自実装。
 * 覚え方・当て方の本体は core/logo-detect.ts (denpa の lib/ts から複写)。
 *
 * - 覚えるとき: キーフレームだけを散らして抜き、上下 1/5 の範囲で線の向きを
 *   足し合わせてロゴの在り処を割り出す
 * - 当てるとき: CM 検出のデコード (scan.ts) にロゴ枠を渡し、届いたコマに点を付ける。
 *   ついでに散らしたコマを足して型を育てる
 * - 型は局 (チャンネル) ごとのフォルダに、コマの大きさごとに保存する
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Rect } from "./core/logo-area";
import {
  addFrame,
  cropOrientation,
  decodeModel,
  emptyOrientation,
  encodeModel,
  findArea,
  framer,
  level,
  type LogoModel,
  logoSpans,
  makeTemplate,
  mergeModel,
  type Orientation,
  score,
  type Span,
  texture,
} from "./core/logo-detect";
import { FFMPEG, type ScanLogo } from "./scan";

export interface VideoInfo {
  width: number;
  height: number;
  duration: number;
}

/** 型の置き場のファイル名。コマの大きさごとに分ける (SD と HD が交互に来ても育つように) */
export const modelFile = (width: number, height: number) => `own-logo-${width}x${height}.bin`;

/** 覚えるときに見るキーフレームの数 */
const LEARN_FRAMES = 600;
/** 当てるついでに型へ足すコマの間隔 (コマ数) */
const GROW_EVERY = 90;

export function loadModel(repo: string, width: number, height: number): LogoModel | null {
  try {
    const model = decodeModel(readFileSync(join(repo, modelFile(width, height))));
    return model?.frameWidth === width && model.frameHeight === height ? model : null;
  } catch {
    return null;
  }
}

/** 型を書く。書けなくても検出は落とさない (次の録画で覚え直せば済む) */
export function saveModel(repo: string, model: LogoModel): void {
  const path = join(repo, modelFile(model.frameWidth, model.frameHeight));
  const temp = `${path}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(repo, { recursive: true });
    writeFileSync(temp, encodeModel(model));
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 置き場ごと作れなかった
    }
    console.warn(`[cm] 覚えたロゴを書けませんでした: ${error}`);
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 枠を切り出す ffmpeg フィルタ。座標は元のコマ大きさに対する比で渡す (途中で大きさが変わる録画でもはみ出さない) */
function cropTo(rect: Rect, video: VideoInfo): string {
  const { width: w, height: h } = video;
  return (
    `crop=iw*${rect.width}/${w}:ih*${rect.height}/${h}:iw*${rect.x}/${w}:ih*${rect.y}/${h}:exact=1,` +
    `scale=${rect.width}:${rect.height}`
  );
}

/** ffmpeg を走らせて標準出力をコールバックへ流す。終了コードを返す */
function runFfmpeg(
  args: string[],
  onStdout: ((chunk: Uint8Array) => void) | null,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (chunk: Buffer) => {
      if (onStdout) onStdout(chunk);
    });
    proc.stderr.on("data", () => {});
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(-1);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/** キーフレームを散らして抜き、上下 1/5 の範囲で向きを足し合わせてロゴの在り処を割り出す */
async function learn(input: string, video: VideoInfo, timeoutMs: number): Promise<LogoModel | string> {
  const { width, height, duration } = video;
  const band = Math.round(height / 5) & ~1;
  const top = emptyOrientation(width, band);
  const bottom = emptyOrientation(width, band);
  const every = Math.max(0.5, (Number.isFinite(duration) ? duration : 0) / LEARN_FRAMES);
  const feed = framer(width * band * 2, (bytes) => {
    addFrame(top, bytes, 0, width);
    addFrame(bottom, bytes, width * band, width);
  });
  const code = await runFfmpeg(
    [
      "-hide_banner", "-nostats", "-v", "error",
      "-skip_frame", "nokey",
      "-i", input,
      "-an", "-sn", "-dn",
      "-vf",
      `fps=1/${every.toFixed(3)},split[a][b];` +
        `[a]${cropTo({ x: 0, y: 0, width, height: band }, video)}[t];` +
        `[b]${cropTo({ x: 0, y: height - band, width, height: band }, video)}[u];` +
        `[t][u]vstack,format=gray`,
      "-frames:v", String(LEARN_FRAMES),
      "-f", "rawvideo", "pipe:1",
    ],
    feed,
    timeoutMs,
  );
  if (code !== 0) return `学習用のコマを取り出せませんでした (code ${code})`;

  const rect = findArea({ top, bottom }, width, height);
  if (rect === null) return "ロゴの位置を特定できませんでした";
  const inTop = rect.y + rect.height <= band;
  const orientation = cropOrientation(inTop ? top : bottom, {
    ...rect,
    y: inTop ? rect.y : rect.y - (height - band),
  });
  return { frameWidth: width, frameHeight: height, rect, orientation };
}

interface Tracker {
  scan: ScanLogo;
  spans(fps: number): Span[];
  scores(): Float32Array;
  frames(): number;
  grow: Orientation;
  points: number;
}

function tracker(model: LogoModel, video: VideoInfo): Tracker | string {
  const template = makeTemplate(model);
  if (template === null) return "ロゴの輪郭が少なすぎて学習できませんでした";
  const { crop } = template;
  const { rect } = model;
  const grow = emptyOrientation(rect.width, rect.height);
  const growAt = (rect.y - crop.y) * crop.width + (rect.x - crop.x);
  const scores: number[] = [];
  const levels: number[] = [];
  const textures: number[] = [];
  return {
    scan: {
      filter: cropTo(crop, video),
      size: crop.width * crop.height,
      onFrame: (bytes) => {
        scores.push(score(template, bytes));
        levels.push(level(template, bytes));
        textures.push(texture(template, bytes));
        if (scores.length % GROW_EVERY === 0) addFrame(grow, bytes, growAt, crop.width);
      },
    },
    spans: (fps) =>
      logoSpans(
        {
          scores: Float32Array.from(scores),
          levels: Uint8Array.from(levels),
          textures: Uint8Array.from(textures),
        },
        fps,
      ),
    scores: () => Float32Array.from(scores),
    frames: () => scores.length,
    grow,
    points: template.points.length,
  };
}

export interface LogoResult {
  /** 0 で当たった。それ以外はロゴを使わずに決める */
  code: number;
  /** ロゴの出ていた区間 (コマ番号) */
  spans: Span[];
  /** コマごとの点 */
  scores: Float32Array;
  /** 覚え書き */
  note: string;
}

/**
 * ロゴ判定のセッション。覚えていれば読み、無ければこの録画から覚える。
 * scanLogo を CM 検出のデコードへ渡し、読み終えたら finish を呼ぶ。
 */
export class LogoSession {
  private model: LogoModel;
  private learnedNow: boolean;
  private current: Tracker;
  private readonly input: string;
  private readonly video: VideoInfo;
  private readonly repo: string;
  private readonly timeoutMs: number;

  private constructor(
    input: string,
    video: VideoInfo,
    repo: string,
    timeoutMs: number,
    model: LogoModel,
    learnedNow: boolean,
    current: Tracker,
  ) {
    this.input = input;
    this.video = video;
    this.repo = repo;
    this.timeoutMs = timeoutMs;
    this.model = model;
    this.learnedNow = learnedNow;
    this.current = current;
  }

  static async open(
    input: string,
    video: VideoInfo,
    repo: string,
    timeoutMs: number,
  ): Promise<LogoSession | string> {
    const loaded = loadModel(repo, video.width, video.height);
    const initial = loaded ?? (await learn(input, video, timeoutMs));
    if (typeof initial === "string") return initial;
    const opened = tracker(initial, video);
    if (typeof opened === "string") return opened;
    return new LogoSession(input, video, repo, timeoutMs, initial, loaded === null, opened);
  }

  /** CM 検出のデコードへ渡すロゴ枠 */
  scanLogo(): ScanLogo {
    const fresh = tracker(this.model, this.video);
    if (typeof fresh === "string") throw new Error(fresh);
    this.current = fresh;
    return fresh.scan;
  }

  /**
   * 区間を出す。覚えていた型で 1 コマも当たらなければ、この録画から覚え直して
   * 枠だけ読み直す (rescan)。覚え直した型の在り処が前と重ならなければ持ち帰らない
   */
  async finish(fps: number, rescan: (logo: ScanLogo) => Promise<number>): Promise<LogoResult> {
    const fail = (note: string, code = 1): LogoResult => ({
      code,
      spans: [],
      scores: new Float32Array(),
      note,
    });
    let spans = this.current.spans(fps);
    let keep = true;
    if (!this.learnedNow && spans.length === 0 && this.current.frames() > 0) {
      console.warn("[cm] 覚えていたロゴが当たらないので、この録画から覚え直します");
      const learned = await learn(this.input, this.video, this.timeoutMs);
      if (typeof learned === "string") return fail(learned);
      keep = overlaps(this.model.rect, learned.rect);
      this.model = learned;
      this.learnedNow = true;
      const next = tracker(learned, this.video);
      if (typeof next === "string") return fail(next);
      const code = await rescan(next.scan);
      if (code !== 0) return fail(`コマを取り出せませんでした (code ${code})`, code);
      this.current = next;
      spans = next.spans(fps);
    }
    if (spans.length === 0) return fail("ロゴの写っているコマがありませんでした");

    if (keep) saveModel(this.repo, this.learnedNow ? this.model : mergeModel(this.model, this.current.grow));

    const { rect } = this.model;
    const lit = spans.reduce((sum, span) => sum + span.end - span.start + 1, 0);
    const share = Math.round((lit / Math.max(1, this.current.frames())) * 100);
    const where = `枠 ${rect.x},${rect.y},${rect.width},${rect.height}、型 ${this.current.points} 画素`;
    const how = this.learnedNow ? (keep ? " (この録画で覚えた)" : " (この録画だけで覚えた。前の型は残す)") : "";
    return {
      code: 0,
      spans,
      scores: this.current.scores(),
      note: `${where} / ロゴ ${share}%${how}`,
    };
  }
}
