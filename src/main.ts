/**
 * cm-detect: denpa の CM 判定コアを使い、録画ごとに CM 区間を求めて
 * KonomiTV が取り込める .chapter.txt (AviUtl 形式) を書き出すツール。
 *
 * 使い方:
 *   node cm-detect.mjs detect <録画TS> --channel <キー> [--program-length 秒]
 *        [--program-start 秒] [--models <型の置き場>] [--out <.chapter.txt のパス>]
 *   node cm-detect.mjs batch [--api http://127.0.0.77:7010] [--models <置き場>]
 *        [--state <状態ファイル>] [--server-dir <KonomiTV/server>] [--python <venv python>]
 *        [--detector-script <run_cm_detector.py>] [--limit N]
 *
 * denpa (danything/denpa) は AGPL-3.0。core/ の 3 ファイルは denpa の
 * src/lib/ts から複写したもので、同ライセンスに従う。
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Range } from "./core/cm-decide";
import { DETECTOR_VERSION, detect, diagnose, type DetectStatus } from "./detect";
import {
  assessStage,
  loadRegistry,
  setModelStatus,
  type ModelStatus,
} from "./models-registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const DEFAULT_MODELS = join(HERE, "models");

function argValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
}

function argNumber(args: string[], name: string): number | undefined {
  const value = argValue(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** チャプター時刻 (HH:MM:SS.mmm) */
