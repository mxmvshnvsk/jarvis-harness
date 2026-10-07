# ADR-0019: Сотрудничество с человеком — Requirements Analysis, уточнения, Review Mode, ручные правки

- Статус: принято
- Дата: 2026-10-03
- Основание: [ADR-0001](0001-target-architecture.md) §4 (HITL), §6 (агенты SDD), §10 (approvals);
  концепция «Jarvis Human Collaboration Architecture» (2026-10-03). Заменяет HITL-часть ADR-0001 §4.
  Опирается на [ADR-0003](0003-workspace-worktree.md) (worktree на Run), [ADR-0004](0004-workflow-back-edges.md)
  (обратные рёбра), [ADR-0005](0005-artifact-versions-provenance.md) (версии артефактов, ручные правки как
  версии, approval привязан к contentRef), [ADR-0006](0006-actor-identity.md) (человек как actor),
  [ADR-0008](0008-incremental-project-graph.md) и граф артефактов (инвалидация потомков),
  [ADR-0013](0013-context-pressure-and-prefix-cache.md) (транскрипт не является памятью агента)
- Код (план): `src/interaction/{store,thread,clarify,review/{collector,analysis,lifecycle},reconcile}.ts`,
  `src/agents/builtin/{requirements,reviewAnalysis}.ts`, миграция `0002` (`approvals` → `interactions`),
  CLI `jarvis attach`, `jarvis answer`, `jarvis review submit|status`, `jarvis threads`

## Контекст

Разработчик читает сгенерированный код в IDE, оставляет точечные замечания, уточняет бизнес-правила в
терминале и иногда правит код сам. Сейчас у Run один канал участия человека — approval шага (`approve`,
`--reject`, `--request-changes`). Этого мало в трёх местах:

1. до Specification никто не ищет противоречия и пробелы в требованиях — spec пишется по непроверенному
   research;
2. неопределённость агента не может стать коротким диалогом: либо агент додумывает, либо Run падает в
   `WAITING_HUMAN` с одним комментарием;
3. замечания к коду приходят «в целом», а не к строке/диапазону, и Jarvis не отличает «исправь код» от
   «спека была неверна».

При этом система не должна превратиться в chat-агента с растущим контекстом и не должна требовать
перезапуска всего workflow после каждой правки.

## Решение

### 1. Три канала участия человека

| Канал | Смысл | Как выражается |
| --- | --- | --- |
| Decision / gate | «Jarvis не может безопасно продолжить без моего решения» | approval шага (как сейчас) и ответ на уточнение |
| Review | «Вот конкретные проблемы результата; исправь» | маркеры в коде → ReviewPackage → ReviewAnalysis |
| Manual edit | «Я сам изменил результат; прими workspace как новое состояние» | human-checkpoint в worktree, ручная версия артефакта |

Все три проходят через одну сущность — **Interaction** (§2) — и завершаются структурированными
артефактами. Инвариант: **диалог производит артефакты, агенты потребляют артефакты**; транскрипт треда
между агентами не передаётся и в контекст Run не попадает.

### 2. Interaction — одна сущность вместо approvals

Таблица `approvals` обобщается до `interactions`:

```
interactions(id, run_id, kind, step_id, iteration, content_ref, state, waiting_for_actor,
             opened_by, opened_at, resolved_by, resolved_at, resolution_ref)
interaction_messages(id, interaction_id, seq, actor, role human|jarvis, text, created_at)
```

- `kind ∈ {approval, clarification, review, conflict}`; `state ∈ {open, acknowledged, applied,
  ready_for_review, resolved, rejected}` (для `approval` используется подмножество `open → resolved|rejected`).
- `content_ref` — версия артефакта, к которой относится взаимодействие (ADR-0005 §4): approval к `spec@3`,
  уточнение к `requirements@1`, review к `implementation@2`.
- `resolution_ref` — артефакт-результат: `decision`, `clarification`, `review-resolution`, `conflict-resolution`.
- Run стоит в `WAITING_HUMAN`; новые состояния не вводятся. Причина ожидания хранится в
  `runs.waiting_for = {kind, interactionId}` и показывается в `status`. Это сохраняет машину состояний Run
  (ADR-0002, `core/domain/run.ts`).

Открытое взаимодействие переживает закрытие терминала и daemon'а — это строка в SQLite, а не процесс.

### 3. RequirementsAnalysisAgent

Между `research` и `spec` в `sdd` появляется шаг `requirements`:

- ResearchAgent отвечает «что известно», RequirementsAnalysisAgent — «требования непротиворечивы, полны и
  проверяемы?», SpecificationAgent — «какое поведение утверждаем».
