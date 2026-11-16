/**
 * 録画 1 本の CM 検出の統括。
 *
 * denpa (danything/denpa, AGPL-3.0) の server/cm.ts の decideFromMaterial の
 * 流れに倣った独自実装: ロゴで決め、使えなければ無音と CM の尺だけで決め直す。
 * どちらも番組の半分以上が CM になったら結果を捨てる。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

import { auditLogoEvidence, perSecondScores, type LogoAudit } from "./audit";
import { decideByCaptions } from "./caption-decide";
import { captionActivity, captionCoverage } from "./captions";
import { boundaries, decideCm, missingVideo, totalLength, type Range } from "./core/cm-decide";
import { LogoSession } from "./logo";
import { loadRegistry, modelKey, recordLearning, recordUsage } from "./models-registry";
import { scanFile, type ScanResult } from "./scan";

const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/**
 * 検出器の版。判定の挙動を変えたら上げる。
 * 状態ファイルの degraded / failed は、版が変わると 1 回だけ再処理される。
 */
export const DETECTOR_VERSION = "2026-11-16.2";

/** シーンチェンジとみなす scdet の下限 (core/cm-decide の CUT_MIN と同じ) */
const SCENE_CUT_MIN = 8;

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

/**
 * 判定の状態。失敗を「CM ゼロ」と同じ記録にしないために分ける。
 * - ok: 有効な材料で判定が完了した (CM ゼロも含む)
 * - degraded: ロゴなどが使えず、残りの材料で判定した (CM ゼロも含む)
 * - failed: 判定に必要な材料を確保できなかった
 */
export type DetectStatus = "ok" | "degraded" | "failed";

/** 取れた材料の量 (診断と状態記録用) */
export interface DetectMaterial {
  scanCode: number;
  /** コマごとの時刻が取れた数 */
  frames: number;
  cuts: number;
  silences: number;
  /** 届いたロゴ枠の数 */
  logoFrames: number;
  /** ロゴ枠として受けた総バイト数 */
  logoBytes: number;
  /** ロゴの点が付いたコマ数 (ロゴ判定ができていれば) */
  logoScores: number;
}

export interface DetectResult {
  cm: Range[];
  duration: number;
  /** どう決めたか */
  note: string;
  /** ロゴ判定の覚え書き (失敗理由を含む) */
  logoNote: string;
  status: DetectStatus;
  /** 状態の根拠 (短い日本語) */
  statusReason: string;
  material: DetectMaterial;
  /** ロゴ材料の監査 (ロゴが使えたときだけ。要確認区間の抽出で、判定には使わない) */
  audit: LogoAudit | null;
}

/**
 * ロゴ材料から監査を作る。対象はコマが実在した秒まで (perSecondScores の長さ) で、
 * 区間と切れ目はそこへ切りそろえる (範囲外の材料で監査を不正にしないため)。
 */
function computeAudit(
  found: ScanResult,
  logoSpansSec: Range[],
  scores: Float32Array,
  duration: number,
): LogoAudit | null {
  const perSecond = perSecondScores(found.times, scores, duration);
  if (perSecond === null) return null;
  const covered = perSecond.length;
  const clip = (ranges: readonly Range[]): Range[] =>
    ranges
      .filter((r) => r.start < covered)
      .map((r) => ({ start: r.start, end: Math.min(r.end, covered) }));
  return auditLogoEvidence({
    duration: covered,
    scores: perSecond,
    logoOn: clip(logoSpansSec),
    silences: clip(found.silences),
    scenes: found.times.filter((t, i) => t < covered && (found.cuts[i] ?? 0) >= SCENE_CUT_MIN),
  });
}