export function chapterTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(mm).padStart(3, "0")}`;
}

/** CM 区間から AviUtl 形式のチャプターテキストを作る (名前が CM で始まるチャプターが CM の開始) */
export function chapterText(cm: Range[], duration: number): string {
  const points = new Map<number, string>();
  points.set(0, cm.length > 0 && cm[0]!.start <= 0.05 ? "CM" : "本編");
  for (const range of cm) {
    const start = Math.min(Math.max(0, range.start), duration);
    const end = Math.min(Math.max(0, range.end), duration);
    points.set(Math.round(start * 1000) / 1000, "CM");
    if (end < duration - 0.05) points.set(Math.round(end * 1000) / 1000, "本編");
  }
  const sorted = [...points.entries()].sort((a, b) => a[0] - b[0]);
  const lines: string[] = [];
  sorted.forEach(([at, name], index) => {
    const no = String(index + 1).padStart(2, "0");
    lines.push(`CHAPTER${no}=${chapterTime(at)}`);
    lines.push(`CHAPTER${no}NAME=${name}`);
  });
  return lines.join("\n") + "\n";
}

async function runDetect(args: string[]): Promise<void> {
  const file = args.find((a) => !a.startsWith("--") && a !== "detect");
  if (!file) throw new Error("録画ファイルを指定してください");
  const channel = argValue(args, "--channel") ?? "unknown";
  const models = argValue(args, "--models") ?? DEFAULT_MODELS;
  const result = await detect(file, {
    modelsDir: models,
    channelKey: channel.replace(/[^\w.-]+/g, "_"),
    programLength: argNumber(args, "--program-length"),
    programStart: argNumber(args, "--program-start"),
    timeoutMs: argNumber(args, "--timeout-ms"),
  });
  const out = argValue(args, "--out");
  if (out && result.cm.length > 0) {
    writeFileSync(out, chapterText(result.cm, result.duration), "utf8");
  }
  console.log(
    JSON.stringify({
      file,
      duration: result.duration,
      cm: result.cm,
      note: result.note,
      status: result.status,
      statusReason: result.statusReason,
      material: result.material,
      audit: result.audit,
      chapter: out ?? null,
    }),
  );
}

// ---------------- 型の台帳 ----------------

function runModels(args: string[]): void {
  const models = argValue(args, "--models") ?? DEFAULT_MODELS;
  const registry = loadRegistry(models);
  const entries = Object.entries(registry.models).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    console.log("台帳に型はありません");
    return;
  }
  for (const [key, entry] of entries) {
    const { stage, validations } = assessStage(entry);
    console.log(
      `${key} v${entry.version} [${entry.status}] stage=${stage} validations=${validations} usages=${entry.usages.length}` +
        (entry.trainedFrom ? ` trained=${entry.trainedFrom}` : ""),
    );
  }
}

function runModelStatus(args: string[], status: ModelStatus): void {
  const models = argValue(args, "--models") ?? DEFAULT_MODELS;
  const channel = (argValue(args, "--channel") ?? "").replace(/[^\w.-]+/g, "_");
  const sizeArg = argValue(args, "--size") ?? "";
  const size = /^(\d+)x(\d+)$/.exec(sizeArg);
  if (!channel || !size) {
    throw new Error("--channel <キー> --size <幅>x<高さ> を指定してください");
  }
  const entry = setModelStatus(models, channel, Number(size[1]), Number(size[2]), status);
  if (!entry) throw new Error("台帳にその型がありません (検出で使われると登録されます)");
  console.log(`${channel} ${sizeArg}: status -> ${status}`);
}

async function runDiagnose(args: string[]): Promise<void> {
  const file = args.find((a) => !a.startsWith("--") && a !== "diagnose");
  if (!file) throw new Error("録画ファイルを指定してください");
  const channel = argValue(args, "--channel") ?? "unknown";
  const models = argValue(args, "--models") ?? DEFAULT_MODELS;
  const windowArg = argValue(args, "--window");
  let window: { start: number; end: number } | undefined;
  if (windowArg) {
    const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(windowArg);
    if (!m) throw new Error(`--window は 開始-終了 (秒) で指定してください: ${windowArg}`);
    window = { start: Number(m[1]), end: Number(m[2]) };
  }
  const dump = await diagnose(file, {
    modelsDir: models,
    channelKey: channel.replace(/[^\w.-]+/g, "_"),
    programLength: argNumber(args, "--program-length"),
    programStart: argNumber(args, "--program-start"),
    timeoutMs: argNumber(args, "--timeout-ms"),
    ...(window ? { window } : {}),
  });
  console.log(JSON.stringify(dump, null, 1));
}

// ---------------- batch ----------------

interface ApiProgram {
  id: number;
  duration?: number;
  recording_start_margin?: number;
  channel?: { display_channel_id?: string; name?: string };
  recorded_video?: {
    status?: string;
    file_path?: string;
    duration?: number;
    cm_sections?: unknown;
  };
}

interface StateEntry {
  at: string;
  cm: number;
  note: string;
  /** 判定の状態。旧形式 (未記録) は ok として扱う */
  status?: DetectStatus;
  /** この版で処理を試みた回数 (failed の再試行上限に使う) */
  attempts?: number;
  /** 処理した検出器の版 */
  v?: string;
  /** ロゴ材料の監査の要約 (要確認区間。人手確認の入口) */
  audit?: {
    reasons: string[];
    suspiciousOnsets: number[];
    reviewWindows: Range[];
  };
}

interface StateFile {
  files: Record<string, StateEntry>;
}

function loadState(path: string): StateFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StateFile;
  } catch {
    return { files: {} };
  }
}

function runIngest(
  python: string,
  serverDir: string,
  script: string,
  file: string,
  duration: number,
): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      python,
      [script, file, String(duration)],
      {
        cwd: serverDir,
        timeout: 120000,
        env: { ...process.env, PYTHONPATH: serverDir },
      },
      (error, _stdout, stderr) => {
        if (error) {
          console.warn(`[batch] 取り込みに失敗: ${file}: ${stderr?.toString().slice(-300) ?? error.message}`);
          resolve(1);
        } else {
          resolve(0);
        }
      },
    );
  });
}

/** バッチの同時実行を 1 つに絞るためのロック。持ち主の pid を書き、死んでいたら奪う */
function acquireLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      let alive = false;
      try {
        const pid = Number(readFileSync(lockPath, "utf8"));
        if (Number.isFinite(pid) && pid > 0) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {
        alive = false;
      }
      if (alive) return false;
      try {
        unlinkSync(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

async function runBatch(args: string[]): Promise<void> {
  const api = argValue(args, "--api") ?? "http://127.0.0.77:7010";
  const models = argValue(args, "--models") ?? DEFAULT_MODELS;
  const statePath = argValue(args, "--state") ?? join(HERE, "state.json");
  // 同時実行は 1 つだけ (タイマーと手動実行が重なると、材料も型の育成も競合する)
  const lockPath = `${statePath}.lock`;
  if (!acquireLock(lockPath)) {
    console.log("[batch] 既に実行中のため終了します");
    return;
  }
  const serverDir = argValue(args, "--server-dir") ?? "";
  const python = argValue(args, "--python") ?? (serverDir ? join(serverDir, ".venv/bin/python") : "");
  const script = argValue(args, "--detector-script") ?? join(HOME, "run_cm_detector.py");
  const limit = argNumber(args, "--limit") ?? Number.POSITIVE_INFINITY;
  const state = loadState(statePath);
  const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  const programs: ApiProgram[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${api}/api/videos?order=asc&page=${page}`);
    if (!response.ok) throw new Error(`KonomiTV API が ${response.status} を返しました`);
    const data = (await response.json()) as { total: number; recorded_programs: ApiProgram[] };
    programs.push(...data.recorded_programs);
    if (programs.length >= data.total || data.recorded_programs.length === 0) break;
  }
  console.log(`[batch] 録画 ${programs.length} 件`);

  let done = 0;
  for (const program of programs) {
    if (done >= limit) break;
    const video = program.recorded_video;
    const file = video?.file_path;
    if (!file || video?.status !== "Recorded") continue;
    // NHK (総合・Eテレ・BS) に CM は無いので検出しない
    if ((program.channel?.name ?? "").includes("NHK")) continue;
    // 状態による再処理の判断: ok は常に対象外。degraded は同じ版では対象外。
    // failed は同じ版では 3 回まで。版が変わったら degraded / failed を 1 回やり直す
    const prev = state.files[file];
    if (prev) {
      const st = prev.status ?? "ok";
      const sameVersion = prev.v === DETECTOR_VERSION;
      if (st === "ok") continue;
      if (sameVersion && st === "degraded") continue;
      if (sameVersion && st === "failed" && (prev.attempts ?? 1) >= 3) continue;
    }
    if (!existsSync(file)) continue;
    const duration = video.duration ?? 0;
    if (duration < 120) continue;
    // 録画直後のファイルは安定するまで待つ
    if (Date.now() - statSync(file).mtimeMs < 180000) continue;

    const chapterPath = file.replace(/\.[^.]+$/, ".chapter.txt");
    const attempts =
      prev && prev.v === DETECTOR_VERSION && prev.status !== "ok" ? (prev.attempts ?? 1) + 1 : 1;
    try {
      if (existsSync(chapterPath)) {
        console.log(`[batch] 既存のチャプターを取り込みます: ${file}`);
        state.files[file] = {
          at: new Date().toISOString(),
          cm: -1,
          note: "既存の .chapter.txt を取り込み",
          status: "ok",
          attempts,
          v: DETECTOR_VERSION,
        };
        saveState();
      } else {
        const channelKey = (program.channel?.display_channel_id ?? "unknown").replace(/[^\w.-]+/g, "_");
        console.log(`[batch] 検出中: ${file} (ch=${channelKey})`);
        const result = await detect(file, {
          modelsDir: models,
          channelKey,
          programLength: program.duration,
          programStart: program.recording_start_margin,
        });
        console.log(
          `[batch] 結果: CM ${result.cm.length} 区間 [${result.status}: ${result.statusReason}] / ${result.note}`,
        );
        if (result.audit && result.audit.suspiciousOnsets.length > 0) {
          console.log(
            `[batch] 要確認区間: ${result.audit.reviewWindows
              .map((r) => `${Math.round(r.start)}-${Math.round(r.end)}s`)
              .join(", ")}`,
          );
        }
        if (result.cm.length > 0) {
          writeFileSync(chapterPath, chapterText(result.cm, result.duration), "utf8");
        }
        state.files[file] = {
          at: new Date().toISOString(),
          cm: result.cm.length,
          note: result.note,
          status: result.status,
          attempts,
          v: DETECTOR_VERSION,
          ...(result.audit
            ? {
                audit: {
                  reasons: [...result.audit.reasons],
                  suspiciousOnsets: [...result.audit.suspiciousOnsets],
                  reviewWindows: result.audit.reviewWindows.map((r) => ({ ...r })),
                },
              }
            : {}),
        };
        saveState();
      }
      if (serverDir && python && script) {
        const code = await runIngest(python, serverDir, script, file, duration);
        if (code === 0) console.log(`[batch] 取り込み完了: ${file}`);
      }
      done++;
    } catch (error) {
      // 例外も「失敗」として状態に残す (無記録だと毎回無制限に再試行してしまう)
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[batch] 失敗: ${file}: ${message}`);
      state.files[file] = {
        at: new Date().toISOString(),
        cm: 0,
        note: `例外: ${message}`,
        status: "failed",
        attempts,
        v: DETECTOR_VERSION,
      };
      saveState();
    }
  }
  console.log(`[batch] 完了 (${done} 件処理)`);
  try {
    unlinkSync(lockPath);
  } catch {
    // ロックが既に無い
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "detect") await runDetect(rest);
  else if (command === "diagnose") await runDiagnose(rest);
  else if (command === "batch") await runBatch(rest);
  else if (command === "models") runModels(rest);
  else if (command === "model-promote") runModelStatus(rest, "promoted");
  else if (command === "model-quarantine") runModelStatus(rest, "quarantined");
  else if (command === "model-release") runModelStatus(rest, "provisional");
  else {
    console.error(
      "使い方: cm-detect.mjs detect <録画TS> --channel <キー> | diagnose <録画TS> --channel <キー> [--window 開始-終了] | batch | models | model-promote/model-quarantine/model-release --channel <キー> --size <幅>x<高さ>",
    );
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
