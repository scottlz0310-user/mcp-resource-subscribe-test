# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-08-25

### Added

- `PROTOCOL_UNSUPPORTED` errorCode: 接続先が `2026-07-28` を提供できない場合に、subscribe / call 両モードで明示的に失敗する（`recommendedNextAction` にサーバー側の更新を促すヒントを含む）
- `SUBSCRIPTION_NOT_HONORED` / `SUBSCRIPTION_DISCONNECTED` / `SUBSCRIPTION_CLOSED` errorCode
- `2026-07-28` の contract test: listen → ack → `notifications/resources/updated` → `resources/read`、ack での URI 欠落、listen 拒否、stream 異常切断、legacy `initialize` の拒否（`-32022`）と GET `405`、未移行サーバーに対する negotiation 失敗

### Changed

- **BREAKING**: MCP protocol revision `2026-07-28` へ移行し、TypeScript SDK を `@modelcontextprotocol/sdk` 1.30.0（v1 系終端）から `@modelcontextprotocol/{client,core,server,node}` 2.0.0 へ手動移行（#162、横断 tracker: scottlz0310/thread-owl#165）
  - `resources/subscribe` / `resources/unsubscribe` RPC は `2026-07-28` で廃止された。購読は `subscriptions/listen` を POST し、`params.notifications.resourceSubscriptions` で URI を指定する方式に全面置換。解除は stream を閉じることで行う
  - `notifications/subscriptions/acknowledged`（ack）を待ってから通知待機に入る。ack に含まれる honored filter と要求 URI を突き合わせ、要求した URI が honor されていなければ待ち続けずに `SUBSCRIPTION_NOT_HONORED` を返す
  - listen stream が応答なしに切断された場合を異常切断として検知し、`--timeout-ms` を待たずに `SUBSCRIPTION_DISCONNECTED` を返す
  - protocol revision は `2026-07-28` に **pin** する。legacy protocol への暗黙のフォールバックは行わず、`2026-07-28` を提供できないサーバーへの接続は `PROTOCOL_UNSUPPORTED` として明示的に失敗する
  - リファレンスサーバー（`src/server/`）を stateless 化。`Mcp-Session-Id` ベースの session map を撤去し、`createMcpHandler(factory, { legacy: "reject" })` + `toNodeHandler` へ置き換え。standalone GET SSE endpoint は廃止され GET / DELETE は `405` を返す。long-lived stream 向けに `X-Accel-Buffering: no` を付与する
- **BREAKING**: subscribe モードの出力スキーマを新 protocol に合わせて変更
  - `--json`: `subscribed` / `unsubscribed` を削除し、`listenAcknowledged` / `honoredUris` / `closeReason`（`"local"` | `"graceful"` | `"remote"` | `null`）を追加
  - line-based: `subscribed` / `unsubscribed` 行を削除し、`listen-acknowledged` / `honored-uris` / `close-reason` 行を追加
  - `route` / `errorCode` / `notificationReceived` / `finalText` は互換のまま（`squirrel-notifier` はこの 4 つのみを解釈する）
- **BREAKING**: `call` モードで不明な tool 名・不正な引数は、tool 実行失敗（exit code `1` / `TOOL_ERROR`）ではなく tools/call 自体の拒否として扱い、exit code `3` / `TOOL_REQUEST_REJECTED` を返すようになった。`2026-07-28` では server が tool 実行前に `-32602` で拒否するため
- リファレンスサーバーの更新シミュレーションの起点を `resources/subscribe` の受信から `subscriptions/listen` の stream 開通に変更（新 protocol には subscribe RPC が無いため、`createMcpHandler` へ渡す `ServerEventBus` の listener 登録を購読開始のシグナルとして使う）。read を起点にすると通知の発行時点で stream が開いておらず通知が失われうる
- リファレンスサーバーが購読サイクルごとに resource の状態を version 1 へ戻すようになった（listen stream が 1 本も無い状態での `resources/read` をサイクル境界とする）。stateless 化で `store` がアプリスコープになったため、同じサーバープロセスに対する 2 回目以降の probe が更新を観測できなくなっていた
- probe クライアントの `resources/read` / `resources/list` を `cacheMode: "bypass"` に固定（SDK v2 は SEP-2549 の cache hint を尊重するため、`ttlMs > 0` を返すサーバーに対して古い内容を現在値として報告しうる）

