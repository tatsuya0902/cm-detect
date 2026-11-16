def parse(path):
    rows = []
    at = None
    for line in open(path, encoding="utf8", errors="replace"):
        if "pts_time:" in line:
            try:
                at = float(line.split("pts_time:")[1].split()[0])
            except Exception:
                at = None
        elif line.startswith("lavfi.scd.score=") and at is not None:
            rows.append((at, float(line.split("=")[1])))
            at = None
    return rows


b = parse("/tmp/prof-cuts-b")
c = parse("/tmp/prof-cuts-c")
print("frames B:", len(b), " C:", len(c))
for th in (5, 10, 20, 40):
    sb = {round(t, 1) for t, s in b if s >= th}
    sc = {round(t, 1) for t, s in c if s >= th}
    print("score>=%d: B=%d C=%d common=%d" % (th, len(sb), len(sc), len(sb & sc)))
import statistics

diffs = [abs(s1 - s2) for (t1, s1), (t2, s2) in zip(b, c) if abs(t1 - t2) < 0.05]
print(
    "paired frames:",
    len(diffs),
    "mean|dScore|:",
    round(statistics.mean(diffs), 2) if diffs else None,
    "max:",
    round(max(diffs), 1) if diffs else None,
)
