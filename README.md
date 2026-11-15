# cm-detect — KonomiTV 向け CM 検出バッチ

denpa (https://github.com/danything/denpa) の CM 判定コアを使い、録画ごとに
CM 区間を求めて、KonomiTV が取り込める `.chapter.txt` (AviUtl 形式) を
録画ファイルの横に書き出すツール。書き出し後に KonomiTV の
CMSectionsDetector を呼んで `cm_sections` へ取り込ませる。

## 仕組み

1. **材料取り** (src/scan.ts): 録画を 1 回だけデコードし、場面の切れ目
   (scdet)、無音区間 (silencedetect)、局ロゴ枠の白黒コマを取る
2. **ロゴ学習** (src/logo.ts): 局ロゴは録画から自動学習する。キーフレームを
   散らして抜き、画面上下 1/5 の帯で線の向きの揃い方を積み重ねてロゴの
   在り処と型を作る。型はチャンネルごと・解像度ごとに `models/` へ保存し、
   次の録画から育てていく。ロゴを出さない局 (読売テレビなど) では学習に
   失敗し、そのまま次の段へ落ちる
3. **判定** (src/core/cm-decide.ts): 動的計画法で「CM は 15 秒の倍数」
   「CM 中はロゴが消える」「提供表示は約 10 秒」「番組表の尺と開始位置」に
   最も合う切り分けを探す。ロゴの結果が番組の半分以上を CM にしたら捨て、
   無音と尺だけで決め直す。それも過半なら CM なしとする
4. **書き出しと取り込み** (src/main.ts): CM 区間を `.chapter.txt` にし、
   KonomiTV サーバーの venv で CMSectionsDetector を実行して取り込ませる

## 使い方

```sh
# 1 本だけ
node dist/cm-detect.mjs detect <録画TS> --channel gr061 \
  --program-length 3240 --program-start 5 --out <出力先.chapter.txt>

# バッチ (KonomiTV の API で未処理の録画を列挙して順に処理)
node dist/cm-detect.mjs batch --models <型の置き場> \
  --server-dir <KonomiTV/server へのパス>
```

AKAGI では systemd のユーザータイマー (cm-detect.timer、15 分ごと) が
バッチを回している。状態は `state.json` (処理済みファイルの一覧)。

## ビルド

```sh
esbuild src/main.ts --bundle --platform=node --format=esm \
  --target=node22 --outfile=dist/cm-detect.mjs
```

## ライセンス

このリポジトリは全体として GNU Affero General Public License v3.0
(AGPL-3.0) でライセンスします。全文は LICENSE を参照してください。

src/core/ の 3 ファイル (cm-decide.ts / logo-detect.ts / logo-area.ts) は
denpa (https://github.com/danything/denpa) の src/lib/ts から複写したものです。
src/ のそのほかのファイル (材料スキャン、ロゴ学習の glue、バッチ処理) は
KonomiTV 向けに書き起こしたもので、同じく AGPL-3.0 で公開します。
