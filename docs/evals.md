# Evals (ADR-0012)

Workflow-уровневые проверки: задача на fixture-репозитории проходит весь `sdd` с автоматически
утверждёнными гейтами, результат сравнивается с «золотом». Нужны, чтобы менять промпты, модели,
навыки и стандарты и видеть, стало ли лучше — в успехах на 10 000 выходных токенов, а не в ощущениях.

## Структура

```
evals/
  <suite>/
    <case>/
      case.yaml
      fixture/            # репозиторий-образец (без .git; инициализируется при прогоне)
      cassette/           # записанные ответы модели (режим record → replay)
  results/<date>-<suite>.json
  baselines/<suite>.json
```

```yaml
# case.yaml
id: onboarding-restart
task: "ABC-42 allow onboarding restart after rejection"
workflow: sdd
fixture: fixture
project:                      # накладывается на .jarvis/project.yaml fixture
  tools: { local: { tests: "node --test" } }
gold:
  files: [src/onboarding.ts]                   # файлы, которых должна коснуться реализация
  tests: "node --test"                         # команда, которая должна пройти после
  acceptance: ["REJECTED", "once"]             # фразы в критериях приёмки спецификации
  requiredSources: ["src/onboarding.ts"]       # источники, которые research/impact обязаны процитировать
cassette: cassette
maxApprovals: 6
source: { run: run_…, task: ABC-42 }           # для кейсов из run-to-case
```

## Прогон

```sh
jarvis evals run --suite pilot --mode record            # живые модели, ответы пишутся в кассету
jarvis evals run --suite pilot                          # replay — детерминированно, без сети
jarvis evals run --suite pilot --mode live --variant roles.implementation.models=[qwen-coder]
jarvis evals run --suite pilot --mode replay --out evals/results/manual.json
```

`--variant k=v` накладывает переопределения конфигурации на каждый кейс (сравнение моделей,
`knowledge.maxSkills`, порогов контекста). В `replay` без кассеты для запроса — ошибка кейса, а не
обращение к модели.

## Метрики

| Метрика | Что |
|---|---|
| `state` | конечное состояние run |
| `testsPassed` | `gold.tests` в workspace после run |
| `fileRecall` | доля `gold.files`, которых коснулась реализация |
| `acceptanceCoverage` | доля `gold.acceptance`, присутствующих в критериях приёмки spec |
| `sourceRecall` | доля `gold.requiredSources`, процитированных research/impact |
| `loops` | число возвратов по обратным рёбрам |
| `outputTokens`, `promptTokens`, `modelCalls`, `ms` | стоимость |
| `success` | `COMPLETED` и все заданные recall/coverage = 1 и тесты прошли |
| `successPer10k` | success / (outputTokens / 10 000) — главная цифра |

Сводка по suite: `successRate`, `meanFileRecall`, `meanAcceptanceCoverage`, `successPer10k`.

## Базовая линия и регрессии

```sh
jarvis evals baseline pilot                   # зафиксировать последний результат
jarvis evals diff pilot --tolerance 0.05      # ненулевой код при падении больше 5 %
```

`diff` сравнивает `successRate`, `successPer10k` и средние recall по кейсам; удобно в CI после
изменения промптов или навыков.

## Кейс из реального run

```sh
jarvis evals run-to-case <run> --suite pilot --id onboarding-restart
```

Берёт fixture `git archive` базового коммита run, gold — из версий spec/impact/research, которые
человек утвердил или правил (файлы из impact, acceptance из spec, источники из research), тестовую
команду из `tools.local.test|tests|check`; записывает `source` для трассируемости. `--no-fixture` —
только `case.yaml`. Кассету для replay нужно записать отдельным `--mode record`.