### Fixed

- listen stream が「通知待機の合間」に切断された場合、待機側に waiter が居らず切断を取りこぼし、次の待機が `SUBSCRIPTION_DISCONNECTED` ではなく `NOTIFICATION_TIMEOUT` を返していたのを修正（切断状態を保持し、以降の待機を即座に落とす）
- SIGTERM / SIGINT 受信時、`closeAllConnections()` が MCP handler の `close()` 完了後にしか実行されず、開いている `subscriptions/listen` stream があるとサーバーが終了できなかったのを修正
- `classifyNetworkError` が `SdkError` の `data.cause` を辿らず、version negotiation 中に発生した DNS 解決失敗・接続拒否・TLS 不信頼を分類できなかったのを修正
- `classifyNetworkError` で最外周の Error オブジェクト自体に `code` プロパティ（`ERR_FETCH_FAILED` 等）が存在する場合に `cause` チェーンの探索が中断され、ネストされた `ECONNREFUSED` や `ENOTFOUND` などのエラーコードが分類できず `CALL_FAILED` に倒れる問題を修正
- リファレンスサーバーの Docker runtime stage が `pnpm install --prod` で devDependencies を除外していたため、devDependencies にしか存在しない依存（`express` ほか）を読み込めず起動できなかったのを修正

### Security

- 依存パッケージの脆弱性勧告に対応（`@modelcontextprotocol/sdk` の更新およびそれに伴う間接依存の修正）

## [0.5.0] - 2026-07-13

### Added

