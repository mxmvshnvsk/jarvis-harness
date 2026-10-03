# Участие человека (ADR-0019)

Человек нужен в четырёх местах, и каждое — тред (`interactions`) с сообщениями, состоянием и тем, что
run ждёт (`waitingFor`): **approval** (гейт), **clarification** (вопрос агента), **review**
(замечания к коду), **conflict** (расхождение ручных правок). `jarvis threads` показывает открытые.

## Гейты

Шаг `approval` ждёт решения по последней версии артефакта типа `artifactType`. Решение привязано к
точному хешу содержимого: новая версия артефакта — новое решение.

```sh
jarvis approve <run> --resume                        # утвердить и продолжить
jarvis approve <run> --request-changes --comment "…" # назад по объявленному ребру
jarvis approve <run> --reject --comment "…"          # run → FAILED
jarvis approve <run> --commit                        # + .jarvis/approvals/<task>/<type>.json для CI
```

`human.mode` задаёт профиль: `autonomous` (гейты по `human.gates`), `balanced` (по умолчанию),
`strict`. `human.gates.<type>.required: false` проходит гейт молча с событием `approval.skipped`.

![work](assets/work.gif)

## Уточнения

Агент `requirements` (и `review-analysis`) может ответить `needs_clarification` с одним вопросом и
рассмотренными интерпретациями. Run паркуется в `WAITING_HUMAN`, открывается тред.

Два способа ответить:

- **асинхронно** — `jarvis answer <thread|run> "текст"`: агент-кларификатор (`generateStructured`,
  схема `ClarifierTurn`) задаёт следующий вопрос или предлагает правило; `--accept` принимает
  предложение, `--rule "…"` — свою формулировку, `--reject` закрывает тред без решения; `--resume`
  продолжает run;
- **в живую** — `jarvis attach <run>`: тот же тред как мини-чат в терминале (`a` принять, `e <rule>`
  принять со своей формулировкой, `r` отклонить, `q` выйти); после решения run возобновляется.

Решение становится артефактом `clarification`; все последующие агенты видят его в L2 как обязательное
(«принято с человеком, не спрашивать снова»), транскрипт остаётся в треде. `human.clarification.maxTurns`
ограничивает диалог, `multiTurn: false` — один вопрос, один ответ.

![clarify](assets/clarify.gif)

## Review Mode

Финальный гейт `approve-impl` — на реализации. Вместо утверждения можно оставить замечания прямо в коде
worktree (`jarvis status <run>` печатает путь):

```ts
// REVIEW: the status check belongs in the domain layer, not here
export function canRestartOnboarding(status: string) { … }
```

```sh
jarvis review submit <run> --resume
```

1. Маркеры собираются, в код записываются идентификаторы `REVIEW(R-1):`, создаётся артефакт
   `review-package` (файл, строка, текст, контекст).
2. Гейт отправляется по ребру `review_submitted` к агенту `review-analysis`, который классифицирует
   каждое замечание: `CODE` (исправить), `SPEC_CORRECTION` (назад к spec), `REQUIREMENT_CORRECTION`
   (назад к requirements), `QUESTION` (тред уточнения), `KNOWLEDGE_CANDIDATE` (кандидат в
   стандарт/знание), `SUGGESTION` (к сведению) — и выбирает исход графа.
3. После исправлений run снова на `approve-impl`; маркеры удаляются при `jarvis apply`
   (`human.review.removeMarkersAfterApproval`).

Каждое замечание проживает жизненный цикл, видимый в `jarvis review status <run>`:

```
open ──analysis──▶ acknowledged ──implementation──▶ applied ──gate──▶ ready_for_review ──approve──▶ resolved
  └─ SUGGESTION / KNOWLEDGE_CANDIDATE ──▶ resolved сразу
```

Повторный `review submit` сохраняет состояние и историю замечаний с тем же id и неизменённым текстом;
изменённый текст — новое замечание. `human.review.sourceMarkers: false` отключает режим.

![review](assets/review.gif)

## Ручные правки в worktree

Пока run ждёт, можно править файлы в его worktree. При `jarvis resume` они фиксируются как checkpoint
`human edit` (`Jarvis-Kind: human-edit`) — не сбрасываются, попадают в diff и к агентам. Правка
артефакта (spec и др.) — новая версия с unified diff и provenance «human». `human.manualEdits.enabled:
false` возвращает строгий reset к checkpoint.

## Что видит человек

- `jarvis status <run>` — что ждёт run, уровень проекта, шаги с итерациями, артефакты с версиями и
  утверждениями, эффекты, события, токены; `--watch` сам останавливается на гейте.
- `jarvis threads`, `jarvis review status`, `jarvis candidates list`.
- Markdown-сводка и `approval-request.json` в CI (см. [ci.md](ci.md)).
