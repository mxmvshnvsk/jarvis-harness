# Конфигурация

Два файла и слои поверх них (ADR-0014, ADR-0017 §1):

| Слой | Где | Что |
|---|---|---|
| user | `~/.jarvis/config.yaml` | машина и человек: модели и endpoint'ы, credentials-ссылки, пулы квот, actor |
| project | `<project>/.jarvis/project.yaml` | проект и команда: роли, политика, инструменты, workspace, знание; версионируется |
| env | `JARVIS_*` | точечные переопределения |
| cli | `--profile`, `--cwd`, опции команд | |

Приоритет: **cli → env → project → user → defaults**. Профиль (`--profile ci` или `JARVIS_PROFILE`)
накладывается после слияния и может только *сужать*: отключать интерактив, запрещать возможности,
переводить workspace в `cwd`, понижать бюджеты. `jarvis config show --sources` показывает источник
каждого значения.

Схемы строгие: неизвестный ключ — ошибка. Секреты в YAML запрещены: ключи, похожие на секрет (`token`,
`password`, `*_KEY` …), принимают только ссылки `env:VAR` или `keychain:ID`.

## `~/.jarvis/config.yaml`

```yaml
version: 1
actor:
  id: me@corp.local            # иначе JARVIS_ACTOR, иначе git config user.email (ADR-0006)
  display: Maxim

quotaPools:                    # ADR-0018 §4
  corp-default:
    window: { minutes: 20, kind: sliding }   # sliding | fixed
    limits: { outputTokens: 60000, inputTokens: 400000, requests: 300, concurrency: 2 }
    soft: 0.8                  # доля окна, после которой новые вызовы ждут

models:                        # ADR-0007, ADR-0017 §2
  deepseek-flash:
    provider: openai-compatible   # openai-compatible | anthropic | openai | ollama
    baseUrl: https://llm.corp.local/v1
    model: deepseek-flash
    auth: { type: bearer, token: keychain:corp-llm }   # none | bearer | header{header,token}
    headers: {}
    egress: private            # private | cloud — обязательно (ADR-0016)
    quotaPool: corp-default
    contextWindow: 128000
    maxOutput: 8192
    supports: { tools: true, parallelTools: false, jsonSchema: false, jsonMode: true,
                systemRole: true, reasoning: false, prefixCache: true }
    tokenizer: deepseek
    timeoutMs: 120000
    maxConcurrency: 2
    stream: true               # ответ потоком (SSE); по умолчанию включено, см. ниже
  embed:
    provider: openai-compatible
    baseUrl: https://llm.corp.local/v1
    model: bge-m3
    egress: private
    contextWindow: 8192
    maxOutput: 1

roles:                         # могут быть и в проекте; проект имеет приоритет
  research:       { models: [deepseek-flash] }
  implementation: { models: [qwen-coder, deepseek-flash] }   # порядок = предпочтение
  review:         { models: [deepseek-flash], maxOutput: 4096 }
  compaction:     { models: [deepseek-flash] }   # суммаризация при компакции контекста (ADR-0013); нет роли — модель самого агента

mcp: { servers: {} }           # можно и здесь (личные серверы), обычно — в проекте
context: {}                    # пороги сжатия контекста, см. ниже
telemetry:                     # ЗАРЕЗЕРВИРОВАНО: политика egress проверяется (doctor), экспортёра пока нет
  export: { enabled: false, url: https://otel.corp.local, network: intranet, payloads: false, maxPayloadBytes: 4096 }
```

`workspace.cache` — зависимости, которые переживают worktree. Раньше каждый прогон в своём worktree ставил
зависимости с нуля, и до первого шага проходили минуты. После `setup` пути из `paths` копируются в
`~/.jarvis/cache/deps/<проект>/<ключ>`, где ключ — хэш файлов `key` (lockfile). Следующий worktree с тем же
lockfile получает их до `setup`, и `setup` почти ничего не делает. Копия — клон copy-on-write, где файловая
система умеет (APFS — `cp -c`, btrfs/xfs — `--reflink`), поэтому там она не стоит ни времени, ни места. Хранятся
три последних ключа. Сломанный кэш стоит только времени полного `setup`. Строка прогресса пишет
`◌ dependencies restored node_modules (key …)` или `kept … for the next run`.

