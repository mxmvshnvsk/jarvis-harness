# ADR-0005: Версии артефактов, правки человека и привязка approval

- Статус: принято
- Дата: 2026-10-03
- Основание: [ADR-0001](0001-target-architecture.md) §4 («Artifact с версией, schema, provenance и source
  references»), §12 (artifact metadata: checksum, provenance), §13 (human approval), §14 (trace: task → spec →
  evidence → plan → diff); [ADR-0004](0004-workflow-back-edges.md) §4 (итерации порождают версии)
- Код (план): `src/artifacts/{model,store,versions}.ts`, `src/storage/approvals.ts`, `src/context/builder.ts`
  (выбор версии при сборке контекста), CLI `jarvis spec|plan … --edit`, `jarvis approve`

## Контекст

ADR-0001 даёт артефакту `checksum` и `provenance`, но описывает его как результат шага. Human gate
подразумевает, что человек правит `spec.md` или `plan.json` перед тем, как одобрить. Если правка меняет
содержимое под тем же идентификатором, checksum перестаёт сходиться, provenance лжёт («сгенерировано
агентом»), а цепочка «почему эта строка изменена» (§14) рвётся ровно в месте, где вмешался человек —
самом важном для аудита. Кроме того, approval, не привязанный к конкретной версии, можно обойти: одобрили
одно, исполнили другое.

## Решение

### 1. Идентичность и неизменяемость

```
Artifact
  |- artifactId      логический id: (runId, type, name) — стабилен между версиями
  |- version         целое >= 1
  |- schemaVersion   версия схемы типа артефакта
  |- contentRef      sha256 содержимого; blob в artifact store (content-addressed)
  |- checksum        = contentRef
  |- parentVersion?  версия, из которой получена эта
  |- provenance      §2
  |- sourceRefs[]    ссылки на источники (файлы@blobSha, Jira issue@updated, tool results)
  |- createdAt, stepId, iteration
  `- retention
```

Версия никогда не изменяется. Любое изменение содержимого — новая версия с `parentVersion`.

### 2. Provenance

| `provenance.kind` | Поля | Когда |
| --- | --- | --- |
| `agent` | `agentId`, `modelCallRefs[]`, `toolCallRefs[]` | результат agentic-шага |
| `tool` | `capability`, `toolCallRef` | детерминированный шаг (impact по графу, tests) |
| `human` | `actor` (ADR-0006), `diffRef`, `comment?` | правка человеком |
| `import` | `source` (`jira`, `confluence`), `externalId`, `externalVersion` | снимок внешнего документа |
| `compaction` | `parentRefs[]`, `policy` | производное от других артефактов (ADR-0001 §7) |

### 3. Правка человеком

Артефакты, предназначенные для правки (`spec.md`, `plan.json`, `review.json`), материализуются в workspace
Run: `.jarvis/runs/<runId>/<type>.<ext>` (worktree, ADR-0003), либо открываются через `jarvis spec ABC-123
--edit` в `$EDITOR`. При `jarvis approve`, `jarvis resume` или перед любым шагом, читающим артефакт, Jarvis
сверяет checksum файла с последней версией:

- совпадает — ничего не происходит;
- отличается — создаётся версия `n+1` с `provenance.kind = human`, `actor`, `parentVersion = n`, `diffRef`
  (unified diff против родителя); событие `artifact.humanEdit` в telemetry.

Правка в файле, не прошедшая через Jarvis (например, в CI), обнаруживается тем же механизмом при следующем
чтении — незафиксированных изменений не бывает.

### 4. Approval привязан к версии

Таблица `approvals`: `{ id, runId, stepId, artifactId, version, contentRef, actor, decision
(approve | reject | request_changes), comment, createdAt }`. Approval-шаг считается пройденным, только если есть
`approve` для **текущей** версии артефакта. Появление новой версии после approval (человек поправил ещё раз,
агент перегенерировал по обратному ребру) делает approval недействительным — шаг снова `WAITING_HUMAN`.
`reject` переводит Run в `FAILED` с причиной; `request_changes` с комментарием — это outcome для обратного
ребра (ADR-0004), комментарий становится `reasons[]`.

### 5. Какую версию видят шаги

Шаг объявляет `inputs[]` типами артефактов; Context Builder по умолчанию подставляет **последнюю** версию
(после человеческой правки — именно её), для approval-гейтов — последнюю одобренную. Запись шага в
`stepHistory` фиксирует точные `artifactId@version`, которые он получил. Так trace отвечает не «какая была
spec», а «какую версию spec видел implementation-агент» — и видно, что между ней и агентской версией был
человек.

### 6. Retention

Пока Run не терминален — хранятся все версии. После завершения политика retention может удалять
промежуточные `agent`/`compaction`-версии, но никогда — `human`, `import` и версии, на которые есть
`approve`. Diff человека против агентской версии (`diffRef`) сохраняется всегда: это размеченный пример для
evals (человеческая коррекция — самый дорогой и самый честный сигнал качества агента).

## Последствия

- Checksum снова что-то значит: он проверяет версию, а не «что-то когда-то».
- Audit и trace включают человека как полноправного актора в цепочке provenance.
- Approval нельзя обойти заменой содержимого после одобрения.
- Evals получают бесплатный датасет «агент vs человек» (см. предложение по evals).
- Цена — таблица версий и approvals, проверка checksum перед шагами (дёшево: один sha256 файла).

## Альтернативы

- **Mutable артефакт + флаг `editedByHuman`.** Теряет агентскую версию и diff; approval не привязать.
- **Правки только через чат/агента («попроси агента поправить spec»).** Дороже по квоте, хуже по качеству,
  и человек всё равно правит руками.
- **Хранить человеческие правки как отдельный тип артефакта («amendment»).** Усложняет сборку контекста
  (нужно применять поправки) ради сомнительной выгоды; версия с provenance проще.
