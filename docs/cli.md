# Справочник CLI

`jarvis [--json] [--profile <name>] [--cwd <dir>] <command>`

Глобальные опции:

| Опция | Действие |
|---|---|
| `--json` | машинно-читаемый вывод (одна JSON-структура вместо текста) |
| `--profile <name>` | применить профиль из `profiles:` конфигурации (ADR-0009 §1); профиль может только сужать |
| `--cwd <dir>` | работать так, будто команда запущена из `<dir>` |

Проект определяется подъёмом от текущей директории: первая с `.jarvis/project.yaml`, иначе первая с
`.git`. Переменные окружения: `JARVIS_HOME` (вместо `~/.jarvis`), `JARVIS_CONFIG`, `JARVIS_PROFILE`,
`JARVIS_ACTOR`, `JARVIS_KEYCHAIN_BACKEND`; любые другие `JARVIS_*` — переопределения конфигурации
(см. [configuration.md](configuration.md#переменные-окружения)).

Идентификатор run принимается полностью (`run_…`) или уникальным префиксом (`e9d5e181`).

## Установка и диагностика

### `jarvis init [--user-only | --project-only]`

Создаёт `~/.jarvis` (config.yaml с шаблоном, базу, каталоги) и `.jarvis/` в проекте (project.yaml,
knowledge/, standards/, skills/ с README, записи в `.gitignore`). Существующие файлы не перезаписывает.

### `jarvis doctor`

Один список всего, что мешает старту: версия Node, конфигурация с источниками значений и ошибками схемы,
версия схемы БД и ожидающие миграции, ссылки на секреты (есть ли значение), сводка политики egress
(ADR-0016), состояние MCP-серверов (discovery, credentials, неизвестные профили), расхождения между
конфигурацией моделей и результатами `models probe`.

### `jarvis config show [--sources]`

Итоговая конфигурация после слияния всех слоёв; `--sources` печатает, откуда взято каждое значение
(cli / env / project / user / profile / default) — ADR-0014 §2.

### `jarvis db status | migrate | backup`

Версия схемы и ожидающие миграции; применение миграций (всегда с бэкапом в `~/.jarvis/backups/`);
бэкап вручную. Миграции только вперёд (ADR-0014 §4); при открытии БД более новой версии команды
отказываются работать.

## Модели и credentials

### `jarvis models list`

Модели с egress, пулами квот, использованием текущего окна и состоянием проб.

### `jarvis models probe <modelId>`

Канареечные запросы: поддерживает ли модель tools, parallel tools, json mode, json schema, system role,
reasoning, prefix cache. Результат записывается и сравнивается с `supports:` конфигурации — расхождения
показывает `doctor` (ADR-0007).

### `jarvis auth set <id> | status | remove <id>`

Credential для ссылки `keychain:<id>` под текущим актором: ввод без эха или через stdin
(`echo $TOKEN | jarvis auth set corp-llm`). `status` показывает только наличие. Бэкенды: macOS Keychain,
libsecret, Windows DPAPI, файл `0600` (fallback; `JARVIS_KEYCHAIN_BACKEND=file|macos|libsecret|windows`).

## MCP

### `jarvis mcp list [--refresh]`

Серверы из `mcp.servers` и их состояние: discovered / exposed / denied / unmapped / «discovered, not
allowed». `--refresh` переподключается к каждому и обновляет кэш `~/.jarvis/cache/mcp/<server>.json`.

### `jarvis mcp serve`

Jarvis как MCP-сервер на stdio (только чтение) для IDE и других агентов: `knowledge.search`,
`spec.get`, `run.status`, `context.inspect`. См. [integrations.md](integrations.md#ide-и-другие-агенты-jarvis-mcp-serve).

## Запуск и жизнь run

### `jarvis work <task> [--workflow <name>] [--base <ref>] [--no-run]`

Preflight (все MCP-серверы, до которых могут дотянуться агенты workflow, должны ответить на
`tools/list`), создание run, worktree от `--base` (по умолчанию `HEAD`), исполнение в foreground до
завершения или остановки. Коды выхода — [overview.md](overview.md#коды-выхода). Workflow по умолчанию
`sdd`; `smoke` проверяет сам движок.

### `jarvis resume <run> [--steal]`

Продолжить парковавшийся, упавший или оборванный run с последнего checkpoint: транскрипт агента
восстанавливается, worktree приводится к checkpoint-коммиту (ручные правки в нём становятся
checkpoint `human edit`, см. [human.md](human.md#ручные-правки-в-worktree)). `--steal` забирает аренду у
процесса, который перестал слать heartbeat.

### `jarvis status [run] [--all] [--watch N] [--events n]`

Без аргумента — активные run и бюджеты пулов; `--all` добавляет завершённые. С run — состояние, что
ждёт (`waitingFor`), уровень возможностей проекта, шаги с итерациями и исходами, checkpoint, артефакты
и утверждения, эффекты, события, токены. `--watch N` обновляет каждые N секунд и сам останавливается
(со звуковым сигналом), когда run завершился или ждёт человека.

### `jarvis cancel <run>`

Немедленно, если run не исполняется; иначе — в ближайшей безопасной точке (граница шага).

### `jarvis daemon [--interval <s>] [--once]`

Возобновляет run, у которых освободилось окно квоты или появилось утверждение; поднимает только run с
истёкшей арендой (ADR-0002 §5). `--once` — один тик.

### `jarvis context [run]`

Контекст агента сейчас: эффективное окно, размер базы (L0–L4), история L5, текущее давление и уровень,
счётчики обрезаний и сжатий. Без аргумента — последний активный run (если таких нет — последний вообще).
Читает только checkpoint, ничего не меняет; без транскрипта в checkpoint (шаг ещё не делал вызовов
инструментов или run между шагами) сообщает об этом.

### `jarvis compact <run> [--aggressive] [--dry-run]`

Обрезает старые результаты инструментов и сворачивает старую историю в handoff, не дожидаясь порога
(ADR-0013). Работает с нетерминальным run, который сейчас не исполняется (например, `WAITING_BUDGET`,
`WAITING_HUMAN`): на 5 минут берёт аренду и сохраняет новый checkpoint, с которого `resume` продолжит. Отказывается для
завершённого run, run без транскрипта и run с чужой арендой. `--dry-run` — только план, без модели и
записи; `--aggressive` оставляет меньше хвоста.

### `jarvis reset-context <run> [--dry-run]`

Заменяет всю историю структурированным handoff (свежее окно); оригинал сохраняется блобом и
перечислен в строке `Originals:`.

## Результат

### `jarvis diff <run>`

Diff worktree run относительно базового коммита.

### `jarvis apply <run> [--message <text>]`

Squash ветки run на текущую ветку основного репозитория одним коммитом; `// REVIEW:` маркеры удаляются
(если `human.review.removeMarkersAfterApproval`).

### `jarvis gc [--days <n>] [--prune-branches]`

Удаляет worktree завершённых run старше `workspace.retentionDays` (или `--days`), с `--prune-branches`
— и ветки `jarvis/*`; чистит устаревшие файлы фактов в кэше графа.

## Участие человека

### `jarvis approve <run> [--type <t>] [--reject | --request-changes] [--comment <text>] [--resume] [--commit]`

Решение по артефакту, который ждёт run (тип выводится из `waitingFor`, `--type` переопределяет).
Утверждение привязано к точной версии и хешу содержимого. `--request-changes` отправляет по
объявленному обратному ребру; `--reject` — run в `FAILED`. `--resume` сразу продолжает. `--commit`
пишет `.jarvis/approvals/<task>/<type>.json` и коммитит — для CI с `humanGate: skip-if-approved`.

### `jarvis threads [--all]`

Открытые треды (clarification, review, approval, conflict) всех run с тем, чего они ждут.

### `jarvis answer <threadOrRun> [text] [--accept] [--rule <text>] [--reject] [--resume]`

Асинхронный ответ в тред уточнения: текст — реплика человека, после которой агент-кларификатор задаёт
следующий вопрос или предлагает правило; `--accept` принимает предложение, `--rule` — принимает со своей
формулировкой, `--reject` закрывает тред без решения (run продолжает ждать). Решение становится
артефактом `clarification`, обязательным для всех последующих агентов.

### `jarvis attach <run> [--no-resume]`

Тот же тред как живой мини-чат в терминале: печатайте ответ, `a` — принять, `e <rule>` — принять со своей
формулировкой, `r` — отклонить, `q` — выйти. После решения run возобновляется (если не `--no-resume`).

### `jarvis review submit [run] [--resume]`

Собирает `// REVIEW: …` маркеры из workspace run (run выводится из текущего worktree, если не указан),
записывает обратно идентификаторы `REVIEW(R-n):`, создаёт артефакт `review-package` и отправляет гейт
`approve-impl` по ребру `review_submitted` к агенту `review-analysis`.

### `jarvis review status [run]`

Каждое замечание с состоянием жизненного цикла: open → acknowledged → applied → ready_for_review →
resolved, классом (CODE, SPEC_CORRECTION, …) и историей.

## Знание проекта

### `jarvis standards list`

Стандарты проекта и пользователя: scope, severity, вид проверки.

### `jarvis standards check [--base <ref>]`

Детерминированные проверки (pattern / tool) по файлам, изменённым относительно `--base`.

### `jarvis skills list [--agent <id>]`

Встроенные, проектные и пользовательские навыки; какие были бы выбраны для типовой задачи данного
агента.

### `jarvis candidates list [--all] | promote <artifactId> [--id <id>] | reject <artifactId>`

Кандидаты в стандарты/знание, предложенные агентами ревью. `promote` пишет файл в
`.jarvis/standards/` или `.jarvis/knowledge/` и записывает решение; `reject` — только решение.

### `jarvis knowledge update [--full]`

Инкрементальное обновление графа проекта: факты по файлам из кэша по хешу содержимого, рёбра — на
снимок дерева; `--full` игнорирует кэш. Нужен адаптер стека уровня FULL (сейчас TypeScript).

### `jarvis knowledge status [--verify]`

Последний снимок графа (узлы, рёбра, дерево); `--verify` пересчитывает без кэша и сравнивает — проверка
детерминизма (ADR-0008).

### `jarvis knowledge index`

Индексирует секции знания, стандарты и навыки (FTS5; векторы — если задано
`knowledge.retrieval.embeddings`). Агенты индексируют автоматически при подготовке контекста.

### `jarvis knowledge search <query> [--limit n]`

Поиск так, как его видят агенты: расширение запроса по глоссарию, лексический и (при наличии) семантический
индексы, слияние RRF, путь извлечения у каждого результата.

## Git hooks

### `jarvis hooks install [--force] | uninstall | status`

`install` пишет в `.git/hooks/pre-push` (с учётом `core.hooksPath` и linked worktrees) тонкий скрипт,
который передаёт ссылки, отправляемые `git push`, в `jarvis prepush --hook`. Повторный `install`
обновляет свой хук; чужой не трогается без `--force` (он сохраняется как `pre-push.pre-jarvis` и
возвращается при `uninstall`). Если `jarvis` не найден в PATH, хук использует CLI этой установки, а
при его отсутствии не блокирует push. `status` — установлен ли хук и действующая политика `hooks.prePush`.

### `jarvis prepush [--base <ref>] [--head <ref>] [--semantic | --no-semantic] [--hook]`

Проверки перед push по диапазону коммитов (по умолчанию: текущая ветка от upstream/`origin/main`; в
режиме `--hook` — отправляемые ветки от tip удалённой):

1. стандарты — детерминированные проверки по изменённым файлам;
2. `hooks.prePush.checks` — команды из `tools.local` (typecheck, lint, tests);
3. влияние по графу проекта — зависимые файлы и покрывающие тесты, которых изменение не коснулось;
4. ревью агентом `review` (встроенный workflow `review-diff`, только чтение) — при
   `semanticReview: always`, применимых semantic/hybrid-стандартах или находках п. 3; не запускается,
   если п. 1–2 уже блокируют.

Выход 1 в режиме `block`, если есть required-нарушение, упавшая проверка или замечание ревью не ниже
`blockOn`; в `advisory` только отчёт. Недоступное ревью (нет модели роли `review`, квота, ошибка) не
блокирует. `--semantic`/`--no-semantic` перекрывают конфигурацию на один запуск. Обход:
`git push --no-verify` или `JARVIS_SKIP_HOOKS=1`. `--json` печатает отчёт по каждому диапазону.

## CI и перенос

### `jarvis ci <task> [--workflow <name>] [--summary <file>] [--bundle <file>]`

`work` под профилем `ci` (или `--profile <name>`): неинтерактивно, checkout только для чтения. На
человеческом гейте — выход 10 с markdown-сводкой (`--summary`, по умолчанию `$GITHUB_STEP_SUMMARY`),
`approval-request.json` в `~/.jarvis/runs/<run>/` и, с `--bundle`, экспорт run. `humanGate: fail` →
выход 12.

### `jarvis export <run> [--out <file>]` / `jarvis import <bundle>`

Один gzipped JSON: строки run, артефакты и блобы, эффекты, утверждения, треды, патч workspace.
`import` восстанавливает worktree от базового коммита с патчем и отказывается от дубликатов.

## Evals

### `jarvis evals run --suite <s> [--mode live|record|replay] [--variant k=v …] [--out <file>]`

Прогон кейсов `evals/<suite>/<case>/case.yaml` на fixture-репозитории с кассетой; гейты утверждаются
автоматически; метрики: тесты, file recall, покрытие acceptance, обязательные источники, циклы, токены,
`successes per 10k output tokens`. Результат в `evals/results/`.

### `jarvis evals run-to-case <run> --suite <s> [--id <id>] [--no-fixture]`

Из завершённого run — кейс: fixture на базовом коммите (`git archive`), gold из того, что человек принял
(spec/impact/research предпочтённых версий), тестовая команда из `tools.local`.

### `jarvis evals baseline <suite> [--from <file>]` / `jarvis evals diff <suite> [--tolerance r] [--from <file>]`

Зафиксировать последний результат как базовый; сравнить последний с базовым, ненулевой код при регрессии
больше допуска (по умолчанию 5 %).