- Схема результата: `requirements[]`, `businessRules[]`, `invariants[]`, `ambiguities[]`,
  `contradictions[]`, `missingCases[]`, `assumptions[]`, `terminology[]`, `openQuestions[]`,
  `verdict ∈ {READY, READY_WITH_ASSUMPTIONS, NEEDS_CLARIFICATION}`; outcome `needs_clarification`
  при блокирующем вопросе.
- Агент ищет неоднозначности, противоречия, пропущенные состояния, неопределённые термины, непроверяемые
  требования, нарушенные инварианты, пробелы во времени/правах/данных, retry/duplicate/race/partial cases.
  Блокирующие пробелы **не закрываются молча** — эскалируются человеку (§4). Допущения (`assumptions`)
  фиксируются и попадают в spec явно.
- Обратное ребро `review --plan_wrong|spec_wrong→ requirements`, а не в `research`: review, обнаруживший
  бизнес-пробел, возвращает workflow на фазу требований.

### 4. Уточнение как многоходовый тред

`outcome: needs_clarification` любого агента открывает `interaction(kind: clarification)` с первым
вопросом и ставит Run в `WAITING_HUMAN`. Тред живёт до разрешения **одного** вопроса.

Два режима ответа, оба обязательны:

- **Синхронно** — `jarvis attach <run>`: показывает открытый тред и ведёт мини-чат в терминале; каждый
  ответ человека вызывает агента-уточнителя (роль `research`, контекст §7) под lease процесса CLI; агент
  либо задаёт следующий вопрос, либо предлагает резолюцию (`[a] accept [e] edit`).
- **Асинхронно** — `jarvis answer <thread> "<текст>"` добавляет сообщение и завершает процесс; следующий
  ход агента выполняет daemon или ближайший `resume`. `jarvis threads [--all]` показывает открытые треды.

Принятая резолюция компилируется в артефакты: `clarification` (вопрос, ответ, принятое правило) и, если
надо, `requirement-correction` (новая версия `requirements` с provenance `human`), `candidate`
(ADR-0020 §6). После этого контекст треда освобождается — в последующие шаги попадают только артефакты.

Ограничения: `human.clarification.maxTurns` (по умолчанию 8); исчерпание → тред переходит в
`rejected`, Run остаётся в `WAITING_HUMAN` с явным требованием решения.

### 5. Review Mode v1 — маркеры в исходниках

MVP не требует расширения IDE. Разработчик пишет в worktree:

```ts
// REVIEW: Почему общий REJECTED? Retry разрешён только для REJECTED_TEMPORARY.
```

`jarvis review submit [run]`:

1. **ReviewCollector** (детерминированный шаг): сканирует diff worktree относительно базового коммита Run
   плюс файлы с маркерами; каждому маркеру присваивает `id` (`R-<n>`, записывается в маркер:
   `// REVIEW(R-3):`), фиксирует файл, диапазон, hunk, `blobSha` файла, базовый коммит; собирает
   `ReviewPackage` — артефакт `review-package`. Маркеры ищутся по шаблону комментария любого языка
   (`//`, `#`, `--`, `/* */`, `<!-- -->`), без знания синтаксиса — стек-нейтрально (ADR-0021).
2. **ReviewAnalysisAgent** классифицирует каждый комментарий: `CODE | SPEC_CORRECTION |
   REQUIREMENT_CORRECTION | QUESTION | KNOWLEDGE_CANDIDATE | SUGGESTION`, предлагает действие и
   указывает, какие артефакты затрагиваются. Результат — `review-analysis`.
3. Для `QUESTION` открывается тред §4; для `SPEC_CORRECTION` / `REQUIREMENT_CORRECTION` — план
   инвалидации §8 показывается человеку до применения; `CODE` идёт в обратное ребро
   `review → implementation` с `reasons`, содержащими `R-id` и диапазон; `KNOWLEDGE_CANDIDATE` —
   артефакт `candidate`.

Жизненный цикл комментария: `OPEN → ACKNOWLEDGED → APPLIED → READY_FOR_REVIEW → RESOLVED`; новый
комментарий к тому же месту — цикл заново. Маркер **не удаляется после первой правки**: он получает
статус и остаётся до approval человека; при `human.review.removeMarkersAfterApproval: true` Jarvis
удаляет маркеры в worktree после `resolved`, ReviewThread остаётся в ArtifactStore.

Расширение IDE (аннотации вне исходников, Review API) — целевая версия, **вне пилота**.

### 6. Ручные правки и владение workspace

Workspace принадлежит разработчику. Перед каждым шагом Jarvis в worktree (ADR-0003):

