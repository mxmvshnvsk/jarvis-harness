# Конфигурация

Два файла и слои поверх них (ADR-0014, ADR-0017 §1):

| Слой | Где | Что |
|---|---|---|
| user | `~/.jarvis/config.yaml` | машина и человек: модели и endpoint'ы, credentials-ссылки, пулы квот, actor |
| project | `<project>/.jarvis/project.yaml` | проект и команда: роли, политика, инструменты, workspace, знание; версионируется. У сервиса без `.jarvis` — файл репы знаний и его `services.<имя>` ([ниже](#репа-знаний-для-многих-сервисов-adr-0025)) |
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
daemon:
  actAsOwner: true             # daemon пушит и открывает PR вашими credentials; false — прогон ждёт вас (ADR-0006 §4)
relatedWork:                   # ADR-0026: ветки и PR смежных задач до спеки (обычно в .jarvis/project.yaml)
  enabled: true                # по умолчанию для прогонов; на прогон — --related / --no-related, галочка в New task
  maxIssues: 12               # сначала связанные с задачей и названные в её описании; кто не влез — в notRead
  sides: { "Back Task": back, "Middle Task": back, "Front Task": front }   # тип задачи Jira → сторона: сначала читается другая
  # base: dev                  # с чем сравнивать ветку; по умолчанию — ветка по умолчанию репозитория
  # Нужны capability jira.devInfo (Atlassian) и, если репозитория нет на машине, bitbucket.branch.commits,
  # bitbucket.commit.get, bitbucket.file.get — с allow у сервера их надо добавить туда.
feedback:                      # «Сообщить о проблеме» в jarvis ui; то же можно задать в проекте
  repo: mxmvshnvsk/jarvis-harness   # куда открывается issue; false — кнопки нет
  host: https://github.com     # GitHub Enterprise — свой адрес

quotaPools:                    # ADR-0018 §4
  corp-default:
    window: { minutes: 20, kind: sliding }   # sliding | fixed
    limits: { outputTokens: 60000, inputTokens: 400000, requests: 300 }
    soft: 0.8                  # доля окна, после которой вызовы моделей пула идут по одному
    unlimited:                 # часы без лимитов на платформе: вызовы идут без проверки
      - { from: "22:00", to: "07:00" }   # через полночь — ок
      - { days: [sat, sun] }             # дни целиком; можно и дни, и часы в одном пункте
    timezone: Europe/Moscow    # пояс для unlimited (IANA); без него — пояс машины
    unlimitedScale: 10         # во сколько раз в эти часы растут лимиты агентов и budget.perStep/perRun

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
    timeoutMs: 120000          # сколько модель может молчать: до начала ответа и между его кусками; весь вызов — до ×10, не меньше 30 мин
    maxConcurrency: 2
    stream: true               # ответ потоком (SSE); по умолчанию включено, см. ниже
    prefixCache: { ttlSeconds: 120, minTokens: 8192 }   # шлюз кэширует префикс, но не пишет это в usage
    reasoningEffort: medium    # none | low | medium | high — reasoning_effort каждого вызова (см. ниже)
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
`models.<id>.maxConcurrency` (по умолчанию 2); с `soft` и выше — по одному. Это ограничение одного процесса, а
каждый прогон — свой процесс (и Ask на странице — тоже), так что между прогонами параллельность не ограничена.
`limits.concurrency` схема принимает, но пока не применяет. Сколько запросов к моделям идёт одновременно по всем
прогонам сейчас и каков пик за сегодня — в попапе **Models** в `jarvis ui` («At once»): если платформа начнёт
отвечать 429, это число покажет, какой лимит ставить.

`quotaPools.<pool>.unlimited` — часы, когда платформа пул не ограничивает (ночь, выходные). Пункты, которые
стыкуются, работают как один: будние ночи 22–07 и выходные целиком дают безлимит с пятницы 22:00 до понедельника
07:00. В эти часы вызовы проходят без проверки квоты. Потраченное в них в окно потом не засчитывается, так что в
07:01 прогон не встанет на паузу из-за ночных токенов. Прогон, вставший на паузу перед безлимитом, продолжится в
ближайший из двух моментов: когда освободится окно или когда начнутся безлимитные часы («unlimited hours begin
then» в причине паузы).

В те же часы лимиты агентов (`agents.<id>.limits`: вызовы инструментов и модели) и бюджет шага и прогона
(`budget.perStep`, `budget.perRun`) для вызовов этого пула растут в `unlimitedScale` раз (по умолчанию в 10). Совсем
лимиты не снимаются: зациклившийся агент всё равно остановится. Лимиты считаются заново при каждой проверке, так
что шаг, начатый ночью, утром снова держится дневных лимитов — но только за то, что сделает после: вызовы и токены,
потраченные в безлимитные часы, в дневные лимиты и `budget.perStep|perRun` не идут (бюджет — по времени каждого
`model.call`, лимиты агента — по счётчику вызовов в эти часы). Иначе прогон, потративший за ночь 80M токенов при
лимите 8M×10, в 8:00 сразу вставал. Выданное человеком (`+25 tool calls`)
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
language: ru                   # на каком языке агенты пишут для людей (см. ниже); можно и в ~/.jarvis/config.yaml
stackScopes:                   # полиглот: путь → стеки (ADR-0021 §9); иначе детекция по верхним каталогам
  "backend/**": [csharp, aspnet]
  "web/**": [typescript, react]

roles: { … }                   # как в user-конфиге

tools:
  local:                       # команды проекта → возможности project.<name>
    tests: "pnpm vitest run"
    typecheck: "pnpm tsc --noEmit"
    lint-web: "cd web && npx eslint --quiet"           # lint*: project.checks допишет изменённые файлы
    fix-web: "cd web && npx eslint --quiet --fix"
    services-check: "pnpm services:check"
    build-lib: "pnpm --filter @acme/ui-kit build"
  required: [tests, lint]      # без каких команд проект не готов (по умолчанию [tests]); см. ниже
  rebuild:                     # перед project.checks: сборка того, что пакеты читают собранным
    - { when: ["packages/ui-kit/**"], run: build-lib }   # run — имя из tools.local
  fix:                         # на каждый файл, что пишет агент, и на изменённые перед project.checks
    - { when: ["web/src/**/*.{ts,tsx}"], run: fix-web }
  checks:                      # своя проверка в project.checks, когда менялись её файлы
    - { when: ["server/src/config/**"], run: services-check }
  shell: false                 # shell.run для произвольных команд в workspace
  maxOutputBytes: 65536        # вывод инструмента агенту обрезается; полный (редактированный) — blob
  commandTimeoutMs: 600000

workspace:                     # ADR-0003
  mode: worktree               # worktree | cwd
  checkout: worktree           # worktree | clone — см. ниже
  setup: "pnpm install --offline --frozen-lockfile"   # после создания worktree
  allowWrites: true            # по умолчанию true для worktree, false для cwd
  retentionDays: 7             # jarvis gc
  try:                         # «Try it» на гейте реализации: как запустить результат
    run: "pnpm dev"            # команда или список; без неё — догадка по scripts в package.json
    url: http://localhost:3000 # что открыть
    note: "войти тестовым пользователем"   # строка подсказки
  cache:                       # зависимости между worktree (по умолчанию выключено)
    key: [pnpm-lock.yaml]      # файлы, по содержимому которых кэш подходит
    paths: [node_modules, "packages/*/node_modules"]   # что сохранить; `*` — один уровень каталогов

`workspace.checkout: clone` — рабочая копия прогона как `git clone --shared`, а не `git worktree`: свой каталог `.git`,
объекты общие с репозиторием (быстро, без копий), ветка прогона создаётся в клоне и при каждом коммите (хук
post-commit) и откате отправляется в репозиторий, так что `jarvis diff`, `apply`, `gc` и страницы видят её как обычно.
Для сборок, чьи инструменты читают git через JGit, не знающий worktree: Gradle-плагин версионирования падал в каждой
worktree с `Missing unknown <sha>` / `Bare Repository has neither a working tree, nor an index`.

modelWait:                     # модель недоступна после повторов шлюза: прогон ждёт, а не падает
  checkEveryMinutes: 5         # как часто проверять (одна попытка, без повторов)
  giveUpAfterHours: 12         # дольше — прогон падает, как раньше
budget:                        # ADR-0018 §4 — лимиты сверх пулов
  perRun:  { inputTokens: 3000000, outputTokens: 200000, requests: 400 }
  perStep: { inputTokens: 800000, outputTokens: 40000, requests: 80 }
  # inputTokens — сумма промптов без того, что взял кэш префикса: каждый вызов шлёт весь разговор шага
  # заново, и вход растёт быстрее числа вызовов (пилот: research 15 вызовов — 0,55M, 39 — 1,84M, 51 — 2,47M).
  # Закэшированное — `cached_tokens` шлюза, а пока он их не отдаёт — оценка по `models.<id>.prefixCache`:
  # вызов в пределах ttlSeconds после предыдущего вызова шага с общим префиксом не короче minTokens
  # считает этот префикс закэшированным (`cachedEstimated` в model.call; на странице — «≈ … cached»).
  # Пилот: прогон дважды вставал на 40M входа, ~95% которого кластер брал из кэша.

humanGate: artifact            # fail | artifact | skip-if-approved — что делать на гейте без человека
                               # (неинтерактивный режим, ADR-0009 §2)

human:                         # ADR-0019 §9
  gates:
    spec: { required: true }
    implementation: { required: true }   # required: false — гейт проходится молча
  review:
    sourceMarkers: true                  # // REVIEW: в коде
    removeMarkersAfterApproval: true
  clarification: { multiTurn: true, maxTurns: 8 }
  suggestAnswers: true                   # перед гейтом — ответы на открытые вопросы документа (один вызов модели)
  autonomous: false                      # experimental: прогоны без человека по умолчанию (как --autonomous, cli.md)
  checks:
    ask: same-failure                    # когда упавшие проверки останавливают прогон до следующего круга:
                                         # same-failure — упали так же, как в прошлом круге, или тесты не запустились;
                                         # every-failure — при любом падении; when-rounds-end — только когда круги кончились

knowledge:                     # ADR-0020 §3, §5; ADR-0015
  maxSkills: 2                 # скиллов на вызов агента; остальные — «по запросу»
  split: { skills: 0.4, standards: 0.35, knowledge: 0.25 }   # доли бюджета слоя L4
  retrieval:
    rankAbove: 4               # ранжировать документы знания индексом, если подошло больше этого числа
    embeddings: embed          # id модели с /embeddings; выключено по умолчанию (ADR-0015 §6)
    code:                      # код в индексе поиска (ADR-0015 §2 v0.4); `code: false` — выключить
      include: ["src/**"]      # глобы от корня; пусто — все отслеживаемые файлы исходников
      exclude: ["src/legacy/**"]
      maxFiles: 5000           # больше файлов не берётся
      maxFileBytes: 262144     # файл крупнее пропускается
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
  workingSet: 160000           # токенов результатов инструментов сверх задачи целиком; 0 — выкл.;
                               # по умолчанию 160k у модели с prefixCache, иначе 80k (у implementation — 40k)

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

`tools.required` — какие проверки у проекта обязаны быть (по умолчанию только `tests`). `tests` закрывает любая
команда `test*` из `tools.local` (`test`, `tests-unit`, `test:e2e`), `lint` — любая `lint*`, `typecheck` — `typecheck*`,
другое имя — команда с этим именем. Чего не хватает, говорят `jarvis onboard`, `jarvis doctor` и страница Knowledge →
Services; остальные из `tests`, `typecheck`, `lint` там показаны как необязательные. В репе знаний задаётся общим и
переопределяется у сервиса (`services.web-app.tools.required: [tests, lint]`); у библиотеки к ним добавляется
`publish-local`. На запуск задачи не влияет: проверки идут те, что есть.

`tools.rebuild` — сборки, от которых зависят проверки. Пакет монорепо, который читает общую библиотеку
собранной (`exports` в её папку публикации), проверяется против той сборки, что лежит на диске; `setup` собрал
её до изменений прогона, и `tsc` приложения проходил на старых типах. Правило: если изменённый файл подходит под
`when`, `project.checks` сначала выполняет команду `run` из `tools.local` (каждую один раз), потом все `typecheck*`
— и для пакетов без своих изменений. Упавшая сборка — дефект с хвостом вывода. Те же сборки идут и перед
`project.test*`/`project.typecheck*`, которые вызывает агент, если исходники сборки изменились с прошлого раза
(в выводе — `[rebuilt first: …]`); сборки и такие проверки в одной рабочей копии идут по очереди. Блок «Try it» ставит те же
команды перед запуском. Проверку типов самой библиотеки добавь отдельной командой `typecheck-<lib>`.

`tools.fix` — форматтер или линтер с `--fix`. Команде `run` дописываются файлы, подходящие под `when`, —
относительно её пакета (`cd <dir> && …`) и в кавычках. Она идёт на каждый файл, который агент записал
(`repo.write`, `repo.edit`): что исправимо — исправлено, в ответе записи `[fix-web: reformatted the file — read it
again before the next edit]`; что нет — хвост вывода линтера, и агент правит это сразу, а не кругом verify. Перед
`project.checks` она же идёт на все изменённые файлы (в checks.json — `fix:<имя>` и `fixed`). Пилот: круг реализации
ушёл на переносы строк в импорте (`object-curly-newline`), которые линтер правит сам. Это примерно одна
команда линтера на запись — несколько секунд.

Команды `lint*` в `project.checks` получают изменённые файлы кода своего пакета: ошибки, что были в репозитории до
прогона, не его (пилот: `yarn lint` падал на пакете, которого прогон не трогал, и агенты не отличали свои ошибки).
`tools.checks` — команда целиком, когда прогон менял файл под `when`: сверка снапшотов, таблиц роутов.

Аргументы, которые агент дописывает к `project.<имя>`, — слова для команды, не shell: каждое в кавычках,
пайп, перенаправление и цепочка (`|`, `>`, `2>&1`, `&&`, `;`) — отказ с объяснением. Пилот: агенты дописывали
`2>&1 | tail -120`, и командная строка уходила в `/bin/sh` как есть.

`workspace.try` — как человек проверяет результат до решения на гейте реализации. Страница реализации в
`jarvis ui` показывает блок **Try it**: путь рабочей копии прогона и ветку (`setup` там уже выполнен — без
него рабочей копии нет), команды из `run`, адрес `url`, строку `note`, критерии приёмки из спеки списком
с галочками, тот же путь в основном репозитории (`git switch -c try-<run> <ветка>`, `setup`, `run`) и к чему
ведут Accept и Send back. Без `run` команда берётся из `scripts` в package.json рабочей копии (`start-dev`,
`start:dev`, `dev`, `start`, `serve` — первая найденная, через yarn/pnpm/npm по lockfile) и помечена как
догадка. Для монорепозитория команду лучше задать явно: `yarn workspace <app> start-dev`.

### Язык агентов (`language`)

`language: ru` — агенты пишут по-русски всё, что читают люди: summary и находки research, требования и spec,
вопросы и замечания ревью, ответы `jarvis ask`, карты модулей. Как есть остаются ключи JSON и значения `outcome`,
имена из кода, пути, команды и цитаты из источников (на языке источника). Задаётся в `.jarvis/project.yaml` для
команды (важнее) или в `~/.jarvis/config.yaml` для себя; `JARVIS_LANGUAGE` — на один запуск. Значение — код (`ru`,
`en`, `uk`, `de` …) или название языка. Без настройки модели пишут на своё усмотрение, на практике по-английски.
Надписи самого Jarvis (терминал, `jarvis ui`) и заготовки `jarvis onboard` остаются на английском.

### Карта контрактов (`contracts`)

Файлы, по которым шаг `sources` сверяет методы API, упомянутые в задаче и её страницах (`GET /path`), — до агентов и
без модели ([integrations.md](integrations.md)). Подходит карта, которую держит в актуальном виде тест: снепшот
маршрутов BFF, сгенерированный список ручек, OpenAPI, сведённый в JSON.

```yaml
contracts:
  - files: ["server/__snapshots__/services-*.json"]   # от корня репозитория; * — только в имени файла
    about: маршруты BFF, сверяются тестом              # пара слов для агентов
```

Формат файла — JSON: объект «ключ → запись» или массив записей; в записи `path` и/или `url`, необязательно `method`
(тогда метод упоминания должен совпасть). Несколько файлов (по карте на приложение) сводятся вместе: одна и та же
запись показывается одной строкой со списком файлов. Нечитаемый или отсутствующий файл попадает в «Not read».

Сервису на Spring карта не нужна: эндпоинты его кода (`@GetMapping`… под `@RequestMapping` класса, в том числе
унаследованные от базового контроллера), вызовы через Feign-клиенты и топики Kafka из `application*.yml` с их
слушателями (`@KafkaListener`) берутся из графа проекта ([integrations.md](integrations.md)). `contracts` и код
сверяются вместе.

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

Сервер, которого нет в `mcp.servers` этой машины, — не ошибка конфигурации: файл проекта едет с репозиторием, а серверы у
каждого разработчика свои. `jarvis doctor` и `jarvis config` предупреждают, исключение начнёт действовать, когда сервер
добавят.

Так же внешнюю (облачную) модель — `egress: cloud` — можно разрешить проекту, чей `dataClass` пускает только
`private`: исключение `modelEgressExceptions` в `project.yaml` проекта (или репы знаний; и только там), с причиной.
Каждый запуск, каждая страница `jarvis ui` и `jarvis doctor` об этом предупреждают:

```yaml
modelEgressExceptions:
  - model: deepseek-public          # id из models личного ~/.jarvis/config.yaml
    reason: "публичный DeepSeek для research; согласовано с …"   # не короче 10 символов
```

Модель в личном конфиге при этом честно помечается `egress: cloud`. Модели, которой нет на этой машине, — только
предупреждение.

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

**Сколько модель думает.** `reasoning_effort` (`none | low | medium | high`) — у модели (`models.<id>.reasoningEffort`,
для всех вызовов) и у агента (`agents.<id>.reasoningEffort`, поверх модели). Агентский уходит только модели с
`supports.reasoning: true` или своим `reasoningEffort` — другая может отклонить незнакомое поле. В `model.call`
пишется, с каким значением шёл вызов. Пилот: до 10 тыс. токенов рассуждения перед ответом в одну строку, и они
входят в `completion_tokens` и в квоту вывода; шлюз пилота параметр пока не пропускает (проверка — тот же
запрос с `low` и `high`: длина `reasoning_content` должна отличаться стабильно). У implementation по умолчанию
`low`: план уже решил, что менять, и каждый вызов — правка или проверка.

```yaml
agents:
  requirements:   { reasoningEffort: high }
  review:         { reasoningEffort: high }
  implementation: { reasoningEffort: low }
  test:           { reasoningEffort: low }
```

**Сколько агент несёт в каждом вызове.** Шлюз пилота не кэширует префикс, поэтому каждый вызов модели
заново отправляет сообщение задачи и весь разговор. Пилот: implementation отправлял ~240 тыс. символов
задачи в каждом из 162 вызовов, это две трети 20M входных токенов шага.
- `agents.<id>.baseChars` — размер сообщения задачи (входы и знания) в символах. У implementation и
  review 100 000, у test 80 000; у остальных — доля окна модели. Если у модели нет `prefixCache`, implementation
  берёт 60 000 и держит 40 000 токенов результатов инструментов (`workingSet`) вместо 80 000. Что не влезло, остаётся по запросу:
  обрезанный вход помечен `knowledge.read <тип/имя@версия>`, design у implementation только по запросу
  (тексты кадров уже в спеке).
- `context.workingSet` — сколько токенов результатов инструментов агент держит целиком: сверх него
  старые уходят в указатели (оригинал читается `knowledge.read blob:…`) одним пакетом до 60%, источники
  задачи и перечитанные файлы остаются; следующая обрезка — когда результаты вырастут ещё на 40% порога.
  По умолчанию 160k у модели с `prefixCache` (держать дёшево, а обрезка стоит перечитываний: пилот — 20
  перечитываний после трёх обрезок), иначе 80k. До этого обрезка шла только от давления окна: при окне
  500k — после 178k токенов.
- Запрос документа в конце шага не меняет системное сообщение: схема уходит в последний запрос, и кэш
  префикса берёт весь разговор.
- Файл, который сообщение задачи показывает целиком («Code already read», файлы шага плана), при
  `repo.read` без изменений отвечается указателем; повторный запрос — текстом.
- Длинный файл (больше 400 строк), классы и методы которого знает адаптер стека (Java), `repo.read` отдаёт
  оглавлением: классы с аннотациями и супертипами, поля, методы с сигнатурами и строками; `symbol:
  "OrderService.find"` — строки метода (по файлу как он есть сейчас), `full: true` — весь файл. В сообщении
  задачи такой файл — оглавление и части, которые читали раньше или которые называет шаг плана. На
  Spring-сервисе: 18 файлов длиннее 400 строк (до 2600), оглавление — около 11% их текста.
- `knowledge.read` понимает входы так, как их называет сообщение задачи (`design/design.md@1`), короткую
  ссылку на оригинал (`blob:96acfe00d8f3`) и документ знаний без префикса (`documentation/x.md`).
- `repo.list` по умолчанию — один уровень (папки с числом файлов), `recursive: true` — всё. `git.diff`
  без пути — список файлов и дифф кода до 24 тыс. символов; тесты, снапшоты и lock-файлы — по именам,
  их дифф — с `path`; новые незакоммиченные файлы — списком; `full: true` — всё.

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

### Доставка PR (`delivery`)

Как завершённый прогон уходит pull request'ом — `jarvis apply --pr`, «Create PR» на странице, `--deliver pr`
(ADR-0003 §4). Это решение команды: в `.jarvis/project.yaml`.

```yaml
delivery:
  pr: allow                    # allow (по умолчанию) | approve — PR сначала одобряет человек | deny — PR не создаются
  remote: origin               # куда пушится ветка jarvis/...
  target: main                 # куда PR; без него — ветка по умолчанию remote'а (origin/HEAD), иначе main
  capability: bitbucket.pr.create   # если PR умеют открывать несколько MCP-серверов
  workspace: SHOP              # репозиторий на сервере; без них — из URL remote'а
  repo: orders-api
```

PR открывает MCP-сервер с профилем `bitbucket` (`bitbucket.pr.create`, [integrations.md](integrations.md)); push —
ваш git. При `approve` одобрение — артефакт `pr-request` с заголовком, описанием и ветками, решение пишется с
актором; прогон с `--deliver pr` ждёт его в `WAITING_HUMAN`. Прогон, читавший недоверенный контент из интернета,
свой PR без одобрения человека не создаёт и при `allow` (ADR-0016 §4).

### Режимы `humanGate`

| Режим | На гейте без интерактива |
|---|---|
| `artifact` | run паркуется в `WAITING_HUMAN`, пишется `approval-request.json`, выход 10 |
| `skip-if-approved` | если `.jarvis/approvals/<task>/<type>.json` утверждает тот же хеш содержимого — гейт пройден (`approval.committed`); иначе как `artifact` |
| `fail` | run `FAILED` с причиной `policy: human_gate_in_ci`, выход 12 |

## Репа знаний для многих сервисов (ADR-0025)

Если у сервисов свои репы и в них не должно быть ничего от Jarvis, всё его хранится в отдельной репе знаний
рядом с остальными. Проще всего назвать её `jarvis-knowledge`. Репа только для Jarvis, поэтому `.jarvis/` в ней
не нужна: `project.yaml` и папки лежат прямо в корне. Вариант с `.jarvis/` внутри тоже работает: если есть
`.jarvis/project.yaml`, берётся он.

Быстрый старт — `jarvis init --knowledge` в новой пустой папке:

```sh
cd ~/repos && mkdir jarvis-knowledge && cd jarvis-knowledge
jarvis init --knowledge            # --repos <dir>, если репы сервисов лежат не в ..
```

Команда делает `git init`, кладёт `project.yaml`, `knowledge/`, `standards/`, `skills/` и черновик карты
`services:` — по одной строке на каждую git-репу рядом (имя папки, в комментарии сборка: gradle, maven, node…).
Код сервисов она не читает: смотрит только, какие папки — git-репы, и их файл сборки; код читает `jarvis onboard`.
Карту дальше правите руками: лишнее удалить, переименованным дописать `repo:`. Репы со своей `.jarvis/`
помечены — они работают отдельно, пока её не убрать; `init` печатает для них команды переноса знания.
Повторный запуск ничего не перезаписывает и показывает репы, которых ещё нет в карте.
Дальше `jarvis onboard` прямо в репе знаний проходит по всем сервисам карты (`--service <имя>` — по одному) и
дописывает каждому `kind` и команды `tools.local`:

```yaml
services:
  orders-api:
    kind: backend
    tools:
      local:
        tests: ./gradlew test
        typecheck: ./gradlew classes testClasses -q
  web-app:
    kind: frontend
    tools:
      local: { tests: pnpm test, typecheck: pnpm typecheck, lint: pnpm lint }
  common-lib:
    kind: library                       # меняется первой в задаче на несколько сервисов
    publishes: [com.example:common-lib] # под каким именем его берут сервисы
    tools:
      local:
        tests: ./gradlew test
        publish-local: ./gradlew publishToMavenLocal
  payments-api:
    kind: backend
    uses: [common-lib]                  # ждёт её изменения в такой задаче
```

```
repos/
  jarvis-knowledge/
    project.yaml                # общая конфигурация + карта сервисов
    workflows/ standards/ skills/ agents/
    knowledge/
      landscape.md glossary.md  # общее: границы, глоссарий
      services/<сервис>/        # знание сервиса: architecture, conventions, contracts, module-*.md
  orders-api/                   # без .jarvis
  slots-service/
```

```yaml
# jarvis-knowledge/project.yaml
version: 1                             # в корне обязателен вместе с services: — иначе это не файл Jarvis
stack: [java, spring, kafka, gradle]   # ключи верхнего уровня — общее для всех сервисов
tools: { local: { test: ./gradlew test } }
repos: ..                              # где лежат репы; по умолчанию папка над репой знаний
services:
  orders-api: {}                       # репа ../orders-api
  delivery-slots-api:
    repo: slots-service                # папка называется иначе
    tools: { local: { test: "TZ=Europe/Moscow ./gradlew test" } }
```

`services.<имя>` принимает те же ключи, что `project.yaml`. Слои: user → общее репы знаний → сервис
(`jarvis config show --sources` подписывает их `project:…#services.<имя>`).

Как Jarvis находит своё, если запущен в репе без `.jarvis`:
1. репа знаний: `JARVIS_KNOWLEDGE`, иначе `knowledgeRepo` в `~/.jarvis/config.yaml`, иначе соседняя папка, чей
   `project.yaml` содержит `services:` (сначала `jarvis-knowledge`);
2. сервис: тот, чья репа по карте — эта. Если у вас репы лежат иначе, своя раскладка задаётся в личном конфиге:
   ```yaml
   # ~/.jarvis/config.yaml
   knowledgeRepo: ~/work/jarvis-knowledge
   repos: { delivery-slots-api: ~/work/slots }
   ```
   Порядок: `repos.<имя>` личного конфига, `services.<имя>.repo`, имя папки.
3. Репы нет в карте — предупреждение с подсказкой, что добавить; `jarvis doctor` показывает его и проверяет карту
   целиком (каждая ли репа на месте, нет ли двух сервисов на одной папке).

Репа со своей `.jarvis/project.yaml` работает как раньше: репа знаний для неё не ищется.

Что меняется для сервиса:
- знание, принятые модули, результаты `onboard` пишутся в `knowledge/services/<сервис>/` репы знаний; общие
  документы верхнего уровня `knowledge/*.md` агенты видят как `common/<имя>`, глоссарий — общий;
- workflow, стандарты, скиллы, инструкции агентов, утверждения (`--commit`) — из репы знаний (из корня или её
  `.jarvis/`);
- `jarvis init` в сервисе ничего в нём не создаёт;
- `onboard` (в сервисе или в репе знаний по всей карте) сам дописывает в `services.<сервис>` то, что нашёл скан:
  `kind` (`frontend` — react, vue, angular, svelte, next; `backend` — java, kotlin, go, dotnet, python, node без
  фронтового фреймворка) и команды `tools.local` (`tests`, `typecheck`, `lint`, `build` — из `package.json`,
  gradle, maven…). Пишет только пустое: ключ, уже заданный у сервиса или в общем `tools.local`, не трогает и
  показывает, если найденное от него отличается («kept as set»). `--dry-run` только показывает;
- библиотеки: `onboard` по файлам сборки, без модели, пишет `kind: library`, `publishes` и `tools.local.publish-local`
  репе, которую публикуют для других (Gradle с `maven-publish` и без приложения — `group:name` и
  `publishToMavenLocal`; Maven без Spring Boot и не war — `groupId:artifactId` и `mvn install`; npm-пакет не
  `private` с точкой входа — имя пакета и `npm pack`), а сервисам, в чьей сборке есть эти имена, — `uses`. В задаче на
  несколько сервисов сабтаск сервиса из `uses` библиотеки ждёт, пока её изменение примут и `publish-local` пройдёт в
  её копии, и получает в задаче новую версию ([workflows.md](workflows.md#граф-sdd-cross-задача-по-нескольким-сервисам-adr-0025-6)).
  `backend` и `frontend` — справочные, на поведение не влияют;
- черновики знания на страницах `jarvis ui` коммитятся в репе знаний; дальше — ветка и PR;
- прогон записывает коммит репы знаний и её изменённые файлы (`run.created` → `knowledgeRepo`);
- eval-кейсы сервиса лежат в репе знаний (docs/evals.md).

## Переменные окружения

Зарезервированные: `JARVIS_HOME`, `JARVIS_CONFIG`, `JARVIS_PROFILE`, `JARVIS_ACTOR`, `JARVIS_ON_BEHALF_OF` (в CI —
автор изменения, от имени которого работает job; ADR-0006 §2),
`JARVIS_KEYCHAIN_BACKEND`, `JARVIS_KNOWLEDGE` (репа знаний, см. выше) и переменные технического лога `JARVIS_LOG`, `JARVIS_LOG_DIR`,
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
