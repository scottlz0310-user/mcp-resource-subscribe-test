# AGENTS.md

## プロジェクトの目的

本リポジトリは、MCP `resources/subscribe` の**互換性検証スパイク**として開始した。CLI AI エージェント（Codex, Gemini, Claude Code, Crush 等）が MCP resource subscription を正しく処理できるかを、再現可能な形でテストするためのものである。この検証フェーズは既に完了しており、現在は以下の 2 つの実運用向けコンポーネントを提供する:

1. **CLI probe**（`mcp-resource-subscriber`、`src/client/cli.ts`）— CLI エージェントのワークフローや外部ツール（例: `squirrel-notifier`）が、MCP resource を subscribe して `notifications/resources/updated` を待ち、結果を構造化された stdout/JSON として報告させるために呼び出す、公開済みのサブプロセス。**protocol revision は `2026-07-28` に pin しており、legacy へフォールバックしない**（#162）。mcp-gateway 向け認証（`--login` / `--logout`、キャッシュ済みトークンの自動更新）も担い、これらの呼び出し元がトークンを手動で用意する必要をなくす。`call` サブコマンド（`--tool` / `--args`）は、subscribe とは別に任意の MCP tool を単発 `tools/call` 呼び出しして即終了するモードで、同じ認証経路を再利用する（#111）。
2. **リファレンス MCP Streamable HTTP サーバー**（`src/server/`）— stateless（`legacy: "reject"`）。1 つの resource（`test://review/status`）を公開し、最初の `resources/read` を起点に更新をシミュレートして、開いている `subscriptions/listen` stream へ `notifications/resources/updated` を配信する。probe クライアントのローカル / Docker テスト用に維持されており、本番トラフィック向けではない。

## 必須コマンド

```bash
pnpm install --frozen-lockfile # 依存関係のインストール
pnpm run build                 # tsc コンパイル → dist/
pnpm test                      # vitest run（in-process サーバーに対するテスト、Docker 不要）
pnpm run test:coverage         # vitest run --coverage
pnpm run typecheck             # tsc --noEmit（出力ファイルなし）
pnpm run check                 # biome check .（lint + フォーマットチェック）
pnpm run format                # biome format --write .
pnpm run dev                   # tsx でサーバーをローカル実行（ビルド不要）
pnpm run start                 # コンパイル済み dist/ からサーバーを実行（本番エントリ）
pnpm run probe:subscribe -- --url http://127.0.0.1:8089/mcp  # 稼働中サーバーに対して probe クライアントを実行
docker compose up --build      # ポート 8089 でリファレンスサーバーを起動
```

**Node 要件**: `>=26.4.0`（`package.json` の engines と CI で強制）。
**パッケージマネージャ**: `pnpm@11.8.0`（`packageManager` で固定。`pnpm-lock.yaml` が唯一の lockfile）。

## アーキテクチャ

