# Документация Jarvis

| Документ | О чём |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | сквозной сценарий пилота: от установки до `jarvis apply` |
| [overview.md](overview.md) | архитектура, понятия, жизнь run, раскладка на диске, коды выхода |
| [cli.md](cli.md) | справочник всех команд |
| [configuration.md](configuration.md) | все ключи `~/.jarvis/config.yaml` и `.jarvis/project.yaml`, env, профили |
| [workflows.md](workflows.md) | движок, граф `sdd`, агенты и их контракты, контекст, события |
| [knowledge.md](knowledge.md) | стандарты, навыки, документы, глоссарий, поиск, граф проекта, кандидаты |
| [human.md](human.md) | гейты, уточнения, Review Mode, ручные правки |
| [integrations.md](integrations.md) | модели, MCP-профили, `jarvis mcp serve`, keychain |
| [ci.md](ci.md) | CI-режим, бандлы, закоммиченные утверждения |
| [evals.md](evals.md) | кейсы, кассеты, метрики, базовая линия |
| [security.md](security.md) | egress, редактирование секретов, политика инструментов, эффекты, аренда |
| [extending.md](extending.md) | адаптеры языков, инструменты, профили MCP, агенты, миграции |
| [adr/0001-target-architecture.md](adr/0001-target-architecture.md) | целевая архитектура: что строим, что реализовано, что нет |
| [adr/](adr/) | решения: ADR-0001 … ADR-0022 |
| [process/stages.md](process/stages.md) | журнал реализации по этапам |
| [process/tui.md](process/tui.md) | терминальный интерфейс: паттерны хороших CLI и план улучшений |

Демонстрации в [assets/](assets/) записаны скриптом `scripts/demo/record.ts` против поддельной модели и
отрисованы `scripts/demo/render.py`.