- TLS 証明書不信頼（`UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `DEPTH_ZERO_SELF_SIGNED_CERT` / `SELF_SIGNED_CERT_IN_CHAIN` / `CERT_HAS_EXPIRED` 等）、DNS 解決失敗（`ENOTFOUND`）、接続拒否（`ECONNREFUSED`）を、それぞれ専用の `errorCode`（`TLS_CERT_UNTRUSTED` / `DNS_LOOKUP_FAILED` / `CONNECTION_REFUSED`）に分類するようになった（#120）。これまでは `subscribe` / `call` 両モードとも `INTERNAL_ERROR` / `CALL_FAILED` に丸められ、原因の切り分けができなかった。`--json` 出力・line-based 出力（`recommended-next-action`）の両方に対処法（`NODE_EXTRA_CA_CERTS` の設定案内等）を含む `recommendedNextAction` を追加
  - `call` モードの `--json` 出力（`CallJsonOutput`）に `recommendedNextAction` フィールドを新規追加（成功時・`TOOL_ERROR` 時は `null`）

### Changed

- 動作に必要な Node.js の最低バージョンを `>=26.4.0` から `>=26.5.0` に引き上げ（Renovate #121）。`>=26.5.0` 未満の Node で `pnpm install` / `pnpm run build` を実行すると `engines` 警告が出る

### Fixed

- リファレンステストサーバーのシャットダウン処理で、生存中の接続（Streamable HTTP の SSE ストリーム等）が残っていると `httpServer.close()` が完了せず、SIGINT / SIGTERM でプロセスが終了できなかったのを修正。`closeAllConnections()` で全接続を即時切断してから終了する
- MCP `initialize` で名乗る `clientInfo.version` が `probeClient.ts` / `callClient.ts` に直書きされ、リリースで package.json の version を上げても古いまま取り残されていたのを修正。CLI は `package.json` から解決した実バージョンを `clientVersion` として明示的に渡し、ライブラリとして直接 import され `clientVersion` 未指定の場合はプレースホルダ `0.0.0` を名乗るよう変更

## [0.4.0] - 2026-07-05

### Added

- `call` サブコマンド: 任意の MCP tool を単発 `tools/call` 呼び出しして結果を stdout に出力し終了するモードを追加（#111）。subscribe と同じ `--url` / `--auth-token` / `--login` トークンキャッシュ・自動 refresh / `--timeout-ms` / `--json` を再利用
  - 引数: `--tool <name>`（必須）、`--args <json>`（省略時 `{}`）
  - exit code: 成功 `0` / tool エラー（`isError: true`）`1` / 認証エラー `2` / 通信・引数エラー `3`（`error-code`: `SERVER_URL_UNKNOWN`, `TOOL_NAME_REQUIRED`, `INVALID_ARGS`, `CALL_FAILED`, `INTERNAL_ERROR`, `AUTH_LOGIN_REQUIRED`, `AUTH_TIMEOUT`, `AUTH_REFRESH_FAILED`, `AUTH_FAILED`）
  - `--json` 出力: `{ serverUrl, tool, isError, errorCode, content }`（`content` は `CallToolResult.content` をそのまま反映）
  - 同梱テストサーバーに `echo_tool`（`call` モードのテスト用: `shouldError: true` で `isError: true` を模擬）を追加

### Fixed

- `call` モードで `runToolCall()` 完了直後に `process.exit()` を呼ぶと、Streamable HTTP transport の SSE ストリームを閉じた直後という条件で Windows 上の libuv アサーション（`!(handle->flags & UV_HANDLE_CLOSING)`, `src/win/async.c`）が確率的にクラッシュしていたのを修正。`process.exitCode` を設定して自然終了させる方式に変更
- `call` モードで `--timeout-ms` が `callTool()` にしか適用されておらず、直前の `client.connect()`（initialize）は SDK 既定の 60 秒 timeout のままだったのを修正（thread-owl review）。応答しない Streamable HTTP server に対して認証後の残り時間から単一 deadline を作り、`initialize` と `tools/call` の両方を同じ予算に束縛するよう変更。initialize がハングするケースの wall-clock 回帰テストを追加
- `call` モードの line-based（非 JSON）出力で、pre-tool-call / 認証エラー / 通信エラー時に `is-error` と `content` が欠落し、成功時と出力形状が不一致だったのを修正（Copilot review）。エラー時も `is-error true` / `content` に `null` を出力し、成功時と同じ5フィールドの形状に統一

### Internal

- `test/callClient.test.ts` を追加: `runToolCall()` / `buildCallJsonOutput()` / `buildCallErrorJsonOutput()` の in-process ユニットテスト（`test/call.test.ts` は CLI サブプロセステストのため、親プロセスのカバレッジ計測に含まれない点を補完）

## [0.3.0] - 2026-07-04

### Added

- mcp-gateway 向け認証トークンの自動取得・キャッシュ・自動更新（#102）
  - `--login` フラグ: RFC 7591 Dynamic Client Registration → RFC 8628 device authorization flow をツール単体で完結。`user-code` / `verification-uri-complete` を表示してブラウザ承認を待ち、取得したトークンをキャッシュする
  - トークンキャッシュ: `node:sqlite`（組み込み、追加依存なし）による gateway origin 単位の永続化。保存先は OS state dir（Windows: `%LOCALAPPDATA%`、macOS: `~/Library/Application Support`、Linux: `$XDG_STATE_HOME`）、`MCP_PROBE_TOKEN_STORE_PATH` で上書き可
  - 自動更新: 購読前に有効期限をチェックし（マージン5分）、期限切れなら refresh grant で無人再取得。gateway の refresh token rotation に対応し、ローテーション後のトークンを即時永続化
  - エラーコード追加: `AUTH_LOGIN_REQUIRED`（refresh token 失効・要 `--login` 再実行）/ `AUTH_REFRESH_FAILED`（gateway 側一時エラー・リトライ可）
  - 後方互換: `--auth-token` / `MCP_PROBE_AUTH_TOKEN` の明示指定は常にキャッシュより優先。`--login` 未使用の実行はキャッシュ DB を作成せず従来動作を完全維持
  - OAuth エンドポイントは RFC 8414 well-known metadata で発見し、未提供時は gateway 固定レイアウト（`/register` / `/device_authorization` / `/token`）にフォールバック
  - device flow ポーリングは RFC 8628 §3.5 準拠（`slow_down` で interval +5秒、`authorization_pending` で継続）
  - トークン値は stdout / stderr に一切出力しない
- `--logout` フラグ: 指定した gateway origin のキャッシュ済みトークンを削除（#106）。トークンストア未作成時は no-op として成功する

### Fixed

- 並行 probe プロセスが同一 refresh token で同時に refresh grant を実行する際の競合を解消（#105, thread-owl review）。gateway は使用済み refresh token の再提示を検出すると rotation family 全体を revoke するため、事後のストア再読み込みだけでは次回 refresh が結局失敗する。`TokenStore.withExclusiveLock()`（SQLite `BEGIN IMMEDIATE`）でオリジン単位の refresh をプロセス間で直列化し、ロック待機後にストアを再読み込みして既に他プロセスが更新済みならネットワーク refresh 自体をスキップするよう変更
  - `requestDeviceAuthorization()`: gateway が `verification_uri` を欠落させた場合に空文字列へフォールバックしていたのを修正。`verification_uri_complete` へのフォールバック、両方欠落時はエラーを送出するよう変更
  - CLI 非 JSON エラーパスの `phase-summary` が常に `url=unknown` を出力し `uri` も欠落していたのを修正。捕捉済みの `url` / `uri` を反映するよう変更
- gateway 側の client 登録喪失（gateway 再構築・DCR ストア消去等）からの回復導線を追加（#106, thread-owl review フォローアップ）。`invalid_client` / `unauthorized_client` を恒久エラーとして `AuthLoginRequiredError` に分類し直し（従来は「単純リトライで回復可能」な `AUTH_REFRESH_FAILED` に誤分類されていた）、`loginToGateway` は cached client_id が拒否された場合に re-register へ自動フォールバックするよう変更
  - `--logout`: 不正な `--url` を渡すと `new URL()` が未捕捉例外を投げてスタックトレースで落ちていたのを修正。加えてトークンストア未作成時は URL 検証をスキップして `exit 0` の誤成功になっていたのも修正し、両ケースとも構造化された `logout-status failed` / `error-code INVALID_URL` を返すよう変更
- auth 解決（endpoint discovery + refresh grant）が `--timeout-ms` の対象外で、応答しない gateway に対して無期限にハングし得た問題を修正（#107, thread-owl review フォローアップ）。`resolveCachedToken` の該当 fetch 呼び出しを `AbortSignal.timeout()` で同じ予算に束縛し、超過時は新しい `AuthTimeoutError` → `error-code AUTH_TIMEOUT` を返すよう変更。CLI は auth 解決に費やした時間を差し引いた残り予算を `runSubscribeProbe` に渡す
  - thread-owl の再レビューで、この AbortSignal が `withExclusiveLock()`（cross-process refresh lock）取得より前に生成されていたため、同期的なロック待ち（最大 `busy_timeout` 5秒）が予算に含まれず timeout 契約に反することが判明。デッドラインをロック取得前に確定し、ロック取得後に残り予算を再計算して signal を生成するよう修正。ロック待機だけで予算を使い切った場合は、期限切れ signal で fetch を開始せず即座に `AuthTimeoutError` を返す
  - 続く再レビューで、上記修正後も `BEGIN IMMEDIATE` 自体が同期的な SQLite 呼び出しであるため、実測 wall-clock 上は依然として接続既定の `busy_timeout`（5秒）まで戻らないことが判明（実測 `--timeout-ms 200` に対し `4644ms`）。`TokenStore.withExclusiveLock()` に `timeoutMs` を渡せるようにし、ロック取得直前に `PRAGMA busy_timeout` を一時的にその値へ変更（取得後は既定値に復元）。ロック取得自体が失敗した場合は新しい `LockTimeoutError` を送出し、`resolveCachedToken` はこれも `AuthTimeoutError` に変換する

### Internal

- `test/helpers/mockAuthServer.ts`: mcp-gateway の OAuth surface を模した in-process モック認可サーバー
- テスト追加: `tokenStore.test.ts` / `oauthClient.test.ts` / `gatewayAuth.test.ts` / `cliAuth.test.ts`（計 30 ケース超）
- `test/cli.test.ts` の子プロセスを開発者の実トークンキャッシュから分離（`MCP_PROBE_TOKEN_STORE_PATH` を一時パスに固定）
- バージョン文字列を 0.3.0 に同期（`package.json` / `src/server/mcpServer.ts` / `src/client/probeClient.ts`）
- `AGENTS.md` を日本語化し、CLI エージェント向けの位置づけ（squirrel-notifier 等からのサブプロセス呼び出し）・バージョン要件・auth 関連テストの説明を最新化

## [0.2.0] - 2026-06-09

### Added

- `--json` 出力モードを追加（#87 / #86）
  - `--json` フラグを指定すると、単一の JSON オブジェクトを stdout に出力し、診断メッセージは stderr のみに書き出す
  - `JsonOutput` 型: `{ route, serverUrl, resourceUri, subscribed, notificationReceived, notificationCount, unsubscribed, errorCode, initialText, finalText, recommendedNextAction }`
  - 成功時 exit 0、エラー時 exit 1（`errorCode` フィールドに `SERVER_URL_UNKNOWN` / `NOTIFICATION_TIMEOUT` / `INTERNAL_ERROR` 等を反映）
  - malformed な引数（`--uri` 値なし、`--timeout-ms bad` 等）でも stdout に valid JSON を出力し、スタックトレースを抑止
  - `src/client/jsonOutput.ts` にトランスフォーム関数（`buildJsonOutput` / `buildErrorJsonOutput`）を副作用なしモジュールとして分離

### Internal

- `test/cli.test.ts` を追加: CLI を子プロセスとして起動し stdout / stderr / exit code を直接検証（8 ケース）
- CLI サブプロセステストを `node --import tsx/esm` でソース直接起動に変更し、fresh checkout での `pnpm test` 単独実行を保証

## [0.1.4] - 2026-05-29

### Changed

- リポジトリの package manager を npm から pnpm に移行
  - `packageManager` で `pnpm@11.4.0` を固定
  - `package-lock.json` を削除し、`pnpm-lock.yaml` を唯一の lockfile として採用
  - CI / Docker / lefthook / README / AGENTS.md の実行コマンドを pnpm 前提に更新
- `pr-review-subscribe` skill: `Copilot route / Human Review Mode` の二分法を廃止し、provider 抽象化 + Unified Review Thread Handling に再設計（#67）
  - `provider = auto | copilot-review | codex | external | existing` を Phase 0 で選択
  - Phase H1–H6 を廃止し、provider 非依存の Phase U1–U6 (Unified Review Thread Handling) に置き換え
  - Phase 2/5/6 (CRM-based thread handling) を廃止し、すべての provider で `gh api graphql` による統一スレッド処理を使用
  - Phase 1S は copilot-review 取得専用として維持
  - Phase W を新設: codex (`@codex review` コメント投稿) / external / human (ユーザー signal 待ち) に対応
  - Phase U6 に re-review policy を実装: copilot-review → structured ループ (max cycles)、その他 → message-based (`WAITING_FOR_REVIEW`) で停止
  - `termination_status` に `WAITING_FOR_REVIEW(provider=...)` を追加
  - Phase 7 Summary に `acquisition provider`・`re-review mode`・`re-review status`・`cycles done` フィールドを追加
  - Phase 8 Merge Gate に `WAITING_FOR_REVIEW` 状態のチェックを追加
- `pr-review-subscribe` skill: Phase U6 に `need_re_review` 判定を追加（PR #68 レビュー指摘対応）
  - `unresolved = 0` だけで READY_TO_MERGE に進まず、`fix_type` と `blocking` accept の有無で `need_re_review` を判定
  - `fix_type = logic | spec_change` または `blocking` accept が 1 件以上あれば re-review を要求
  - `fix_type = none | trivial` の場合のみ即 READY_TO_MERGE
  - Issue #36 override を「`need_re_review = no` の場合のみ適用」と明確化

### Internal

- npm publish を Trusted Publishing (OIDC) に移行（`id-token: write` 追加、`NPM_TOKEN` 撤廃、`npm publish --provenance --access public` に統一）(#72)
- バージョン文字列を 0.1.4 に同期（`package.json` / `src/server/mcpServer.ts` / `src/client/probeClient.ts`）

## [0.1.3] - 2026-05-17

### Changed

- `pr-review-subscribe` skill: scope-out / deferred reject を完了扱いにする際の追跡 Issue 必須化ルールを `docs/skills/pr-review-subscribe/SKILL.md` に追加（#51）
  - Required Surfaces に `{GH}:create_issue` を追加（follow-up issue 作成を skill 仕様として明示）
  - Phase 3 decision table に `Follow-up issue` 列を追加し、`out-of-scope` / `deferred` / `follow-up` reject では issue 番号必須と明記
  - Phase 5 に reject 種別ごとの返信ルールを追加（既存Issue流用禁止、新規issue作成手順、`Won't fix` の扱い、Issue作成不可時はthread未resolveまたは`needs user decision`で停止）
  - Phase 7 Summary に `### Deferred / Scope-out Items` セクションを新設し、`- None` 可とする条件を明確化

