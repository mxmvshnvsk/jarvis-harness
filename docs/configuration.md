# Конфигурация

Два файла и слои поверх них (ADR-0014, ADR-0017 §1):

| Слой | Где | Что |
|---|---|---|
| user | `~/.jarvis/config.yaml` | машина и человек: модели и endpoint'ы, credentials-ссылки, пулы квот, actor |
| project | `<project>/.jarvis/project.yaml` | проект и команда: роли, политика, инструменты, workspace, знание; версионируется |
| env | `JARVIS_*` | точечные переопределения |
| cli | `--profile`, `--cwd`, опции команд | |

Приоритет: **cli → env → project → user → defaults**. `dataClass` переменная или флаг может только повысить:
понижение относительно файлов — ошибка конфигурации. Профиль (`--profile ci` или `JARVIS_PROFILE`) накладывается
после слияния. Расширять он не может `dataClass` (только повысить), `workspace.allowWrites` (нельзя включить
запрещённое) и `budget` (только понизить) — такая попытка — ошибка; `interactive`, `workspace.mode`, `humanGate`,
запреты инструментов и MCP профиль задаёт как есть. `jarvis config show --sources` показывает источник каждого
значения.

Схемы строгие: неизвестный ключ — ошибка. Секреты в YAML запрещены: `auth.token`, а также значения `env`
stdio-серверов MCP и `models.<id>.headers` с «секретными» именами (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`,
`*API_KEY*`, `*PRIVATE*`, `*CREDENTIAL*`) принимают только ссылки `env:VAR` или `keychain:ID`.

## `~/.jarvis/config.yaml`

```yaml
version: 1
actor:
  id: me@corp.local            # JARVIS_ACTOR важнее; без обоих — git config user.email (ADR-0006)
  display: Maxim

quotaPools:                    # ADR-0018 §4
  corp-default:
    window: { minutes: 20, kind: sliding }   # sliding | fixed
    limits: { outputTokens: 60000, inputTokens: 400000, requests: 300 }
    soft: 0.8                  # доля окна, после которой вызовы моделей пула идут по одному
    unlimited:                 # часы без лимитов на платформе: вызовы идут без проверки
      - { from: "22:00", to: "07:00" }   # через полночь — ок
      - { days: [sat, sun] }             # дни целиком; можно и дни, и часы в одном пункте
    timezone: Europe/Moscow    # пояс для unlimited (IANA); без него — пояс машины
    unlimitedScale: 5          # во сколько раз в эти часы растут лимиты агентов и budget.perStep/perRun

models:                        # ADR-0007, ADR-0017 §2
  deepseek-flash:
    provider: openai-compatible   # openai-compatible (нужен baseUrl) | openai | ollama (адрес по умолчанию); anthropic — адаптера пока нет
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

`quotaPools` — окно и лимиты пула, общие для всех прогонов на моделях с этим `quotaPool`. Перед вызовом jarvis
проверяет, что вызов поместится в окно (admission). Вывод резервируется не целым `maxOutput`, а типичным ответом
такого же вызова: 95-й перцентиль последних ответов того же агента (ход с инструментами и итоговый ответ —
отдельно; без агента — той же роли), не меньше 2000 и не больше `maxOutput`; пока таких ответов меньше 5 — 8000
или `maxOutput`, если он меньше. Ответ
длиннее резерва превышает окно не больше чем на этот один ответ; сам запрос по-прежнему разрешает весь
`maxOutput`. В пилоте резерв целым `maxOutput` (16k) при лимите 30k на окно останавливал всё уже после 14k
реально потраченных, хотя ответы агентов были около 250 токенов. Не поместился вызов — прогон ставится на паузу
(`WAITING_BUDGET`) до освобождения окна и продолжается сам; в `jarvis ui` он виден как «paused, not failed» с
временем продолжения и кнопкой **Resume now**. Параллельность вызовов одной модели задаёт
`models.<id>.maxConcurrency` (по умолчанию 2); с `soft` и выше — по одному. `limits.concurrency` схема принимает, но
пока не применяет.

`quotaPools.<pool>.unlimited` — часы, когда платформа пул не ограничивает (ночь, выходные). Пункты, которые
стыкуются, работают как один: будние ночи 22–07 и выходные целиком дают безлимит с пятницы 22:00 до понедельника
07:00. В эти часы вызовы проходят без проверки квоты. Потраченное в них в окно потом не засчитывается, так что в
07:01 прогон не встанет на паузу из-за ночных токенов. Прогон, вставший на паузу перед безлимитом, продолжится в
ближайший из двух моментов: когда освободится окно или когда начнутся безлимитные часы («unlimited hours begin
then» в причине паузы).

В те же часы лимиты агентов (`agents.<id>.limits`: вызовы инструментов и модели) и бюджет шага и прогона
(`budget.perStep`, `budget.perRun`) для вызовов этого пула растут в `unlimitedScale` раз (по умолчанию в 5). Совсем
лимиты не снимаются: зациклившийся агент всё равно остановится. Лимиты считаются заново при каждой проверке, так
что шаг, начатый ночью, утром снова держится дневных лимитов. Выданное человеком (`+25 tool calls`)
прибавляется сверху без умножения. Пул без `unlimited` лимиты агентов не трогает, даже если сам он не ограничен
(`limits` пустые). Чтобы они росли всегда, объяви ему безлимитными все дни: `unlimited: [{ days: [mon, tue, wed, thu, fri, sat, sun] }]`. `jarvis models` показывает у окна пула `unlimited until …` или `unlimited from …`.

Модели роли (`roles.<role>.models`) — порядок предпочтения, и следующие подхватывают вызов, пока пул первой полон.
Если вызов не помещается в пул своей модели, шлюз берёт следующую модель той же роли в **другом** пуле, если она:
- разрешена для `dataClass`;
- умеет то, что нужно вызову (инструменты, структурированный ответ);
- вмещает промпт;
- проходит проверку квоты своего пула.

Пауза наступает, только когда места нет ни у одной. Как только у первого пула появляется место, вызовы
возвращаются к нему. В журнале переход записывается событием `model.failover`, по одному на отрезок, а в ленте
прогона видна строка `↪ deepseek-flash → deepseek-flash-vip`. Например, второй кластер как запасной:

```yaml
quotaPools:
  vip: { window: { minutes: 20 } }        # без limits — не ограничен
models:
  deepseek-flash-vip: { …, quotaPool: vip }
roles:
  research: { models: [deepseek-flash, deepseek-flash-vip] }   # сначала общий пул, при упоре — VIP
```

`models.<id>.stream` — просить ответ потоком (SSE, `stream: true` + `stream_options.include_usage`). Заголовки
приходят сразу, поэтому долгий ответ не обрывается по таймауту заголовков, а строка прогресса показывает, что
ответ идёт (`thinking ~3k tok`, `receiving ~1.2k tok`); `jarvis models stats` — сколько ответов пришло потоком и
время до первого токена. Сервер, который отвечает на поток ошибкой 400/422 про `stream`, спрашивается ещё раз без
него, и до конца процесса — без него; сервер, который игнорирует `stream` и отвечает обычным JSON, читается как
есть. Обрыв потока посреди ответа и ошибка внутри потока — временные сбои с повтором. `stream: false` выключает.

Роли, которые используют встроенные агенты: `research` (research, requirements, specification, impact,
plan, release-notes, onboard-mapper, knowledge-answerer), `implementation` (implementation, test, docs, telemetry), `review` (review,
review-analysis); `compaction` — суммаризатор контекста при компакции (ADR-0013); без неё суммаризирует
модель самого агента. Сводка получает до 8000 токенов вывода (меньше, если `maxOutput` модели меньше;
`roles.compaction.maxOutput` на неё не действует) и считается вызовом модели агента. Роутер выбирает первую модель роли, которая
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
  perRun:  { inputTokens: 3000000, outputTokens: 200000, requests: 400 }
  perStep: { inputTokens: 800000, outputTokens: 40000, requests: 80 }
  # inputTokens — сумма промптов: без кэша префикса каждый вызов шлёт весь разговор шага заново, и вход
  # растёт быстрее числа вызовов (пилот: research 15 вызовов — 0,55M, 39 — 1,84M, 51 — 2,47M)

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
      exclude: ["drafts/**"]   # не брать; по умолчанию ничего
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
      profile: atlassian       # atlassian | bitbucket | figma | { base: atlassian, map: { … } }
      timeoutMs: 60000         # на один вызов инструмента (по умолчанию 60 с)
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

`workspace.cache` (только в `.jarvis/project.yaml`) — зависимости, которые переживают worktree. Раньше каждый прогон в своём worktree ставил
зависимости с нуля, и до первого шага проходили минуты. После `setup` пути из `paths` копируются в
`~/.jarvis/cache/deps/<проект>/<ключ>`, где ключ — хэш файлов `key` (lockfile). Следующий worktree с тем же
lockfile получает их до `setup`, и `setup` почти ничего не делает. Копия — клон copy-on-write, где файловая
система умеет (APFS — `cp -c`, btrfs/xfs — `--reflink`), поэтому там она не стоит ни времени, ни места. Хранятся
три последних ключа. Сломанный кэш стоит только времени полного `setup`. Строка прогресса пишет
`◌ dependencies restored node_modules (key …)` или `kept … for the next run`.

### Политика egress (ADR-0016)

| dataClass | Модели | Инструменты / MCP |
|---|---|---|
| public | private, cloud | none, intranet, internet |
| internal | только private | none, intranet, internet (пометка результата как недоверенного, ADR-0016 §4, пока не сделана) |
| confidential | только private | none, intranet |

Модель без `egress` не проходит схему; сервер без `network` получает сеть своего профиля, а без профиля —
`internet`. Нарушение — отказ
роутера до вызова, событие `tool.denied`.

Один сервер можно выпустить за пределы `dataClass` только на чтение — исключением в `.jarvis/project.yaml`
(и только там), с причиной; каждый запуск и каждая страница `jarvis ui` об этом предупреждают (ADR-0016 §6):

```yaml
egressExceptions:
  - server: figma
    capabilities: ["figma.*"]  # по умолчанию ["*"]; выпускаются только чтения, эффекты — никогда
    reason: "макеты задач; согласовано с …"   # не короче 10 символов
```

### Лимиты агентов (`agents`)

У каждого встроенного агента есть лимиты на шаг: сколько раз он может вызвать инструменты и модель.
`agents.<id>.limits` меняет их для проекта (`.jarvis/project.yaml`) или машины (`~/.jarvis/config.yaml`),
переменной — `JARVIS_AGENTS__RESEARCH__LIMITS__MAX_TOOL_CALLS=80`.

```yaml
agents:
  research:     { limits: { maxToolCalls: 80, maxModelCalls: 100 }, onLimit: ask }   # по умолчанию 40 / 60
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
финализируется как обычно, но помечается неполным — `budgetExhausted: tools|model|budget` в происхождении
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
`JARVIS_LOG_KEEP_DAYS`, `JARVIS_LOG_MAX_FIELD` (см. [workflows.md](workflows.md#технический-лог)),
`JARVIS_PROGRESS=off` — без живой строки прогресса в терминале, переменные терминала `JARVIS_INTERACTIVE`,
`JARVIS_NOTIFY`, `JARVIS_NOTIFY_AFTER`, `JARVIS_TITLE`, `JARVIS_TAB_PROGRESS`, `JARVIS_MARKS`, `JARVIS_PAGER`,
`JARVIS_ACCESSIBLE`, `JARVIS_ASCII`, `JARVIS_EDITOR`, `JARVIS_CARD_POLL_MS` (см. [cli.md](cli.md)) и выставляемые
самим Jarvis `JARVIS_RUN`, `JARVIS_SHELL*`. Они конфигурацию не переопределяют.

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
