# ADR-0021: Стек-нейтральное ядро и языковые адаптеры

- Статус: принято
- Дата: 2026-10-03
- Основание: [ADR-0001](0001-target-architecture.md) §8 (Project Graph), §17 (инструменты);
  концепция «Jarvis Stack-Agnostic Core & Language Adapters» (2026-10-03). Опирается на
  [ADR-0008](0008-incremental-project-graph.md) (экстракторы как плагины с общим кэшем),
  [ADR-0017](0017-models-and-mcp-configuration.md) (MCP как транспорт внешних процессов),
  [ADR-0020](0020-skills-and-standards.md) (стековое поведение через skills/standards),
  [ADR-0016](0016-egress-policy.md) и tool policy (команды проекта — исполняемая конфигурация)
- Код (план): `src/core/capabilities/{languageAdapter,codeIntelligence,diagnostics,projectGraph}.ts`
  (контракты), `src/capabilities/{registry,detector,resolver}.ts`, `src/adapters/{typescript,csharp}/`,
  `src/knowledge/graph/{model,store,traversal}.ts` (стек-нейтральная модель), `tests/architecture/`
  (fitness-тест), событие `stack_detected` и артефакт `project-capabilities`

## Контекст

Jarvis создаётся во frontend-контексте, и есть риск незаметно встроить TypeScript/React-допущения в
Project Graph, инструменты, агентов и workflow. При этом Research, Requirements, Specification, HITL,
Review, Budget, ArtifactStore и оркестрация от языка не зависят. Backend-команда должна подключить
C#/.NET-проект, добавив dotnet/Roslyn-capabilities и .NET-стандарты, а не форкая Jarvis.

Состояние на момент решения: ядро стек-нейтрально — инструменты уже capability-ориентированы
(`repo.*`, `git.*`, `project.<cmd>` из `tools.local`), единственные упоминания TS/pnpm — в комментариях
шаблона `project.yaml`. Project Graph ещё не реализован. Это лучший момент зафиксировать границу.

## Решение

### 1. Правило архитектурной пригодности

**Поддержка нового стека требует новых адаптеров, инструментов, skills и standards — не изменений ядра.**
Если ради C# меняются WorkflowEngine, Interaction, ArtifactStore, Requirements-flow или Budget — граница
проведена неправильно, и это дефект архитектуры, который фиксируется как issue, а не обходится.

Ядро (`src/core`, `src/orchestration`, `src/agents`, `src/interaction`, `src/artifacts`, `src/budget`,
`src/models`, `src/knowledge/{resolver,package,graph/model,graph/traversal}`): Run/engine/state, Budget,
Context, ArtifactStore и граф артефактов, Interaction и gates, Review lifecycle, Research/Requirements/
Spec/Impact-оркестрация, реестры knowledge/standards/skills, Model/MCP gateway, policy, telemetry, evals.

Fitness-тест `tests/architecture/stackNeutral.test.ts`: в ядре нет импортов из `src/adapters/**` и
нет строк `react|typescript|csharp|dotnet|roslyn|ts-morph` (кроме комментариев шаблонов). Запускается
с остальными тестами.

### 2. Capability-слой и порты

Ядро работает через порты, адаптеры зависят от контрактов ядра, не наоборот:

```ts
interface LanguageAdapter {
  id: string;                      // "typescript" | "csharp" | ...
  languages: string[];
  detect(ws: WorkspaceRef): Promise<DetectionResult>;
  capabilities(): LanguageCapability[];       // что реализовано
  codeIntelligence?(): CodeIntelligence;      // optional
  diagnostics?(): DiagnosticsProvider;
  graphExtractor?(): ProjectGraphExtractor;   // ADR-0008 §5
}
interface CodeIntelligence {
  findSymbol(q: SymbolQuery): Promise<SymbolRef[]>;
  findReferences(s: SymbolRef): Promise<Reference[]>;
  getDefinition(s: SymbolRef): Promise<DefinitionRef | null>;
  getDependencies(t: CodeRef): Promise<Dependency[]>;
  getDiagnostics(scope: CodeScope): Promise<Diagnostic[]>;
}
```

Типы `SymbolRef`, `Reference`, `Diagnostic` — нейтральные (файл, диапазон, имя, kind из фиксированного
перечня); Roslyn `ISymbol` или ts-morph `Node` в артефакты ядра не попадают. Стековые возможности, не
выражаемые общим контрактом, публикуются как optional capabilities (`roslyn.*`, `ts.*`), а не условными
ветками в ядре.

**Адаптер может быть in-process или out-of-process.** TypeScript — in-process (ts-morph, ADR-0008). Roslyn
в Node не запускается, поэтому C#-адаптер — отдельный процесс (dotnet tool) с JSON-протоколом по stdio;
транспорт — тот же MCP-клиент (ADR-0017), порт `CodeIntelligence` реализуется прокси над его
инструментами. Для ядра разницы нет.

### 3. Обнаружение и ProjectCapabilities

Детерминированный шаг `discover` в начале Run (и `jarvis doctor`):

```
Stack detector: package.json → typescript; *.sln|*.csproj|Directory.Build.* → dotnet/csharp;
                pyproject.toml → python
Capability registry: адаптеры + команды проекта → список capability с уровнем
ProjectCapabilities артефакт: { stacks[], adapters[], level, commands{}, toolchainVersions{} }
```

