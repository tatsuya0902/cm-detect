/**
 * ロゴの型の台帳 (レジストリ)。型ファイルそのものは従来どおり models/<チャンネル>/
 * に置き、ここでは「版・出自・状態・使われ方」だけを models/registry.json に記録する。
 *
 * 高度 AI への相談 (第 2 報への回答) の設計に基づく。ただし 2 点、運用に合わせて変えた。
 *
 * - 型の「凍結」はしない。denpa の設計では型は録画のたびに少しずつ育てる (mergeModel)
 *   のが通常運転で、凍結すると学習そのものが止まる。代わりに、使われるたびに
 *   被覆率と監査理由を台帳へ残し、悪化に気づけるようにする。版が上がるのは
 *   「この録画から覚え直した (再学習)」ときだけ。
 * - 昇格は自動にしない。合格の目安 (検証 2 本など) を満たしても stage が
 *   awaiting-external-validation になるだけで、昇格は人手のフレーム確認のあとに
 *   CLI (model-promote) で行う。誤認が確認された型は model-quarantine で隔離でき、
 *   隔離中の型は検出に使われない。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { currentModelPath, modelFile } from "./logo";

export type ModelStatus = "provisional" | "promoted" | "quarantined";

export interface ModelUsage {
  file: string;
  at: string;
  /** 学習元の録画か、それ以外 (検証の数え方の都合で分ける) */
  kind: "training" | "use";
  /** ロゴの被覆率 (点灯秒 / 尺)。取れなければ null */
  coverage: number | null;
  auditReasons: string[];
  detectorVersion: string;
}

export interface ModelEntry {
  /** 再学習のたびに上がる */
  version: number;
  status: ModelStatus;
  /** 型ファイルのバイト列の sha256 先頭 12 桁 (育成で変わる。版とは別に追う) */
  hash: string;
  trainedFrom?: string;
  trainedAt?: string;
  updatedAt: string;
  usages: ModelUsage[];
  history: Array<{ at: string; event: string }>;
}

export interface RegistryFile {
  models: Record<string, ModelEntry>;
}

const KEEP = 50;

export const modelKey = (channelKey: string, width: number, height: number) =>
  `${channelKey}/${modelFile(width, height)}`;

const registryPath = (modelsDir: string) => join(modelsDir, "registry.json");

export function loadRegistry(modelsDir: string): RegistryFile {
  try {
    const data = JSON.parse(readFileSync(registryPath(modelsDir), "utf8")) as RegistryFile;
    if (data && typeof data === "object" && data.models) return data;
  } catch {
    // 無ければ空として扱う (台帳が無くても検出は止めない)
  }
  return { models: {} };
}

/** 台帳を書く。書けなくても検出は落とさない */
export function saveRegistry(modelsDir: string, registry: RegistryFile): void {
  const path = registryPath(modelsDir);
  const temp = `${path}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(temp, JSON.stringify(registry, null, 2) + "\n", "utf8");
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 置き場ごと作れなかった
    }
    console.warn(`[cm] 型の台帳を書けませんでした: ${error}`);
  }
}

/** 型ファイルの指紋。無ければ null */
export function modelHash(modelsDir: string, channelKey: string, width: number, height: number): string | null {
  try {
    const path = currentModelPath(join(modelsDir, channelKey), width, height);
    if (path === null) return null;
    const bytes = readFileSync(path);
    return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

function pushHistory(entry: ModelEntry, event: string): void {
  entry.history.push({ at: new Date().toISOString(), event });
  if (entry.history.length > KEEP) entry.history = entry.history.slice(-KEEP);
}

/** 型が覚え直されたことを記録する (版 +1、検証の蓄積はリセット、昇格は取り消し) */
export function recordLearning(
  modelsDir: string,
  channelKey: string,
  width: number,
  height: number,
  file: string,
): void {
  const registry = loadRegistry(modelsDir);
  const key = modelKey(channelKey, width, height);
  const hash = modelHash(modelsDir, channelKey, width, height) ?? "";
  const prev = registry.models[key];
  const now = new Date().toISOString();
  const entry: ModelEntry = {
    version: (prev?.version ?? 0) + 1,
    status: prev?.status === "quarantined" ? "quarantined" : "provisional",
    hash,
    trainedFrom: file,
    trainedAt: now,
    updatedAt: now,
    usages: [],
    history: prev?.history ?? [],
  };
  pushHistory(entry, `learned v${entry.version} from ${file}`);
  registry.models[key] = entry;
  saveRegistry(modelsDir, registry);
}

/** 型が 1 本の録画で使われたことを記録する。指紋はその時点の型ファイルで更新する */
export function recordUsage(
  modelsDir: string,
  channelKey: string,
  width: number,
  height: number,
  usage: Omit<ModelUsage, "at">,
): void {
  const registry = loadRegistry(modelsDir);
  const key = modelKey(channelKey, width, height);
  const hash = modelHash(modelsDir, channelKey, width, height);
  if (hash === null) return;
  const now = new Date().toISOString();
  let entry = registry.models[key];
  if (!entry) {
    // 台帳導入前からある型は、最初に使われた時点で仮登録として載せる
    entry = {
      version: 1,
      status: "provisional",
      hash,
      updatedAt: now,
      usages: [],
      history: [{ at: now, event: "registered (existing model)" }],
    };
    registry.models[key] = entry;
  }
  entry.hash = hash;
  entry.updatedAt = now;
  entry.usages.push({ ...usage, at: now });
  if (entry.usages.length > KEEP) entry.usages = entry.usages.slice(-KEEP);
  saveRegistry(modelsDir, registry);
}

/** 状態を人手で変える (promote / quarantine / release)。CLI から使う */
export function setModelStatus(
  modelsDir: string,
  channelKey: string,
  width: number,
  height: number,
  status: ModelStatus,
): ModelEntry | null {
  const registry = loadRegistry(modelsDir);
  const key = modelKey(channelKey, width, height);
  const entry = registry.models[key];
  if (!entry) return null;
  entry.status = status;
  entry.updatedAt = new Date().toISOString();
  pushHistory(entry, `status -> ${status} (manual)`);
  saveRegistry(modelsDir, registry);
  return entry;
}

/**
 * 審査の進み具合 (回答の assessModelProgress に相当する数えられる部分だけ)。
 * 人手確認が要る項目は数えられないので、ここは「材料が揃ったか」まで。
 */
export function assessStage(entry: ModelEntry): {
  stage: "provisional" | "validating" | "awaiting-external-validation";
  validations: number;
} {
  const validations = entry.usages.filter(
    (u) => u.kind === "use" && u.coverage !== null && u.coverage >= 0.1 && u.coverage <= 0.98,
  ).length;
  const stage =
    validations >= 2
      ? "awaiting-external-validation"
      : entry.usages.length > 0
        ? "validating"
        : "provisional";
  return { stage, validations };
}
