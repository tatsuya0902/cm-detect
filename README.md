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

## 字幕信号の実験 (既定では無効)

字幕 (ARIB) パケットの流れも判定材料になるかを試した記録。字幕テキストは
デコードせず、パケットの到着間隔だけを見る (本編は字幕パケットが密に届き、
CM 中は細い管理パケットが約 15 秒間隔で届くだけになる、という実測に基づく)。
実装は src/captions.ts (字幕が流れている区間の抽出) と
src/caption-decide.ts (字幕の空白 + 無音 + 尺での判定)。

2026-11-15 の実録画での結果は否定的だった:

- 中京テレビ「キャッチ！」: 字幕判定と合流させたことで、正しく拾えていた
  2 分の CM 区間が見落としになった
- MBS「それ Snow Man にやらせて下さい」: 候補が 10 区間から 16 区間に増え、
  増えた分は歌や VTR など字幕の無い本編を拾った誤検出とみられる

バラエティ・ニュースは本編でも字幕が途切れる場面が多く、「字幕の空白 = CM」
が成り立たないため。想定していた「ロゴを出さない局のドラマ」では効く可能性が
残るため、環境変数 `CM_DETECT_CAPTIONS=1` を付けたときだけ合流させる形で
コードは残してある (既定では字幕パケットも読まない)。

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

## 検出器の版 2026-11-16.2 で入れたもの

- **材料の完全性チェック**: ロゴ枠のバイト数・コマ数・メタデータ側のコマ数が
  一致しない材料は、ロゴだけを無効化して残りの材料で判定する (型の育成もしない)。
  バッチはロックで同時実行を 1 つに絞る
- **ロゴ材料の監査** (`src/audit.ts`): 秒ごとのロゴスコアなど今ある材料から
  「要確認区間」を抽出する。誤認を断定するものではなく、人手でフレームを
  確認すべき場所の入口。diagnose の出力とバッチの状態記録に含まれる
- **型の台帳** (`models/registry.json`): 型ごとに版・出自 (学習元の録画)・
  状態 (仮登録 / 昇格 / 隔離) と使われ方 (被覆率・監査理由) を記録する。
  `models` で一覧、`model-promote` / `model-quarantine` / `model-release` で
  状態変更。隔離中の型は検出に使われない。昇格は自動では行わない
- **無音の無い強い切れ目も境界候補に** (ロゴ経路のみ): 無音が乏しい素材でも
  境目の置き場所を用意するため。無音の長さを持たない分、減点は満額かかる

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
