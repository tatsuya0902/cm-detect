/**
 * 録画ガード (src/guard.ts) の単体テスト。
 * 実行: node tests/test-guard.ts (Node 22+ の型ストリッピングで TS のまま動く)
 */
import {
  checkRecordingGuard,
  evaluateGuard,
  guardConfigFromEnv,
  type GuardConfig,
} from "../src/guard.ts";

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
};

const now = 1_800_000_000_000;
const MIN = 60000;

// 1. 録画中は止める
{
  const d = evaluateGuard(2, [], now, 10);
  check("recording blocked", d.blocked && d.reason.includes("録画中"));
}

// 2. 10 分以内に始まる予約は止める (isSkip は除く、最も近いものを理由に出す)
{
  const d = evaluateGuard(
    0,
    [
      { startAt: now + 60 * MIN, endAt: now + 120 * MIN, name: "far" },
      { startAt: now + 5 * MIN, endAt: now + 65 * MIN, name: "near" },
      { startAt: now + 3 * MIN, endAt: now + 63 * MIN, name: "skip", isSkip: true },
    ],
    now,
    10,
  );
  check("reserve within window blocked", d.blocked && d.reason.includes("near"));
}

// 3. どちらも無ければ通す (窓の外の予約・終わった予約・skip 予約だけ)
{
  const d = evaluateGuard(
    0,
    [
      { startAt: now + 30 * MIN, endAt: now + 90 * MIN, name: "later" },
      { startAt: now - 60 * MIN, endAt: now - 1, name: "past" },
      { startAt: now + 1 * MIN, endAt: now + 61 * MIN, name: "skip", isSkip: true },
    ],
    now,
    10,
  );
  check("no block when idle", !d.blocked);
}

// 3b. 窓を広げれば (600 分) 遠い予約でも止める
{
  const d = evaluateGuard(
    0,
    [{ startAt: now + 300 * MIN, endAt: now + 360 * MIN, name: "far" }],
    now,
    600,
  );
  check("wide window blocked", d.blocked);
}

// 4. API 到達不能は fail-closed で止める (リトライ 1 回込み)
{
  const config: GuardConfig = { enabled: true, windowMin: 10, apiBase: "http://127.0.0.1:1" };
  let calls = 0;
  const d = await checkRecordingGuard(config, now, async () => {
    calls++;
    throw new Error("connect ECONNREFUSED");
  });
  check("api failure fail-closed", d.blocked && d.reason.includes("fail-closed"));
  check("api failure retried once", calls === 2);
}

// 5. API 正常時はその内容で判定する / ガード無効なら API を見ずに通す
{
  const config: GuardConfig = { enabled: true, windowMin: 10, apiBase: "http://example.invalid" };
  const okFetch = async (url: string) =>
    url.includes("/api/recording") ? { records: [], total: 0 } : { reserves: [] };
  const d = await checkRecordingGuard(config, now, okFetch as never);
  check("api ok passes", !d.blocked);

  const disabled = await checkRecordingGuard(
    { ...config, enabled: false },
    now,
    (async () => {
      throw new Error("呼ばれてはいけない");
    }) as never,
  );
  check("disabled guard passes without api", !disabled.blocked);
}

// 6. 環境変数の解釈
{
  const c = guardConfigFromEnv({});
  check("env defaults", c.enabled && c.windowMin === 10);
  const c2 = guardConfigFromEnv({
    CM_DETECT_RECORDING_GUARD: "0",
    CM_DETECT_GUARD_WINDOW_MIN: "600",
  });
  check("env overrides", !c2.enabled && c2.windowMin === 600);
  const c3 = guardConfigFromEnv({ CM_DETECT_GUARD_WINDOW_MIN: "abc" });
  check("env invalid window falls back", c3.windowMin === 10);
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