export async function detect(input: string, options: DetectOptions): Promise<DetectResult> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const probed = await probe(input);
  const video = { width: probed.width, height: probed.height, duration: probed.duration };
  const repo = join(options.modelsDir, options.channelKey);

  let logo: { spans: Array<{ start: number; end: number }>; scores: Float32Array } | null = null;
  let logoNote = "";
  let logoLearnedNow = false;
  let audit: LogoAudit | null = null;
  // ロゴがどうなったか: used=使えた / discarded=結果をガードで捨てた /
  // unavailable=覚えられなかった / mismatch=枠とコマの数が合わない / failed=判定に失敗 /
  // quarantined=台帳で隔離中
  let logoState: "used" | "discarded" | "unavailable" | "mismatch" | "failed" | "quarantined" =
    "unavailable";
  // 隔離中の型は検出に使わない (誤認が確認された型を通常運用から外す)
  const registryEntry = loadRegistry(options.modelsDir).models[
    modelKey(options.channelKey, probed.width, probed.height)
  ];
  const quarantined = registryEntry?.status === "quarantined";
  const session = quarantined ? null : await LogoSession.open(input, video, repo, timeoutMs);
  let found;
  if (quarantined) {
    logoNote = "ロゴの型は台帳で隔離中のため使いませんでした";
    logoState = "quarantined";
    found = await scanFile(input, { logo: null, timeoutMs });
  } else if (typeof session === "string" || session === null) {
    logoNote = `ロゴを覚えられませんでした: ${session}`;
    found = await scanFile(input, { logo: null, timeoutMs });
  } else {
    found = await scanFile(input, { logo: session.scanLogo(), timeoutMs });
    if (found.times.length > 0 && found.integrity.ok) {
      const result = await session.finish(probed.fps, async (again) => {
        const rescan = await scanFile(input, { logo: again, audio: false, timeoutMs });
        return { code: rescan.code, logoFrames: rescan.logoFrames, frames: rescan.times.length };
      });
      if (result.code === 0) {
        logo = { spans: result.spans, scores: result.scores };
        logoNote = result.note;
        logoState = "used";
        logoLearnedNow = result.learnedNow;
      } else {
        logoNote = `ロゴ判定に失敗: ${result.note}`;
        logoState = "failed";
      }
    } else {
      // 枠とコマの対応が取れない材料でロゴ判定を続けるのは危険 (途中で欠けたコマが
      // あれば、それ以降の対応が全部ずれる) ため、ロゴだけを無効化して残りの材料で決める
      logoNote = found.integrity.reason ?? `ロゴの枠の数 (${found.logoFrames}) とコマの数 (${found.times.length}) が合いません`;
      logoState = "mismatch";
    }
  }

  const { times } = found;
  const duration = probed.duration;
  // 字幕の流れ (ロゴが使えないときの判定材料)。取れなければ null
  // 2026-11-15 の実測で、バラエティ・ニュースでは本編でも字幕が途切れるため
  // 「字幕の空白 = CM」が成り立たず、合流させると誤検出・見落としが増えた。
  // そのため既定では使わず、環境変数 CM_DETECT_CAPTIONS=1 のときだけ有効にする
  // (ロゴを出さない局のドラマなど、効く素材が来たときの実験用に残してある)
  const captions = process.env.CM_DETECT_CAPTIONS === "1"
    ? await captionActivity(input).catch(() => null)
    : null;
  const at = (frame: number) => (frame < times.length ? times[frame]! : duration);
  const missing = missingVideo(Float64Array.from(times), duration);

  // ロゴ材料の監査と、型の台帳への記録 (どちらも判定には使わない。失敗しても検出は続ける)
  if (logo !== null) {
    try {
      const logoSec = logo.spans.map((s) => ({ start: at(s.start), end: at(s.end + 1) }));
      audit = computeAudit(found, logoSec, logo.scores, duration);
      if (logoLearnedNow) {
        recordLearning(options.modelsDir, options.channelKey, probed.width, probed.height, input);
      }
      recordUsage(options.modelsDir, options.channelKey, probed.width, probed.height, {
        file: input,
        kind: logoLearnedNow ? "training" : "use",
        coverage: totalLength(logoSec) / Math.max(1, duration),
        auditReasons: audit ? [...audit.reasons] : [],
        detectorVersion: DETECTOR_VERSION,
      });
    } catch (error) {
      console.warn(`[cm] 監査・台帳への記録に失敗: ${error}`);
    }
  }
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
  let decidedBy: "logo" | "plain" | "captions" | "none" = "none";
  if (logo !== null) {
    const withLogo = decideCm({
      ...base,
      logo: logo.spans.map((s) => ({ start: at(s.start), end: at(s.end + 1) })),
      logoScores: logo.scores,
    });
    if (withLogo.length > 0 && share(withLogo) < 0.5) {
      cm = withLogo;
      note = `ロゴで判定 (${logoNote})`;
      decidedBy = "logo";
    } else {
      logoState = "discarded";
      note =
        withLogo.length === 0
          ? `ロゴの消えている所がありませんでした (${logoNote})`
          : `番組の ${Math.round(share(withLogo) * 100)}% が CM と判定されたためロゴの結果を捨てました (${logoNote})`;
    }
  }
  if (cm.length === 0) {
    const plain = decideCm(base);
    if (captions !== null) {
      const viaCaptions = decideByCaptions({
        duration,
        silences: found.silences,
        active: captions,
      });
      /*
       * 字幕入り CM 対策: 字幕付きの CM は「字幕の空白」にならないので、
       * 尺だけで拾えた区間のうち字幕の密度が低いものは、字幕が流れていても採る。
       * 逆に字幕が密な区間は、尺が合っていても本編の無言場面の可能性が高いので落とす
       */
      const extra = plain.filter(
        (b) =>
          !viaCaptions.some((c) => b.start < c.end && c.start < b.end) &&
          captionCoverage(captions, b) < 0.35,
      );
      const merged = [...viaCaptions, ...extra].sort((a, b) => a.start - b.start);
      if (merged.length > 0 && share(merged) < 0.5) {
        cm = merged;
        note = `${note}${note ? " / " : ""}字幕の空白と尺で判定`;
        decidedBy = "captions";
      }
    }
    if (cm.length > 0) {
      // 字幕経由で決まった
    } else if (plain.length > 0 && share(plain) < 0.5) {
      cm = plain;
      note = `${note}${note ? " / " : ""}無音と尺で判定`;
      decidedBy = "plain";
    } else if (plain.length > 0) {
      note = `${note}${note ? " / " : ""}尺だけの判定も CM の割合が過半のため捨てました`;
    } else {
      note = `${note}${note ? " / " : ""}CM は見つかりませんでした`;
    }
    if (logo === null && logoNote) note = `${logoNote} / ${note}`;
  }

  // 状態の分類: 失敗を「CM ゼロ」と同じ扱いにしない
  const material: DetectMaterial = {
    scanCode: found.code,
    frames: found.times.length,
    cuts: found.cuts.length,
    silences: found.silences.length,
    logoFrames: found.logoFrames,
    logoBytes: found.logoBytes,
    logoScores: logo?.scores.length ?? 0,
  };
  let status: DetectStatus;
  let statusReason: string;
  if (found.code !== 0 || found.times.length === 0) {
    status = "failed";
    statusReason = `材料が取れませんでした (scan code ${found.code} / コマ ${found.times.length})`;
  } else if (decidedBy === "logo") {
    status = "ok";
    statusReason = "ロゴで判定";
  } else if (decidedBy !== "none") {
    status = logoState === "used" ? "ok" : "degraded";
    statusReason =
      logoState === "used" ? "ロゴの裏付け付きで判定" : `ロゴが使えず (${logoState}) 残りの材料で判定`;
  } else if (logoState === "discarded") {
    status = "degraded";
    statusReason = "ロゴ・尺の両方の結果をガードで捨てた";
  } else if (logoState === "used") {
    status = "ok";
    statusReason = "ロゴ・尺とも CM なしと判定";
  } else if (found.silences.length === 0) {
    status = "failed";
    statusReason = `ロゴが使えず (${logoState})、無音の材料も無い`;
  } else {
    status = "degraded";
    statusReason = `ロゴが使えず (${logoState})、残りの材料でも CM を決められなかった`;
  }
  return { cm, duration, note, logoNote, status, statusReason, material, audit };
}