```
src/
  server/
    index.ts         — エントリポイント: 環境設定を読み込み、Express HTTP サーバーを起動
    config.ts        — TestConfig 型 + configFromEnv()（全環境変数をここでパース）
    httpServer.ts    — createMcpHttpApp(): createMcpHandler（legacy: "reject"）+ toNodeHandler を Express にマウントし、{ app, close } を返す。resource の状態と更新シミュレーションは McpServer がリクエストごとに作り直されるためここ（アプリスコープ）に置く
    mcpServer.ts     — createProbeServer(): MCP ハンドラを登録（list/read + tool）。2026-07-28 に resources/subscribe RPC は無く、通知配信は handler.notify.resourceUpdated() が担う
    resourceState.ts — ReviewStatusStore（in-memory、version 1→2）、renderReviewStatus()、定数
    logger.ts        — createConsoleLogger(config): logLevel が 'silent' でない限り全行を出力する LogSink を返す（レベル階層フィルタなし）
  client/
    probeClient.ts   — runSubscribeProbe(): 全フローを実行し型付き結果を返す SDK クライアント（subscriptions/listen → ack 検証 → 通知待機 → 再 read → stream close）
    protocolNegotiation.ts — protocol revision を 2026-07-28 に pin する Client オプションと connectPinned()。negotiation 失敗を ProtocolNegotiationError に正規化する（ネットワーク起因は素通し）
    callClient.ts    — runToolCall(): call サブコマンド用、単発 tools/call を実行し型付き結果を返す SDK クライアント
    callJsonOutput.ts — call サブコマンドの --json 出力スキーマ（CallJsonOutput）
    cli.ts           — 公開 bin エントリ; --url, --uri, --auth-token, --login, --logout, --skip-resource-list-check, --timeout-ms に加え `call` サブコマンド（--tool, --args）をサポート
    auth/
      tokenStore.ts  — node:sqlite トークンキャッシュ（gateway origin 単位で 1 行、OS state dir、0600）; withExclusiveLock() は任意の timeoutMs を受け取り、BEGIN IMMEDIATE の同期的な待機がそれを超えないよう busy_timeout を一時的に下げる（LockTimeoutError を送出）
      oauthClient.ts — RFC 8414 discovery / RFC 7591 DCR / RFC 8628 device flow / refresh grant（fetch + sleep を注入可能）
      gatewayAuth.ts — loginToGateway() と resolveCachedToken()（rotation 永続化を伴う自動 refresh）

scripts/
  subscribe-client.ts  — CLI 引数で runSubscribeProbe() を呼び出し、結果を表示する薄いラッパー

test/
  mcp-resource-subscribe.test.ts  — vitest 統合テスト（ポート 0 で in-process サーバーを起動）
  cli.test.ts                     — CLI サブプロセステスト: --json モード、不正な引数、exit code
  e2e.test.ts                     — 外部 copilot-review-mcp サーバーに対する E2E テスト（環境変数が必要）
  tokenStore.test.ts              — 一時 SQLite ファイルに対するトークンキャッシュ CRUD; withExclusiveLock() のロック挙動
  oauthClient.test.ts             — in-process モック認可サーバーに対する device flow / refresh
  gatewayAuth.test.ts             — login + キャッシュ済みトークン解決（refresh, rotation, re-login エラー, AUTH_TIMEOUT）
  cliAuth.test.ts                 — CLI サブプロセス認証統合（--login, --logout, キャッシュ優先順位, AUTH_LOGIN_REQUIRED, AUTH_TIMEOUT）
  call.test.ts                    — call サブコマンドの CLI サブプロセステスト（引数パース、成功、tool エラー、認証エラー、通信エラー、exit code 0/1/2/3）
  helpers/mockAuthServer.ts       — mcp-gateway の OAuth surface を模した express モック
```

## 主要パターン

**サーバー/クライアント二重構成のリポジトリ**: `src/server/`（サーバー）と `src/client/`（クライアント）はどちらも第一級の存在。サーバーは Docker / 手動テスト用であり、probe クライアントはパッケージ内に公開され（`dist/src/client/probeClient.js`）、CLI bin は `dist/src/client/cli.js`。

**`createProbeServer()` は subscribe 時のみ更新をトリガーする**: `scheduleUpdate()` は `SubscribeRequestSchema` ハンドラ内で呼ばれる。タイマーは `updateDelaySeconds` 秒後に発火する。テストではこれを `0.05` に設定して高速化している — テストで本番デフォルト（5秒）を使わないこと。

**Subscription セットは in-memory かつサーバーインスタンス単位**: `subscriptions` は各 `createProbeServer()` 呼び出しにローカルな `Set<string>`。各テストはポート 0 で新しいサーバーインスタンスを作成する。

**`McpServer` と `McpServer.server` の違い**: SDK の `McpServer`（高レベル）は低レベルの `server` プロパティをラップしている。`registerTool()` は高レベルラッパー上にあるが、resources/subscribe/unsubscribe 用の `setRequestHandler()` は高レベル API が公開していないため `.server` を直接呼び出す必要がある。`sendResourceUpdated()` も `.server` 上にある。

**import は `.js` 拡張子を使う**: TypeScript は `moduleResolution: NodeNext` でコンパイルされる。`.ts` ソースファイル内であっても、相対 import はすべて `.js` で終える必要がある。

**`tsconfig.json` の `rootDir` は `.`**: `src/`、`test/`、`scripts/` はいずれも同じサブディレクトリ構成を保ったまま `dist/` にコンパイルされる。`dist/src/client/cli.js` が公開 bin エントリ。

## 設定（環境変数）

### リファレンスサーバー（`src/server/`）

