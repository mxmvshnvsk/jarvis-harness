# Расширение

Что можно добавить без правки ядра — и что требует кода.

## Без кода: файлы в `.jarvis/`

| Хочу | Файл |
|---|---|
| правило, которое проверяется автоматически | `.jarvis/standards/<id>.md` с `verification.kind: deterministic` и `check` |
| «как у нас делают X» | `.jarvis/skills/<id>/{skill.yaml,instructions.md}` с `appliesTo` |
| факты о системе | `.jarvis/knowledge/<тема>.md` (front matter для области) |
| бизнес-термины ↔ код | `.jarvis/knowledge/glossary.md` |
| другие инструкции агенту | `.jarvis/agents/<id>.md` |
| другой граф шагов | `.jarvis/workflows/<name>.yaml` (`sdd.yaml` заменяет встроенный) |
| команды проекта агентам | `tools.local.<name>` → `project.<name>` |
| внешняя система | `mcp.servers.<name>` с профилем или `readOnly` |
| гейт выключить / включить | `human.gates.<type>.required` |
| полиглот-репозиторий | `stackScopes` |

Подробности — [knowledge.md](knowledge.md), [workflows.md](workflows.md), [configuration.md](configuration.md).

## Адаптер языка (ADR-0021)

Контракты в `src/core/capabilities/contracts.ts` не знают о стеках:

```ts
interface LanguageAdapter {
  id: string;                             // "csharp"
  languages: string[];                    // ["csharp"]
  detect(workspace): Promise<{ detected, stacks, evidence }>;
  capabilities(): ("build"|"test"|"format"|"lint"|"codeIntelligence"|"diagnostics"|"graph")[];
  defaultCommands?(): { build?, test?, format?, lint? };   // когда tools.local молчит
  codeIntelligence?(workspace): CodeIntelligence;          // symbols, references, definitions
  diagnostics?(workspace): DiagnosticsProvider;
  graphExtractor?(): ProjectGraphExtractor;                // факты по файлу → узлы и рёбра
}
```

`ProjectGraphExtractor.extract(file, content)` возвращает `FileFacts` (узлы `Module | Symbol | Type | Function |
Endpoint | DataModel | Test | Event | Artifact`, рёбра `DEPENDS_ON | CALLS | REFERENCES | IMPLEMENTS | EXPOSES |
PERSISTS | EMITS | TESTED_BY`) — чистую функцию от содержимого файла, поэтому результат кэшируется по хешу и граф
детерминирован; `version` экстрактора — часть ключа кэша. `extensions` — какие файлы он берёт. Разрешение,
которое по одному файлу не сделать (алиасы, пакеты монорепо), — необязательный `createResolver(workspace, files)`
со своим `resolverVersion` (часть ключа снимка).

Регистрация — `capabilities.register(new MyAdapter())` в `src/app/runtime.ts` (образец —
`src/adapters/typescript/`). Адаптер даёт проекту уровень FULL. Внешние адаптеры (например, C# через
Roslyn-процесс) по плану ADR-0021 §8 — отдельные пакеты, подключаемые через тот же контракт.

Архитектурный тест запрещает ядру (`src/core`, `orchestration`, `agents`, `artifacts`, `budget`,
`models`, `knowledge`, `storage`, `security`, `tools`) упоминать стеки и импортировать `src/adapters`.

## Инструменты и возможности

`ToolProvider` (`src/tools/types.ts`) — `{ name, capabilities() }`; `Capability`: `name`, `description`,
`parameters` (JSON Schema аргументов), `network: none|intranet|internet`, `access: read|write|destructive`,
`effect` (с `verify` для проверяемых), `handler(args, ctx)` и необязательный `server` (MCP-сервер за ней). Регистрация — `registry.register(provider)` в runtime.
Локальные инструменты — `src/tools/local/provider.ts`; инструменты графа — `src/knowledge/graph`;
MCP — `src/mcp/provider.ts`.

Детерминированные шаги workflow (`tool: <name>`) находят либо встроенную функцию
(`src/orchestration/tools/builtin.ts`: `artifact.write`, `project.discover`, `design.collect`, `standards.check`,
`project.checks`, `impact.quick`, `onboard.verify`, `noop`, `fail`), либо любую возможность реестра
(`project.tests`, `code.diagnostics`).

## Профили MCP

`src/mcp/profiles/<name>.ts` — профиль `{ name, version, network, map }`, где `map` отображает инструменты
сервера на возможности (`ProfileCapability`): `{ tools: [кандидаты имён на сервере], description, access, effect,
parameters, args(a) → аргументы сервера, markerArg?, verify?, enrich?, cacheMs?, retryAfterSeconds? }`.
Эффект обязан уметь проверить себя после resume (маркер в тексте, чтение статуса, поиск PR). Зарегистрировать —
добавить в `BUILTIN_PROFILES` в `src/mcp/profiles/index.ts`. Без кода: `profile: { base, map }` в конфигурации
сервера добавляет к встроенному профилю только чистые чтения.

## Агенты

`AgentDefinition` (`src/agents/definition.ts`): `id`, `role`, `description`, `instructions`, `capabilities`
(шаблоны вроде `project.*`), `requires`, `output: { type, schema, outcomes }`, `limits` (по умолчанию 40 вызовов
инструментов, 60 вызовов модели, checkpoint каждые 5), `contextInputs` (какие входы — целиком в контекст).
Схема результата — zod в `src/agents/builtin/schemas.ts`; поле `outcome` обязано быть в `outcomes`, иначе
движок отвергнет результат. Добавить в `BUILTIN_AGENTS` в `src/agents/builtin/index.ts` и сослаться из workflow;
лимиты проект меняет через `agents.<id>.limits` и `onLimit`.

## Провайдеры моделей

`ProviderAdapter` (`src/models/types.ts`) — `{ name, call(request, model, options) → ProviderResult }` с usage и
поддержкой инструментов/структурного вывода. Регистрация — в `defaultAdapters()` (`src/models/providers/index.ts`)
по ключу провайдера: `openai-compatible`, `openai`, `ollama`; `anthropic` пока без адаптера. Нативный Anthropic
адаптер — в планах; сейчас всё, что говорит на OpenAI chat-completions, работает через
`openai-compatible`.

## Миграции схемы

`src/storage/migrations/index.ts` — массив миграций вперёд (`0001` init, `0002` interactions,
`0003` graph, `0004` knowledge index). Новая миграция = следующий номер + SQL; `jarvis db migrate`
применяет с бэкапом; тесты `tests/storage/migrate.test.ts` и `tests/cli/cli.test.ts` фиксируют
ожидаемую версию.

## Разработка

```sh
pnpm install
pnpm check            # tsc + biome + vitest
pnpm dev <cmd>        # CLI из исходников (node src/cli/main.ts)
pnpm build            # dist/
node scripts/demo/record.ts && python3 scripts/demo/render.py   # GIF для README
```

Тесты используют поддельный OpenAI-сервер (`tests/helpers/fakeOpenAi.ts`) и песочницу с временным
`HOME` и проектом (`tests/helpers/tmp.ts`, `engine.ts`); сетевых вызовов в тестах нет.
