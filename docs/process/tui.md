# Терминальный интерфейс: что брать у хороших CLI

Обзор паттернов терминальных интерфейсов для долгой агентной работы с человеком в контуре и план улучшений
Jarvis. Источники — в конце; что из них взято и что уже сделано, отмечено.

## Принципы

1. **Тишина выглядит как поломка.** Что-то видимое — меньше чем через 100 мс, перед долгим вызовом сказать,
   что он начинается; пятиминутный вызов модели не должен быть пустым экраном (clig.dev).
2. **Вывод остаётся в scrollback.** Основной режим — дописывание строк и маленькая перерисовываемая
   область внизу; полноэкранный режим (alternate screen) теряет историю, ломает поиск и выделение, плохо
   живёт в tmux. Полноэкранным может быть только отдельный наблюдатель (Codex: `alternate_screen = never`,
   Claude Code: полноэкранный рендер по выбору).
3. **Цвет — со смыслом, но не единственный носитель.** 16 ANSI-цветов (тема пользователя), рядом — символ
   или слово (✓/✗/⏸, «failed»); `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, не-TTY (gh, Heroku).
4. **Сначала итог, детали по запросу:** итоговая строка и путь к подробностям, полный лог — отдельной
   командой (Turborepo `--output-logs`, BuildKit, terraform `Plan: 1 to add…`).
5. **Всегда следующий шаг** — готовая команда в конце вывода (`git status`, terraform).
6. **Внимание человека дорого:** звать только когда без него стоит работа — гейт, конец, ошибка; не за
   каждую мелочь (Codex: `notification_condition = unfocused`).
7. **У каждого интерактивного действия — неинтерактивный эквивалент;** без TTY — явная ошибка, а не
   зависание (`--no-input`, `GH_PROMPT_DISABLED`).
8. **Падение не ломает состояние:** Ctrl-C быстро и с подсказкой, как продолжить; второй Ctrl-C — сразу.
9. **Доступность — отдельный режим:** без анимации, нумерованные меню, текстовые метки строк (Claude Code
   screen reader mode, gh accessible prompter).

## Что у Jarvis уже есть

- заголовок прогона с планом, строка на каждый завершённый шаг (`[k/N]`, время, агент, вызовы, токены,
  инструменты из лимита, повторы), возвраты по рёбрам, итог с командами `next` — принципы 1, 4, 5;
- одна живая строка: время, шаг, ожидание модели, бюджет инструментов полосой, последний инструмент;
  со стримингом — `thinking ~3k tok` / `receiving ~1.2k tok`;
- палитра со смыслом, `--color/--no-color`, `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, без цвета вне TTY;
- решения на месте (`enter/a/c/q`, открытые вопросы по одному), `jarvis continue` без id; флаги
  `approve/answer` и выход 10 — для скриптов и CI; `JARVIS_INTERACTIVE=off`;
- Ctrl-C отдаёт аренду сразу и пишет, как продолжить; модель недоступна — прогон ждёт с отсчётом;
- **сделано в этой пачке:** заголовок вкладки по ходу прогона и уведомления (OSC 9 / BEL, через tmux) на
  гейте, в конце и при падении (`src/cli/notify.ts`).

## План

Сложность: S — до дня, M — 2–4 дня, L — неделя и больше.