| 変数 | デフォルト | 備考 |
|---|---|---|
| `MCP_TEST_PORT` | `8089` | |
| `MCP_TEST_PATH` | `/mcp` | 第二のパスエイリアスを追加; `/mcp` は常に登録される |
| `MCP_TEST_UPDATE_DELAY_SECONDS` | `5` | 高速なローカルテストには `0` または `0.05` を設定 |
| `MCP_TEST_INITIAL_STATUS` | `pending` | |
| `MCP_TEST_UPDATED_STATUS` | `reviewed` | |
| `MCP_TEST_SEND_LIST_CHANGED` | `false` | 更新後に `notifications/resources/list_changed` も送信 |
| `MCP_TEST_LOG_LEVEL` | `debug` | `debug`/`info`/`warn`/`error`/`silent` |

### CLI probe（`src/client/cli.ts`）

| 変数 | デフォルト | 備考 |
|---|---|---|
| `MCP_PROBE_URL` | — | `--url` で上書き |
| `MCP_PROBE_URI` | `test://review/status` | `--uri` で上書き; デフォルト値は同梱テストサーバーに対してのみ意味を持つ |
| `MCP_PROBE_AUTH_TOKEN` | — | Bearer トークン; `--auth-token` で上書き（こちらの環境変数を推奨 — フラグはプロセス一覧やシェル履歴に漏れる） |
| `MCP_PROBE_TOKEN_STORE_PATH` | OS state dir（下記 gateway auth precedence を参照） | SQLite トークンキャッシュのパスを上書き; テストはこれによる分離に依存している |
| `MCP_PROBE_TIMEOUT_MS` | `15000` | `--timeout-ms` で上書き |
| `MCP_PROBE_SKIP_LIST_CHECK` | `false` | `--skip-resource-list-check` で上書き |

## テスト

**サーバー/probe 統合テスト**（`mcp-resource-subscribe.test.ts`）は `createMcpHttpApp()` を使ってポート `0`（OS 割り当て）で実際の HTTP サーバーを起動し、実際の MCP SDK クライアントを接続する。transport やプロトコルのモックは行わない。テストは `afterEach` で全サーバー・クライアントをクローズする。

テスト設定内の `updateDelaySeconds: 0.05` は重要 — テスト内の通知タイムアウトは 2000ms なので余裕があるが、本番のディレイ（5秒）ではテストが遅くなる。

3 つのテストケース:
1. `get_review_status` ツールが list され、呼び出し可能であること
2. subscribe→notify→re-read の全フローをログアサーション付きで検証
3. `runSubscribeProbe()` probe クライアントをエンドツーエンドで検証

**Gateway auth テスト**（`tokenStore.test.ts` / `oauthClient.test.ts` / `gatewayAuth.test.ts` / `cliAuth.test.ts`、計 30 ケース超）は、`helpers/mockAuthServer.ts`（mcp-gateway の OAuth surface を模した in-process Express モック）に対して OAuth device flow・トークンキャッシュ・refresh/rotation・CLI サブプロセスの挙動を検証する。`cliAuth.test.ts` は接続は受け付けるが応答しない生の `node:http` サーバーも起動し、`AUTH_TIMEOUT` を検証する。

## 成果物とドキュメント

- `results/compatibility-matrix.md` — Round 1 互換性マトリクス（resource のみのテスト）
- `results/compatibility-matrix-v2.md` — Round 2 互換性マトリクス（tool + resource テスト、最新）
- `results/` — 各エージェントテスト実行のセッションログ
- `docs/verification-guide.md` — Round 1 手動検証手順
- `docs/verification-guide-v2.md` — Round 2 手動検証手順（最新）
- `docs/skills/pr-review-subscribe/SKILL.md` — subscribe 経由の PR レビュー用 Codex skill テンプレート

## CLI の状態

`src/client/cli.ts` は公開 bin エントリ（`dist/src/client/cli.js`）。`--url`、`--uri`、`--auth-token`、`--login`、`--logout`、`--skip-resource-list-check`、`--timeout-ms`、`--version`、`--help` をサポートする。実際の probe 機能は `src/client/probeClient.ts` にある。

