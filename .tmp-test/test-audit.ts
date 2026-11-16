import { auditLogoEvidence, perSecondScores, validateMaterial } from "../src/audit";

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
};

// 1. はぐれ刑事型: 227 秒で 0.85 に立ち上がり平坦に続く → 要確認窓が 250 秒を含む
{
  const scores = new Array<number>(3600).fill(0.1);
  for (let i = 227; i < 600; i++) scores[i] = i % 2 === 0 ? 0.84 : 0.86;
  const audit = auditLogoEvidence({
    duration: 3600,
    scores,
    logoOn: [{ start: 227.2, end: 590 }],
    silences: [{ start: 226.83, end: 227.26 }],
    scenes: [227.21],
  });
  check("hagure valid", audit.valid);
  check("hagure onset 227", audit.suspiciousOnsets.includes(227));
  check(
    "hagure window covers 250",
    audit.reviewWindows.some((r) => r.start <= 250 && r.end >= 250),
  );
  check("hagure sparse-silence", audit.reasons.includes("sparse-silence"));
}

// 2. NaN は材料不正として保留 (0 に化けさせない)
{
  const scores = new Array<number>(120).fill(0.5);
  scores[10] = Number.NaN;
  const errors = validateMaterial({ duration: 120, scores, logoOn: [], silences: [], scenes: [] });
  check("nan invalid", errors.includes("score-missing-or-out-of-range"));
}

// 2b. 実測の相関スコア (わずかに負) は材料不正にしない
{
  const scores = new Array<number>(120).fill(-0.02);
  const errors = validateMaterial({ duration: 120, scores, logoOn: [], silences: [], scenes: [] });
  check("negative correlation scores ok", !errors.includes("score-missing-or-out-of-range"));
}

// 3. 配列長不足は補完しない
{
  const errors = validateMaterial({
    duration: 3600,
    scores: new Array<number>(100).fill(0.5),
    logoOn: [],
    silences: [],
    scenes: [],
  });
  check("length mismatch", errors.includes("score-length-mismatch"));
}

// 4. 被覆率 49% はそれだけで不良扱いしない
{
  const audit = auditLogoEvidence({
    duration: 1000,
    scores: new Array<number>(1000).fill(0.9),
    logoOn: [{ start: 0, end: 490 }],
    silences: Array.from({ length: 40 }, (_, i) => ({ start: i * 25, end: i * 25 + 0.5 })),
    scenes: [],
  });
  check("coverage 0.49 no flag", audit.valid && !audit.reasons.includes("coverage-needs-review"));
  check("coverage value", audit.coverage !== null && Math.abs(audit.coverage - 0.49) < 1e-9);
}

// 5. 重複区間は被覆率を二重計上しない
{
  const audit = auditLogoEvidence({
    duration: 100,
    scores: new Array<number>(100).fill(0.9),
    logoOn: [
      { start: 0, end: 50 },
      { start: 25, end: 75 },
    ],
    silences: Array.from({ length: 10 }, (_, i) => ({ start: i * 10, end: i * 10 + 0.5 })),
    scenes: [],
  });
  check("overlap merged coverage 0.75", audit.coverage !== null && Math.abs(audit.coverage - 0.75) < 1e-9);
}

// 6. perSecondScores: 秒ごとの平均 / コマの無い秒は null
{
  const ok = perSecondScores([0.0, 0.5, 1.0, 1.5, 2.0, 2.5], [0.2, 0.4, 0.6, 0.8, 1.0, 1.0], 3);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  check("perSecond means", ok !== null && near(ok[0]!, 0.3) && near(ok[1]!, 0.7) && near(ok[2]!, 1.0));
  const gap = perSecondScores([0.0, 0.5, 2.0, 2.5], [0.2, 0.4, 1.0, 1.0], 3);
  check("perSecond gap null", gap === null);
  const tail = perSecondScores([0.0, 0.5, 1.0, 1.5], [0.2, 0.4, 0.6, 0.8], 3);
  check("perSecond trailing trimmed", tail !== null && tail.length === 2);
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
