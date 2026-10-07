# ADR-0018: Интерфейсы наблюдения в терминале — status/stats, TUI, поток событий, лимиты пулов

- Статус: принято (только терминал; web GUI — отдельным решением: [ADR-0023](0023-editor-and-web-ui.md), `jarvis ui`
  на localhost поверх того же журнала);
  §1 «TUI на Ink» для основного вывода уточнён [ADR-0022](0022-terminal-interface.md): вывод остаётся в
  истории терминала, свой рендерер без Ink; `jarvis ui` — возможный отдельный наблюдатель
- Дата: 2026-10-03
- Основание: [ADR-0001](0001-target-architecture.md) §11 (Budget & Resource Manager, soft/hard limits),
  §14 (метрики по уровням, `jarvis stats`), §15 (CLI, `jarvis status|context|stats|daemon`), §17
  (Commander.js); [ADR-0005](0005-artifact-versions-provenance.md) (версии и approvals),
  [ADR-0006](0006-actor-identity.md) (approve с актором), [ADR-0007](0007-model-capabilities.md) §1
  (`quotaPool`), [ADR-0013](0013-context-pressure-and-prefix-cache.md) (pressure, слои, cache hit),
  [ADR-0016](0016-egress-policy.md) §5 (строка egress), [ADR-0017](0017-models-and-mcp-configuration.md) §2
- Код (план): `src/cli/commands/{status,stats,ui}.ts`, `src/ui/` (Ink-компоненты: timeline, calls, budget,
  context, tools, gates), `src/telemetry/{events,stream}.ts`, `src/orchestration/daemon/socket.ts`,
  `src/budget/{pools,window,admission}.ts`, таблицы `events`, `usage_window` в SQLite

## Контекст

Нужно видеть цикл работы Run и расход ресурсов: токены prompt/cached/output, число запросов за окно,
размер окна и лимиты — причём лимиты должны задаваться в конфиге. Архитектура уже делает главное: всё
состояние долговечно (Run, stepHistory, журнал эффектов, события telemetry). Значит, интерфейс — читатель
БД и потока событий, а не участник исполнения; интерфейсов может быть несколько, и они не влияют на
runtime. Интерактивная среда у разработчика уже есть (OpenCode), поэтому собственный GUI не нужен.

## Решение

### 1. Три ступени, все в терминале

| Этап | Интерфейс | Содержание |
| --- | --- | --- |
| v0.1 (этап 3 roadmap) | `jarvis status [run]`, `jarvis stats`, везде `--json`, `--watch` | состояние Run, шаг/итерация, бюджет пула за окно, pressure последнего вызова |
| v0.2–0.3 | `jarvis ui [run]` — TUI | живой цикл работы, панели §3 |
| shared runtime | `run.status` через Jarvis MCP для OpenCode/IDE; тот же поток событий по сети | для команды; GUI — отдельным решением, если понадобится |

TUI — Ink (React в терминале): совпадает со стеком TS/React/ESM, компоненты тестируются как обычный React.
`--json` — контракт для скриптов и CI; TUI и текстовый вывод строятся из тех же структур.

### 2. Поток событий

Источник истины — таблица `events` в `jarvis.db` (append-only: `{ seq, ts, runId, stepId, iteration, actor,
kind, payloadRef }`), которую пишут все процессы (CLI, daemon, CI). При запущенном daemon он дополнительно
публикует события по локальному Unix-сокету `~/.jarvis/daemon.sock` (NDJSON, с `seq` для догонки);
`jarvis ui` подписывается на сокет, при его отсутствии — читает хвост `events` по polling (1 с). Один
источник, два способа доставки; UI никогда не держит состояния, которого нет в БД.

Действия из TUI (approve/reject, cancel, resume) — вызовы тех же команд CLI с актором (ADR-0006); UI не
имеет прямого доступа к runtime.

### 3. Панели `jarvis ui`