| # | Что | Откуда | Польза | |
|---|---|---|---|---|
| 1 | **Прогресс во вкладке** OSC 9;4: доля шагов `k/N`, «неопределённо» во время вызова модели, «внимание» на гейте, «ошибка» при падении | Windows Terminal, Claude Code, ConEmu | состояние видно на панели задач и во вкладке, не переключаясь | S |
| 2 | **Ссылки OSC 8** на артефакты и файлы в итоге, `show` и строках шагов (`spec.json` кликабелен) | gh, Claude Code | открыть документ одним кликом; без поддержки — просто текст | S |
| 3 | **Гейт: `$PAGER` и `$EDITOR`.** `enter` открывает документ в `less -R`, `e` — комментарий в `$EDITOR` по шаблону с вопросами и закомментированным контекстом, `?` — справка по клавишам; Enter никогда не означает «принять» (уже так) | `git commit`, `git add -p`, gum `write` | длинные документы и комментарии без мучений с одной строкой ввода | M |
| 4 | **Карточка гейта сначала-итог:** к краткому виду добавить затронутые файлы и diffstat (для approve-impl), риски, ссылку OSC 8 на полный документ | terraform plan, Gemini CLI | решение быстрее и осознаннее, меньше «accept не читая» | S–M |
| 5 | **Живая область из 2–3 строк** вместо одной: шаг и ожидание; хвост из двух последних событий (инструмент, повтор); бюджет и токены. Перерисовка внутри synchronized output (DEC 2026), обрезка по ширине с учётом широких символов, пересчёт по `SIGWINCH` | Docker BuildKit, Claude Code | видно, чем занят агент, без мерцания; ничего не ломается в узкой панели | M |
| 6 | **Гистограмма инструментов в строке шага:** `read×12 search×4 edit×2 (18/40)` вместо одного числа; `-v` — хвост событий вживую | Claude Code (свёрнутые tool calls) | по одной строке понятно, что агент делал | S |
| 7 | **Режимы вывода** `--progress=auto|tty|plain|json`: plain — строки с временем и пульс раз в 30 с (CI, nohup), json — поток событий JSONL | BuildKit `--progress`, Turborepo `--log-order` | читаемые логи в CI, интеграции и дашборды поверх событий | M |
| 8 | **Ctrl-C в две ступени:** первое — отменить текущий вызов модели, сохранить чекпоинт, напечатать команду; второе — выйти сразу | clig.dev | прерывать не страшно и не дорого | M |
| 9 | **Анатомия ошибки:** `error[J0xx]: что случилось`, контекст (шаг, агент, вызов), `help:` с исправлением, путь к логу; `jarvis explain J0xx` | rustc/cargo | меньше «что теперь делать?» | S–M |
| 10 | **Доступный режим** `JARVIS_ACCESSIBLE=1`: без спиннера и перерисовок, метки `step:`/`gate:`/`error:`, нумерованные меню, звонок на гейте; заодно — для `script(1)` | Claude Code, gh | скринридеры, записи сессий | S–M |
| 11 | **Маркеры OSC 133** на начале шага и гейта: переход между ними клавишей «предыдущий промпт» | iTerm2, VS Code, Windows Terminal | навигация по длинному прогону в scrollback | S |
| 12 | **Снимки вывода в тестах** для TTY/не-TTY, `NO_COLOR`, ширины 60/120; ASCII-замены символов без UTF-8 | — | регрессии вывода ловятся тестами | S–M |
| 13 | **`jarvis attach <run>` и `logs -f`**: подключиться к прогону, который идёт в другом терминале или демоне; в `status --watch` ждущие человека — сверху | gh run watch, k9s | несколько прогонов параллельно | M–L |

Порядок: сначала 1, 2, 6, 4 (по дню, сразу видно), затем 3 и 5 (главное в ежедневной работе), потом 7–9,
остальное по мере надобности.

**Реализация.** Остаёмся на своём ANSI-рендерере, без Ink (≈620 КБ и React) и blessed (не поддерживается):
`src/cli/output.ts` + `src/cli/notify.ts` уже покрывают основу. Добавить небольшие модули: живая область
(N строк, synchronized output, ширина, `SIGWINCH`), OSC-последовательности (заголовок, уведомления, 9;4, 8,
133 — с отключением переменной), однобуквенные меню через `readline`. Если понадобится многострочный ввод
без `$EDITOR` — `@clack/prompts` (≈94 КБ, меню по клавишам, `multiline`), но `$EDITOR` проще и привычнее.

## Источники

- Command Line Interface Guidelines — https://clig.dev/
- Heroku CLI Style Guide — https://devcenter.heroku.com/articles/cli-style-guide
- GitHub CLI, переменные окружения — https://cli.github.com/manual/gh_help_environment
- GitHub Blog, Building a more accessible GitHub CLI — https://github.blog/engineering/user-experience/building-a-more-accessible-github-cli/
- Claude Code: терминал и уведомления — https://code.claude.com/docs/en/terminal-config; полноэкранный режим —
  https://code.claude.com/docs/en/fullscreen; доступность — https://code.claude.com/docs/en/accessibility
- Aider, уведомления — https://aider.chat/docs/usage/notifications.html
- Docker `buildx build --progress` — https://docs.docker.com/reference/cli/docker/buildx/build/
- Turborepo `run` (`--ui`, `--log-order`, `--output-logs`) — https://turborepo.dev/docs/reference/run
- Terraform `plan` / `apply` — https://developer.hashicorp.com/terraform/cli/commands/plan
- rustc, диагностика — https://rustc-dev-guide.rust-lang.org/diagnostics.html
- Charm: gum, huh, Lip Gloss — https://github.com/charmbracelet/gum, https://github.com/charmbracelet/huh,
  https://github.com/charmbracelet/lipgloss
- OSC 8, гиперссылки — https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda
- OSC 9;4, прогресс — https://learn.microsoft.com/en-us/windows/terminal/tutorials/progress-bar-sequences
- iTerm2 escape-коды (OSC 9, 1337) — https://iterm2.com/documentation-escape-codes.html
- kitty, уведомления (OSC 99) — https://sw.kovidgoyal.net/kitty/desktop-notifications/
- Synchronized output (DEC 2026) — https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036
- NO_COLOR — https://no-color.org/; FORCE_COLOR — https://force-color.org/
- @clack/prompts — https://github.com/bombshell-dev/clack; Ink — https://github.com/vadimdemedes/ink
