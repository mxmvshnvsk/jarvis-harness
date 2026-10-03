# ADR-0009: CI-режим, human gate и перенос Run между окружениями

- Статус: принято
- Дата: 2026-10-03
- Основание: [ADR-0001](0001-target-architecture.md) §3 (режим CI), §13 («CI использует отдельный
  non-interactive permission profile»), §15 (Git / CI: те же workflow definitions), §21 («одна и та же
  задача может быть запущена локально и в CI через один workflow definition»);
  [ADR-0003](0003-workspace-worktree.md) §5 (режим `cwd`), [ADR-0005](0005-artifact-versions-provenance.md)
  §4 (approval привязан к версии), [ADR-0002](0002-run-effects-and-lease.md) §5 (аренда `ci:`)
- Код (план): `src/integrations/ci/{runner,exitCodes,summary}.ts`, `src/orchestration/bundle.ts`
  (export/import), профили в `.jarvis/project.yaml: profiles.ci`, CLI `jarvis ci`, `jarvis export|import`,
  коммитимые approvals `.jarvis/approvals/`

## Контекст

CI-runner эфемерен и без человека. ADR-0001 задаёт для CI отдельный permission profile, но не отвечает,
что происходит, когда workflow в CI доходит до approval-шага: ждать нельзя, падать — значит, любой
workflow с human gate в CI бесполезен. Второй вопрос — где живёт state Run, если runner исчезает после job:
без shared backend «resume» CI-Run невозможен. Третий — как CI узнаёт, что человек уже одобрил spec
локально, и не требует approval повторно.

## Решение

### 1. Профиль как наложение, а не отдельный workflow

Определение workflow одно. `.jarvis/project.yaml`:

```yaml
profiles:
  ci:
    interactive: false
    workspace: { mode: cwd, allowWrites: false }
    tools: { deny: [jira.transition, bitbucket.pr.merge, "*.delete"] }
    humanGate: artifact          # fail | artifact | skip-if-approved
```

`jarvis ci <workflow>` применяет профиль `ci` поверх policy проекта; `actor.kind = ci` (ADR-0006). Профиль
может только сужать права относительно базовой policy — расширить их в CI нельзя.

### 2. Поведение на human gate

| `humanGate` | Поведение |
| --- | --- |
| `fail` | Run → `FAILED` с причиной `human_gate_in_ci`; exit `12` |
| `artifact` (по умолчанию) | checkpoint, Run → `WAITING_HUMAN`, артефакт `approval-request.json` + markdown-сводка для job summary/PR-комментария; exit `10` |
| `skip-if-approved` | gate проходится, если в репозитории есть коммитимый approval для текущей версии артефакта (§4); иначе — как `artifact` |

### 3. Коды выхода

| Код | Смысл |
| --- | --- |
| `0` | Run завершён, policy удовлетворена |
| `1` | ошибка исполнения |
| `10` | `WAITING_HUMAN` — требуется решение человека |
| `11` | `WAITING_BUDGET` — квота исчерпана, checkpoint сохранён |
| `12` | отказ policy (запрещённое действие, human gate при `fail`) |
| `13` | потеря аренды (ADR-0002) |

Pipeline трактует `10`/`11` как «не красный, но не зелёный» (neutral/warning) — это настраивается на стороне
CI, Jarvis лишь гарантирует стабильные коды.

### 4. Коммитимые approvals

Approval (ADR-0005 §4) можно материализовать в репозиторий: `jarvis approve --commit` пишет
`.jarvis/approvals/<task>/<artifactType>.json` — `{ artifactId, version, contentRef, actor, decision,
createdAt }` — и коммитит его в ветку. CI при `skip-if-approved` сверяет `contentRef` файла артефакта в
checkout с записью: совпадает — gate пройден, иначе — `WAITING_HUMAN`. Доверие — то же, что к коммиту:
подпись коммита или защищённая ветка. Это следует §3 ADR-0001: проект содержит versioned policy, approvals —
её часть.

### 5. Перенос Run: export/import

Пока нет shared backend, CI-Run нельзя «продолжить» на другом runner'е. Вместо этого — бандл:

- `jarvis export <run>` → `<run>.jarvis.tar.zst`: строка Run, stepHistory, checkpoints, артефакты (все
  версии), журнал эффектов, approvals, patch workspace (в `cwd`-режиме — `git diff`, в worktree — ссылка на
  ветку + diff). Секреты уже отредактированы на записи (ADR-0010).
- `jarvis import <bundle>` → Run в локальном `jarvis.db` (с проверкой, что Run с таким id ещё не
  импортирован), workspace восстанавливается как worktree от `baseCommit` с наложением patch.

CI публикует бандл как job artifact при exit `10`/`11`; разработчик импортирует, одобряет/дорабатывает,
`jarvis resume`, доставляет результат (ADR-0003 §4). Тот же бандл — формат для багрепортов и переноса
eval-кейсов. С появлением shared backend бандл остаётся форматом обмена, а resume станет прямым.

### 6. Права в CI

Read-only по умолчанию. Запись в файлы — только при `allowWrites: true` и только в ветке job'а; push —
только в ту же ветку и только если workflow это объявляет. Деструктивные и административные MCP-действия в
CI запрещены профилем без возможности включить.

## Последствия

- Любой workflow с human gate работоспособен в CI: он завершается чётким состоянием и возобновляется
  человеком локально.
- Approval, данный один раз, не запрашивается повторно в CI — через данные в репозитории, без сервера.
- Появляется формат бандла — нужен его `schemaVersion` и совместимость при обновлениях (см. предложение по
  миграциям).
- CI не получает доступа к токенам людей: `actor.kind = ci`, credentials — только CI-сервисные.

## Альтернативы

- **Shared backend сразу.** Правильная конечная точка (ADR-0001 §3), но это этап после local-first; бандл
  закрывает разрыв и остаётся полезным после.
- **Падать на human gate.** Делает SDD-workflow в CI бесполезным; остаётся как опция `fail` для
  строгих pipeline'ов.
- **Approval через комментарий в PR.** Требует MCP-доступ из CI и доверие к тексту комментария; коммитимый
  approval проверяется checksum'ом и подписью коммита.
