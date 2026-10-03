# ADR-0007: Дескрипторы возможностей моделей и маршрутизация по требованиям агента

- Статус: принято
- Дата: 2026-10-03
- Основание: [ADR-0001](0001-target-architecture.md) §6 (AgentDefinition: model role, schema результата),
  §10 (ModelGateway, Model Router «по роли и политике», structured output validation), §17 (DeepSeek Flash,
  Qwen Coder через OpenAI-compatible endpoint), §19 («Invalid structured output → schema repair/retry»)
- Код (план): `src/models/registry.ts` (дескрипторы из конфига), `src/models/router.ts` (фильтр по
  требованиям), `src/models/structured.ts` (стратегии structured output), `src/agents/definition.ts`
  (`requires`), CLI `jarvis models list|probe`

## Контекст

Корпоративный endpoint OpenAI-compatible, но модели за ним — разные: DeepSeek Flash, Qwen Coder, «future
model». Они по-разному поддерживают tool calling, JSON schema / JSON mode, размер окна, системную роль,
reasoning-поля, prefix caching. Router «по роли» выберет модель, которая не умеет того, что требует агент, и
единственным симптомом будет серия schema-repair retry'ев, маскирующих несовместимость под «модель плохо
слушается». Это сжигает квоту и портит evals: сравниваются не модели, а их несовместимости с харнессом.

## Решение

### 1. Реестр моделей — данные в конфиге

`~/.jarvis/config.yaml` (глобально) и `.jarvis/project.yaml` (переопределения):

```yaml
models:
  deepseek-flash:
    provider: openai-compatible
    endpoint: ${CORP_LLM_ENDPOINT}
    model: deepseek-flash
    contextWindow: 128000
    maxOutput: 8192
    quotaPool: corp-default
    supports:
      tools: true
      parallelTools: false
      jsonSchema: false      # response_format: json_schema
      jsonMode: true         # response_format: json_object
      systemRole: true
      reasoning: false
      prefixCache: true
    tokenizer: deepseek      # для оценки контекста; см. предложение по context pressure
    roles: [research, review, compaction]
```

Дескриптор — факт о модели, не политика. `jarvis models probe <id>` отправляет канареечные запросы (tool
call на тривиальной функции, `json_schema`, `json_object`, системная роль) и записывает результат в
`~/.jarvis/cache/models/<id>.probe.json` с датой; `doctor` предупреждает, если probe расходится с конфигом
или старше 30 дней.

### 2. Требования агента

```
AgentDefinition.requires
  |- structuredOutput: schema | json | text     минимально приемлемый режим
  |- tools: boolean
  |- minContext: number                          токены
  `- reasoning?: boolean
```

### 3. Маршрутизация

`ModelRouter.resolve(role, requires, policy)`:

1. кандидаты — модели с этой `role` (политика проекта может сузить/переупорядочить);
2. фильтр по `requires` против `supports` (с учётом probe, если он есть и свежее конфига);
3. первый подходящий по порядку в политике; при `quotaPool` в состоянии exhausted — следующий, если политика
   разрешает fallback между пулами, иначе `WAITING_BUDGET`.

Проверка выполняется для **всех** шагов workflow при создании Run (`jarvis work`), а не при достижении
шага: несовместимый workflow падает сразу с понятной ошибкой («review требует tools, ни одна модель роли
review их не поддерживает»), а не на пятом шаге после потраченной квоты.

### 4. Стратегии structured output

Выбираются по дескриптору, фиксируются в telemetry (`structuredOutput.mode`):

| Режим | Как | Repair |
| --- | --- | --- |
| `schema` | `response_format: json_schema` из Zod | Zod-валидация; repair-промпт ≤ 1 |
| `json` | `response_format: json_object` + схема в промпте | Zod-валидация; repair ≤ 2 |
| `text` | схема в промпте, извлечение fenced JSON | Zod-валидация; repair ≤ 2 |

Лимит repair — из policy; исчерпание — `FAILED` шага с артефактом `invalid-output.json` (сырой ответ
сохранён для evals). Repair никогда не повышает лимит сам.

### 5. Чего не делаем

Эмуляция tool calling для моделей без нативной поддержки (парсинг «вызовов» из текста) не реализуется:
недетерминированно, ломает audit tool calls. Агент с `requires.tools` на такой модели не запускается.

### 6. Связь с контекстом

`contextWindow`, `maxOutput`, `tokenizer` и `supports.prefixCache` — входы Context Engine для расчёта
context pressure и порядка слоёв (отдельное решение по порогам).

## Последствия

- Добавление новой модели — запись в конфиг плюс `probe`, без изменения кода агентов (цель §10 ADR-0001).
- Evals сравнивают модели в одинаковом режиме structured output или явно видят разницу режимов.
- Несовместимости обнаруживаются при создании Run, а не внутри него.
- Дескрипторы придётся поддерживать актуальными — для этого `probe` и `doctor`.

## Альтернативы

- **Пробовать и падать назад (schema → json → text) в рантайме.** Прячет несовместимость, непредсказуемая
  стоимость, грязные evals.
- **Захардкодить известные модели в коде.** Корпоративный endpoint меняет модели без предупреждения;
  данные в конфиге + probe переживают это.