export interface DiagnoseOptions extends DetectOptions {
  /** 詳しく見る範囲 (秒) */
  window?: { start: number; end: number };
}

/**
 * 診断モード: 判定そのものではなく「なぜそうなったか」を出す。
 * 指定範囲について、無音・境目候補・ロゴ区間・秒ごとのロゴの点を並べ、
 * ロゴ経路と尺経路の両方の結果を返す。材料は detect() と同じ取り方をする。
 */
export async function diagnose(input: string, options: DiagnoseOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const probed = await probe(input);
  const video = { width: probed.width, height: probed.height, duration: probed.duration };
  const repo = join(options.modelsDir, options.channelKey);
  const win = options.window ?? { start: 0, end: Math.min(60, probed.duration) };
  const near = (t: number) => t >= win.start - 10 && t <= win.end + 10;

  let logo: { spans: Array<{ start: number; end: number }>; scores: Float32Array } | null = null;
  let logoNote = "";
  const session = await LogoSession.open(input, video, repo, timeoutMs);
  let found: ScanResult;
  if (typeof session === "string") {
    logoNote = `ロゴを覚えられませんでした: ${session}`;
    found = await scanFile(input, { logo: null, timeoutMs });
  } else {
    found = await scanFile(input, { logo: session.scanLogo(), timeoutMs });
    if (found.times.length > 0 && found.integrity.ok) {
      const result = await session.finish(probed.fps, async (again) => {
        const rescan = await scanFile(input, { logo: again, audio: false, timeoutMs });
        return { code: rescan.code, logoFrames: rescan.logoFrames, frames: rescan.times.length };
      });
      if (result.code === 0) {
        logo = { spans: result.spans, scores: result.scores };
        logoNote = result.note;
      } else {
        logoNote = `ロゴ判定に失敗: ${result.note}`;
      }
    } else {
      logoNote = found.integrity.reason ?? `ロゴの枠の数 (${found.logoFrames}) とコマの数 (${found.times.length}) が合いません`;
    }
  }

  const { times } = found;
  const duration = probed.duration;
  const at = (frame: number) => (frame < times.length ? times[frame]! : duration);
  const base = {
    duration,
    silences: found.silences,
    times: Float64Array.from(times),
    cuts: Float64Array.from(found.cuts),
    ...(options.programLength !== undefined ? { programLength: options.programLength } : {}),
    ...(options.programStart !== undefined ? { programStart: options.programStart } : {}),
  };

  const dumpBoundary = (b: ReturnType<typeof boundaries>[number]) => ({
    silence: b.silence,
    cuts: b.cuts.filter(near),
    weak: b.weak.filter(near),
    still: b.still,
  });
  const inWindow = (b: ReturnType<typeof boundaries>[number]) =>
    near(b.silence.start) || near(b.silence.end) || b.cuts.some(near);

  // 秒ごとのロゴの点 (範囲内のみ)。コマと時刻の対応が取れているときだけ意味がある
  const scoreBySecond: Array<{ t: number; mean: number; max: number }> = [];
  if (logo !== null && found.logoFrames === times.length) {
    for (let s = Math.floor(win.start); s <= Math.ceil(win.end); s++) {
      let sum = 0;
      let max = 0;
      let n = 0;
      for (let i = 0; i < times.length; i++) {
        const t = times[i]!;
        if (t < s) continue;
        if (t >= s + 1) break;
        const v = logo.scores[i] ?? 0;
        sum += v;
        if (v > max) max = v;
        n++;
      }
      if (n > 0) scoreBySecond.push({ t: s, mean: Math.round((sum / n) * 100) / 100, max });
    }
  }

  const logoSpansSec =
    logo?.spans.map((s) => ({ start: at(s.start), end: at(s.end + 1) })) ?? [];
  const withLogo =
    logo !== null
      ? decideCm({ ...base, logo: logoSpansSec, logoScores: logo.scores })
      : null;
  const plain = decideCm(base);

  // 録画全体のロゴ材料の監査 (要確認区間の抽出。診断用で判定には使わない)
  const audit: LogoAudit | null =
    logo !== null ? computeAudit(found, logoSpansSec, logo.scores, duration) : null;

  return {
    file: input,
    duration,
    fps: probed.fps,
    size: `${probed.width}x${probed.height}`,
    programLength: options.programLength ?? null,
    programStart: options.programStart ?? null,
    window: win,
    scan: {
      code: found.code,
      frames: times.length,
      cuts: found.cuts.length,
      silences: found.silences.length,
      logoFrames: found.logoFrames,
    },
    logoNote,
    silencesInWindow: found.silences.filter((s) => near(s.start) || near(s.end)),
    boundariesDefault: boundaries(base).filter(inWindow).map(dumpBoundary),
    boundariesAlone: boundaries(base, 0.8).filter(inWindow).map(dumpBoundary),
    logoSpansInWindow: logoSpansSec.filter((s) => s.end >= win.start - 10 && s.start <= win.end + 10),
    logoScoreBySecond: scoreBySecond,
    audit,
    resultWithLogo: withLogo,
    resultPlain: plain,
  };
}
