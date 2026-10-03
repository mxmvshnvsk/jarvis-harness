# ADR-0003: Изоляция workspace — git worktree на каждый Run

- Статус: принято
- Дата: 2026-10-03
- Основание: [ADR-0001](0001-target-architecture.md) §4 (`Run.workspace`), §13 («Repo patch ограничивается
  текущим workspace и policy»), §15 (Git / CI), §19 (resume с checkpoint); [ADR-0002](0002-run-effects-and-lease.md)
  §1 (файловые записи не журналируются, потому что checkpoint = commit)
- Код (план): `src/core/workspace.ts` (модель), `src/orchestration/workspace/{worktree,cwd}.ts` (две
  реализации порта `Workspace`), `src/orchestration/checkpoint.ts` (commit на checkpoint), CLI
  `jarvis work|apply|gc`, хук `workspace.setup` в `.jarvis/project.yaml`

## Контекст

Run долговечен: он может сутки стоять в `WAITING_BUDGET` или `WAITING_HUMAN`. Разработчик за это время
продолжает работать в той же ветке. Если агенты правят рабочее дерево разработчика напрямую, то (а) resume
возвращает Run в дерево, которое уже изменилось, (б) разработчик и агент мешают друг другу, (в) два Run на
одном проекте невозможны, (г) «checkpoint» не описывает состояние файлов. ADR-0001 говорит «repo patch
ограничивается текущим workspace», но не определяет, что такое workspace Run.

## Решение

### 1. Модель

```
Run.workspace
  |- mode:        worktree | cwd
  |- repoRoot     корень основного репозитория
  |- path         каталог, в котором работают инструменты Run
  |- branch       jarvis/<task>/<runIdShort>      (только worktree)
  |- baseRef      origin/main | HEAD | <указано>  (что взяли за основу)
  |- baseCommit   sha baseRef на момент создания
  `- headCommit   sha последнего checkpoint
```

### 2. Режим `worktree` (локальный CLI, daemon)

`jarvis work ABC-123`:

1. `baseRef` — `--base <ref>`; по умолчанию текущий `HEAD` проекта (разработчик обычно хочет работать от
   своей ветки). Незакоммиченные изменения в рабочее дерево Run **не переносятся**: Run стартует от
   коммита. CLI предупреждает, если рабочее дерево грязное.
2. `git worktree add ~/.jarvis/worktrees/<projectHash>/<runId> -b jarvis/ABC-123/<runIdShort> <baseCommit>`.
3. Хук `workspace.setup` из `project.yaml` (например `pnpm install --offline --frozen-lockfile`) — в
   worktree нет `node_modules`; pnpm store делает установку дешёвой, но хук проектный, Jarvis его не
   угадывает.
4. Все инструменты Run (`repo.*`, tests, typecheck, AST) получают `cwd = workspace.path`; Tool Router
   отвергает пути вне него (ADR-0001 §13).

Research-фаза тоже работает в worktree: это даёт согласованный снимок `baseCommit` для всего Run — research,
impact и diff смотрят на одно состояние кода.

### 3. Checkpoint = commit

Граница шага и intra-step checkpoint (ADR-0002 §4) делают `git add -A && git commit` в ветке Run с trailer'ами
`Jarvis-Run: <id>`, `Jarvis-Step: <stepId>`, `Jarvis-Iteration: <n>`. Checkpoint в RunStore хранит sha. Resume:
`git reset --hard <headCommit> && git clean -fd` (ignored-файлы, включая `node_modules`, не трогаются).
Пустой diff — коммит не создаётся, checkpoint ссылается на предыдущий sha.

Ветка Run — служебная история; при доставке она схлопывается (§4).

### 4. Доставка результата

Агенты никогда не пишут в рабочее дерево разработчика. По завершении Run результат — ветка. Варианты
доставки — явные команды:

| Команда | Действие | Класс |
| --- | --- | --- |
| `jarvis apply <run>` | squash-коммит diff ветки Run поверх текущей ветки разработчика; отказ при конфликте с подсказкой `jarvis apply --rebase` | локальный, без эффекта |
| `jarvis apply <run> --pr` | push ветки `jarvis/...` + создание PR через MCP (эффект, журналируется по ADR-0002) | эффект |
| `jarvis diff <run>` | показать diff против `baseCommit` | чтение |

Policy проекта может запретить `--pr` или потребовать human approval (ADR-0001 §13).

### 5. Режим `cwd` (CI)

В CI checkout runner'а и есть workspace: `jarvis ci …` работает в `cwd`, worktree не создаётся. В этом
режиме:

- запись в файлы разрешена только если профиль `ci` явно даёт `workspace.allowWrites: true` (нужно для
  fix-loop в CI); иначе write-capabilities отвергаются — review/validation-workflow'ы остаются read-only;
- checkpoint не делает коммит (CI-дерево не наше), а сохраняет patch (`git diff`) как артефакт;
- резюмировать CI-Run локально можно через export-бандл (ADR-0009).

### 6. Параллельность и уборка

Несколько Run на одном проекте = несколько worktree; аренда (ADR-0002 §5) гарантирует один процесс на Run.
`jarvis gc` удаляет worktree терминальных Run старше `retention.worktreeDays` (по умолчанию 7); ветки
остаются до `jarvis gc --prune-branches` или до merge. Project Graph кэшируется по blob/tree sha (ADR-0008) и
общий для всех worktree.

### 7. Ограничения

- Монорепозитории с тяжёлой установкой: первый `workspace.setup` — минуты. Смягчение — pnpm store и
  `--offline`; sparse-checkout рассматривается отдельно, когда появится реальный кейс.
- Generated-файлы, которые не в git и не ignored, попадут в коммиты checkpoint'ов. Проектам нужен
  корректный `.gitignore` — `jarvis doctor` проверяет, что после `workspace.setup` дерево чистое.

## Последствия

- Resume детерминирован: состояние файлов однозначно задаётся `headCommit`.
- ADR-0002 упрощается — файловые записи вне журнала эффектов.
- Разработчик продолжает работать параллельно с Run; результат приходит как diff/PR, который он принимает
  осознанно. Это соответствует принципу «workflow owns control».
- Появляются служебные ветки и каталог `~/.jarvis/worktrees`; нужны `gc` и `doctor`-проверки.

## Альтернативы

- **Работа в рабочем дереве разработчика со stash.** Ломается на первом же resume через сутки; блокирует
  разработчика; невозможны параллельные Run.
- **Полный clone на Run.** Медленнее, не делит объекты с основным репозиторием, та же модель checkpoint'ов —
  worktree даёт то же без стоимости.
- **Copy-on-write каталог без git.** Непереносимо, теряет историю checkpoint'ов и trailer'ы provenance.
