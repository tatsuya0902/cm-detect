/**
 * 録画ガード: バッチが録画中・録画開始直前に動いて AKAGI に負荷をかけ、
 * チューナーの読み出しを止めて録画を欠けさせる事故を防ぐための確認。
 *
 * CM 検出は遅れても困らない処理なので、判定できないときは
 * 「今回はやらない」側に倒す (fail-closed)。
 *
 * 環境変数:
 *   CM_DETECT_RECORDING_GUARD=0   ガードを無効化する (既定は有効)
 *   CM_DETECT_GUARD_WINDOW_MIN=N  予約開始が何分以内なら止めるか (既定 10)
 *   CM_DETECT_EPGSTATION_API=URL  EPGStation の API ベース (既定 http://127.0.0.1:8888)
 */

export interface ReserveLike {
  startAt?: number;
  endAt?: number;
  isSkip?: boolean;
  name?: string;
}

export type GuardDecision =
  | { blocked: false }
  | { blocked: true; reason: string };

export interface GuardConfig {
  enabled: boolean;
  windowMin: number;
  apiBase: string;
}

export function guardConfigFromEnv(env: Record<string, string | undefined>): GuardConfig {
  const windowParsed = Number(env.CM_DETECT_GUARD_WINDOW_MIN);
  return {
    enabled: env.CM_DETECT_RECORDING_GUARD !== "0",
    windowMin: Number.isFinite(windowParsed) && windowParsed > 0 ? windowParsed : 10,
    apiBase: (env.CM_DETECT_EPGSTATION_API ?? "http://127.0.0.1:8888").replace(/\/+$/, ""),
  };
}

/**
 * 純粋な判定ロジック (単体テスト対象)。
 * recordingCount: 現在の録画件数。reserves: 予約一覧 (startAt/endAt は ms epoch)。
 */
export function evaluateGuard(
  recordingCount: number,
  reserves: readonly ReserveLike[],
  nowMs: number,
  windowMin: number,
): GuardDecision {
  if (recordingCount > 0) {
    return { blocked: true, reason: `録画中 (${recordingCount} 件)` };
  }
  const windowMs = windowMin * 60000;
  let nearest: ReserveLike | undefined;
  for (const reserve of reserves) {
    if (reserve.isSkip) continue;
    if (typeof reserve.startAt !== "number" || typeof reserve.endAt !== "number") continue;
    if (reserve.endAt <= nowMs) continue; // 終わった予約は対象外
    if (reserve.startAt > nowMs + windowMs) continue; // 窓の外
    if (!nearest || reserve.startAt < (nearest.startAt ?? Infinity)) nearest = reserve;
  }
  if (nearest) {
    const at = new Date(nearest.startAt!).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    return {
      blocked: true,
      reason: `${windowMin} 分以内に録画開始 (${at} ${nearest.name ?? ""})`.trim(),
    };
  }
  return { blocked: false };
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} が ${response.status} を返しました`);
  return response.json();
}

/**
 * EPGStation へ問い合わせてガード判定する。到達不能は 1 回だけリトライし、
 * それでも駄目なら fail-closed で blocked を返す。
 */
export async function checkRecordingGuard(
  config: GuardConfig,
  nowMs: number = Date.now(),
  fetchImpl: typeof fetchJson = fetchJson,
): Promise<GuardDecision> {
  if (!config.enabled) return { blocked: false };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // isHalfWidth が無いと EPGStation が 400 を返すので必須
      const recording = (await fetchImpl(
        `${config.apiBase}/api/recording?isHalfWidth=true`,
        5000,
      )) as { records?: unknown[]; total?: number };
      const recordingCount =
        typeof recording.total === "number" ? recording.total : (recording.records?.length ?? 0);
      const reservesData = (await fetchImpl(
        `${config.apiBase}/api/reserves?isHalfWidth=true`,
        5000,
      )) as { reserves?: ReserveLike[] };
      return evaluateGuard(recordingCount, reservesData.reserves ?? [], nowMs, config.windowMin);
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return {
    blocked: true,
    reason: `EPGStation API に到達できないため今回はスキップ (fail-closed): ${message}`,
  };
}
