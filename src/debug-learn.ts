/** learn の中身を診断する使い捨てスクリプト */
import { spawn } from "node:child_process";

import { CORNERS, pickArea, regionOf } from "./core/logo-area";
import {
  addFrame,
  coherence,
  cropOrientation,
  emptyOrientation,
  findArea,
  framer,
} from "./core/logo-detect";
import { probe } from "./detect";

const input = process.argv[2]!;
const p = await probe(input);
const { width, height, duration } = p;
console.log("probe", p);
const band = Math.round(height / 5) & ~1;
const top = emptyOrientation(width, band);
const bottom = emptyOrientation(width, band);
const every = Math.max(0.5, duration / 600);
const cropTo = (rect: { x: number; y: number; width: number; height: number }) =>
  `crop=iw*${rect.width}/${width}:ih*${rect.height}/${height}:iw*${rect.x}/${width}:ih*${rect.y}/${height}:exact=1,scale=${rect.width}:${rect.height}`;
let fed = 0;
const feed = framer(width * band * 2, (bytes) => {
  fed++;
  addFrame(top, bytes, 0, width);
  addFrame(bottom, bytes, width * band, width);
});
const args = [
  "-hide_banner", "-nostats", "-v", "error",
  "-skip_frame", "nokey",
  "-i", input,
  "-an", "-sn", "-dn",
  "-vf",
  `fps=1/${every.toFixed(3)},split[a][b];` +
    `[a]${cropTo({ x: 0, y: 0, width, height: band })}[t];` +
    `[b]${cropTo({ x: 0, y: height - band, width, height: band })}[u];` +
    `[t][u]vstack,format=gray`,
  "-frames:v", "600",
  "-f", "rawvideo", "pipe:1",
];
const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
proc.stdout.on("data", (c: Buffer) => feed(c));
proc.stderr.on("data", (c: Buffer) => process.stderr.write(c));
const code = await new Promise((r) => proc.on("close", r));
console.log("ffmpeg code", code, "frames fed", fed, "top.count", top.count, "bottom.count", bottom.count);
console.log("findArea:", findArea({ top, bottom }, width, height));
for (const corner of CORNERS) {
  const region = regionOf(corner, width, height);
  const isTop = corner.startsWith("top");
  const bandO = isTop ? top : bottom;
  const y = isTop ? region.y : region.y - (height - bandO.height);
  if (y < 0 || y + region.height > bandO.height) {
    console.log(corner, "skip (outside band)");
    continue;
  }
  const strength = coherence(cropOrientation(bandO, { ...region, y }));
  let max = 0;
  for (const v of strength) if (v > max) max = v;
  const picked = pickArea(strength, region, width, height, 0.15);
  console.log(corner, "max coherence", max.toFixed(3), "pickArea:", picked);
}