1. если `git status` показывает незафиксированные изменения, они коммитятся как human-checkpoint с
   трейлером `Jarvis-Actor: <actor>` (ADR-0006) и `Jarvis-Kind: human-edit`; соответствующие артефакты
   (`implementation`) получают новую версию с provenance `human` и diff (ADR-0005 §3);
2. Jarvis никогда не делает `reset --hard` поверх незафиксированных человеческих изменений; restore
   checkpoint'а допустим только после human-checkpoint;
3. если ручная правка конфликтует с тем, что Jarvis собирался применить (конфликт слияния при restore или
   изменённые человеком файлы в плане шага), открывается `interaction(kind: conflict)` с тремя исходами:
   принять правку человека, принять версию Jarvis, объединить вручную.

Хэши файлов не нужны — границей служит git-коммит.

### 7. Контекст взаимодействия

Тред собирается под конкретную проблему, а не из истории Run:

```
L0 система / роль уточнителя
L1 происхождение (review-комментарий | пробел требований | неопределённость агента)
L2 релевантные requirements + spec (срез по сущностям вопроса)
L3 релевантный код / артефакты (диапазон маркера, затронутые файлы)
L4 релевантные standards / knowledge (ADR-0020)
L5 короткая история треда (последние N ходов)
L6 текущий вопрос
```

Транскрипт треда хранится как blob для аудита (ADR-0013); в контекст других агентов не передаётся.

### 8. Инвалидация по графу артефактов

Граф зависимостей фиксирован в workflow: `research → requirements → spec → impact → plan →
implementation → {tests, docs} → review`. Изменение узла инвалидирует только потомков. Перед применением
существенного отката показывается план:

```
R-3 → SPEC_CORRECTION
Будут пересчитаны: impact, plan, implementation, tests, review
Сохранятся:        research, requirements
Применить? [Y/n]
```

Применение — обратное ребро на нужный шаг (ADR-0004) с `reasons`; артефакты потомков не удаляются —
появятся новые версии (ADR-0005). Это же правило используется ADR-0008 для детерминированного impact.

### 9. Политика участия человека

В `.jarvis/project.yaml`, narrow-only (пользовательский config может ужесточать, не ослаблять — как
профили ADR-0014):

```yaml
human:
  gates:
    requirements: { onBlockingIssue: true }
    specification: { required: true }
    implementation: { reviewRequired: true }
    final: { required: true }
  review:
    sourceMarkers: true
    removeMarkersAfterApproval: true
  clarification: { multiTurn: true, maxTurns: 8 }
```

Убрано в пилоте (2026-10-07), потому что не понадобилось и кода под них не было: `mode` (`autonomous | balanced |
strict` — пресет поверх `gates`, которые задают то же явно), `review.knowledgePromotion` (кандидаты не мешали;
вернуть, если появится шум), `manualEdits.enabled` (ручные правки фиксируются всегда, отбрасывать их не нужно).

CI-профиль (ADR-0009) не может отвечать на треды: `needs_clarification` в CI = exit 10 с экспортом
треда; ответ даётся локально через `jarvis answer`.

### 10. Что отложено

- Расширение VS Code и аннотации вне исходников (не в пилоте).
- Несколько одновременно открытых тредов на один шаг: в v1 — один открытый тред на Run.
- Автоматическое продвижение знаний из review (ADR-0020 §6 — только через `candidate` + подтверждение).

## Последствия

- Workflow `sdd` получает шаг `requirements` и обратные рёбра из review в требования; существующие
  тесты e2e расширяются, схема графа не меняется.
- `approvals` мигрирует в `interactions` (forward-only миграция `0002`, ADR-0014); команда `approve`
  остаётся как сахар над `interaction(kind: approval)`.
- Run в `WAITING_HUMAN` теперь всегда указывает, чего ждёт; `status` и `attach` показывают это.
- Стоимость: ReviewCollector, два новых агента, мини-чат в CLI, reconciliation перед шагами.
  Всё это — поверх существующих механизмов (версии, обратные рёбра, lease), а не новый runtime.

## Альтернативы

- **Chat-first агент с общей историей Run.** Растущий контекст, lost-in-the-middle, невоспроизводимость;
  противоречит ADR-0013.
- **Отдельные таблицы и менеджеры для approvals, review, clarifications.** Три копии одного жизненного
  цикла; единая `interactions` проще в `status`, экспорте (ADR-0009) и в CI.
- **Новые состояния Run (`WAITING_REVIEW`, `WAITING_CLARIFICATION`).** Ломает машину состояний и все
  переходы ради информации, которую несёт `waiting_for`.
- **Хэши файлов для обнаружения ручных правок.** Дублируют то, что уже даёт git в worktree.