`models.<id>.stream` — просить ответ потоком (SSE, `stream: true` + `stream_options.include_usage`). Заголовки
приходят сразу, поэтому долгий ответ не обрывается по таймауту заголовков, а строка прогресса показывает, что
ответ идёт (`thinking ~3k tok`, `receiving ~1.2k tok`); `jarvis models stats` — сколько ответов пришло потоком и
время до первого токена. Сервер, который отвечает на поток ошибкой 400/422 про `stream`, спрашивается ещё раз без
него, и до конца процесса — без него; сервер, который игнорирует `stream` и отвечает обычным JSON, читается как
есть. Обрыв потока посреди ответа и ошибка внутри потока — временные сбои с повтором. `stream: false` выключает.

Роли, которые используют встроенные агенты: `research` (research, requirements, specification, impact,
plan, release-notes, onboard-mapper, knowledge-answerer), `implementation` (implementation, test, docs, telemetry), `review` (review,
review-analysis); `compaction` — суммаризатор контекста при компакции (ADR-0013); без неё суммаризирует
модель самого агента. Роутер выбирает первую модель роли, которая
удовлетворяет требованиям агента (tools, structured output) и правилу egress для `dataClass` проекта.

## `.jarvis/project.yaml`

```yaml
version: 1
dataClass: confidential        # public | internal | confidential (по умолчанию). confidential →
                               # только egress: private модели и network ≤ intranet (ADR-0016)
stack: [typescript, react]     # пусто = детекция по workspace (ADR-0021 §3)
stackScopes:                   # полиглот: путь → стеки (ADR-0021 §9); иначе детекция по верхним каталогам
  "backend/**": [csharp, aspnet]
  "web/**": [typescript, react]

roles: { … }                   # как в user-конфиге

tools:
  local:                       # команды проекта → возможности project.<name>
    tests: "pnpm vitest run"
    typecheck: "pnpm tsc --noEmit"
    lint: "pnpm biome check ."
  shell: false                 # shell.run для произвольных команд в workspace
  maxOutputBytes: 65536        # вывод инструмента агенту обрезается; полный (редактированный) — blob
  commandTimeoutMs: 600000

workspace:                     # ADR-0003
  mode: worktree               # worktree | cwd
  setup: "pnpm install --offline --frozen-lockfile"   # после создания worktree
  allowWrites: true            # по умолчанию true для worktree, false для cwd
  retentionDays: 7             # jarvis gc
  cache:                       # зависимости между worktree (по умолчанию выключено)
    key: [pnpm-lock.yaml]      # файлы, по содержимому которых кэш подходит
    paths: [node_modules, "packages/*/node_modules"]   # что сохранить; `*` — один уровень каталогов

modelWait:                     # модель недоступна после повторов шлюза: прогон ждёт, а не падает
  checkEveryMinutes: 5         # как часто проверять (одна попытка, без повторов)
  giveUpAfterHours: 12         # дольше — прогон падает, как раньше
budget:                        # ADR-0018 §4 — лимиты сверх пулов
  perRun:  { outputTokens: 200000, requests: 400 }
  perStep: { outputTokens: 40000, requests: 80 }

humanGate: artifact            # fail | artifact | skip-if-approved — что делать на гейте без человека
                               # (неинтерактивный режим, ADR-0009 §2)

human:                         # ADR-0019 §9
  mode: balanced               # autonomous | balanced | strict
  gates:
    spec: { required: true }
    implementation: { required: true }   # required: false — гейт проходится молча
  review:
    sourceMarkers: true                  # // REVIEW: в коде
    removeMarkersAfterApproval: true
    knowledgePromotion: confirm          # confirm | never — кандидаты требуют решения человека
  clarification: { multiTurn: true, maxTurns: 8 }
  manualEdits: { enabled: true }         # правки в worktree становятся checkpoint human edit

knowledge:                     # ADR-0020 §3, §5; ADR-0015
  maxSkills: 2                 # навыков на вызов агента; остальные — «по запросу»
  split: { skills: 0.4, standards: 0.35, knowledge: 0.25 }   # доли бюджета слоя L4
  retrieval:
    rankAbove: 4               # ранжировать документы знания индексом, если подошло больше этого числа
    embeddings: embed          # id модели с /embeddings; выключено по умолчанию (ADR-0015 §6)
  sources:                     # документация команды на месте, без копий в .jarvis/ (см. knowledge.md)
    - path: documentation      # каталог или файл от корня репозитория
      include: ["**/*.md"]     # по умолчанию
      skills: ["SKILL_*.md"]   # эти документы — скиллы (id: SKILL_foo-bar.md → foo-bar)
      scopes:                  # документ (glob от path) → пути кода, к которым он относится
        "billing/**": ["packages/lib/src/billing/**"]
      agents: [implementation] # для кого скиллы источника; пусто = implementation
    - AGENTS.md                # строка = { path }; AGENTS.md ниже корня — только для своего каталога

context:                       # ADR-0013
  thresholds:                  # доли эффективного окна; по умолчанию как ниже
    default: { watch: 0.40, compact: 0.60, aggressive: 0.75, reset: 0.85 }
    byModel: { deepseek-flash: { compact: 0.5 } }       # приоритет: фаза > модель > default
    byPhase: { implementation: { compact: 0.65 } }
  compactTarget: 0.35          # до какой доли окна сжимать при компакции
  maxContext: 100000           # потолок окна, если модель заявляет больше

hooks:                         # git pre-push (ADR-0001 §15); читает `jarvis prepush`
  prePush:
    mode: block                # block | advisory — advisory только сообщает
    standards: true            # детерминированные проверки стандартов по диапазону
    checks: [typecheck, test]  # имена из tools.local, по порядку; пусто = ничего
    semanticReview: auto       # auto | never | always — ревью агентом review (workflow review-diff)
    blockOn: blocker           # blocker | major — с какой серьёзности замечание ревью блокирует
    skipBranches: ["wip/**"]   # ветки, которые хук пропускает

security:                      # ADR-0010
  secretPatterns: [{ name: corp-token, regex: "corp_[A-Za-z0-9]{32}" }]
  secretEnv: [CORP_TOKEN]      # значения этих переменных редактируются из любого вывода
  deniedPaths: ["**/.env*", "secrets/**"]   # отказ до чтения

mcp:
  servers:
    jira:                      # ADR-0017 §3
      transport: http          # stdio | http | sse
      url: https://mcp.corp.local/atlassian
      auth: { type: bearer, token: keychain:atlassian }
      network: intranet        # none | intranet | internet; по умолчанию — из профиля, иначе internet
      profile: atlassian       # atlassian | bitbucket | { base: atlassian, map: { … } }
      allow: [jira.get, jira.search, jira.comment]   # пусто = все возможности профиля
      deny: [jira.transition]
    bitbucket:
      transport: stdio
      command: node
      args: [/opt/mcp/bitbucket/index.js]
      env: { BB_TOKEN: keychain:bitbucket }
      cwd: /opt/mcp/bitbucket
      profile: bitbucket
    elastic:                   # без профиля: инструменты как mcp.elastic.<tool>
      transport: http
      url: https://mcp.corp.local/elastic
      readOnly: true           # все инструменты — чистые чтения; иначе каждый — непроверяемый эффект

profiles:                      # ADR-0009 §1 — только сужение
  ci:
    interactive: false
    dataClass: confidential
    workspace: { mode: cwd, allowWrites: false }
    humanGate: artifact
    mcp:   { deny: ["*.comment", "*.transition"] }
    tools: { deny: ["shell.run"] }
    budget: { perRun: { outputTokens: 100000 } }
```