**`call` サブコマンド**（第一引数が `"call"` の場合、`src/client/cli.ts` 内 `runCallCommand()`）: `--url`、`--tool`、`--args`（JSON、省略時 `{}`）、`--auth-token`、`--timeout-ms`、`--json` を受け取り、`initialize` → `tools/call` → 結果を stdout に出力して終了する（実体は `src/client/callClient.ts` の `runToolCall()`）。認証は subscribe と同じ `resolveBearerToken()` / token cache / auto-refresh をそのまま再利用する。exit code は成功 0 / tool エラー(`isError: true`) 1 / 認証エラー 2 / 通信・引数エラー 3 の 4 値に分かれ、subscribe モードの「常に 0 か 1」とは異なる（squirrel-notifier 等の呼び出し元が stdout をパースせず `$?` だけで分岐できるようにするため）。**注意**: `runToolCall()` の呼び出し完了後（`client.close()` 後）は `process.exit()` を呼ばず `process.exitCode` を設定して自然終了させること — Streamable HTTP transport の SSE ストリームを閉じた直後に `process.exit()` すると、Windows 上で libuv のアサーション（`!(handle->flags & UV_HANDLE_CLOSING)`, `src/win/async.c`）が確率的にクラッシュを起こす。ネットワーク I/O を伴わない早期のバリデーションエラー（`--url`/`--tool` 未指定、`--args` の JSON 不正、`--timeout-ms` 不正）も同様に `process.exitCode` 方式に統一している。

**Gateway auth の優先順位**（`src/client/auth/`）: 明示的な `--auth-token` / `MCP_PROBE_AUTH_TOKEN` は常に優先される; そうでなければ `--url` の origin に対する SQLite トークンキャッシュが参照される（rotation 永続化を伴う自動 refresh）; probe の実行はキャッシュを作成しない — 作成するのは `--login` のみ。`MCP_PROBE_TOKEN_STORE_PATH` はキャッシュパスを上書きする（テストはこれによる分離に依存）。`--logout` は `--url` の origin に対応するキャッシュ済みエントリを削除する（ストアが未作成なら no-op）。gateway からの `invalid_client` / `unauthorized_client`（例: 再構築後）は `AuthLoginRequiredError` として扱われ、`loginToGateway` はキャッシュ済み `client_id` が拒否された場合に re-register へ自動フォールバックする。`resolveCachedToken` の refresh パス — cross-process ロック待機 *および* ネットワーク呼び出し（endpoint discovery + refresh grant）— は同じ `--timeout-ms` 予算に束縛される: デッドラインは `withExclusiveLock()` 取得前に計算され、`withExclusiveLock()` 自身がその `timeoutMs` を受け取って SQLite の `busy_timeout` を一時的に下げることで `BEGIN IMMEDIATE` の同期待機がそれを黙って超過できないようにする（超過時は `LockTimeoutError` を送出）。ネットワーク呼び出しに渡される `AbortSignal.timeout()` は、ロック取得後に残った予算を使う（既に使い切っている場合は、失敗が確定しているネットワーク呼び出しを開始せず即座に失敗する）。いずれかの上限を超えると `AuthTimeoutError` → `error-code AUTH_TIMEOUT` を送出し、CLI は auth 解決に費やした時間を差し引いた残り予算を `runSubscribeProbe` に渡す。

## シークレットとログの扱い

ログ、コマンド出力、PR 説明、issue コメント、レビューサマリ、E2E レポートを GitHub に投稿する前に、すべてのシークレットを redact すること。

以下のような生の値を絶対に貼り付けないこと:

- GitHub トークン: `ghp_`、`gho_`、`github_pat_`
- npm トークン: `npm_`
- Bearer トークンや OAuth トークン
- `Authorization:` ヘッダーの値
- `MCP_PROBE_AUTH_TOKEN`、`MCP_E2E_TOKEN`、`NODE_AUTH_TOKEN`
- cookie、セッション ID、refresh token、秘密鍵、client secret

代わりにプレースホルダーを使うこと:

- `<redacted>`
- `<token>`
- `Bearer <redacted>`
- コマンド例では `$(gh auth token)`

シークレットが誤って公開投稿された場合、後で編集して消したとしても漏洩したものとして扱うこと。直ちにトークンをローテーション・失効させ、公開テキストをプレースホルダーに置き換える。

PR、issue、コメント、コミット済みログに生の環境変数ダンプを含めないこと。

E2E のエビデンスでは、プロトコルの事実は残しつつ認証情報は redact すること:

- 残す: サーバー URL、resource URI、route、subscribed、notification-received、unsubscribed、error-code、phase-summary
- redact する: Authorization ヘッダー、トークン値、cookie、セッション、OAuth レスポンス、refresh token
