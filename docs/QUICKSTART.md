# Jarvis — быстрый старт для пилота

Сквозной сценарий: от пустой машины до применённого результата. Команды даны в порядке, в котором их
проходит разработчик; каждая ссылается на ADR, где описано поведение.
Полная документация — в [docs/README.md](README.md).

## 0. Установка

```sh
git clone <repo> jarvis-harness && cd jarvis-harness
pnpm install && pnpm build          # Node ≥ 22.18, без нативных модулей
pnpm link --global                  # команда `jarvis` в PATH (или `node bin/jarvis.js`)
```

## 1. Машина: модели и credentials (ADR-0017)

```sh
jarvis init                         # ~/.jarvis/config.yaml + .jarvis/ в проекте с шаблонами
$EDITOR ~/.jarvis/config.yaml       # models: endpoint, egress: private|cloud, contextWindow …
jarvis auth set corp-llm            # токен в OS keychain под вашим actor (ввод без эха)
jarvis models probe corp-llm        # ключ из models:, не имя модели на шлюзе; что она умеет: tools, json, schema
jarvis doctor                       # всё, что мешает старту, одним списком
```

Секреты в YAML запрещены схемой: только `env:VAR` и `keychain:ID` (ADR-0014). `jarvis auth status`
показывает наличие, никогда — значения.

## 2. Проект: политика команды (`.jarvis/project.yaml`)

```yaml
version: 1
dataClass: confidential            # confidential → только private-модели и intranet (ADR-0016)
stack: [typescript, react]         # пусто = детекция по workspace (ADR-0021)
roles:
  research:       { models: [deepseek-flash] }
  implementation: { models: [qwen-coder] }
  review:         { models: [deepseek-flash] }
tools:
  local: { tests: "pnpm vitest run", typecheck: "pnpm tsc --noEmit", lint: "pnpm biome check ." }
mcp:
  servers:
    jira: { transport: http, url: https://mcp.corp.local/atlassian, profile: atlassian,
            auth: { type: bearer, token: keychain:atlassian }, allow: [jira.get, jira.search, jira.comment] }
human:
  gates: { spec: { required: true }, implementation: { required: true } }
  clarification: { maxTurns: 8 }
budget:
  perRun: { outputTokens: 150000 }
```

Для существующего репозитория `jarvis onboard --apply-config` сам предложит и впишет `tools.local` (из
`package.json` и признаков других стеков) — без модели, `--dry-run` покажет результат, ничего не записав.

Проверка: `jarvis mcp list --refresh` (обнаружено / разрешено / не сопоставлено), `jarvis standards
list`, `jarvis skills list` — что получит агент для этого проекта (ADR-0020).

## 3. Знание проекта (ADR-0020)

| Каталог | Что это | Проверяется |
| --- | --- | --- |
| `.jarvis/knowledge/*.md` | факты о проекте; front-matter `paths`/`stacks`/`tags` сужает область | — |
| `.jarvis/standards/<id>.md` | правила; `severity: required` + `verification.check` (pattern/tool) | в шаге `verify` → нарушение возвращает implementation |
| `.jarvis/skills/<id>/` | как делать тип изменения; `appliesTo` по стеку/путям/виду задачи | — |
| `knowledge.sources` в project.yaml | документация команды в репозитории (`documentation/`, `AGENTS.md`), читается на месте | — |

`jarvis standards check --base main` — те же проверки руками, до запуска.

`jarvis onboard` создаёт заготовки `architecture.md` и `conventions.md` из фактов репозитория (модули и их
зависимости из графа, документация, тесты, стиль коммитов); смысл модулей и правила дописывает человек.
Файлы, отредактированные человеком, `--refresh` не перезаписывает. Смысл модуля объяснит агент:
`jarvis onboard --module src/orders` (проверенные утверждения придут кандидатом, `jarvis candidates promote`), а
в `jarvis ui` то же делается на вкладке Knowledge → Modules.

## 4. Запуск задачи (ADR-0001, 0003, 0004)

```sh
jarvis work ABC-42                  # ветка jarvis/ABC-42/<run8>, checkout ~/.jarvis/worktrees/<repo>/<run8>-ABC-42;
                                    # граф sdd: discover → design → research → requirements → spec → [gate] →
                                    # impact → plan → implementation → verify(tests, standards, checks, docs, telemetry)
                                    # → review → [gate] → release-notes
jarvis status <run> --watch 5       # id прогона из вывода work; без аргумента — все активные
jarvis c                            # вернуться к прогону, который ждёт вас, и решить прямо там
```

