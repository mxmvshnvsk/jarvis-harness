# ADR-0017: Подключение моделей и MCP — формат конфигурации, профили capability, credentials

- Статус: принято
- Дата: 2026-10-03
- Основание: [ADR-0001](0001-target-architecture.md) §3 (`~/.jarvis/config.yaml`, `.jarvis/project.yaml`),
  §9 (Tool Registry с нормализованными capability), §10 (ModelGateway, provider adapter), §13
  («credentials и MCP auth никогда не передаются модели»), §17 (AI SDK / OpenAI-compatible adapter,
  official TypeScript MCP SDK, YAML + Zod); [ADR-0002](0002-run-effects-and-lease.md) §1, §3 (`effect`,
  `verify()`), [ADR-0006](0006-actor-identity.md) §4 (credentials принадлежат актору),
  [ADR-0007](0007-model-capabilities.md) (дескрипторы, роли), [ADR-0010](0010-secret-redaction.md) §2
  (литералы из keychain в Redactor), [ADR-0014](0014-config-precedence-and-migrations.md) (приоритет,
  `env:`/`keychain:`), [ADR-0016](0016-egress-policy.md) (`egress`, `network`)
- Код (план): `src/core/config/schema.ts`, `src/models/gateway/providers/{openaiCompatible,anthropic,
  openai,ollama}.ts`, `src/mcp/client/{pool,transport}.ts`, `src/mcp/profiles/{atlassian,bitbucket,
  elastic}.ts`, `src/tools/registry.ts`, `src/security/credentials/{keychain,env}.ts`, CLI `jarvis auth
  set|status|remove`, `jarvis models list|probe`, `jarvis mcp list`, `jarvis doctor`

## Контекст

