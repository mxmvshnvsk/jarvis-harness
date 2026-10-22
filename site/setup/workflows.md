# Сценарии задач

Сценарий (workflow) — граф шагов, по которому идёт задача. Встроенных сценариев хватает для обычной работы. Свой
нужен, когда команде нужен другой порядок шагов: убрать лишний, добавить проверку, поменять число возвратов.

## Встроенные

| Сценарий | Как запустить | Что делает |
|---|---|---|
| `sdd` | `jarvis work`, Implementation в «Новой задаче» | весь путь, от исследования до кода и заметок к релизу |
| `spec` | `jarvis spec`, Specification | до утверждённой спецификации, потом можно продолжить в `sdd` |
| `fix` | `jarvis fix`, Bugfix | исследование, спецификация, правка, проверки, ревью |
| `research` | `jarvis research` | только исследование. В «Новой задаче» его нет: спецификация начинается с того же исследования |
| `ask` | `jarvis ask`, База знаний → Спросить | ответ на вопрос по базе знаний |
| `review-diff` | `jarvis prepush` | ревью диапазона коммитов перед push |

Полный путь по шагам — на странице [как проходит задача](../guide/how).

## Свой сценарий

Сценарий — YAML в `.jarvis/workflows/<имя>.yaml`. Файл с именем встроенного, например `sdd.yaml`, заменяет его
целиком. Свой сценарий запускается так: `jarvis work <задача> --workflow <имя>`.

```yaml
name: hotfix
version: 1
kind: fix                    # тип задачи по умолчанию — от него зависят скиллы и стандарты
entry: discover
steps:
  - id: discover
    kind: deterministic
    tool: project.discover
    outputs: [project-capabilities]
    transitions: { onSuccess: implementation }
  - id: implementation
    kind: agentic
    agent: implementation
    skills: [hotfix-checklist]   # агент получит этот скилл целиком
    outputs: [implementation]
    transitions: { onSuccess: tests }
  - id: tests
    kind: deterministic
    tool: project.tests
    transitions: { onSuccess: approve-impl }
  - id: approve-impl
    kind: approval
    artifactType: implementation
    transitions:
      onSuccess: DONE
      onOutcome:
        request_changes: { to: implementation, maxIterations: 2 }
```

## Виды шагов

| Вид | Что делает | Примеры |
|---|---|---|
| `deterministic` | инструмент без модели | `project.discover`, `project.tests`, `project.checks`, `standards.check` |
| `agentic` | агент | `research`, `requirements`, `specification`, `impact`, `plan`, `implementation`, `test`, `review` |
| `approval` | вы утверждаете документ | `artifactType: spec`, `artifactType: implementation` |
| `composite` | несколько шагов параллельно с общим бюджетом | `verify`: проверки, стандарты, тесты, документация |

Список агентов и что каждый умеет — на странице [какие агенты есть](../agents/).

## Переходы и возвраты

- `onSuccess: <шаг>` — куда идти дальше; `DONE` — конец задачи.
- `onOutcome: { <исход>: { to: <шаг>, maxIterations: N } }` — куда вернуться при определённом исходе. Например,
  ревью вернуло `fix_required` — снова реализация, но не больше трёх раз.
- На следующем круге агент получает причины возврата: замечания ревью, нарушенные стандарты, упавшие тесты.
- Если круги кончились, задача не падает молча: она останавливается и спрашивает вас.

## Поля шага

| Поле | Зачем |
|---|---|
| `agent`, `tool`, `artifactType` | что исполняет шаг |
| `outputs` | какие документы он пишет |
| `skills: [id, …]` | скиллы, которые агент получит целиком, без подбора и без лимита ([скиллы](./skills)) |
| `quick: <инструмент>` | сначала пробуется путь без модели, агент работает, только если тот не справился |

## Поля сценария

| Поле | Зачем |
|---|---|
| `name`, `version`, `entry` | имя, версия и первый шаг |
| `kind` | тип задачи по умолчанию |
| `next` | во что продолжается завершённая задача, например `next: sdd` — кнопка «Продолжить в sdd» |
| `deliver: pr` | в конце задача сама пушит ветку и открывает PR. По умолчанию выключено |

## Что рядом, в project.yaml

Поведение шагов настраивается без правки сценария:

```yaml
human:
  gates:
    spec: { required: true }
    implementation: { required: false }   # утверждение кода пройдёт молча, в истории это останется
  checks:
    ask: same-failure          # когда упавшие проверки останавливают задачу:
                               # same-failure — упали так же, как в прошлом круге (по умолчанию)
                               # every-failure — при любом падении
                               # when-rounds-end — только когда кончились круги
agents:
  research:       { limits: { maxToolCalls: 80, maxModelCalls: 100 }, onLimit: ask }
  implementation: { reasoningEffort: low }
budget:
  perRun:  { outputTokens: 200000 }
  perStep: { outputTokens: 40000 }
delivery:
  pr: approve                  # allow — без подтверждения (по умолчанию), approve — сначала вы, deny — нельзя
```

- `agents.<id>.limits` — сколько раз за шаг агент может вызвать инструменты и модель.
- `onLimit: ask` — на лимите задача спрашивает, добавить ли ещё вызовов, а не отдаёт полусделанное. Во встроенных
  сценариях так у реализации и у спецификации в `fix`. Спецификация в `spec` и `sdd` на лимите дописывает документ
  из того, что есть, с пометкой «неполный»: код к этому моменту уже прочитали исследование и анализ требований.
- `reasoningEffort` — сколько модель думает: `low`, `medium`, `high`.
- `human.autonomous: true` — все задачи проекта автономные (experimental); подробно на странице
  [где решает человек](../guide/human).
- Свои инструкции агенту — `.jarvis/agents/<id>.md`, подробно на странице
  [как промпт настраивает агента](../agents/prompts).

## Чего агенты не делают

Ни один агент не пишет во внешние системы: не оставляет комментарии, не пушит, не открывает PR. Это делают шаги без
модели через журнал действий. Если процесс упал посреди такого действия, Jarvis не повторит его вслепую, а спросит
вас, произошло ли оно.