Явная конфигурация имеет приоритет над детекцией; детекция — bootstrap и проверка (расхождение →
предупреждение в `doctor`):

```yaml
project: payment-service
stack: [dotnet, csharp, aspnet-core, ef-core]
tools:
  local:                         # как сейчас; алиас `commands:` допускается
    build: dotnet build
    test: dotnet test
    format: dotnet format --verify-no-changes
capabilities:
  codeIntelligence: csharp       # id адаптера или off
```

Теги `stack` — вход для `scope`/`appliesTo` в ADR-0020.

### 4. Инструменты именуются по операции

Общие имена описывают инженерную операцию, а не библиотеку:

```
repo.read  repo.search  repo.edit  git.diff
code.findReferences  code.findSymbol  code.diagnostics      ← адаптер
project.build  project.test  project.format  project.lint   ← tools.local / адаптер
```

`project.*` берутся из `tools.local` (как сейчас) либо из адаптера по умолчанию, если команда не задана;
явная команда проекта всегда приоритетнее. Сырые стековые инструменты (`dotnet.*`, `roslyn.*`) могут
существовать, но встроенные workflow и skills используют только capability-имена. Команды проекта —
исполняемая конфигурация: проходят tool policy и allowlist (ADR-0016, этап 4), в адаптер не передаются
секреты без явной необходимости, вызовы логируются в Run.

### 5. Агенты остаются общими ролями

`ImplementationAgent` — одна роль «безопасно реализовать утверждённый план». Специализация под стек —
через EngineeringContextPackage (ADR-0020 §3): skills + standards + capabilities проекта. Отдельный
стековый агент допустим, только если evals (ADR-0012) показывают устойчивую пользу. Запрещено в промптах
ядра: «если React — X, если C# — Y».

Review Mode (ADR-0019 §5) стек-нейтрален: сборщик работает по file/range/diff; символьный контекст, если
нужен, берётся через `CodeIntelligence` адаптера.

### 6. Стек-нейтральная модель Project Graph

Ядро графа (ADR-0008) моделирует общие сущности, адаптеры добавляют metadata и расширяющие типы узлов:

```
Nodes:     Module Symbol Type Function Endpoint DataModel Test Event Artifact
Relations: DEPENDS_ON CALLS REFERENCES IMPLEMENTS EXPOSES PERSISTS EMITS TESTED_BY
```

Impact traversal, поиск соседей и зависимостей — общие и работают над графом, построенным любым
экстрактором. Impact analysis = общий слой (зависимости артефактов, бизнес-домен, текстовые
свидетельства из репозитория) + обогащение из графа, если он есть.

### 7. Уровни возможностей и деградация

```
FULL         семантический code intelligence + граф + диагностика
BASIC        repo search + build/test/lint команды + чтение кода моделью
UNSUPPORTED  нет безопасной build/test-команды или требуемой политикой capability
```

Отсутствие адаптера не блокирует Jarvis: Run идёт в BASIC. Уровень обязателен в `project-capabilities`,
в `status`/summary Run и в событиях: `stack_detected`, `capability_registered`, `capability_resolved`,
`capability_missing`, `language_adapter_selected`, `language_adapter_degraded`,
`project_graph_extracted`, `diagnostics_collected`. Качество результата при FULL и BASIC не должно
выглядеть одинаково.

### 8. Пилот C#/.NET

| Capability | Пилот 1 (BASIC) | Пилот 2 |
| --- | --- | --- |
| Обнаружение | `*.sln`, `*.csproj`, `Directory.Build.*` | — |
| Build / Tests / Format | `dotnet build` / `dotnet test` / `dotnet format --verify-no-changes` | — |
| Code intelligence | чтение кода моделью, `repo.search` | Roslyn-мост (symbols/references) |
| Diagnostics | вывод компилятора/analyzers из build | через мост |
| Graph | — | Roslyn-экстрактор |
| Skills / Standards | ASP.NET endpoint change, service/refactor, unit testing; C#, ASP.NET, architecture, testing, persistence/security | — |

Критерий успеха пилота: ни одного изменения в модулях ядра; каждое потребовавшееся — архитектурный
дефект с issue.

### 9. Отложено

Polyglot-репозитории (несколько стеков в одном workspace, несколько implementation work items в одном
Run с разными пакетами) — после стабилизации однoстекового пилота; архитектура (resolve по affected
scope, а не по проекту) этого не исключает.

## Последствия

- Контракты capability-слоя фиксируются до Project Graph (этап 13); TS-адаптер — первый и самый зрелый,
  C# — первое доказательство нейтральности ядра.
- `tools.local` остаётся; добавляются `stack`, `capabilities`, артефакт `project-capabilities`,
  уровень в summary и fitness-тест.
- Цена: слой портов и реестр; TS-экстрактор ADR-0008 пишется сразу как адаптер.

## Альтернативы

- **Ветвления по стеку в ядре (`if (language === "csharp")`).** Быстро для первого стека, затем каждый
  новый стек трогает всё; отвергнуто, допускается только в resolvers/adapters/capability packs.
- **Отдельный агент на стек.** Удвоение промптов и evals при одинаковой роли; специализация через пакет
  знаний дешевле и измеримее.
- **Roslyn in-process через bridge-библиотеку.** Невозможно в Node без нативных модулей (запрещены
  решением о `node:sqlite`); stdio-процесс через MCP-транспорт.
- **Форк Jarvis под backend.** Два ядра, двойная поддержка — ровно то, чего ADR избегает.
