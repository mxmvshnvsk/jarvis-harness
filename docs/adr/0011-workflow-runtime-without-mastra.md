# ADR-0011: Собственный workflow runtime в v0.1, Mastra — за портом и позже

- Статус: принято
- Дата: 2026-10-03
- Основание: [ADR-0001](0001-target-architecture.md) §5 («Jarvis определяет собственный WorkflowRuntime.
  Mastra используется как первая реализация durable orchestration»), §17 (Workflow: «Mastra adapter
  первым»), §21 («ни один агент не зависит от Mastra API»); [ADR-0002](0002-run-effects-and-lease.md)
  (журнал эффектов, аренда), [ADR-0004](0004-workflow-back-edges.md) (граф шагов)
- Код (план): `src/orchestration/runtime.ts` (собственный движок), `src/orchestration/engine.port.ts`
  (порт `WorkflowEngine`), `src/models/gateway/retry.ts` (ретраи и классификация ошибок квоты)

## Контекст

Исходный мотив для Mastra — готовые ретраи и suspend/resume при исчерпании лимитов. После ADR-0002 и
ADR-0004 картина другая:

- ретраи transient-ошибок и распознавание quota-ответов (`429`, `insufficient_quota`) — ответственность
  ModelGateway: классификация ошибки → bounded retry с backoff → checkpoint → `WAITING_BUDGET` → выход
  процесса. Это десятки строк и они нужны в Gateway независимо от движка;
- resume требует журнала эффектов и аренды — Mastra о них не знает, и эта логика в любом случае наша;
- durable state Mastra хранит в собственной схеме — второй владелец состояния Run рядом с RunStore;
- из agent/model/tool-абстракций Mastra используется малая часть: AgentRuntime, ModelGateway и Tool
  Router — свои по ADR-0001;
- закрытый контур: тяжёлое дерево зависимостей через внутреннее зеркало, каталоги `ee/` под отдельной
  лицензией, которые нельзя задеть случайно.

При этом сам runtime после ADR-0004 невелик: граф шагов с объявленными переходами, счётчики итераций,
checkpoint на границе шага, состояния Run из ADR-0001 §4.

## Решение

### 1. v0.1 — собственный runtime

`WorkflowRuntime` реализует: загрузку и валидацию определения workflow (Zod), выбор следующего шага как
чистую функцию `(definition, runState, outcome) → transition`, исполнение шага через `StepExecutor`
(deterministic / agentic / approval / composite), checkpoint после шага и intra-step (ADR-0002 §4), переходы
состояний Run, аренду, обработку `WAITING_*`. Параллельные ветки — только независимые composite-шаги с
`Promise.all` и общим бюджетом; без распределённого исполнения.

### 2. Порт остаётся

```
interface WorkflowEngine {
  start(run: Run, definition: WorkflowDefinition): Promise<void>;
  resume(run: Run, checkpoint: Checkpoint): Promise<void>;
  cancel(run: Run): Promise<void>;
}
```

Domain-типы (`Run`, `Step`, `Artifact`, `Checkpoint`) принадлежат `src/core` и не зависят от реализации.
Единственная реализация в v0.1 — `LocalWorkflowEngine`. Любая внешняя реализация обязана использовать
RunStore как единственный источник истины о состоянии Run; собственное хранилище движка допустимо только
как кэш, восстанавливаемый из RunStore.

### 3. Условия пересмотра

Mastra (или другой движок) оценивается заново на этапах 8–9 roadmap, если появится одно из: потребность в
параллельных ветках с человеком в контуре и UI, распределённое исполнение шагов на нескольких машинах,
стоимость поддержки собственного runtime, измеримо превышающая стоимость адаптера. Решение принимается
по evals и по объёму кода runtime, а не по ощущению.

## Последствия

- Один владелец состояния Run; ADR-0002 реализуется без согласования двух хранилищ.
- Меньше зависимостей в закрытом контуре; нет риска задеть `ee/`.
- Runtime придётся писать и тестировать самим; ограничение области (§1) держит его малым.
- Тестируемость — через record/replay ModelGateway (ADR-0012), без живой модели.

## Альтернативы

- **Mastra с первого этапа.** Отвергнуто по причинам из контекста; порт сохраняет возможность вернуться.
- **Temporal/подобные durable-движки.** Требуют сервера; противоречит local-first этапу; возможны как
  реализация порта в shared runtime.