| Панель | Содержание |
| --- | --- |
| Timeline | переходы состояний Run, шаги с итерациями и outcome, обратные рёбра (ADR-0004), checkpoints, записи журнала эффектов со ссылками (Jira, PR), версии артефактов и их provenance (ADR-0005) |
| Model calls | поток вызовов: роль, модель, prompt / cached / output токены, latency, finish reason, retries, режим structured output; итоги по шагу и Run |
| Budget | по каждому пулу: output-токены использовано/лимит за окно, запросов/лимит, input-токены если лимитированы, время до сброса окна, прогноз «лимит через ~N мин при текущем темпе», причина `WAITING_BUDGET` |
| Context | pressure текущего агента с разбивкой по слоям L0–L5, последние compaction/reset, cache-hit ratio (ADR-0013) |
| Tools | вызовы capability, отказы policy/egress (ADR-0016), счётчик редакций секретов (ADR-0010) |
| Gates | ожидающие human-решения: артефакт и версия, клавиши approve / reject / open in `$EDITOR` |

`jarvis status` — те же данные одним экраном без интерактива; `jarvis stats --since 7d` — агрегаты по
ролям, моделям, фазам, cache-hit, петлям, итерациям, эффектам — содержание ADR-0001 §14 без отдельного
хранилища.

### 4. Лимиты в конфиге

Пул квоты (расширение `quotaPools` из ADR-0007 §1 и ADR-0017 §2):

```yaml
quotaPools:
  corp-default:
    window: { minutes: 20, kind: sliding }     # sliding | fixed (сброс по границам часов)
    limits:
      outputTokens: 60000
      inputTokens: 2000000                      # необязательно
      requests: 300
      concurrency: 2
    soft: 0.8                                   # доля, с которой начинается замедление и приоритет compaction

models:
  deepseek-flash:
    contextWindow: 128000                       # размер окна модели (ADR-0007)
    maxOutput: 8192
    quotaPool: corp-default

roles:
  review: { models: [deepseek-flash], maxOutput: 4096 }   # резерв под output по роли (ADR-0013 §1)

budget:                                          # .jarvis/project.yaml — лимиты на Run и шаг
  perRun:  { outputTokens: 150000, requests: 500 }
  perStep: { outputTokens: 40000 }
```

Семантика: `limits` пула — hard-лимит внешнего провайдера (при достижении — checkpoint и `WAITING_BUDGET`,
ADR-0001 §11); `soft` — порог, с которого Budget Manager снижает concurrency до 1 и даёт приоритет
compaction над новыми вызовами; `budget.perRun/perStep` — защита от убегающего Run независимо от пула
(при достижении — `WAITING_HUMAN`, не `WAITING_BUDGET`: квота провайдера есть, закончился план).

`perRun`/`perStep` считают и `inputTokens` — сумму промптов: на шлюзе без кэша префикса это главная цена
(пилот: один шаг research — 2,47M входа при окне кластера 2M за 20 минут).

Сделано так (пилот: остановка парковала прогон с пустой карточкой): `WAITING_HUMAN` с `waitingFor: budget`
и расходом в checkpoint остановки; карточка `jarvis continue` и страница `jarvis ui` предлагают «ещё N и
дальше» или «закончить с тем, что есть». Решение — событие `budget.grant` (актор, канал, сколько), лимит
шага или прогона — конфигурация плюс добавленное. Тот же выбор — у шагов с `onLimit: ask`, когда агент
исчерпал свои `maxToolCalls`/`maxModelCalls`: вместо молчаливого `INCOMPLETE` прогон ждёт человека, разговор
агента сохраняется и продолжается с того же места.

Безлимитные часы и второй кластер (пилот: платформа не ограничивает пул ночью и в выходные, а отдельный кластер
не ограничен вообще):

