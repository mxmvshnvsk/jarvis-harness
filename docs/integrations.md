# Интеграции: модели, MCP, IDE, credentials

## Модели (ADR-0007, ADR-0017 §2)

`ModelGateway` — единственная дверь к LLM. Через неё проходят:

1. **Роутер по ролям** — для роли агента берётся первая модель из `roles.<role>.models`, которая
   удовлетворяет требованиям агента (`tools`, `structuredOutput`) по данным `supports:` и проб, и
   правилу egress для `dataClass` проекта.
2. **Бюджет** — допуск по окну пула квот (`quotaPools`), мягкий порог `soft`, лимиты `budget.perRun` и
   `perStep`; при исчерпании run паркуется в `WAITING_BUDGET` с `resumeAfter` (ADR-0018 §4–5).
3. **Транспорт** — credential подставляется только здесь (`auth.token` → заголовок); тело запроса не
   содержит секретов.
4. **Повторы** — ограниченные, с классификацией ошибок: quota / rate-limit (с `Retry-After`) / transient /
   policy (ADR-0011 §1).
5. **Учёт** — `usage` и события `model.call|retry|error` с токенами, длительностью, cassette-ключом.
6. **Кассеты** — режимы `live | record | replay` для тестов и evals (ADR-0012 §4).
7. **Оценка токенов** — самокалибрующаяся по фактическому `usage` (ADR-0013 §3).

Провайдеры: `openai-compatible` (корпоративные шлюзы, vLLM, DeepSeek, Qwen), `openai`, `ollama` — все
через диалект chat-completions; `anthropic` зарезервирован (адаптера пока нет). Структурный вывод —
`schema` (json_schema), `json` (json mode) или `text` с ограниченным ремонтом невалидного JSON — по тому,
что модель реально поддерживает (`jarvis models probe`).

`probe` даёт каждой канарейке 512 токенов вывода: модель с рассуждением (DeepSeek-V4-Flash) тратит
бюджет на размышление, и при 16 токенах ответ был пустым. Ответ, обрезанный до какого-либо содержимого,
— «не определено» (`?`, не drift); неверный ответ показывается текстом. Недоступная модель — ошибка
команды, результат не сохраняется.

Сетевая ошибка называет корневую причину из цепочки `cause` (`fetch failed (SELF_SIGNED_CERT_IN_CHAIN: …)`)
и подсказку. Корпоративный шлюз с внутренним CA: `NODE_OPTIONS=--use-system-ca` (Node берёт CA из
системного хранилища) или `NODE_EXTRA_CA_CERTS=<ca.pem>`; отключать проверку TLS не нужно.

Embeddings для семантического поиска — та же конфигурация модели с `/embeddings`
(`knowledge.retrieval.embeddings: <id>`).

## MCP-клиент (ADR-0017 §3–4)

Jarvis подключает MCP-серверы по официальному TypeScript SDK: `stdio`, streamable `http`, legacy `sse`.
Подключение ленивое — при первом обращении агента; `tools/list` кэшируется в
`~/.jarvis/cache/mcp/<server>.json` (`jarvis mcp list --refresh` обновляет).

### Профили

Профиль отображает инструменты сервера на **нормализованные возможности**, которые знают агенты и
политика:

| Профиль | Возможности | Эффекты (журналируются и проверяются) |
|---|---|---|
| `atlassian` | `jira.get`, `jira.search`, `confluence.get`, `confluence.search` | `jira.comment` (по маркеру в тексте), `jira.transition` (чтением статуса), `confluence.create` |
| `bitbucket` | `bitbucket.pr.get`, `bitbucket.pr.list`, `bitbucket.pr.diff` | `bitbucket.pr.create`, `bitbucket.pr.comment` |

`profile: { base: atlassian, map: { "jira.worklog": "jira_add_worklog" } }` добавляет только чистые
чтения; эффекты из конфигурации объявить нельзя (их проверку должен знать код).

Сервер без профиля: инструменты как `mcp.<server>.<tool>` — непроверяемые эффекты (агентам не
выдаются по умолчанию) или, с `readOnly: true`, чистые чтения.

`allow` / `deny` на сервере, `mcp.deny` в профиле конфигурации (`*.comment`, `*.transition`),
`network` сервера против `dataClass` — всё решает Tool Router до вызова; `jarvis mcp list` показывает
exposed / denied / unmapped / «discovered, not allowed».

### Preflight

`jarvis work` перед созданием run опрашивает каждый сервер, до которого могут дотянуться агенты
workflow; сервер, не ответивший на `tools/list`, — отказ до старта (а не падение на 7-м шаге).
`jarvis doctor` показывает credentials, состояние discovery и неизвестные профили.

## IDE и другие агенты: `jarvis mcp serve`

Jarvis сам — MCP-сервер на stdio, только чтение:

| Инструмент | Что возвращает |
|---|---|
| `knowledge.search` | поиск по знанию, стандартам, навыкам с глоссарием (как у агентов) |
| `spec.get` | последняя спецификация run (по id, префиксу или ключу задачи), `type` — другой артефакт |
| `run.status` | состояние одного run или всех активных |
| `context.inspect` | точный EngineeringContextPackage, который получил бы агент для задачи/путей |

Пример для клиента, понимающего MCP (Claude Code, Cursor, Continue, …):

```json
{ "mcpServers": { "jarvis": { "command": "jarvis", "args": ["mcp", "serve"], "cwd": "/path/to/project" } } }
```

## Credentials (ADR-0017 §5)

Ссылки `keychain:<id>` разрешаются из хранилища ОС под текущим актором:

| Бэкенд | Платформа | Как |
|---|---|---|
| `macos` | macOS | Keychain (`security`) |
| `libsecret` | Linux | `secret-tool` |
| `windows` | Windows | DPAPI через PowerShell `ProtectedData`, шифртекст в файле |
| `file` | любая | `~/.jarvis/credentials.json` с правами 0600 — fallback |

Выбор автоматический по платформе и наличию утилит; `JARVIS_KEYCHAIN_BACKEND` переопределяет.
`jarvis auth set|status|remove`. Значения попадают только в транспорты и редактируются из любого вывода
инструментов (ADR-0010). `env:VAR` — альтернатива для CI.

## Профили конфигурации

`--profile <name>` / `JARVIS_PROFILE` применяет оверлей из `profiles.<name>`; `jarvis ci` использует
`ci` по умолчанию. Оверлей только сужает: `interactive`, `dataClass`, `workspace.mode|allowWrites`,
`mcp.deny`, `tools.deny`, `humanGate`, `budget`. Попытка расширить (например, повысить бюджет) — ошибка
конфигурации, оверлей не применяется.