ADR-0001 называет файлы конфигурации и адаптеры, но не определяет, что в каком файле лежит, как имена
tools MCP-серверов превращаются в нормализованные capability, где живут токены и как Run убеждается, что
всё нужное ему доступно, до того как потратит квоту. Нужно разделить то, что принадлежит машине и
человеку (endpoint'ы, токены), и то, что принадлежит проекту и команде (роли, права, политика).

## Решение

### 1. Разделение по файлам

| Файл | Содержимое | Принцип |
| --- | --- | --- |
| `~/.jarvis/config.yaml` | `models` (endpoint'ы, дескрипторы), личные `mcp.servers`, `actor`, `quotaPools`, дефолтные `roles` | «моя машина»: мои endpoint'ы и мои токены |
| `.jarvis/project.yaml` | `roles` (модель на роль), `mcp.servers` проекта (URL, профиль, `allow`/`deny`), `dataClass`, `tools.local`, `workspace`, `budget`, `profiles` | версионируется с проектом, одинаков для команды |
| OS keychain / env | значения токенов | в yaml литералы запрещены схемой (ADR-0014 §1) |

Проект **объявляет потребность** (сервер `jira`, профиль `atlassian`, URL корпоративной Jira — не секрет);
пользовательский конфиг **поставляет подключение** и токен. Сервер с тем же именем в пользовательском
конфиге переопределяет `transport`/`url`/`command`/`auth`, но не `allow`/`deny`/`network`: права по
цепочке только сужаются (ADR-0014 §1, ADR-0016 §2). Если проект требует сервер, которого нет у
пользователя, `jarvis doctor` называет его и указывает, что настроить.

### 2. Модели

```yaml
# ~/.jarvis/config.yaml
version: 1
actor: { id: env:JARVIS_ACTOR }

quotaPools:                       # полное описание — ADR-0018 §4
  corp-default: { window: { minutes: 20, kind: sliding }, limits: { outputTokens: 60000, requests: 300, concurrency: 2 } }

models:
  deepseek-flash:
    provider: openai-compatible   # openai-compatible | anthropic | openai | ollama
    baseUrl: https://llm.corp.local/v1
    model: deepseek-flash
    auth: { type: bearer, token: keychain:corp-llm }     # bearer | header | none
    headers: { X-Team: payments }
    egress: private               # ADR-0016, обязательное
    quotaPool: corp-default
    contextWindow: 128000
    maxOutput: 8192
    supports: { tools: true, jsonSchema: false, jsonMode: true, prefixCache: true }
    tokenizer: deepseek
    timeoutMs: 120000
    maxConcurrency: 2
```

`provider` выбирает адаптер ModelGateway (поверх AI SDK provider); `openai-compatible` покрывает
корпоративный gateway, vLLM, Ollama с OpenAI API. Дескрипторные поля — по ADR-0007. Домашний конфиг
добавляет `provider: anthropic, egress: cloud` — в `public`-проекте модель доступна, в `confidential`
правило ADR-0016 её не допустит.

```yaml
# .jarvis/project.yaml
roles:
  research:       { models: [deepseek-flash, qwen-coder] }     # порядок = предпочтение
  implementation: { models: [qwen-coder] }
  review:         { models: [deepseek-flash], maxOutput: 4096 }
  compaction:     { models: [deepseek-flash] }
```

Роли ссылаются на модели по id; проект без `roles` берёт дефолтные из пользовательского конфига.

### 3. MCP-серверы

```yaml
# .jarvis/project.yaml
mcp:
  servers:
    jira:
      transport: http             # stdio | http (streamable HTTP) | sse (legacy)
      url: https://mcp.corp.local/atlassian
      auth: { type: bearer, token: keychain:atlassian }
      network: intranet           # ADR-0016
      profile: atlassian          # §4
      allow: [jira.get, jira.search, jira.comment]
      deny:  [jira.transition, "jira.*.delete"]
    bitbucket:
      transport: stdio
      command: node
      args: [/opt/mcp/bitbucket/index.js]
      env: { BB_TOKEN: keychain:bitbucket }     # резолвится при spawn
      network: intranet
      profile: bitbucket
    elastic:
      transport: http
      url: https://mcp.corp.local/elastic
      network: intranet
      readOnly: true              # все tools — pure; профиль не нужен
```

Клиент — official TypeScript MCP SDK. `allow`/`deny` — по нормализованным именам (§4), glob допустим.
Capability, не попавшая в `allow`, агенту не выдаётся, даже если сервер её объявляет.

### 4. Нормализация capability — профили

MCP-сервер отдаёт tools со своими именами (`add_comment`, `search_issues`); агенты, policy и журнал
эффектов работают с нормализованными capability (`jira.comment`). Связь — **профиль** в коде Jarvis
(`src/mcp/profiles/<name>.ts`):

```
Profile
  |- map:      { "jira.comment": { tool: "add_comment", effect: true, verify: verifyComment } , … }
  |- network:  intranet            дефолт для серверов этого профиля
  `- version
```

`verify()` реализует проверку по маркеру для ADR-0002 §3. Профили поставляются с пакетом; проект может
дополнить маппинг в конфиге (`profile: { base: atlassian, map: { … } }`) только для `pure`-capability —
объявить новый `effect` без `verify` из конфига нельзя.

Сервер **без профиля**: tools экспонируются как `mcp.<server>.<tool>`, каждый считается `effect: true,
verifiable: false` — после resume выполняется только через human gate (ADR-0002 §3), — пока конфиг не
скажет `readOnly: true` (все tools — `pure`) или не появится профиль. Безопасный дефолт: неизвестный
инструмент не может тихо изменить внешнюю систему.

### 5. Credentials

`jarvis auth set <id>` — промпт без эха, запись в OS keychain (macOS Keychain, libsecret, Windows
Credential Manager) под ключом актора (ADR-0006 §4); `jarvis auth status` показывает наличие, не значения;
`jarvis auth remove <id>`. `env:VAR` — для CI и скриптов; литерал в yaml — ошибка схемы.

Токен попадает только в транспорт: заголовок HTTP-клиента или `env` spawn'а stdio-процесса. В аргументы
tool call, контекст модели, артефакты и telemetry — никогда (ADR-0001 §13); значения, полученные из
keychain/env, добавляются в литеральный набор Redactor'а (ADR-0010 §2).

### 6. Жизненный цикл подключений

- MCP-клиенты поднимаются лениво при первом обращении Run к capability сервера, живут пулом на процесс,
  закрываются при завершении процесса; stdio-процессы — дочерние, с `env` из §5.
- При подключении — `tools/list`; результат хэшируется и кэшируется в `~/.jarvis/cache/mcp/<server>.json`.
  Новый tool на сервере — не автоматическое разрешение: `allow` явный; `doctor` показывает «обнаружен, не
  разрешён».
- Проверка при `jarvis work`: все модели ролей workflow проходят `probe` (ADR-0007) и правило egress
  (ADR-0016); все серверы, чьи capability нужны workflow, отвечают на `tools/list`; иначе Run не создаётся —
  ошибка называет, что именно недоступно.
- `jarvis models list`, `jarvis mcp list`, `jarvis doctor` — таблицы: модель → endpoint, egress, probe-дата,
  пул; сервер → transport, tools обнаружено/разрешено/запрещено, auth ok, network.

### 7. Jarvis как MCP-сервер

`jarvis mcp serve` (stdio) — для OpenCode и IDE (ADR-0001 §15): `knowledge.search`, `spec.get`,
`run.status`, `context.inspect`. Read-only по умолчанию; set-операции (например `approve`) — отдельным
решением на этапе 14 roadmap.

## Последствия

- Два файла с ясной границей: машина/человек против проект/команда; токены нигде не лежат текстом.
- Профили — единственное место, где определяется, что является эффектом и как его проверить; policy и
  журнал эффектов опираются на одно определение.
- Неизвестные серверы безопасны по умолчанию, но менее удобны; стимул писать профили.
- Run не стартует, пока не доказано, что все его зависимости доступны и допустимы.

## Альтернативы

- **Один файл конфигурации.** Смешивает токены и endpoint'ы с версионируемой политикой проекта.
- **Экспонировать tools MCP «как есть» без нормализации.** Policy и агенты привязываются к именам
  конкретного сервера; смена сервера Jira ломает workflow; эффекты не распознаются.
- **Хранить токены в зашифрованном файле Jarvis.** Второй keychain с собственным ключом; OS keychain
  уже решает задачу и интегрирован с SSO организаций.
