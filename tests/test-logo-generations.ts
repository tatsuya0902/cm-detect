/**
 * 型の世代保存 (src/logo.ts) の単体テスト。
 * 実行: bun tests/test-logo-generations.ts
 * (logo.ts の import グラフは拡張子なし import を含むため bun で実行する。
 *  node の型ストリッピングでは読めない)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyOrientation, encodeModel, type LogoModel } from "../src/core/logo-detect.ts";
import { latestFile, loadModel, modelFile, modelFileVersioned, saveModel } from "../src/logo.ts";
import { modelHash } from "../src/models-registry.ts";

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
};

const W = 1920;
const H = 1080;
const makeModel = (count: number): LogoModel => {
  const orientation = emptyOrientation(120, 60);
  orientation.count = count;
  orientation.sx[0] = count;
  return {
    frameWidth: W,
    frameHeight: H,
    rect: { x: 1740, y: 20, width: 120, height: 60 },
    orientation,
  };
};
const sha12 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);

const base = mkdtempSync(join(tmpdir(), "cm-logo-gen-"));
try {
  // 1. 初回保存は v0001 + latest、読み戻せる
  const repo = join(base, "ch1");
  saveModel(repo, makeModel(1));
  check("v0001 file exists", existsSync(join(repo, modelFileVersioned(W, H, 1))));
  check(
    "latest points to v0001",
    readFileSync(join(repo, latestFile(W, H)), "utf8") === `1\n${modelFileVersioned(W, H, 1)}\n`,
  );
  check("load returns v1", loadModel(repo, W, H)?.orientation.count === 1);

  // 2. 2回目は v0002、旧版が残り、最新が読まれる
  saveModel(repo, makeModel(2));
  check("v0002 file exists", existsSync(join(repo, modelFileVersioned(W, H, 2))));
  check("v0001 kept", existsSync(join(repo, modelFileVersioned(W, H, 1))));
  check("load returns v2", loadModel(repo, W, H)?.orientation.count === 2);
  check("load rejects other size", loadModel(repo, 1280, 720) === null);

  // 3. latest が壊れても最大版へ落ちる
  writeFileSync(join(repo, latestFile(W, H)), "garbage\n");
  check("corrupt latest falls back to max version", loadModel(repo, W, H)?.orientation.count === 2);

  // 4. latest が無くても最大版へ落ちる
  rmSync(join(repo, latestFile(W, H)));
  check("missing latest falls back to max version", loadModel(repo, W, H)?.orientation.count === 2);

  // 5. 従来の単一ファイルだけの置き場も読める。初回保存は v0001 になる
  const legacyRepo = join(base, "ch2");
  mkdirSync(legacyRepo, { recursive: true });
  writeFileSync(join(legacyRepo, modelFile(W, H)), encodeModel(makeModel(9)));
  check("legacy file loads", loadModel(legacyRepo, W, H)?.orientation.count === 9);
  saveModel(legacyRepo, makeModel(10));
  check("first versioned save after legacy is v0001", existsSync(join(legacyRepo, modelFileVersioned(W, H, 1))));
  check("load returns v0001 after legacy", loadModel(legacyRepo, W, H)?.orientation.count === 10);

  // 6. 7回保存すると直近5世代だけ残る
  const pruneRepo = join(base, "ch3");
  for (let i = 1; i <= 7; i++) saveModel(pruneRepo, makeModel(i));
  const kept = readdirSync(pruneRepo).filter((n) => n.includes("-v")).sort();
  check(
    "prune keeps latest 5 generations",
    kept.length === 5 && kept[0]!.includes("-v0003") && kept[4]!.includes("-v0007"),
  );
  check("latest is v0007", readFileSync(join(pruneRepo, latestFile(W, H)), "utf8").startsWith("7\n"));
  check("load returns v7", loadModel(pruneRepo, W, H)?.orientation.count === 7);

  // 7. 台帳のハッシュが現行世代を追う
  const modelsDir = join(base, "models");
  mkdirSync(join(modelsDir, "ch1"), { recursive: true });
  saveModel(join(modelsDir, "ch1"), makeModel(1));
  const h1 = modelHash(modelsDir, "ch1", W, H);
  check(
    "modelHash matches current versioned file",
    h1 !== null && h1 === sha12(join(modelsDir, "ch1", modelFileVersioned(W, H, 1))),
  );
  saveModel(join(modelsDir, "ch1"), makeModel(2));
  const h2 = modelHash(modelsDir, "ch1", W, H);
  check(
    "modelHash follows new generation",
    h2 !== null && h2 !== h1 && h2 === sha12(join(modelsDir, "ch1", modelFileVersioned(W, H, 2))),
  );
  check("modelHash unknown channel is null", modelHash(modelsDir, "nope", W, H) === null);
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`${failures} FAILURES`);
  process.exit(1);
}
console.log("ALL PASS");
