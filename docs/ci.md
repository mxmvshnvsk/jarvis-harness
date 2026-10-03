# CI-режим и перенос run (ADR-0009)

Тот же workflow в пайплайне: без терминала, без записи в checkout, с человеческим гейтом, который
переносится к человеку, а не блокирует job.

## `jarvis ci <task>`

Эквивалент `jarvis work` под профилем `ci` (`--profile <name>` меняет; профиль из `profiles:` только
сужает): `interactive: false`, `workspace: { mode: cwd, allowWrites: false }`, `humanGate: artifact`,
`mcp.deny: ["*.comment", "*.transition"]` по умолчанию из шаблона `jarvis init`.

Результат job:

| Ситуация | Код | Что остаётся |
|---|---|---|
| workflow дошёл до `DONE` | 0 | артефакты в БД runner'а, сводка |
| run дошёл до гейта | 10 | markdown-сводка (шаги, ожидающие утверждения артефакты) в `--summary` / `$GITHUB_STEP_SUMMARY` / `$JARVIS_CI_SUMMARY`; `~/.jarvis/runs/<run>/approval-request.json` и `summary.md`; с `--bundle <file>` — бандл run |
| исчерпан бюджет | 11 | то же, `resumeAfter` в сводке |
| `humanGate: fail` и гейт достигнут, UNSUPPORTED стек, запрет политики | 12 | причина `policy: …` |
| ошибка | 1 | |

Пример GitHub Actions:

```yaml
- run: pnpm install --frozen-lockfile && pnpm build
- run: echo "$CORP_LLM_TOKEN" | node bin/jarvis.js auth set corp-llm
  env: { CORP_LLM_TOKEN: ${{ secrets.CORP_LLM_TOKEN }}, JARVIS_KEYCHAIN_BACKEND: file }
- run: node bin/jarvis.js ci "${{ github.event.issue.title }}" --bundle run.jarvis.json.gz
  continue-on-error: true
  id: jarvis
- uses: actions/upload-artifact@v4
  if: steps.jarvis.outcome == 'failure'
  with: { name: jarvis-run, path: run.jarvis.json.gz }
```

Сводка попадает в job summary; бандл — в артефакт job; выход 10 — сигнал «нужен человек».

## Перенос run: `export` / `import`

```sh
jarvis export <run> --out run.jarvis.json.gz
jarvis import run.jarvis.json.gz
```

Один gzipped JSON: строка run, шаги и checkpoints, артефакты с блобами, approvals, эффекты, треды с
сообщениями, события, usage и патч workspace относительно базового коммита. `import` на другой
машине воссоздаёт run с теми же id (дубликат отклоняется), worktree от базового коммита с наложенным
патчем — и дальше обычные `jarvis status | approve | attach | resume`.

## Закоммиченные утверждения

Чтобы CI не останавливался на гейте, который человек уже прошёл локально:

```sh
jarvis approve <run> --commit          # пишет и коммитит .jarvis/approvals/<task>/<type>.json
```

Файл хранит `artifactId`, `version`, `contentRef` (хеш содержимого) и решение. Профиль с
`humanGate: skip-if-approved` проходит гейт, если контент артефакта совпадает с утверждённым
(`approval.committed`); иначе ведёт себя как `artifact`. Изменившаяся спецификация — новый хеш — снова
требует человека.

## Что CI не делает

- Не пишет в checkout (`allowWrites: false`); результат — артефакты и патч в бандле, применяемые
  человеком через `jarvis import` + `jarvis apply`.
- Не выполняет эффекты, запрещённые профилем (`*.comment`, `*.transition`); разрешённые —
  журналируются и проверяются как обычно.
- Не хранит секреты в конфигурации: `env:VAR` или `keychain:` с `JARVIS_KEYCHAIN_BACKEND=file`.