Короче: `jarvis fix ABC-43` — путь для бага (research → spec → [gate] → implementation → standards и checks →
review → [gate]); `jarvis research ABC-44` — только исследование, ничего не меняя; `jarvis spec ABC-42` — до
одобренной spec. Шаг `design` читает задачу, её страницы Confluence и макеты Figma без модели.

Коды выхода: `0` готово, `1` ошибка, `10` ждёт человека, `11` ждёт квоту или модель, `12` отказ policy,
`13` потеря аренды, `130` остановлен Ctrl-C (прогон сохранил место) (ADR-0009 §3). Run durable: закрыли терминал —
`jarvis continue` или `jarvis resume <run>`; процесс умер — `--steal`.

## 5. Участие человека (ADR-0019)

**Gate.** `jarvis approve <run> --resume` / `--request-changes --comment "…"` / `--reject`.
Одобрение привязано к контенту артефакта: новая версия — новое решение (ADR-0005).

**Уточнение.** Агент не может продолжить без ответа → `status` показывает `waiting clarification`.

```sh
jarvis attach <run>                 # мини-чат: ответ | a принять | e <правило> | r отклонить | q
jarvis answer <thread> "…"          # то же асинхронно; затем `jarvis answer <thread> --accept --resume`
jarvis threads                      # все открытые треды
```

Резолюция становится артефактом `clarification`; все следующие агенты видят её как обязательное правило.

**Review в коде.** Пишете в worktree `// REVIEW: почему не через repository?` и:

```sh
jarvis review submit <run> --resume # маркеры → review-package → review-analysis агент:
                                    # CODE → fix, SPEC/REQUIREMENT → назад в spec/requirements,
                                    # QUESTION → тред, KNOWLEDGE → кандидат
```

**Ручные правки** в worktree сохраняются как `human edit` checkpoint при resume — ничего не
перезаписывается. Маркеры `REVIEW(R-n)` удаляются при `apply`.

## 6. Результат

```sh
jarvis diff <run>                   # что изменилось относительно базового коммита
jarvis apply <run>                  # изменения прогона одним коммитом в текущую ветку
jarvis candidates list              # что review предложил записать как стандарт/знание
jarvis candidates promote <имя>    # имя из candidates list; файл в .jarvis/standards или knowledge — в обычный code review
jarvis gc                           # старые worktree
```

## 7. CI (ADR-0009)

```sh
jarvis ci ABC-42 --bundle run.jarvis.json.gz   # профиль ci по умолчанию; exit 10 на gate + summary + bundle
jarvis import run.jarvis.json.gz    # на машине разработчика: worktree от baseCommit + patch
jarvis approve <run> --commit --resume                      # решение коммитится в репозиторий
# следующий CI с humanGate: skip-if-approved проходит этот gate сам
```

## 8. Веб-интерфейс (ADR-0023, ADR-0024)

`jarvis ui` — локальная страница (127.0.0.1, порт 4317):
- прогоны и что ждёт вас;
- решения по гейтам, бюджету и петлям; Resume и Cancel;
- New task (research, fix, sdd, spec) в фоне;
- документы и дифф реализации с комментариями к строкам;
- Knowledge: Overview, Modules (исследовать модуль и принять кандидата), Documents, Architecture, Standards,
  Skills, Glossary;
- индикаторы моделей и MCP.

## 9. Лимиты и наблюдаемость (ADR-0018)

`quotaPools` в пользовательском конфиге (окно, soft/hard, безлимитные часы `unlimited`), `budget.perRun/perStep`
в проекте. Модели роли — порядок предпочтения: когда пул заполнен, вызов уходит следующей модели в другом пуле.
`jarvis models list` — расход окна по пулам; `status` — токены Run; события — в `jarvis.db`
(`events`), redaction секретов включён везде (ADR-0010).

## Что дальше (roadmap)

Адаптеры других языков (первым — C#/.NET, ADR-0021), pre-commit хук, экспорт телеметрии, нативный адаптер
Anthropic, включение embeddings после гейта evals (ADR-0015 §6) — см. ADR-0001, приложение B.
