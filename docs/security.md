# Безопасность и гарантии исполнения

Jarvis рассчитан на закрытый контур: конфиденциальный код не должен покинуть периметр, секреты — попасть
в модель или в лог, а внешние действия — выполниться дважды.

## Egress (ADR-0016)

`dataClass` проекта (по умолчанию `confidential`) определяет, какие модели и сети допустимы:

| dataClass | Модели | Сеть инструментов/MCP |
|---|---|---|
| public | `egress: private` и `cloud` | none, intranet, internet |
| internal | только `private` | none, intranet, internet (пометка результата как недоверенного пока не сделана) |
| confidential | только `private` | none, intranet |

`egress` обязателен у каждой модели (схема не пропустит без него); сервер без `network` получает сеть
своего профиля (`atlassian`, `bitbucket` — `intranet`, `figma` — `internet`), а без профиля — `internet`. Нарушения отсекаются роутером моделей и Tool Router до вызова; `jarvis doctor` печатает
сводку политики.

Один MCP-сервер можно выпустить за пределы сети его `dataClass` только на чтение: `egressExceptions: [{ server,
capabilities, reason }]` в `.jarvis/project.yaml` (и только там), `reason` — не короче 10 символов. Эффекты не
выпускаются никогда. Каждый прогон и каждая страница `jarvis ui` об исключении предупреждают, у вызова в журнале —
`egressException` (ADR-0016 §6). Для будущего экспорта телеметрии (`telemetry.export`) правило уже проверяется через `network` (`doctor`), сам экспортёр пока не реализован.

## Секреты (ADR-0010, ADR-0014 §1)

- В YAML секреты запрещены схемой: только `env:VAR` и `keychain:ID`. Значения разрешаются в момент
  построения транспорта и никуда больше не попадают.
- `Redactor` обрабатывает **каждый** результат инструмента и вывод команд до того, как он попадёт в
  контекст модели, артефакт или лог:
  - точные литералы из `secretEnv`, разрешённых `env:`/`keychain:` ссылок;
  - детекторы: PEM, AWS, GitHub, Slack, OpenAI, Google ключи, JWT, `Bearer …`, URL с basic-auth,
    присваивания вида `password=…`, строки высокой энтропии в присваиваниях (пути, имена из кода, хеши и UUID
    не трогаются); `security.secretPatterns` добавляет свои; значения переменных окружения с «секретными»
    именами тоже маскируются;
  - `security.deniedPaths` — отказ **до чтения** файла; встроенный список: `.env*`, `secrets/**`, `*.pem`,
    `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.ssh/**`, `.aws/**`, `.npmrc`, `.jarvis/credentials*`.
- Замена — детерминированный плейсхолдер `[REDACTED:<тип>:<hash8>]` на run (одинаковый секрет → одинаковый плейсхолдер внутри run,
  другой — в другом run), событие `security.redaction` с типом детектора.

## Политика инструментов (ADR-0001 §9, ADR-0009 §6)

Tool Router решает перед каждым вызовом, по порядку:

1. возможность входит в набор агента (allowlist в `AgentDefinition`);
2. не запрещена профилем (`mcp.deny`, `tools.deny`, `deniedCapabilities`);
3. её `network` допустима для `dataClass`;
4. запись в workspace разрешена (`workspace.allowWrites`: в `cwd`-режиме и CI — нет);
5. `access: destructive` никогда не выполняется в неинтерактивном профиле.

Отказ — событие `tool.denied` с причиной; модель видит только разрешённые инструменты. Выводы
ограничены `tools.maxOutputBytes`, полный редактированный текст остаётся блобом. `shell.run`
выключен по умолчанию (`tools.shell: true` включает внутри workspace).

## Эффекты: ровно один раз (ADR-0002)

Внешние действия (`jira.comment`, `jira.transition`, `confluence.create`, `bitbucket.pr.create`,
`bitbucket.pr.comment`, `git.push`) идут через журнал:

```
intended(run, step, args, marker) → вызов → done(result)
                                  ↘ падение → при resume: verify через тот же сервер
                                               (маркер в тексте / статус / PR) → done | unresolved
```

`unresolved` паркует run в `WAITING_HUMAN` (`waitingFor: effect`, событие `effect.unresolved`) — человек
решает, повторять ли.
Эффекты без способа проверки (`mcp.<server>.<tool>` без профиля) агентам по умолчанию не выдаются.

## Аренда и параллельность (ADR-0002 §5)

Run исполняет один процесс: аренда с эпохой, heartbeat, fencing при записи checkpoint и эффектов —
процесс с устаревшей эпохой не может ничего записать. `jarvis resume --steal` забирает аренду у
мёртвого процесса с событием `run.steal`. Daemon продолжает припаркованные run без живой аренды:
`WAITING_BUDGET` — после `resumeAfter`, `WAITING_HUMAN` — когда решение уже записано; упавшие и прерванные не
трогает.

## Workspace (ADR-0003)

- `worktree` (по умолчанию): ветка `jarvis/<task>/<run>` от базового коммита в `~/.jarvis/worktrees/`;
  checkpoint — коммит с трейлерами `Jarvis-Run`, `Jarvis-Step`, `Jarvis-Kind`; основной checkout
  не трогается до `jarvis apply`.
- `cwd`: работа в текущем каталоге, запись выключена, если не включить явно — режим CI и чтения.
- `jarvis gc` удаляет worktree завершённых run по `retentionDays`.

## Аудит

Всё в SQLite: `runs`, `steps`, `checkpoints`, `artifacts` (с provenance и версиями), `approvals`
(актор, решение, хеш содержимого), `effects`, `interactions` и сообщения, `events`, `usage`.
Актор (ADR-0006) — `actor.id`, `JARVIS_ACTOR` или git identity — записывается в каждое решение.
`jarvis export` переносит это всё целиком.