### Политика egress (ADR-0016)

| dataClass | Модели | Инструменты / MCP |
|---|---|---|
| public | private, cloud | none, intranet, internet |
| internal | только private | none, intranet, internet (результат помечается как недоверенный, ADR-0016 §4) |
| confidential | только private | none, intranet |

Модель без `egress` не проходит схему; сервер без `network` считается `internet`. Нарушение — отказ
роутера до вызова, событие `tool.denied`.

### Лимиты агентов (`agents`)

У каждого встроенного агента есть лимиты на шаг: сколько раз он может вызвать инструменты и модель.
`agents.<id>.limits` меняет их для проекта (`.jarvis/project.yaml`) или машины (`~/.jarvis/config.yaml`),
переменной — `JARVIS_AGENTS__RESEARCH__LIMITS__MAX_TOOL_CALLS=80`.

```yaml
agents:
  research:     { limits: { maxToolCalls: 80 } }      # по умолчанию 40 / 60
  specification: { limits: { maxToolCalls: 30 } }    # 20 / 60
```

| агент | инструменты | вызовы модели |
|---|---|---|
| research, requirements, test, review и прочие | 40 | 60 |
| specification | 20 | 60 |
| plan | 15 | 60 |
| implementation | 80 | 100 |
| onboard-mapper | 60 | 80 |
| knowledge-answerer | 12 | 20 |

