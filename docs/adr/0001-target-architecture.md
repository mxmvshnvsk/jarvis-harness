# ADR-0001: Jarvis — целевая архитектура

- Статус: принято (редакция 2, адаптирована под реализацию)
- Дата: 2026-10-03 (исходная редакция), 2026-10-04 (редакция 2)
- Область: конечная архитектура Jarvis; roadmap приведён только как путь к ней
- Уточняют: [ADR-0002](0002-run-effects-and-lease.md) … [ADR-0024](0024-knowledge-in-web-ui.md)
- Код: весь `src/`; нумерация разделов сохранена из исходной редакции — на неё ссылаются код и ADR

> **Ключевая формула: Jarvis ≠ AI coding chat.**
> Jarvis = engineering runtime + SDD workflows + project knowledge + context policies +
> resource governance + tools + replaceable LLMs.

## Как читать эту редакцию

Исходная редакция описывала целевое состояние. Пока оно реализовывалось, часть решений уточнилась,
часть изменилась, часть появилась. Эта редакция — то же целевое состояние, приведённое в соответствие с
принятыми ADR-0002…0021 и с кодом. Что изменилось — перечислено в [Приложении A](#приложение-a-изменения-относительно-исходной-редакции),
что из целевой модели ещё не реализовано — в §20 и [Приложении B](#приложение-b-что-не-реализовано).
Пометки в тексте: **[ADR-N]** — решение уточнено отдельным ADR; **[не реализовано]** — целевая модель
сохраняется, кода пока нет.

## Содержание

1. Контекст, цели и архитектурные принципы
2. Конечная модель системы
3. Deployment и физическая модель
4. Core domain: Run, Workflow, Step, Artifact
5. Workflow Runtime и SDD
6. Agent Runtime и специализация агентов
7. Context Engine: lost-in-the-middle, trimming, compaction, reset
8. Knowledge Engine и Project Graph
9. Tool Platform, MCP и capability routing
10. Model Gateway и model routing
11. Budget & Resource Manager
12. Durable state, Artifact Store и Storage
13. Security и policy enforcement
14. Observability, tracing и evals
15. Developer UX: CLI, IDE, Git hooks, CI
16. Целевая структура репозитория
17. Целевой стек
18. End-to-end execution flows
19. Failure model и восстановление
20. Эволюция к целевой архитектуре
21. Acceptance criteria зрелого Jarvis
22. Итоговое решение

---

## 1. Контекст, цели и архитектурные принципы

Jarvis создаётся для закрытой корпоративной среды, где модели не имеют доступа в интернет, а
инженерный контекст распределён между исходным кодом, Jira, Confluence, Bitbucket, Elastic и локальными
знаниями проекта. Основная рабочая область — TypeScript/React и сложный legacy, где качество результата
зависит прежде всего от корректного исследования зависимостей и бизнес-правил. **[ADR-0021]** Ядро при
этом не знает о конкретном стеке: TypeScript — первый адаптер языка, а не часть ядра; другие стеки
(например, C#/.NET) подключаются через те же контракты.

### Цели

- Делать AI-разработку воспроизводимой: задача проходит через явный workflow, а не через
  неструктурированный чат.
- Поддерживать specification-driven development: research → requirements → specification → impact
  analysis → plan → implementation → verification → review.
- Экономно расходовать модельный бюджет и приостанавливать работу при исчерпании квоты.
- Решать проблему загрязнения длинного контекста и lost-in-the-middle через построение контекста,
  trimming, compaction, retrieval и reset.
- Хранить знания проекта независимо от конкретной модели, IDE или coding agent.
- Использовать deterministic tooling везде, где LLM не нужен: AST, git, ripgrep, typechecker, tests,
  schemas.
- Позволять интерактивному OpenCode (и любому MCP-клиенту) существовать рядом, но не делать его
  владельцем workflow или project knowledge.
- **[ADR-0019]** Делать участие человека явной частью процесса: гейты, уточнения и ревью — сущности
  runtime с состоянием, а не реплики в чате.

### Архитектурные принципы

| Принцип | Следствие |
|---|---|
| Run > Agent | Главная сущность — долговечное выполнение инженерной задачи, а не автономный агент. |
| Artifacts > chat history | Агенты передают структурированные артефакты, а не длинные пересказы. |
| Construct context | Контекст собирается под следующий шаг, а не бесконечно накапливается. |
| Sources survive summaries | Compaction не уничтожает исходные документы и tool outputs. |
| Workflow owns control | Порядок фаз определяет workflow/policy, а не самопроизвольный swarm. |
| Ports & adapters | Модели, MCP, storage и **языки программирования** являются сменными адаптерами. **[ADR-0011, ADR-0021]** Mastra не используется вовсе. |
| Measure first | Новые агенты и retrieval-механизмы остаются только если evals показывают пользу. |
| Human is first-class **[ADR-0019]** | Человеческое решение — версионируемый артефакт/тред, привязанный к хешу содержимого. |
| Knowledge as data **[ADR-0020]** | Стандарты, навыки и знание — файлы в репозитории, выбираются детерминированно и проверяются. |
| Stack-neutral core **[ADR-0021]** | Ядро не упоминает конкретные стеки; это проверяет архитектурный тест. |

## 2. Конечная модель системы

```
Developer / Git / CI / OpenCode / IDE
              |
              v
+---------------------------------------------------------------------+
|                               JARVIS                                |
|                                                                     |
|   CLI / MCP Server / CI Adapter / Git Hooks (pre-push)               |
|                                  |                                  |
|                                  v                                  |
|                         Orchestration Layer                         |
|   LocalWorkflowEngine + Policy (Tool Router) + Daemon/Scheduler     |
|                                  |                                  |
|        +-------------+-----------+-----------+--------------+       |
|        v             v                       v              v       |
|   Context Engine  Resource Manager     Artifact Store  Interactions |
|   (слои L0–L5)    (budget/admission)   (+ blobs)       (ADR-0019)   |
|        +-------------+-----------+-----------+--------------+       |
|                                  v                                  |
|                            Agent Runtime                            |
|                                  |                                  |
|              +-------------------+-------------------+              |
|              v                                       v              |
|        Tool Platform                            Model Gateway       |
|    Local | MCP | Knowledge | Graph          OpenAI-compatible ...   |
|              |                                                      |
|              v                                                      |
|     Capability Layer (адаптеры языков: TypeScript, …)  [ADR-0021]   |
|                                                                     |
|   Cross-cutting: Storage | Security | Telemetry (events) | Evals    |
+---------------------------------------------------------------------+
```

Целевая система имеет несколько входов, но одно ядро. CLI, CI и MCP server не реализуют собственную
логику разработки — они запускают один и тот же Run и один и тот же workflow runtime.

## 3. Deployment и физическая модель

```
~/dev/jarvis/                       # отдельный git-репозиторий harness
~/work/project-a/
  .jarvis/
    project.yaml                    # политика команды (ADR-0017)
    knowledge/                      # документы знания + glossary.md   [ADR-0015, ADR-0020]
    standards/  skills/             # типизированные правила и навыки  [ADR-0020]
    agents/  workflows/             # переопределения инструкций и графов
    approvals/<task>/<type>.json    # закоммиченные утверждения для CI [ADR-0009]
    specs/                          # зарезервировано под экспорт spec
    runs/  cache/                   # состояние; в .gitignore
~/.jarvis/
  config.yaml                       # модели, пулы квот, endpoint'ы     [ADR-0014, ADR-0017]
  jarvis.db                         # SQLite
  artifacts/blobs/  runs/  worktrees/  backups/
  cache/{mcp,graph}/
```

Jarvis поставляется как внутренний npm-пакет/CLI. Проект содержит только versioned project policy,
knowledge, standards, skills и approvals. Состояние выполнения, credentials, traces и кэш являются
локальными либо хранятся в корпоративном backend при переходе к shared runtime. Credentials — в OS
keychain (macOS / libsecret / Windows DPAPI / файл 0600) под актором **[ADR-0006, ADR-0017]**.

### Режимы запуска

| Режим | Назначение | Статус |
|---|---|---|
| Local CLI | Основной интерактивный запуск разработчиком. | реализовано |
| Git hooks | Pre-push: стандарты, проверки проекта, impact по графу, ревью агентом только по необходимости: `jarvis hooks install`, `jarvis prepush`. Pre-commit не реализован: проверки идут при push и в CI. | реализовано |
| CI | Non-interactive review/validation с теми же workflow definitions; `jarvis ci`, бандлы run. **[ADR-0009]** | реализовано |
| Jarvis MCP Server | knowledge/spec/run/context сервисы OpenCode и другим клиентам: `jarvis mcp serve`. | реализовано |
| Daemon/Scheduler | Автовозобновление quota-blocked runs: `jarvis daemon`. | реализовано |

## 4. Core domain: Run, Workflow, Step, Artifact

Run — центральная сущность. Он хранит identity задачи, workspace, workflow, текущий step, budget state,
ссылки на artifacts и durable execution state.

```
Run
 |- id, task, workflow, state
 |- workspace (worktree: ветка jarvis/<task>/<run> от baseCommit)      [ADR-0003]
 |- actor                                                              [ADR-0006]
 |- lease (владелец, epoch, heartbeat)                                 [ADR-0002]
 |- currentStep, iterations
 |- waitingFor { kind, interactionId, detail }                         [ADR-0019]
 |- budget state (per-run / per-step caps, usage по пулам)             [ADR-0018]
 |- artifacts[] (версии), approvals[]
 |- checkpoints[] (на границе шага и внутри шага), effects[]
 `- events[] (telemetry)
```

Workflow состоит из Step. Step может быть **deterministic**, **agentic**, **approval** или
**composite**. Результат каждого значимого шага — Artifact с версией, schema, provenance и source
references **[ADR-0005]**.

### Состояния Run

```
CREATED -> RUNNING -> COMPLETED
             |
             +-> WAITING_BUDGET -> RUNNING        (квота; resumeAfter)
             +-> WAITING_HUMAN  -> RUNNING | FAILED   (гейт, тред, неразрешённый эффект, лимит)
             +-> SUSPENDED      -> RUNNING
             +-> FAILED         -> RUNNING (retry) | terminal
             +-> CANCELLED                        [ADR-0002 §6] (из любого нетерминального)
```

Различие от исходной редакции: добавлено `CANCELLED`; `WAITING_HUMAN` теперь всегда сопровождается
`waitingFor` — что именно ждёт run. Run исполняет один процесс, владеющий арендой с эпохой; запись
checkpoint и эффектов защищена fencing'ом **[ADR-0002]**.

## 5. Workflow Runtime и SDD

**[ADR-0011]** Jarvis определяет собственный WorkflowRuntime (`LocalWorkflowEngine`). Mastra как
оркестратор **не используется**: исходное решение «Mastra как первая реализация» было отвергнуто — её
модель durable-исполнения не покрывала аренду, журнал эффектов и ограниченные обратные рёбра. Движок
работает через порт `StepExecutor`; типы стороннего оркестратора в domain layer не протекают.

Фактический SDD-граф (`sdd`, встроенный; переопределяется в `.jarvis/workflows/`):

```
TASK
 |
 v
discover ------------> project-capabilities           [ADR-0021]  (уровень FULL / BASIC / UNSUPPORTED)
 v
research ------------> research
 v
requirements ---------> requirements                   [ADR-0019]  (противоречия, пробелы; needs_clarification → тред)
 v
spec -----------------> spec
 v
approve-spec  (гейт: утверждение привязано к хешу)    ---- request_changes → spec
 v
impact ---------------> impact          (граф проекта как evidence)   ---- needs_research → research
 v
plan -----------------> plan                                     ---- spec_infeasible → spec
 v
implementation -------> implementation
 v
verify (composite, параллельно): tests | standards.check | docs | telemetry
 |      ---- defects_found / standards_violation → implementation; spec_gap → spec
 v
review ---------------> review                  ---- fix_required → implementation; plan_wrong → plan;
 v                                                    requirements_wrong → requirements
approve-impl (финальный гейт)  <----> review-analysis ( // REVIEW: маркеры → классификация → маршрут )
 v
release-notes
 v
DONE
```

Обратные рёбра объявлены явно, каждое с `maxIterations`; переход — чистая функция от исхода шага
**[ADR-0004]**. Workflow policy решает, какие ветки обязательны. Небольшая задача может пропустить фазы
(собственный workflow, `human.gates.<type>.required: false`); изменение публичного API,
бизнес-критичной логики или telemetry может включить дополнительные гейты. Автоматический выбор веток
по риску изменения **[не реализовано]**: сейчас политика задаётся workflow и конфигурацией.

## 6. Agent Runtime и специализация агентов

| Agent | Основная ответственность | Статус |
|---|---|---|
| Research | Собрать требования, источники, affected areas, неизвестные и существующие реализации. | реализовано |
| Requirements **[ADR-0019]** | Проверить требования на непротиворечивость, полноту и проверяемость; блокирующий пробел → вопрос человеку. | реализовано (новый) |
| Specification | Превратить research в проверяемую спецификацию и acceptance criteria. | реализовано |
| Impact Analysis | Найти code/domain/test/telemetry/docs dependencies и риски; использует граф проекта. | реализовано |
| Plan | Разбить спецификацию на проверяемые шаги. | реализовано |
| Implementation | Внести минимально достаточные изменения кода. | реализовано |
| Test | Построить и выполнить стратегию проверки. | реализовано |
| Telemetry | Проверить/добавить события и метрики, logging/tracing/Elastic-сигналы. | реализовано (**Metrics объединён с Telemetry**) |
| Documentation | Синхронизировать техническую и пользовательскую документацию. | реализовано (`docs`) |
| Review | Проверить diff против spec, conventions, стандартов и evidence. | реализовано |
| Review-analysis **[ADR-0019]** | Классифицировать `// REVIEW:` замечания человека и выбрать маршрут графа. | реализовано (новый) |
| Release-notes | Подготовить публикуемые release notes после финального гейта. | реализовано (новый) |

AgentDefinition задаёт инструкции, model role, capability set, requirements к модели, контракт
результата (schema + допустимые outcomes) и лимиты. Агент не получает все MCP tools и не знает деталей
model API. Ни один агент не получает эффекты на внешние системы — они выполняются детерминированными
шагами через журнал эффектов. Инструкции агента переопределяются проектом (`.jarvis/agents/<id>.md`).

Параллельность допускается только когда ветви действительно независимы (`verify`). Jarvis не
стремится к swarm: лишний агент должен оправдывать output-token cost.

## 7. Context Engine

Context Engine отвечает не за «память чата», а за формирование минимального high-signal
ContextPackage для конкретного model call.

### Слои

```
L0 System / security / immutable policy       NEVER COMPACT   (байт-в-байт стабилен → prefix cache)  [ADR-0013]
L1 Task / spec / hard constraints             NEVER COMPACT
L2 Current state / decisions                  STRUCTURED      (шаг, итерация, loop reasons, принятые уточнения)
L3 Current working set                        RELOADABLE      (входные артефакты)
L4 Retrieved knowledge / sources              RELOADABLE      (EngineeringContextPackage)       [ADR-0020]
L5 Tool history / conversational residue      EVICTABLE
```

Слои L0–L5, byte-stable системный слой, fair-share бюджет слоя L4, загрузка по ссылке
(`knowledge.read`) и самокалибрующаяся оценка токенов **реализованы**. L4 теперь — не «найденное»,
а детерминированно выбранный пакет: навыки > стандарты > знание **[ADR-0020]**.

### Context pressure policy **[ADR-0013]**

| Usage | Политика |
|---|---|
| < 40% | Healthy: обычная сборка контекста. |
| 40-60% | Watch: continuous trimming старых tool results. |
| 60-75% | Semantic compaction; целевой размер около 35%. |
| 75-85% | Aggressive compaction + более строгий retrieval. |
| >= 85% | Context reset / новый agent session с structured handoff. |

«Usage» — доля эффективного окна: `min(contextWindow, context.maxContext) − резерв под вывод − 5% окна`.
Пороги (`context.thresholds`: `default`, `byModel`, `byPhase`; приоритет — фаза > модель > по умолчанию;
значения зажимаются так, чтобы порядок сохранялся) и `compactTarget` настраиваются; 60% остаётся
стартовой гипотезой, а не универсальным законом, и подтверждается evals. Реализация — `src/context/`:

- **watch** — старые результаты инструментов заменяются началом и ссылкой на блоб с оригиналом
  (`knowledge.read blob:<ref>`);
- **compact** — сначала trimming, затем старые блоки сворачиваются в один structured handoff (goal,
  requirements, decisions, business rules, progress, unresolved, next actions, sources); суммаризацию
  делает роль `compaction`, а если её нет — модель самого агента; оригинал сохраняется блобом, ссылки
  `Originals:` накапливаются между сжатиями; пары tool-call/tool-result не разрываются;
- **aggressive** — то же с меньшим хвостом и пересобранной (×0,6) базой L3/L4, один раз за шаг;
- **reset** — handoff вместо всей истории, не более двух сбросов за шаг;
- отказ суммаризатора не ломает run: жёсткий trimming и событие `context.compaction_failed`; исчерпание
  квоты и ошибки авторизации пробрасываются как обычно;
- ручное управление: `jarvis context [run]`, `jarvis compact <run> [--aggressive] [--dry-run]`,
  `jarvis reset-context <run> [--dry-run]` — работают с транскриптом припаркованного run и сохраняют
  новый checkpoint, с которого resume продолжит;
- события: `context.pressure`, `context.trimmed`, `context.compacted`, `context.reset`,
  `context.tightened`, `context.compaction_failed`, `context.overflow`; в `agent.finish` — пик давления
  и счётчики. Не сделано: сериализатор префикса для метрики cache-hit и `jarvis stats`.

Дополнительно остаются прежние ограничители раздувания: reset между фазами (каждый агент стартует с
чистого окна и получает только артефакты и retrieved evidence), лимиты `maxToolCalls`/`maxModelCalls`,
cap на вывод инструментов (`tools.maxOutputBytes`) и checkpoint транскрипта.

### Compaction

```
RAW SOURCE ----------------------------> Artifact Store
    |
    +-> compact representation ----------> Active Context

Need exact detail later:
Active Context -> artifact/search/read -> original source
```

Compaction сохраняет goal, requirements, decisions, business rules, constraints, progress, modified
files, unresolved questions, next actions и source references. Исходные данные остаются доступными,
чтобы избежать каскадного summary-of-summary: сжатая часть и обрезанные результаты хранятся
content-addressed блобами, а предыдущий handoff при следующем сжатии переносится вперёд, а не
пересказывается по памяти.

### Reset между фазами

```
Research context -> research artifact -> RESET -> Impact context
Impact context   -> impact artifact   -> RESET -> Implementation context
```

Это основной механизм против накопления шума и lost-in-the-middle: специализированные агенты начинают
с чистого окна и получают только релевантные artifacts + retrieved evidence. **Реализовано.**

## 8. Knowledge Engine и Project Graph

Knowledge Engine объединяет versioned project knowledge, deterministic project graph,
lexical/structural retrieval, semantic retrieval и внешние корпоративные источники.

```
                         Knowledge Engine
        +----------------+----------------+-----------------+
        v                v                v                 v
 Versioned docs     Project Graph    External knowledge   Standards & Skills
 architecture.md    symbols/imports  Jira/Confluence       .jarvis/standards
 domain.md          routes/APIs      Bitbucket/Elastic     .jarvis/skills
 glossary.md        tests/events     (через MCP)           [ADR-0020]
        \                |                /                 /
         +---------------+---------------+-----------------+
                         v
                  Hybrid Retrieval (FTS5 + glossary + опц. embeddings, RRF)   [ADR-0015]
                         |
                         v
        EngineeringContextPackage → Context Builder (L4)
```

Project Graph строится детерминированно: адаптером языка (TypeScript — ts-morph/Compiler API),
git и статическим анализом; факты по файлу кэшируются по хешу содержимого и разделяются между ветками
и worktree, снимок строится на дерево git **[ADR-0008, ADR-0021]**. LLM добавляет семантические связи,
но не заменяет детерминированный индекс.

Vector DB не является фундаментом архитектуры **[ADR-0015]**. Реализованы лексический индекс (FTS5),
расширение запросов глоссарием «бизнес-термин → символы кода» и порт `Embedder` с OpenAI-совместимой
реализацией за флагом `knowledge.retrieval.embeddings`; по умолчанию embeddings выключены до прохождения
гейта по evals (ADR-0015 §6).

## 9. Tool Platform, MCP и capability routing

Tool Registry хранит нормализованные capabilities (`network`, `access`, `effect`). Tool Router выдаёт
агенту только разрешённый subset. Local tools предпочтительны для файловой системы, git, AST и команд
проекта; корпоративные системы подключаются через MCP **[ADR-0017]**.

```
Agent
  |
  v
Capability request: repo.search
  |
  v
Tool Router ---- policy/security/audit (allowlist → профиль → egress → запись → destructive)
  |
  +--> LocalToolProvider --> rg/git/tsc/tests (project.<name>)
  |
  +--> GraphToolProvider --> graph.impact / graph.neighbors
  |
  +--> McpToolProvider  ---> Jira/Confluence/Bitbucket/Elastic (профили atlassian, bitbucket)
```

Read/write/destructive capabilities разделены. ResearchAgent не получает `repo.write`; implementation
не получает административные Jira actions без отдельной policy. Внешние эффекты идут через журнал
эффектов с проверкой после resume **[ADR-0002]**.

## 10. Model Gateway и model routing

Все обращения к LLM идут через ModelGateway. Он скрывает OpenAI-compatible корпоративный endpoint,
собирает usage, применяет timeout/retry/abort, валидирует structured output и взаимодействует с
Resource Manager.

```
Agent -> ModelGateway -> admission check -> provider adapter -> model
              |                                  |
              +-> telemetry (events)             +-> DeepSeek Flash
              +-> structured output (+repair)    +-> Qwen Coder
              +-> usage accounting               +-> future model
```

Model Router назначает модель по роли, требованиям агента и egress-политике: research, implementation,
review, compaction могут использовать разные модели **[ADR-0007, ADR-0016]**. Это позволяет менять модель
без изменения agent/workflow domain. Нативного адаптера Anthropic пока нет (схема его допускает);
`openai`, `ollama`, корпоративные шлюзы — через диалект chat-completions.

## 11. Budget & Resource Manager

Resource Manager управляет отдельными ограниченными ресурсами: provider output quota, context capacity,
concurrency, time и при необходимости денежным budget.

```
Context Manager:  WHAT should the model see?
Budget Manager:   CAN we call the model now?
Scheduler:        WHEN should this step run?
Policy Engine:    IS this action allowed?
```

Для исходной корпоративной квоты применяется 60k output / 20 min с soft и hard limits (пулы квот в
конфигурации, окна sliding/fixed). При hard limit workflow checkpoint'ится и переходит в
`WAITING_BUDGET` вместо sleep/retry loop; к лимитам пула добавлены per-run и per-step cap'ы
**[ADR-0018]**. При восстановлении daemon проверяет eligibility и продолжает Run с сохранённого
checkpoint.

## 12. Durable state, Artifact Store и Storage

SQLite достаточен для local-first варианта (`node:sqlite`, forward-only миграции с бэкапом
**[ADR-0014]**). Интерфейсы RunStore, ArtifactStore, CheckpointStore, StepHistoryStore, EffectJournal
отделяют domain от конкретной БД.

### Artifact metadata

```
Artifact (версия)
  |- id / type / name / version / schemaVersion
  |- runId / stepId / iteration / agent
  |- createdAt
  |- content or contentRef (content-addressed blob)
  |- sourceRefs[]
  |- checksum
  |- provenance { kind: agent | human | tool, входы, пакет контекста }     [ADR-0005]
  `- approvals (привязаны к версии и хешу)
```

Крупные документы и raw tool outputs хранятся как файлы/content-addressed blobs, а SQLite — только
metadata и индексы. Это позволяет сохранять полные evidence без раздувания active context. Человеческая
правка — новая версия с unified diff **[ADR-0005]**. Retention policy артефактов **[не реализовано]**:
чистятся только worktree по `retentionDays`.

## 13. Security и policy enforcement

- Least privilege на уровне capabilities, а не только prompt-инструкций.
- Credentials и MCP auth никогда не передаются модели; значения попадают только в транспорты
  **[ADR-0010, ADR-0017]**.
- Read/write/destructive operations разделены.
- Sensitive paths и секреты фильтруются до попадания в model context/artifacts (Redactor: литералы,
  детекторы, denied paths до чтения) **[ADR-0010]**.
- Каждый tool call имеет run/agent identity и audit trail; решения человека несут актора **[ADR-0006]**.
- Human approval может быть обязательным для рискованных действий; в CI гейт переносится к человеку или
  проходится по закоммиченному утверждению для того же хеша **[ADR-0009]**.
- Repo patch ограничивается текущим workspace и policy (worktree на run) **[ADR-0003]**.
- CI использует отдельный non-interactive permission profile (профили только сужают) **[ADR-0009]**.
- **[ADR-0016]** `dataClass` проекта задаёт, какие модели и сети допустимы; по умолчанию —
  `confidential`.

Policy Engine детерминирован. LLM не принимает окончательное решение о том, имеет ли он право
выполнить действие.

## 14. Observability, tracing и evals

Jarvis измеряет не только latency и tokens, но и качество инженерного результата.

| Уровень | Метрики / события | Статус |
|---|---|---|
| Model | input/output tokens, model, latency, finish reason, retries (`model.call/retry/error`, `usage`). | реализовано |
| Context | peak usage, trims, compactions, reset (`context.*`, `agent.finish.context`), retrieved sources (`retrieval.knowledge`). Compression ratio и cache-hit — нет. | реализовано (кроме cache-hit) |
| Tools | calls, failures, duration, denied capabilities (`tool.call`, `tool.denied`, `security.redaction`). | реализовано |
| Workflow | step duration, suspend/resume, retries, approvals, interactions, review lifecycle. | реализовано |
| Outcome | tests, review findings, rework (loops), human corrections, task success — в evals. | реализовано (evals) |

События пишутся в SQLite; `jarvis status` показывает run, шаги, события, токены, давление пулов
**[ADR-0018]**. Внешний экспорт (`telemetry.export`) — схема и проверка egress есть, экспортёра
**[не реализовано]**.

Evals **[ADR-0012]** сравнивают конфигурации (модели, навыки, стандарты, пороги, retrieval) по task
success, покрытию acceptance и file recall, циклам и стоимости; главная метрика — successes per 10k
output tokens; режимы record/replay/live, baseline и diff с допуском; кейс из реального run
(`run-to-case`). Сравнение порогов compaction 50/60/70% — отдельный прогон evals с `--variant` по `context.thresholds`.

Trace должен позволять ответить: «почему Jarvis изменил эту строку?» — через цепочку
task → spec → evidence → plan → tool/model calls → diff. Цепочка собирается из provenance артефактов,
событий и трейлеров `Jarvis-Run` и выдаётся командой `jarvis explain <file[:line]|commit|run>`: blame →
коммит → run → шаги, артефакты с источниками и утверждениями, вызовы инструментов. Ограничение: события
`tool.call` хранят имя возможности, но не аргументы, поэтому «какой вызов правил эту строку» команда не
указывает — только какие артефакты и источники к ней привели.

## 15. Developer UX: CLI, OpenCode, Git hooks, CI

### CLI

Исходный набор → фактическое состояние:

| Исходная команда | Сейчас |
|---|---|
| `jarvis init` | реализовано |
| `jarvis work ABC-123` | реализовано (`--workflow`, `--base`) |
| `jarvis status [run]` | реализовано (`--watch`, `--all`, `--events`) |
| `jarvis resume <run>` | реализовано (`--steal`) |
| `jarvis context` | реализовано (`context [run]`, плюс MCP-инструмент `context.inspect`) |
| `jarvis compact`, `reset-context` | реализовано (`--aggressive`, `--dry-run`; ADR-0013) |
| `jarvis research ABC-123`, `spec ABC-123` | реализовано: встроенные workflow `research` и `spec` (до утверждения спецификации) |
| `jarvis review [--base origin/main]` | частично: `jarvis standards check --base`, шаг `review` в workflow |
| `jarvis prepush` | реализовано (`--base`, `--head`, `--semantic`/`--no-semantic`, `--hook`); ставится `jarvis hooks install` |
| `jarvis knowledge update` | реализовано (+ `status`, `index`, `search`) |
| `jarvis stats` | нет; `jarvis status` и события |
| `jarvis doctor`, `jarvis daemon` | реализовано |

Добавлено сверх исходного набора: `approve`, `cancel`, `diff`, `apply`, `gc`, `threads`, `answer`,
`attach`, `review submit|status`, `standards`, `skills`, `candidates`, `ci`, `export`, `import`, `evals`,
`models`, `mcp`, `auth`, `config`, `db`, `hooks`. Полный справочник — [docs/cli.md](../cli.md).

### OpenCode и другие клиенты

OpenCode остаётся интерактивной исследовательской средой. Он (и любой MCP-клиент) обращается к
`jarvis mcp serve` за project knowledge, spec, run status и контекстом, но не становится владельцем
этих данных. Сервер только читает.

### Git / CI

CI запускает те же workflow definitions, что и локальный CLI (`jarvis ci`). Pre-push сначала
выполняет всё детерминированное по диапазону коммитов, затем — только если данные это оправдывают —
семантический review:

```
git push → .git/hooks/pre-push (shim) → jarvis prepush --hook
  1. диапазон: от tip удалённой ветки (или точки ответвления от upstream/trunk) до отправляемого коммита
  2. стандарты: детерминированные проверки по изменённым файлам
  3. проверки проекта (hooks.prePush.checks → tools.local): typecheck, lint, tests
  4. граф: затронутые, но не изменённые зависимые файлы и покрывающие тесты
  5. review-агент (workflow review-diff, только чтение) — если semanticReview=always, либо применимы
     semantic/hybrid-стандарты, либо граф нашёл незатронутые зависимые/тесты;
     при провалах п. 2–3 платный шаг пропускается
  → блокирует: required-нарушение, упавшая проверка, замечание не ниже blockOn (mode: block)
```

Хук — тонкий shim: вся логика в CLI; уважает `core.hooksPath` и linked worktrees, чужой хук не
перезаписывает без `--force` (резервная копия возвращается при `uninstall`); если `jarvis` не найден,
push не блокируется. Сбои инфраструктуры ревью (нет модели, квота, ошибка) никогда не блокируют push —
они попадают в отчёт. Обход: `git push --no-verify` или `JARVIS_SKIP_HOOKS=1`. Если отправляемая ветка
не выгружена, проверки идут во временном worktree (команды проекта в нём пропускаются: нет зависимостей).

## 16. Целевая структура репозитория

Фактическая структура (проект — один пакет; разделение на packages только при появлении независимо
версионируемых компонентов):

```
jarvis/
├── docs/adr/  docs/*.md  docs/process/  docs/assets/
├── src/
│   ├── cli/            # commander, команды, вывод
│   ├── app/            # runtime (композиция), движок, status, bundle, preflight
│   ├── core/           # Run, Artifact, Workflow, config, actor, capabilities-контракты (без стека)
│   ├── orchestration/  # LocalWorkflowEngine, исполнители шагов, worktree, аренда
│   ├── workflows/      # SDD и smoke (YAML)
│   ├── agents/         # определения агентов, схемы, слои контекста, цикл вызова инструментов
│   ├── interaction/    # треды с человеком, кларификатор, Review Mode           [ADR-0019]
│   ├── knowledge/      # стандарты, навыки, резолвер, граф, retrieval            [ADR-0008/0015/0020]
│   ├── capabilities/   # детекция стеков, реестр, уровни поддержки               [ADR-0021]
│   ├── adapters/       # адаптеры языков (typescript)                            [ADR-0021]
│   ├── models/         # gateway, router, провайдеры, кассеты
│   ├── budget/         # quota admission
│   ├── tools/          # registry/router/local tools
│   ├── mcp/            # client pool + профили + Jarvis server
│   ├── artifacts/  storage/      # ArtifactStore/BlobStore; SQLite + миграции
│   ├── security/       # redactor, egress policy, credentials
│   ├── telemetry/      # события
│   └── evals/          # кейсы, scorer'ы, run-to-case
├── tests/  scripts/demo/
```

Отличия от исходной структуры: нет отдельного `context/` (сборка контекста — `agents/context.ts`) и
`integrations/` (CI-адаптер — `cli/commands/ci.ts`, git hooks — `hooks/` и `cli/commands/hooks.ts`); добавлены `app/`,
`interaction/`, `capabilities/`, `adapters/`.

## 17. Целевой стек

| Область | Решение |
|---|---|
| Runtime | Node.js ≥ 22.18 (нативное исполнение TypeScript) + ESM + pnpm |
| CLI | Commander.js 15 |
| Validation | Zod 4 |
| Model abstraction | Собственный ModelGateway + OpenAI-compatible adapter (AI SDK не используется) |
| Workflow | Собственный `LocalWorkflowEngine` **[ADR-0011]** (Mastra не используется) |
| MCP | Official TypeScript MCP SDK (клиент: stdio/http/sse; сервер: stdio) |
| Persistence | SQLite local-first через встроенный `node:sqlite` (без нативных модулей); FTS5 для поиска; интерфейсы допускают замену backend |
| Repo analysis | ripgrep, git, TypeScript Compiler API через ts-morph (адаптер языка) |
| Testing | Vitest 4 + реальные fixture repositories, поддельный OpenAI-сервер; кассеты |
| Lint/format | Biome 2 |
| Config | YAML + Zod, слои cli > env > project > user |
| Telemetry | Structured events в SQLite; экспортируемый backend adapter — **не реализован** |

## 18. End-to-end execution flows

### Полный work flow

```
jarvis work ABC-123
   |
Resolve workspace/config → preflight (модели, MCP-серверы workflow)
   |
Create durable Run + worktree jarvis/ABC-123/<run>
   |
discover -> project-capabilities (FULL / BASIC / UNSUPPORTED)
   |
Research -> artifact          (Jira/Confluence/Repo через MCP)
   |
Requirements -> artifact      (пробел? -> WAITING_HUMAN, тред уточнения, answer/attach, resume)
   |
Context reset (чистое окно)
   |
Spec -> artifact  ->  approve-spec (WAITING_HUMAN)
   |
Impact -> graph + sources -> artifact
   |
Plan
   |
Implementation <-> deterministic tools/tests
   |
verify: tests | standards.check | docs | telemetry   (в параллель)
   |
Review diff vs spec/evidence
   |
Fix loop if policy allows (ограниченные обратные рёбра)
   |
approve-impl (WAITING_HUMAN)  ←→  review submit → review-analysis → fixes
   |
release-notes
   |
Complete Run (+ events/usage); jarvis diff / apply
```

### Quota exhaustion

```
Model call -> Budget admission denied
        -> persist artifacts/checkpoint
        -> WAITING_BUDGET (resumeAfter)
        -> process may exit
        -> daemon/manual resume
        -> rebuild context from artifacts
        -> continue exact workflow step
```

### Context exhaustion **[ADR-0013]**

```
Context pressure >= threshold
  -> trim deterministic noise
  -> compact if needed
  -> persist compacted handoff + source refs
  -> reset if critical/phase boundary
  -> retrieve exact originals on demand
```

### Человек недоступен (CI) **[ADR-0009]**

```
Gate reached, interactive=false
  humanGate: artifact          -> WAITING_HUMAN, approval-request.json, summary, exit 10 (+ bundle)
  humanGate: skip-if-approved  -> committed approval с тем же хешем? пройти : как artifact
  humanGate: fail              -> FAILED "policy: human_gate_in_ci", exit 12
```

## 19. Failure model и восстановление

| Failure | Поведение |
|---|---|
| Model timeout/transient error | Bounded retry по policy; затем step failure/checkpoint. |
| Quota exhausted | WAITING_BUDGET, без busy wait. |
| MCP unavailable | Preflight отказывает до старта; в ходе run — failure шага с evidence или ожидание по policy. |
| Tool command failed | Structured ToolResult; агент видит stderr/exit code в пределах cap'а вывода. |
| Invalid structured output | Schema repair/retry с ограничением попыток; затем артефакт `invalid-output`. |
| Process killed | Resume с последнего durable checkpoint (аренда истекает; `resume --steal`). |
| Двое возобновляют один run | Аренда с эпохой + fencing: устаревший процесс не может записать. **[ADR-0002]** |
| Эффект «неизвестно, выполнился ли» | Verify через тот же сервер по маркеру; иначе `unresolved` → WAITING_HUMAN. **[ADR-0002]** |
| Compaction lost detail | Retrieve original: `knowledge.read blob:<ref>` (в handoff перечислены `Originals:`); summary не source-of-truth. |
| Unsafe action | Policy denial или WAITING_HUMAN. |
| Гейт в CI без человека | exit 10 (артефакт/бандл) или 12 (`humanGate: fail`). **[ADR-0009]** |
| Стек без адаптера и команд | UNSUPPORTED → остановка с причиной `policy:`. **[ADR-0021]** |
| Ручные правки в worktree | Фиксируются checkpoint'ом `human edit`, не сбрасываются. **[ADR-0019]** |

## 20. Эволюция к целевой архитектуре

Roadmap не определяет архитектуру снизу вверх: каждый этап реализует часть уже зафиксированной целевой
модели и сохраняет её boundaries. Исходная нумерация этапов сохранена; справа — фактический результат.

| Этап | Результат (исходный план) | Статус / факт |
|---|---|---|
| 0. Bootstrap | CLI, config/workspace discovery, build/test. | ✔ `286c86b` |
| 1. Model runtime | ModelGateway + corporate endpoint + usage. | ✔ `98ccf6a` |
| 2. Durable core | Run/SQLite/ArtifactStore/checkpoints. | ✔ `faab88f` (+ аренда, журнал эффектов) |
| 3. Resource control | BudgetManager + suspend/resume. | ✔ + собственный workflow engine [ADR-0011] |
| 4. Tools | repo/git/terminal deterministic tools. | ✔ + Redactor, worktree [ADR-0003, 0010] |
| 5. Research | Первый structured agent + artifact. | ✔ (агенты research…review) |
| 6. MCP | Jira, затем Confluence/Bitbucket/Elastic. | ✔ `723f3c5` (профили atlassian, bitbucket; Elastic — через `readOnly`-сервер без профиля) |
| 7. v0.1 workflow | Research → Implementation → Review. | ✔ (сразу полный `sdd`) |
| 8. Context Engine | trimming/compaction/reset/manual controls. | ✔ `6a9c6d4` (слои, prefix-stable system layer, бюджет L4, пороги, trimming, compaction, reset, `context`/`compact`/`reset-context`) [ADR-0013]; не сделано: метрика cache-hit |
| 9. SDD | Spec + Impact + Plan. | ✔ `8db955b` + участие человека [ADR-0019] |
| 10. Knowledge | versioned docs + targeted injection. | ✔ `6887cf0` (стандарты, навыки, резолвер) [ADR-0020] |
| 11. Specialization | Tests/Metrics/Telemetry/Docs agents. | ✔ `ee23341` (Metrics объединён с Telemetry) |
| 12. Dev workflow | pre-push + CI. | ✔ CI `0dd2b8f`, бандлы run; pre-push `f11ca47` (`hooks install`, `prepush`, workflow `review-diff`) |
| 13. Project Graph | symbols/dependencies/tests/events + hybrid retrieval. | ✔ `474d113`, `9f72b44` (граф TS), `10fa9f5` (retrieval; embeddings выключены) [ADR-0008, 0015, 0021] |
| 14. Jarvis MCP | knowledge/spec/context/run APIs для OpenCode/IDE. | ✔ `2e8e6ed` (+ evals [ADR-0012]) |
| 15. Daemon | auto-resume/scheduling/background runs. | ✔ `jarvis daemon` (реализован вместе с этапом 3) |

Сверх плана: Review Mode и жизненный цикл замечаний [ADR-0019], polyglot-репозитории (`stackScopes`),
`run-to-case`, Windows-бэкенд credentials, `status --watch`, `gc` кэша графа.

Не закрыто: экспорт телеметрии и `jarvis stats`, нативный Anthropic-адаптер, адаптеры других языков (C#/.NET — следующий по
ADR-0021), включение embeddings после гейта ADR-0015 §6, пилот на реальном репозитории.

## 21. Acceptance criteria зрелого Jarvis

| Критерий | Статус |
|---|---|
| Одна и та же задача может быть запущена локально и в CI через один workflow definition. | ✔ `jarvis work` / `jarvis ci` |
| Run переживает завершение процесса, quota wait и ручное resume без потери состояния. | ✔ checkpoints, аренда, daemon |
| Ни один специализированный агент не зависит от конкретного model provider или Mastra API. | ✔ (Mastra не используется вовсе) |
| Project knowledge доступно CLI, workflow и OpenCode через общую Jarvis-платформу. | ✔ `knowledge.*`, `jarvis mcp serve` |
| Context можно inspect/compact/reset; исходные evidence остаются recoverable. | ✔ `jarvis context`, `compact`, `reset-context`; оригиналы — блобы, читаются `knowledge.read` |
| Jarvis способен объяснить provenance изменения от task/spec до конкретных sources и tool calls. | ✔ `jarvis explain` (до sources и счёта tool calls; аргументы вызовов хранятся в событиях, `explain` их пока не показывает) |
| Model quota является планируемым ресурсом; исчерпание не ломает Run. | ✔ WAITING_BUDGET |
| Agents имеют минимальные capabilities; policy enforcement выполняется вне LLM. | ✔ Tool Router |
| Pre-push/CI сначала используют deterministic analysis и только затем LLM там, где нужна семантика. | ✔ `jarvis prepush` (ревью — только при сигнале из стандартов/графа); CI ✔ |
| Новые агенты, RAG и orchestration complexity принимаются только после измеримого улучшения evals. | ✔ процесс и инфраструктура evals; embeddings за гейтом |

## 22. Итоговое решение

Целевой Jarvis — это локально-ориентированная, но расширяемая engineering platform вокруг LLM, а не ещё
один coding assistant. Она отделяет orchestration, context, knowledge, tools, resource governance и
models друг от друга и делает каждую из этих частей наблюдаемой и заменяемой.

**Финальная формула:**

Jarvis = Durable Engineering Runtime
+ Specification-Driven Workflows
+ Artifact-Based Agents
+ Context Engineering
+ Project Knowledge & Dependency Graph
+ Capability-Routed Tools & MCP
+ Model Gateway
+ Budget / Policy / Security Governance
+ Observability & Evals
+ CLI / Git / CI / MCP interfaces
+ **Human Collaboration** [ADR-0019]
+ **Standards & Skills as data** [ADR-0020]
+ **Stack-agnostic core with language adapters** [ADR-0021]

Это позволяет менять модели, workflow engine, retrieval strategy, язык программирования и developer
clients независимо друг от друга, сохраняя главное: знания проекта, инженерные policies и
воспроизводимый процесс разработки.

---

## Приложение A. Изменения относительно исходной редакции

| Раздел | Было | Стало | Основание |
|---|---|---|---|
| §1, §2, §17 | Основная область — TS/React, стек зашит | Ядро стек-нейтрально; TS — адаптер языка; добавлен Capability Layer | ADR-0021 |
| §1, §4, §5, §6 | Человек — «human approval» в конце | Человек — сущность runtime (approval/clarification/review/conflict), `waitingFor`, агенты requirements и review-analysis, финальный гейт `approve-impl` | ADR-0019 |
| §4 | Состояния без CANCELLED | Добавлено `CANCELLED`; аренда с эпохой, журнал эффектов, `baseCommit` | ADR-0002, ADR-0003 |
| §5, §17 | Собственный WorkflowRuntime, Mastra первым | Только собственный `LocalWorkflowEngine`, Mastra не используется | ADR-0011 |
| §5 | Линейный граф с ветвлением CODE/TESTS/METRICS/TELEMETRY | Фактический граф `sdd`: `discover`, `requirements`, composite `verify`, обратные рёбра с лимитами, `review-analysis`, `release-notes` | ADR-0004, ADR-0019 |
| §6 | Агенты: Research, Spec, Impact, Impl, Test, Metrics, Telemetry, Docs, Review | Metrics объединён с Telemetry; добавлены Requirements, Plan, Review-analysis, Release-notes | ADR-0019 |
| §7 | Слои L0–L5 + пороги + compaction | Реализовано: пороги от эффективного окна (по умолчанию 0,40/0,60/0,75/0,85, по фазе и модели), trimming с блобами, handoff-компакция, reset, ручные команды | ADR-0013 |
| §8 | Hybrid retrieval, vector DB «если надо» | Лексический FTS5 + глоссарий + порт Embedder за флагом; стандарты и навыки как вид знания | ADR-0015, ADR-0020 |
| §8 | Граф: ts-morph | Граф через адаптер языка, факты кэшируются по хешу, снимки на дерево git | ADR-0008, ADR-0021 |
| §9 | Local + MCP | + GraphToolProvider; профили MCP с проверяемыми эффектами | ADR-0017, ADR-0002 |
| §10, §13 | Model routing, security | Egress по `dataClass`, Redactor, capabilities моделей | ADR-0007, ADR-0010, ADR-0016 |
| §11 | 60k/20 мин | Пулы квот, per-run/per-step cap'ы | ADR-0018 |
| §12 | SQLite | `node:sqlite`, миграции только вперёд, версионированные артефакты, привязка утверждений к хешу | ADR-0014, ADR-0005 |
| §14 | Метрики, evals | Evals: record/replay/live, baseline/diff, run-to-case | ADR-0012 |
| §15 | CLI на 13 команд | Реализованы 60+ команд и подкоманд, включая `hooks`, `prepush`, `context`, `compact`, `reset-context`, `research`, `spec`, `explain`, `onboard`, `ask`, `logs`; не сделан `stats` | ADR-0009, ADR-0018 |
| §16 | `context/`, `integrations/` | Контекст в `agents/`, CI в `cli/`; добавлены `app/`, `interaction/`, `capabilities/`, `adapters/` | — |
| §19 | 8 сценариев отказа | + аренда, неразрешённый эффект, CI без человека, UNSUPPORTED, ручные правки | ADR-0002, ADR-0009, ADR-0019, ADR-0021 |
| §20, §21 | План и критерии | Добавлены статус и коммиты по каждому пункту | — |

## Приложение B. Что не реализовано

Целевая модель сохраняется; кода пока нет.

1. **Метрики контекста сверх событий**: cache-hit префикса (сериализатор из ADR-0013 §4), compression ratio,
   `jarvis stats`; выбор порогов по evals (50/60/70%) ещё не проведён.
2. **Pre-commit хук** (§3) — не реализован; `prepush` покрывает push.
3. **Экспорт телеметрии** во внешний backend; `jarvis stats`.
4. **Автоматический выбор веток workflow по риску** изменения (§5).
5. **Нативный адаптер Anthropic** (§10); retention policy артефактов (§12).
6. **Адаптеры других языков** (C#/.NET — первый по ADR-0021); для них проект работает на уровне BASIC.
7. **Включение embeddings** — после гейта ADR-0015 §6 по evals.
8. **`jarvis explain` не называет конкретный вызов инструмента**: `tool.call` теперь хранит редактированные `args`
   (до 600 символов), но `explain` пока показывает только счётчики вызовов.

## Приложение C. Карта уточняющих ADR

| ADR | Тема | Разделы |
|---|---|---|
| 0002 | Журнал эффектов и аренда Run | 4, 9, 13, 19 |
| 0003 | Workspace: git worktree | 3, 4, 13 |
| 0004 | Обратные рёбра workflow | 5 |
| 0005 | Версии артефактов, provenance, утверждения | 4, 12 |
| 0006 | Идентичность актора | 3, 13 |
| 0007 | Возможности моделей, роутер | 10 |
| 0008 | Инкрементальный граф проекта | 8 |
| 0009 | CI-режим и человеческий гейт | 3, 13, 15, 18 |
| 0010 | Редактирование секретов | 13 |
| 0011 | Workflow runtime без Mastra | 5, 17 |
| 0012 | Evals и record/replay | 14 |
| 0013 | Давление контекста и prefix cache | 7 |
| 0014 | Приоритет конфигурации и миграции | 3, 12 |
| 0015 | Семантический поиск | 8 |
| 0016 | Политика egress | 13 |
| 0017 | Конфигурация моделей и MCP | 3, 9, 10 |
| 0018 | Терминальная наблюдаемость, пулы квот | 11, 14 |
| 0019 | Человеческое взаимодействие | 1, 4, 5, 6, 18 |
| 0020 | Навыки и стандарты | 7, 8 |
| 0021 | Стек-нейтральное ядро | 1, 2, 8, 17 |
| 0022 | Терминальный интерфейс | 14, 15 |
| 0023 | Редактор и веб-интерфейс `jarvis ui` | 15, 18 |
| 0024 | База знаний в `jarvis ui` | 8, 15 |