### Fixed

- `mcp-resource-subscriber` CLI/probe は `recommended_next_action=POLL_AFTER` を非終端として扱い、同じ subscription を維持して次の `notifications/resources/updated` を待つようになりました（#52）
- `POLL_AFTER` 後の `resources/read` 中に届いた次の通知を消費済みにせず、終端更新を取りこぼさないようにしました

## [0.1.2] - 2026-05-15

### Changed

- `pr-review-subscribe` skill: extended termination classification taxonomy in `docs/skills/pr-review-subscribe/SKILL.md` (closes #36)
  - Phase 6 now records `termination_status` as one of `READY_TO_MERGE`, `ESCALATE — Clean`, or `ESCALATE — Unverified Fix`
  - Phase 7 summary template surfaces the classification, unverified blocking commit SHA(s), and a human-review recommendation when applicable
  - Phase 8 merge gate downgrades merge readiness on `ESCALATE — Unverified Fix` regardless of CI status
- Distinguishes safe ESCALATE (max cycles reached with only non-blocking items) from risky ESCALATE (final cycle accepted a blocking fix that Copilot has not re-reviewed)

### Notes

- Spike-to-CLI transition completed (closes #19); all 7 subtasks (#22, #24, #26, #27, #28, #29, #30) had already shipped
- No functional behavior changes in this release; bumps internal version strings (observable via MCP `initialize` handshake) to keep `package.json`, `src/server/mcpServer.ts`, and `src/client/probeClient.ts` in sync per the CHANGELOG 0.1.0 note

## [0.1.1] - 2026-05-14

### Changed

- `pr-review-subscribe` skill: probe commands updated from `npm run probe:subscribe` / local `node dist/` invocations to `pnpm dlx mcp-resource-subscriber` (published package)
- `pnpm dlx` established as primary invocation, `npx` as fallback when pnpm is unavailable — consistently across README, SKILL.md, and `tool-template.md`
- Version-pinning note clarified: "default to latest published version"; added `@<version>` pinning example for reproducible probes

### Fixed

- README Install section: reordered to show `pnpm dlx` first, `npx` as fallback
- `tool-template.md` Local SDK Wrapper Pattern: added `pnpm dlx` primary and `npx` fallback commands alongside the existing `node` local-build option

## [0.1.0] - 2026-05-14

### Added

- CLI probe (`mcp-resource-subscriber`) for MCP `resources/subscribe` — connects to any MCP Streamable HTTP server, subscribes to a resource, receives `notifications/resources/updated`, and re-reads the updated content
- Structured machine-parseable output: `route`, `subscribed`, `notification-received`, `unsubscribed`, `error-code`, `phase-summary`
- `--auth-token` / `MCP_PROBE_AUTH_TOKEN` for Bearer token auth (e.g. `copilot-review-mcp`)
- `--skip-resource-list-check` / `MCP_PROBE_SKIP_LIST_CHECK` for servers with dynamic resources not in `resources/list`
- `--timeout-ms` / `MCP_PROBE_TIMEOUT_MS` configurable notification wait (default: 15 s)
- `--version` / `--help` flags
- Bundled reference MCP test server (`test://review/status`) for reproducible client compatibility testing
- GitHub Actions publish workflow: triggers on `v*` tag push; runs build → typecheck → test → `npm publish`
- `workflow_dispatch` manual trigger for dry-run verification
- E2E test suite (`test/e2e.test.ts`) verifying Level 3 subscribe→notify→re-read flow against a live MCP server
- Compatibility matrix covering Codex CLI, Gemini CLI, OpenCode, GitHub Copilot CLI, Claude Code, Goose, Crush

### Notes

- `src/server/mcpServer.ts` contains a hardcoded version string (bundled test server, not part of the published npm package). This must be updated manually on each version bump. `src/client/probeClient.ts` / `src/client/callClient.ts` resolve their version dynamically from `package.json` as of v0.5.0 and no longer need manual updates.

[Unreleased]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/scottlz0310/mcp-resource-subscriber/releases/tag/v0.1.0