```yaml
quotaPools:
  corp-default:
    window: { minutes: 20 }
    limits: { inputTokens: 2000000 }
    unlimited:                                  # часы без лимитов: дни, время HH:MM или то и другое
      - { from: "22:00", to: "07:00" }          # через полночь — ок
      - { days: [sat, sun] }                    # стыкующиеся пункты — один отрезок: пт 22:00 — пн 07:00
    timezone: Europe/Moscow                     # IANA; без него — пояс машины
    unlimitedScale: 5                           # во сколько раз в эти часы растут лимиты агентов и budget
  vip: { window: { minutes: 20 } }              # без limits — не ограничен
models:
  deepseek-flash-vip: { quotaPool: vip }
roles:
  research: { models: [deepseek-flash, deepseek-flash-vip] }   # порядок — предпочтение
```

- **В безлимитные часы** admission пропускает вызовы пула без проверки, `concurrency` действует как обычно.
  Потраченное в эти часы в окно потом не входит: окно начинается не раньше конца последнего безлимитного
  отрезка, иначе прогон в 07:01 вставал бы на паузу из-за ночных токенов, которые платформа не считала.
- **Пауза перед безлимитом.** Отказ admission ставит `resumeAfter` на ближайший из двух моментов: освобождение
  окна или начало безлимитных часов. В причину добавляется «unlimited hours begin then».
- **Лимиты агентов и бюджет.** В те же часы `agents.<id>.limits` (вызовы инструментов и модели) и
  `budget.perStep/perRun` для вызовов этого пула умножаются на `unlimitedScale` (по умолчанию 5). Совсем они не
  снимаются, чтобы зациклившийся шаг всё равно закончился. Множитель читается при каждой проверке: утром шаг снова
  держится дневных лимитов. Выданное человеком (`budget.grant`) прибавляется сверху и не умножается.
- **Переход на следующую модель роли.** Если вызов не проходит admission своего пула, Gateway отдаёт его следующей
  модели той же роли в другом пуле. Условия: модель разрешена для `dataClass`, умеет то, что нужно вызову
  (инструменты, структурированный ответ), вмещает промпт и проходит admission своего пула. `WAITING_BUDGET`
  наступает, только когда места нет ни у одной модели. Как только у первого пула появляется место, вызовы
  возвращаются к нему. Переход — событие `model.failover`, одно на отрезок.
- **Где это видно.** `jarvis models` показывает у пула `unlimited until …` или `unlimited from …`. В `jarvis ui` на
  кнопке моделей — метка `∞ until 07:00` (безлимитные часы) или `∞` (пул без лимитов); в поповере — входные и
  выходные токены окна.

### 5. Учёт окна

Таблица `usage_window { pool, ts, model, runId, promptTokens, cachedTokens, outputTokens }` — строка на
вызов. Текущее потребление пула — один SQL-запрос по окну (`ts > now − window` для sliding; по границе
для fixed; у пула с безлимитными часами — не раньше конца последнего из них). Это число используют одинаково:
admission check перед вызовом (ADR-0001 §11), `status`, TUI и `stats`. Строки старше `2 × window` сворачиваются в почасовые агрегаты для `stats`.

Если провайдер возвращает заголовки лимитов (`x-ratelimit-*`), Gateway пишет их в событие `model.call`
и Budget Manager использует меньшее из локального расчёта и значения провайдера.

### 6. Чего не делаем

Собственный GUI (Electron/web) до shared runtime; дашборды в корпоративном backend — его забота, Jarvis
отдаёт события через экспорт telemetry (ADR-0010 §3). Интерактивные команды внутри TUI сверх §2 (чат с
агентом и т. п.) — это OpenCode.

## Последствия

- Наблюдение не меняет runtime: любой UI — читатель; тестируется на записанных событиях.
- Лимиты окна, модели, роли, Run и шага — всё в конфиге, одно место подсчёта.
- Прогноз исчерпания виден до того, как Run встанет.
- Ink добавляет React-зависимость в CLI-пакет; принимается, потому что стек и так React.

## Альтернативы

- **Web GUI с первого этапа.** Второй клиент рядом с OpenCode, сервер, auth — не для local-first.
- **Логи вместо UI.** Не отвечают на «сколько осталось в окне» и «где сейчас Run» без grep'а.
- **Blessed/ncurses-библиотеки.** Старые, без компонентной модели; Ink совпадает со стеком.