Упёршись в лимит инструментов, агент получает «бюджет исчерпан, заканчивай с тем, что есть» и
следующий ответ даёт без инструментов; на лимите вызовов модели цикл обрывается. Шаг не падает: документ
финализируется как обычно, но помечается неполным — `budgetExhausted: tools|model` в происхождении
артефакта и в событии `agent.finish`. Это видно в строке шага («tool limit reached, result may be
incomplete»), в итоге прогона и в `jarvis show` («⚠ incomplete»), а следующий агент получает такой вход
с пометкой `INCOMPLETE` — чтобы не принимать его за полный.

Для шагов, где полусделанный результат дороже вопроса, — `onLimit: ask`: на лимите агент сохраняет разговор,
прогон ждёт человека (`WAITING_HUMAN`, `waitingFor: budget`), а карточка `jarvis continue` или страница
`jarvis ui` предлагает добавить вызовов (шаг продолжается с того же места) или закончить с тем, что есть
(как без `ask`, с пометкой `INCOMPLETE`). Во встроенных workflow так у шагов `spec` и `implementation`.
Где отвечать некому (`interactive: false`, профиль `ci`), `ask` ведёт себя как `finish`.

```yaml
agents:
  research: { onLimit: ask }           # над шагом workflow; finish — как раньше, без вопроса
```

```yaml
# .jarvis/workflows/<name>.yaml
  - id: implementation
    kind: agentic
    agent: implementation
    onLimit: ask                       # finish (по умолчанию) | ask
```

Добавленное записывается в журнал событием `budget.grant` с автором и каналом (`cli` / `ui`) и
прибавляется к лимиту только этого шага этого прогона; конфигурация не меняется.

### Режимы `humanGate`

| Режим | На гейте без интерактива |
|---|---|
| `artifact` | run паркуется в `WAITING_HUMAN`, пишется `approval-request.json`, выход 10 |
| `skip-if-approved` | если `.jarvis/approvals/<task>/<type>.json` утверждает тот же хеш содержимого — гейт пройден (`approval.committed`); иначе как `artifact` |
| `fail` | run `FAILED` с причиной `policy: human_gate_in_ci`, выход 12 |

## Переменные окружения

Зарезервированные: `JARVIS_HOME`, `JARVIS_CONFIG`, `JARVIS_PROFILE`, `JARVIS_ACTOR`,
`JARVIS_KEYCHAIN_BACKEND` и переменные технического лога `JARVIS_LOG`, `JARVIS_LOG_DIR`,
`JARVIS_LOG_KEEP_DAYS`, `JARVIS_LOG_MAX_FIELD` (см. [workflows.md](workflows.md#технический-лог)) и
`JARVIS_PROGRESS=off` — без живой строки прогресса в терминале.

Остальные `JARVIS_<PATH>` переопределяют конфигурацию: `__` разделяет сегменты пути, сегменты
сопоставляются с ключами без учёта регистра, `_` и `-`:

```sh
JARVIS_MODELS__DEEPSEEK_FLASH__BASEURL=http://localhost:8000/v1
JARVIS_WORKSPACE__MODE=cwd                 # в режиме cwd запись выключена: для реализации ещё
JARVIS_WORKSPACE__ALLOW_WRITES=true        # и это — агент правит вашу рабочую копию
JARVIS_HUMAN__GATES__SPEC__REQUIRED=false
JARVIS_KNOWLEDGE__RETRIEVAL__RANKABOVE=2
```

Значения разбираются как YAML (`true`, `3`, `[a, b]`, строки).

## Файлы знания

- `.jarvis/knowledge/*.md` — произвольные документы; необязательный front matter
  `tags`, `paths`, `stacks`, `agents` сужает область.
- `.jarvis/knowledge/glossary.md` — таблица «термин | синонимы | символы/модули | источники | обновлено».
- `.jarvis/standards/<id>.md`, `.jarvis/skills/<id>/` — см. [knowledge.md](knowledge.md).
- `~/.jarvis/standards/`, `~/.jarvis/skills/` — личные дополнения; не могут быть `required`.
- `.jarvis/agents/<id>.md` — инструкции агента вместо встроенных.
- `.jarvis/workflows/<name>.yaml` — свои workflow или переопределение `sdd`.
