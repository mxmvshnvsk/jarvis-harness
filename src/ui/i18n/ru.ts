/**
 * The page in Russian, written by hand against the glossary (docs/i18n.md): what people say in English
 * at work stays English — run, step, workflow, spec, checkout, commit, branch, PR, deploy, release,
 * review, onboard, the names of steps and workflows, commands. Buttons are verbs in the infinitive,
 * the person is «вы». A key is the English string with its `{placeholders}`; a string missing here
 * stays English.
 */
export const RU: Readonly<Record<string, string>> = {
  // ---- top bar
  "Skip to content": "К содержимому",
  "just now": "только что",
  Pages: "Разделы",
  Knowledge: "База знаний",
  Runs: "Прогоны",
  Services: "Сервисы",
  "New task": "Новая задача",
  "New task (N)": "Новая задача (N)",
  "MCP: checking the servers…": "MCP: проверяем серверы…",
  "MCP servers": "Серверы MCP",
  "Models: collecting the stats…": "Модели: собираем статистику…",
  Models: "Модели",
  "connecting…": "подключение…",
  "System notifications when a run waits for you": "Уведомления системы, когда run ждёт вас",
  "Switch the theme": "Сменить тему",
  Back: "Назад",
  Actions: "Действия",

  // ---- Runs
  "{n} today": "сегодня: {n}",
  "{calls} today": "{calls} сегодня",
  "Waits for you": "Ждёт вас",
  "Nothing waits for you.": "Ничего не ждёт вас.",
  Running: "Идут сейчас",
  "Nothing runs now.": "Сейчас ничего не идёт.",
  Recent: "Недавние",
  "Search runs: id, task, state…": "Поиск: id, задача, состояние…",
  "Search runs": "Поиск по прогонам",
  "Every word in some field: id, task, workflow, state and its reason, author, repository, branch, step, date; a quoted phrase as a whole":
    "Каждое слово — в каком-нибудь поле: id, задача, workflow, состояние и его причина, автор, репозиторий, branch, step, дата; фраза в кавычках — целиком",
  Search: "Найти",
  "Rows per page": "Строк на странице",
  "Recent runs, pages": "Недавние прогоны, страницы",
  "← Newer": "← Новее",
  "Older →": "Старше →",
  "{from}–{to} of {total}": "{from}–{to} из {total}",
  "{n} found": "найдено: {n}",
  Task: "Задача",
  State: "Состояние",
  Took: "Заняло",
  Model: "Модель",
  "a subtask of a task across services": "подзадача задачи на несколько сервисов",
  "subtask {key} of": "подзадача {key} из",
  "No runs match «{q}».": "Нет прогонов по запросу «{q}».",
  "No runs yet.": "Прогонов пока нет.",
  interrupted: "прерван",
  "waits for the model": "ждёт модель",
  "waits for quota": "ждёт квоту",
  "waits for the model {model}": "ждёт модель {model}",
  "waits for the quota window": "ждёт окно квоты",
  "waits for the quota window of {pool}": "ждёт окно квоты {pool}",
  "goes on {when}": "продолжит {when}",
  Open: "Открыть",
  Follow: "Следить",
  "cancelling…": "отменяется…",
  "plan {at}": "план {at}",
  "ended without a run": "закончился без прогона",
  "failed to start (exit {code})": "не запустился (код {code})",
  log: "лог",
  starting: "запуск",
  "preparing the checkout (a workspace setup can take minutes)":
    "готовим checkout (настройка рабочей копии может занять минуты)",

  // ---- what waits
  "waiting {ago}": "ждёт {ago}",
  "a terminal waits": "ждёт терминал",
  "tests failed": "упали тесты",
  "loop used up": "круги кончились",
  "{step} sent the work back {times}": "{step} вернул работу {times}",
  "{step} sent the work back too often": "{step} слишком часто возвращал работу",
  "+{n} more": "и ещё {n}",
  budget: "бюджет",
  "{step} stopped at {used} of {cap} {unit}": "{step} остановился на {used} из {cap} {unit}",
  approval: "одобрение",
  "the terminal goes on": "терминал продолжит",
  "nothing goes on with it yet": "пока никто не продолжает",
  "the run waits for": "run ждёт",
  "Review the {type}": "Проверить {type}",
  clarification: "уточнение",
  "Jarvis proposes a rule — accept it or answer on":
    "Jarvis предлагает правило — примите его или ответьте дальше",
  Answer: "Ответить",
  "spans services": "задевает другие сервисы",
  "The impact reaches other services: on as a task across services, or only {service}":
    "Изменение задевает другие сервисы: продолжить задачей на несколько сервисов или только в {service}",
  Decide: "Решить",
  "Answer in the terminal:": "Ответьте в терминале:",
  "Open the run": "Открыть прогон",
  "Open in editor": "Открыть в редакторе",
  accepted: "принято",
  rejected: "отклонено",
  "sent back": "возвращено на доработку",
  "by {who}": "— {who}",
  "in the browser": "в браузере",
  "in the terminal": "в терминале",
  "knowledge · module": "знания · модуль",
  "Review what the research found:": "Проверьте, что нашёл research:",
  "{kept} of {proposed} claims confirmed against the code":
    "{kept} из {proposed} утверждений подтверждены кодом",
  "A module document": "Документ модуля",
  "{n} to check": "{n} на проверку",
  "Nothing is written until you accept it.": "Пока вы не примете, ничего не записывается.",
  "Review the module": "Проверить модуль",
  "A terminal waits at this card: what you decide there shows here, and the other way round.":
    "Эту карточку ждёт и терминал: что решите там, появится здесь, и наоборот.",
  "runs {step} again": "запускает {step} снова",
  more: "добавить",
  finish: "закончить",
  "Decide in the terminal:": "Решите в терминале:",
  "Copy command": "Скопировать команду",

  // ---- after a decision
  Resume: "Продолжить",
  "The terminal waiting at the card goes on with it.":
    "Терминал, который ждёт на карточке, продолжит с этим решением.",
  "It did not go on by itself": "Само не продолжилось",
  "No terminal waits at this run": "Этот run не ждёт ни один терминал",
  "Resume goes on in the background, or": "«Продолжить» — в фоне, или",
  "in a terminal": "в терминале",
  "It goes on in the background.": "Продолжается в фоне.",
  "No terminal waits at this run: it goes on with":
    "Этот run не ждёт ни один терминал: продолжить можно командой",

  // ---- steps
  "no model call": "без вызова модели",
  "per call": "за вызов",
  "{n} in the requirements": "{n} в требованиях",
  "model call limit reached": "кончился лимит вызовов модели",
  "budget limit reached": "кончился бюджет",
  "tool limit reached": "кончился лимит инструментов",
  skipped: "пропущен",
  "done in {workflow} {id}": "сделано в {workflow} {id}",
  "sent the work back to {to}": "вернул работу в {to}",
  "paused · waits for the quota window": "пауза · ждёт окно квоты",
  "waits for you": "ждёт вас",
  "running now": "идёт сейчас",
  "stopped before it finished": "остановлен, не закончив",
  Steps: "Шаги",

  // ---- a used-up loop
  "no rounds left": "кругов больше нет",
  "the last round's reasons:": "причины последнего круга:",
  "No reason recorded.": "Причина не записана.",
  "Fix it by hand in the run's checkout": "Исправьте руками в checkout прогона",
  "Copy path": "Скопировать путь",
  "Changed in the checkout · live": "Изменено в checkout · обновляется",
  "nothing yet": "пока ничего",
  "one more round of {step}, then {next}": "ещё один круг {step}, потом {next}",
  "{step} runs again": "{step} запускается снова",
  asked: "попросили",
  "from the page": "со страницы",
  "One more round of {step}": "Ещё один круг {step}",
  "Run {step} again": "Запустить {step} снова",
  "one more round: {back} with the reasons above and your notes, then {step}; run again: only {step}, after you fixed the checkout yourself":
    "ещё один круг: {back} с причинами выше и вашими заметками, потом {step}; запустить снова — только {step}, когда вы сами поправили checkout",
  "same as": "то же, что",
  "on the terminal's card": "на карточке в терминале",
  "the terminal waiting there goes on": "терминал, который там ждёт, продолжит",
  "no terminal waits:": "терминал не ждёт:",
  "does it": "сделает это",

  // ---- failed tests
  "Tests failed again the same way": "Тесты снова упали так же",
  "The tests did not run": "Тесты не запустились",
  "Tests failed": "Тесты упали",
  "Tests still fail — no rounds left": "Тесты всё ещё падают — кругов больше нет",
  "round {n} of {m}": "круг {n} из {m}",
  "Round {n} failed exactly as round {m}: the same test with the same assertion.":
    "Круг {n} упал ровно так же, как круг {m}: тот же тест, та же проверка.",
  "Round {n} failed exactly as round {m}: the same {failures}.":
    "Круг {n} упал ровно так же, как круг {m}: те же {failures}.",
  "Another round with the same input is unlikely to help, so Jarvis asks you before spending it":
    "Ещё один круг с теми же данными вряд ли поможет, поэтому Jarvis спрашивает вас, прежде чем его тратить",
  "{checks} stopped before any test ran: the build or the environment broke, not a test. The output below says where; a model rarely fixes that by trying again.":
    "{checks} остановились до первого теста: сломалась сборка или окружение, а не тест. Где именно — в выводе ниже; повторная попытка модели такое исправляет редко.",
  "The project asks a person on every failed check": "В проекте человек решает при каждой упавшей проверке",
  "decide what {back} does with it.": "решите, что с этим делать {back}.",
  "{back} had {rounds} and the checks still fail. Decide what happens next.":
    "У {back} было {rounds}, а проверки всё ещё падают. Решите, что дальше.",
  "Round {n}": "Круг {n}",
  "Round {n} of {m}": "Круг {n} из {m}",
  "no test ran": "тесты не запустились",
  "{n} failed": "упало: {n}",
  passed: "прошли",
  "the same as round {n}": "так же, как в круге {n}",
  "this round": "этот круг",
  "same as round {n}": "как в круге {n}",
  Failure: "Падение",
  Expected: "Ожидалось",
  Got: "Получено",
  "What to do": "Что делать",
  "Send back with a hint": "Вернуть с подсказкой",
  "{back} gets your words as binding, with these failures and the whole output.":
    "{back} получит ваш комментарий как обязательный — вместе с этими падениями и всем выводом.",
  "Send back to {back}": "Вернуть в {back}",
  "The test is wrong — let it change the test": "Ошибка в тесте — пусть поправит тест",
  "{back} changes the test, not the code, and says which and why; review sees it.":
    "{back} меняет тест, а не код, и пишет, какой и почему; это видно на review.",
  "Send back: change the test": "Вернуть: поправить тест",
  "I fix it myself in the checkout": "Исправлю сам в checkout",
  "Then the checks run again — not another round of {back}.":
    "Потом проверки запустятся снова — без нового круга {back}.",
  "Not this task's — go on without it": "Не про эту задачу — идти дальше",
  "{step} counts as passed; the failures stay recorded and the next steps get your words.":
    "{step} считается пройденным; падения записаны, а следующие шаги получат ваш комментарий.",
  "Go on without it": "Идти дальше без этого",
  "Back to the spec": "Назад к спеке",
  "The task is not what the spec says: the spec gets your words and comes to you again.":
    "Задача не та, что в спеке: спека получит ваш комментарий и снова придёт к вам.",
  "Your words — needed for a hint; for the others, why":
    "Ваш комментарий — нужен для подсказки, для остального — почему",
  "«The value comes rounded from {file} — round once, at the end»":
    "«Значение приходит уже округлённым из {file} — округлять один раз, в конце»",
  "A hint, a decision, where to look": "Подсказка, решение, куда посмотреть",
  "{n} more in": "ещё {n} — в",
  "the checks of this round": "проверках этого круга",
  "{step}, end of its last round": "{step}, конец последнего круга",
  "Whole output of {check}": "Весь вывод {check}",
  "The checks of round {n}": "Проверки круга {n}",
  "Copy to run it yourself": "Скопировать, чтобы запустить самому",
  "goes on without the failed checks": "идёт дальше без упавших проверок",
  decided: "решено",
  "The run's checkout": "Checkout прогона",

  // ---- budget
  "{step} finishes with what it has": "{step} закончит с тем, что есть",
  "{step} stopped: {used} of {cap} {unit}": "{step} остановился: {used} из {cap} {unit}",
  "its conversation is kept: more calls go on from where it stopped":
    "разговор агента сохранён: новые вызовы продолжат с того же места",
  "the step goes on from its last model call; the cap grows for this run only":
    "шаг продолжит с последнего вызова модели; лимит вырастет только для этого прогона",
  "Changed in the checkout so far": "Уже изменено в checkout",
  "+{n} {unit} and go on": "+{n} {unit} и продолжить",
  "How many more {unit}": "Сколько ещё {unit}",
  "another amount": "другое число",
  Grant: "Добавить",
  "Finish with what it has": "Закончить с тем, что есть",
  "Finish: the step writes its result from what it has, marked incomplete for the steps after it.":
    "«Закончить» — шаг соберёт результат из того, что есть, и пометит его неполным для следующих шагов.",
  "Same as": "То же, что",
  "goes on": "продолжит",

  // ---- a document to approve
  risk: "риск",
  "incomplete: agent {agent} hit its {limit} limit": "неполный: агент {agent} упёрся в лимит {limit}",
  "{n} changed": "изменено: {n}",
  "approve {type}": "одобрить {type}",

  // ---- try it
  "Try it before you decide": "Попробовать до решения",
  Copy: "Скопировать",
  "No start command known: set": "Команда запуска неизвестна: задайте",
  "in .jarvis/project.yaml": "в .jarvis/project.yaml",
  "start command guessed from package.json — set": "команда запуска угадана по package.json — задайте",
  "to be sure": "для надёжности",
  "Go to the run's checkout": "Перейти в checkout прогона",
  "dependencies are there:": "зависимости уже стоят:",
  "ran when the run started": "выполнилось при старте прогона",
  "the run's own copy of the repository": "собственная копия репозитория для этого прогона",
  "Start the project": "Запустить проект",
  "the run changed what the project reads built — rebuild first":
    "прогон поменял то, что проект берёт собранным, — сначала пересоберите",
  "guessed from package.json — set": "угадано по package.json — задайте",
  "in .jarvis/project.yaml to be sure": "в .jarvis/project.yaml для надёжности",
  "from workspace.try in .jarvis/project.yaml": "из workspace.try в .jarvis/project.yaml",
  "no start command known — set": "команда запуска неизвестна — задайте",
  "then open": "затем откройте",
  "Check by hand": "Проверить руками",
  "the spec's acceptance criteria": "критерии приёмки из спеки",
  "Copy: cd and start": "Скопировать: cd и запуск",
  "Copy git diff": "Скопировать git diff",
  "Or in your main repository": "Или в основном репозитории",
  "a branch of your own from the run's branch (the run's branch itself is taken by its checkout); your uncommitted changes go along":
    "своя branch от branch прогона (саму branch прогона занимает его checkout); незакоммиченные изменения переедут вместе с вами",
  "Jarvis already ran: tests": "Jarvis уже запускал тесты:",
  "{n} failing": "падают: {n}",
  Accept: "Принять",
  "the branch stays — then": "branch остаётся — затем",
  "on the run's page (or": "на странице прогона (или",
  "lands it on your branch as one commit": "переносит изменения в вашу branch одним commit",
  "Send back": "Вернуть на доработку",
  "Fixed something yourself": "Поправили что-то сами",
  "in the checkout → it goes in as a": "в checkout → это войдёт как",
  "when the run goes on": "когда прогон продолжится",

  // ---- cancel, pause, wait
  "Cancel run…": "Отменить прогон…",
  "Cancel run {id}": "Отменить прогон {id}",
  "Cancel run {id}?": "Отменить прогон {id}?",
  "A process runs it: it stops after its current model or tool call.":
    "Его ведёт процесс: остановится после текущего вызова модели или инструмента.",
  "Nothing runs it now: it is cancelled at once.": "Сейчас его никто не ведёт: отменится сразу.",
  "The checkout and the artifacts stay; it cannot be resumed.":
    "Checkout и артефакты останутся; продолжить его будет нельзя.",
  "Cancel the run": "Отменить прогон",
  "Keep it": "Оставить",
  "Cancelling…": "Отменяется…",
  Pausing: "Ставим на паузу",
  "Pausing…": "Ставим на паузу…",
  "asked by {who}": "попросил {who}",
  "the run stops after its current model or tool call and keeps its place; then Resume goes on from there":
    "run остановится после текущего вызова модели или инструмента и сохранит место; потом «Продолжить» пойдёт с него",
  "Cancelling — the run stops after its current model or tool call (a model call can take a minute or two); then it is CANCELLED, its checkout and artifacts stay":
    "Отменяем — run остановится после текущего вызова модели или инструмента (вызов модели может идти минуту-две); затем он будет отменён, checkout и артефакты останутся",
  Pause: "Пауза",
  "Stops after the current model or tool call, keeps its place; Resume goes on":
    "Остановится после текущего вызова модели или инструмента и сохранит место; «Продолжить» пойдёт дальше",
  "Waits for the model": "Ждёт, пока модель",
  "to answer again": "снова ответит",
  "Waits for the quota window": "Ждёт окно квоты",
  "of pool": "пула",
  "This page resumes it then — keep": "Тогда эта страница его продолжит — держите",
  "open.": "открытым.",
  "No process waits for it: resume it here, or": "Его не ждёт ни один процесс: продолжите здесь или командой",
  "paused, not failed": "пауза, не ошибка",
  "Goes on by itself at": "Продолжится сам в",
  "Window:": "Окно:",
  "Resume now": "Продолжить сейчас",
  "tries at once — if the window is still full, it waits again":
    "попробует сразу — если окно ещё занято, снова будет ждать",

  // ---- now
  Now: "Сейчас",
  "Resume goes on from where it stopped": "«Продолжить» пойдёт с того места, где остановился",
  "stopped with Ctrl-C — it goes on from where it stopped":
    "остановлен через Ctrl-C — продолжит с того же места",
  "no process drives this run (interrupted or crashed)": "этот run никто не ведёт (прерван или упал процесс)",
  "the model failed the run — its work is kept": "модель подвела прогон — сделанное сохранено",
  "Try again": "Попробовать снова",
  "once the model answers again: the step goes on from its last checkpoint; or":
    "когда модель снова ответит: шаг продолжит с последнего checkpoint; или",
  "Once the model answers again:": "Когда модель снова ответит:",
  "goes on in the background, or": "продолжит в фоне, или",
  "Go on with": "Продолжить командой",
  "last:": "последнее:",
  "resumed {at} after {after}": "продолжено в {at} после {after}",
  "{n}× this round": "{n}× в этом круге",
  "the same round goes on from its checkpoint: its conversation, tool calls and plan marks are kept":
    "тот же круг продолжается с checkpoint: разговор, вызовы инструментов и отметки плана сохранены",
  "starting…": "запуск…",
  "model call {n} asked for {tools} · running them": "вызов модели {n} попросил {tools} · выполняем",
  "receiving ~{n} tok": "приходит ~{n} ток.",
  "thinking ~{n} tok": "думает ~{n} ток.",
  "retry {n} after {why}": "повтор {n} после {why}",
  "nothing from the model for": "от модели ничего уже",
  "model call {n}, waiting": "вызов модели {n}, ждём",
  tools: "инструменты",
  "{n} of {m} tool calls used": "использовано {n} из {m} вызовов инструментов",
  "tools per model call": "инструментов за вызов модели",
  "tool calls per model call: independent reads in one turn":
    "вызовов инструментов на вызов модели: независимые чтения за один ход",
  "{n} in parallel": "{n} параллельно",
  "{n} in a row": "{n} подряд",
  "{t} so far": "уже {t}",
  "{n} done": "готово: {n}",
  "the last batch, model call {n}": "последняя пачка, вызов модели {n}",

  // ---- switches
  "Ask me when tests fail": "Спрашивать, если тесты упали",
  "every failed check stops this run for you": "любая упавшая проверка остановит этот run и спросит вас",
  "the project's setting:": "настройка проекта:",
  "asks when a round fails as the one before": "спрашивает, когда круг упал так же, как прошлый",
  "asks on every failure": "спрашивает при любом падении",
  "asks when the rounds are used up": "спрашивает, когда кончились круги",
  "Stop after {step}": "Остановиться после {step}",
  "it pauses when {step} ends": "встанет на паузу, когда закончится {step}",
  "pause when {step} ends, before the next step": "пауза, когда закончится {step}, до следующего шага",
  "for this run": "для этого прогона",

  // ---- a second round, notes, the plan
  "Fixing what {who} sent back at {step}": "Исправляет то, что {who} вернул на {step}",
  "no comment": "без комментария",
  "Fixing {defects} {step} found": "Исправляет {defects}, найденные {step}",
  "Fixing what {step} found": "Исправляет то, что нашёл {step}",
  "the agent gets it as is, binding": "агент получает это как есть, обязательно к исполнению",
  "No comment was given.": "Комментария нет.",
  "A hint for {step}": "Подсказка для {step}",
  "Add a note for {step}": "Заметка для {step}",
  "The agent gets it before its next model call, as binding — and every step after it":
    "Агент получит это перед следующим вызовом модели как обязательное — и все шаги после него тоже",
  "A correction, a decision, a hint: «the slots method serves the courier app too»":
    "Поправка, решение, подсказка: «метод слотов используется и в приложении курьера»",
  "Send to the agent": "Отправить агенту",
  Notes: "Заметки",
  "{n} on its way": "{n} в пути",
  "the agents have them": "агенты их получили",
  "the agent got it": "агент получил",
  "goes with its next model call": "уйдёт со следующим вызовом модели",
  "sent {times}": "отправлено {times}",
  "{n} of {m}": "{n} из {m}",
  "{n} of {m} done": "готово {n} из {m}",
  "Plan {at}": "План {at}",
  "every step of the plan is done; the result comes next": "все пункты плана сделаны, дальше — результат",
  "out of plan order": "не по порядку плана",
  files: "файлы",
  check: "проверка",
  now: "сейчас",
  edit: "правит",
  reading: "читает",
  "{n} of {files} touched": "затронуто {n} из {files}",
  "editing {file}": "правит {file}",

  // ---- activity, time, the run's head
  Activity: "Ход работы",
  "{n} earlier": "ещё раньше: {n}",
  "Nothing yet.": "Пока ничего.",
  Working: "Работа",
  "steps ran, the model answered, tools worked": "шли шаги, отвечала модель, работали инструменты",
  "Waiting for you": "Ждал вас",
  "Waiting on budget and the model": "Ждал бюджет и модель",
  "Waiting for its subtasks": "Ждёт свои сабтаски",
  "waits for its subtasks": "ждёт свои сабтаски",
  "{n} starting": "стартуют: {n}",
  "{n} working": "в работе: {n}",
  "{n} waiting for you": "ждут тебя: {n}",
  "Waits for its subtasks: {done} of {all} done": "Ждёт сабтаски: готово {done} из {all}",
  "It goes on by itself once every subtask is done (or dropped): the contract check, then delivery.":
    "Продолжит сам, когда все сабтаски будут готовы (или убраны): проверка контракта, потом поставка.",
  "The subtasks": "Сабтаски",
  "its subtasks": "сабтаски",
  "they work in their own runs": "они работают в своих прогонах",
  "Paused or stopped": "На паузе или остановлен",
  "started {at}": "начат в {at}",
  "ended {at}": "закончен в {at}",
  "not over yet": "ещё идёт",
  "{d} working": "{d} работы",
  "Time of this run": "Время этого прогона",
  Total: "Всего",
  "From the run's journal, {when}. Working time is what the run cost in time; the rest is where it waited.":
    "По журналу прогона, {when}. Время работы — сколько прогон реально занял; остальное — где он ждал.",
  in: "вход",
  cached: "из кэша",
  out: "выход",
  tok: "ток.",
  "subtask {key} of {of}": "подзадача {key} из {of}",
  of: "из задачи",
  "the contract is the master's": "контракт — у главной задачи",
  Artifacts: "Артефакты",
  "No artifacts yet.": "Артефактов пока нет.",

  // ---- New task
  "How far": "Насколько",
  "Where it runs": "Где запускать",
  "Find a service or repository": "Найти сервис или репозиторий",
  "Nothing found": "Ничего не нашлось",
  Run: "Запустить",
  // the four of New task keep their English names (the team says them so)
  Specification: "Specification",
  Implementation: "Implementation",
  "All services": "Все сервисы",
  "requirements, a spec to approve, impact, plan, code, checks, review":
    "требования, спека на одобрение, анализ влияния, план, код, проверки, review",
  "one spec, a subtask per service, the contract between them, delivery in order":
    "одна спека, подзадача на каждый сервис, контракт между ними, перенос по порядку",
  "up to an approved spec; implement later": "до одобренной спеки; реализовать — потом",
  "one spec for all the services, approved; split later":
    "одна спека на все сервисы, одобренная; разбить — потом",
  "In one service only — pick it in Where": "Только в одном сервисе — выберите его в «Где запускать»",
  "Across services": "Несколько сервисов",
  "One service": "Один сервис",
  "Other repositories with runs": "Другие репозитории с прогонами",
  "knowledge repo": "репозиторий знаний",
  "this repository": "этом репозитории",
  "across services": "по всем сервисам",
  "Reads {key} at the start, with its pages and frames.":
    "В начале прочитает {key} вместе с его страницами и макетами.",
  "ABC-123 — or in words: what to find out, the bug, the change":
    "ABC-123 — или словами: что выяснить, какой баг, какое изменение",
  "More options": "Ещё настройки",
  "Read the Figma frames again": "Заново прочитать макеты из Figma",
  "the design changed at the same link; past Jarvis's one-day cache, each frame is a Figma API call":
    "макет поменялся по той же ссылке; в обход дневного кэша Jarvis каждый фрейм — отдельный запрос к Figma API",
  "Runs in the background, as {cmd} (or the one chosen) would without a terminal; where it needs you, it waits here — decide on the page and it goes on.":
    "Идёт в фоне, как {cmd} (или выбранное), только без терминала; где нужны вы — ждёт здесь: решите на странице, и работа пойдёт дальше.",
  // ---- kind of task
  "Kind of task": "Тип задачи",
  "picked by you": "выбран вами",
  "by the workflow": "по workflow",
  "by the word «{word}»": "по слову «{word}»",
  "by default": "по умолчанию",
  Auto: "Авто",
  "picks the skills and standards written for this kind of work":
    "по нему подбираются скиллы и стандарты для такой работы",
  "new feature": "новая функциональность",
  change: "изменение",
  "bug fix": "исправление бага",
  refactoring: "рефакторинг",
  tests: "тесты",
  docs: "документация",
  "the kind of task the skills and standards were picked by":
    "тип задачи, по которому подобраны скиллы и стандарты",
  "The task names": "В задаче упомянуты",
  and: "и",
  "linked by": "связанные через",
  "If both must change, run it in": "Если менять нужно оба, запускайте в",
  "If they must change, run it in": "Если менять нужно их все, запускайте в",
  // ---- knowledge base: tabs and overview
  Overview: "Обзор",
  Modules: "Модули",
  Documents: "Документы",
  Architecture: "Архитектура",
  Standards: "Стандарты",
  Skills: "Скиллы",
  Glossary: "Глоссарий",
  Ask: "Спросить",
  "what the agents know about this project": "что агенты знают об этом проекте",
  "Not in the context of any recent agent call.": "Не попадал в контекст ни одного недавнего вызова агента.",
  "In the context of {calls} over {runs}": "В контексте {calls} за {runs}",
  "asked for by name {n}×": "запрошен по имени {n}×",
  last: "последний",
  "Would an agent find it?": "Найдёт ли агент?",
  "The same search the agents use: the query widened by the glossary, every step shown.":
    "Тот же поиск, что у агентов: запрос расширяется по глоссарию, каждый шаг виден.",
  Query: "Запрос",
  "widened by the glossary:": "расширен по глоссарию:",
  "no term matched": "ни один термин не подошёл",
  "add a term": "добавить термин",
  "Nothing found — an agent asking this would get no project knowledge.":
    "Ничего не найдено — агент с таким запросом не получит знаний о проекте.",
  "click to read · edit them in your editor": "нажмите, чтобы прочитать · правьте в своём редакторе",
  "Knowledge documents": "Документы базы знаний",
  Document: "Документ",
  "About (paths)": "О чём (пути)",
  Used: "Используется",
  Edited: "Изменён",
  generated: "сгенерирован",
  everywhere: "везде",
  "not committed": "не закоммичен",
  "May be stale": "Возможно, устарел",
  "Nothing points that way.": "Ничего не указывает на устаревание.",
  "{n} under its paths since its last edit": "{n} в его путях с последней правки",
  "{n} generated by jarvis and never taken over by a person":
    "{n}: сгенерированы jarvis, человек их не дорабатывал",
  glossary: "глоссарий",
  "{n} with a problem": "{n} с проблемами",
  "Modules to research": "Модули без описания",
  all: "все",
  "in parts": "по частям",
  "Every module has a document.": "У каждого модуля есть документ.",
  "Architecture and modules": "Архитектура и модули",
  Project: "Проект",
  stale: "устарел",
  gen: "ген.",
  "source · read-only": "источник · только чтение",
  "generated by jarvis": "сгенерирован jarvis",
  "tags:": "теги:",
  "paths:": "пути:",
  "agents:": "агенты:",
  "edited:": "изменён:",
  "How the agents see it": "Как его видят агенты",
  "How the index cuts it": "Как его режет индекс",
  "{n}, one per section; a search finds a unit, not the whole file.":
    "{n}, по одному на раздел; поиск находит фрагмент, а не весь файл.",
  "{n} chars": "{n} симв.",
  "Who reads it": "Кто его читает",
  "every agent": "все агенты",
  "when the task touches": "когда задача затрагивает",
  "in every task": "в каждой задаче",
  "Research the module again on {modules}, or update the document in your editor.":
    "Исследуйте модуль заново в разделе {modules} или обновите документ в редакторе.",
  "No document {path}.": "Документа {path} нет.",
  "Pick a document.": "Выберите документ.",
  // ---- standards
  "Rules the agents follow and the checks enforce. Written in {files} — this page shows them.":
    "Правила, которым следуют агенты и которые проверяют проверки. Лежат в {files}, здесь — только просмотр.",
  "No standards here: {dir} is empty.": "Стандартов нет: {dir} пуст.",
  "checked by": "чем проверяется",
  "review (semantic)": "review (по смыслу)",
  pattern: "шаблон",
  "must not:": "не должно быть:",
  "must:": "должно быть:",
  "{n} lines": "строк: {n}",
  "applies to": "к чему применяется",
  source: "источник",
  "In recent runs": "В недавних прогонах",
  "Checked by review: its findings are in the reviews, not counted here.":
    "Проверяется на review: замечания — в самих review, здесь они не считаются.",
  "No violations in the last runs.": "В последних прогонах нарушений нет.",
  "Pick a standard.": "Выберите стандарт.",
  // ---- skills
  "From documentation/": "Из documentation/",
  "read in place; the id is the file name": "читаются на месте; id — имя файла",
  Yours: "Ваши",
  "Built-in": "Встроенные",
  "ship with jarvis; a project skill with the same id wins":
    "идут с jarvis; скилл проекта с тем же id главнее",
  "How to do one kind of work. An agent call gets the best matching ones in full ({setting}); the rest are listed as available on request.":
    "Как делать определённый вид работы. Вызов агента получает самые подходящие целиком ({setting}), остальные — списком, их можно запросить.",
  overridden: "заменён",
  "overrides built-in": "заменяет встроенный",
  "Replaced by the project skill {id}: agents get that one, this one is not used.":
    "Заменён скиллом проекта {id}: агенты получают его, а этот не используется.",
  "Replaces the built-in skill with the same id.": "Заменяет встроенный скилл с тем же id.",
  "Read in place from the team's documentation — change it there; jarvis copies nothing.":
    "Читается прямо из документации команды — правьте его там, jarvis ничего не копирует.",
  "for agents": "для агентов",
  "task kinds": "типы задач",
  any: "любые",
  paths: "пути",
  stacks: "стеки",
  "needs standards": "нужны стандарты",
  "verified by": "чем проверяется",
  "Did it reach the agent?": "Дошёл ли до агента?",
  "Not used: the project version is picked instead.": "Не используется: вместо него берётся версия проекта.",
  "Pick a skill.": "Выберите скилл.",
  // ---- glossary
  "Add a term": "Добавить термин",
  "goes to {file} as a draft; agents use it from the next run":
    "попадёт в {file} черновиком; агенты начнут его использовать со следующего прогона",
  Term: "Термин",
  Synonyms: "Синонимы",
  "comma-separated, how people say it": "через запятую, как его называют люди",
  Source: "Источник",
  optional: "необязательно",
  "Symbols and modules": "Символы и модули",
  "what it is called in the code": "как это называется в коде",
  Definition: "Определение",
  "one or two sentences, in the project's language": "одно-два предложения, на языке проекта",
  "not in the code": "в коде нет",
  "Check in the code": "Проверить по коду",
  "Add anyway": "Всё равно добавить",
  "Add to the glossary": "Добавить в глоссарий",
  "{n} not found — fix the spelling, or add as it is":
    "не найдено: {n} — исправьте написание или добавьте как есть",
  "Business term → synonyms → code symbols. Every search an agent makes is widened by it; Ask (or {cmd}) answers from it. Existing terms are changed in the file; here you add new ones.":
    "Бизнес-термин → синонимы → символы в коде. По глоссарию расширяется каждый поиск агента, по нему отвечает «Спросить» (или {cmd}). Существующие термины правятся в файле, здесь — только новые.",
  Filter: "Фильтр",
  "Filter terms, synonyms, symbols…": "Термины, синонимы, символы…",
  "All terms": "Все термины",
  "Problems only ({n})": "Только с проблемами ({n})",
  Terms: "Термины",
  "No glossary yet: the first term you add creates {file}.":
    "Глоссария пока нет: первый термин создаст {file}.",
  "Symbols / modules": "Символы / модули",
  "No term matches.": "Подходящих терминов нет.",
  "Where it is used": "Где используется",
  "selected term": "выбранный термин",
  "a query with it also searches for": "запрос с ним ищет ещё и",
  "in the code": "в коде",
  "sources:": "источники:",
  "Pick a term to see what a query with it becomes and where its symbols are.":
    "Выберите термин — будет видно, во что превращается запрос с ним и где в коде его символы.",
  // ---- modules
  "by parts": "по частям",
  "no document": "нет документа",
  "via a doc": "через документ",
  "may be stale": "возможно, устарел",
  "Modules and folders": "Модули и папки",
  "Module / folder": "Модуль / папка",
  Files: "Файлы",
  Path: "Путь",
  "(the team's documentation, read-only)": "(документация команды, только чтение)",
  "— about a wider folder": "— о папке уровнем выше",
  "— generated, nobody took it over": "— сгенерирован, никто его не дорабатывал",
  "from the scan": "по сканированию",
  "{files}, about {lines}": "{files}, около {lines}",
  "knowledge now": "знания сейчас",
  "also applies": "также относятся",
  "— wider documents, not about this folder": "— общие документы, не про эту папку",
  "What matters": "Что важно",
  "optional — goes into the agent's task": "необязательно — попадёт в задачу агента",
  "Agent {agent}, read-only, stays inside {path}: {cost}. One research at a time; the next one waits in the queue.":
    "Агент {agent} только читает и не выходит за {path}: {cost}. Исследования идут по одному, следующее ждёт в очереди.",
  "Start research": "Начать исследование",
  "Research again": "Исследовать заново",
  "Research {path}": "Исследование {path}",
  "Same as {cmd}": "То же, что {cmd}",
  // ---- Modules of a knowledge repository (ADR-0025)
  "no clone": "нет клона",
  "No services in the map.": "В карте нет сервисов.",
  service: "сервис",
  "Runs in {repo} as {cmd}; the candidate goes to {dir}":
    "Запускается в {repo} как {cmd}; кандидат ляжет в {dir}",
  "in the map": "в карте",
  "Its code is not on this machine: the modules come from its repository. Clone it there, and the page shows its tree.":
    "Кода сервиса нет на этой машине, а модули берутся из его репозитория. Склонируйте его туда, и здесь появится дерево.",
  "A clone elsewhere: its path in {key} of {file}.":
    "Если клон лежит в другом месте, укажите путь в {key} файла {file}.",
  "Services of the map and the modules of their code. An agent maps a module in the service's repository; every claim is checked against the code; what survives waits here. Nothing reaches {dir} until you accept it.":
    "Сервисы карты и модули их кода. Агент описывает модуль в репозитории сервиса, каждое утверждение проверяется по коду, прошедшее проверку ждёт здесь. В {dir} ничего не попадёт, пока вы не примете.",
  "optional — the same note for every part": "необязательно — одна заметка для всех частей",
  "Research the picked parts": "Исследовать выбранные части",
  "Check these first": "Сначала проверьте это",
  "— the excerpts show one place, the statement speaks for the whole folder. Tick when you agree.":
    "— цитаты из одного места, а утверждение про всю папку. Отметьте, если согласны.",
  "{file} exists and was written by a person. Replace it with this document, or keep it and write the new one under another name.":
    "{file} уже есть, и его писал человек. Замените его этим документом или оставьте и сохраните новый под другим именем.",
  "{file} exists but jarvis generated it and nobody took it over: Accept replaces it.":
    "{file} уже есть, но его сгенерировал jarvis и никто не дорабатывал: «Принять» его заменит.",
  "or as": "или как",
  "Write under that name": "Сохранить под этим именем",
  "Writes {file} into the working copy; commit it with the drafts below.":
    "Запишет {file} в рабочую копию; закоммитьте его вместе с черновиками ниже.",
  "Note for the next research": "Заметка к следующему исследованию",
  "what was wrong or missing": "что было не так или чего не хватило",
  "Research again with the note": "Исследовать заново с заметкой",
  Discard: "Отбросить",
  "Dropped by the check": "Отсеяно проверкой",
  "Dropped by the check against the code": "Отсеяно проверкой по коду",
  "The document → {file}": "Документ → {file}",
  "What replacing {file} changes": "Что изменится при замене {file}",
  "Starting research is off here (read-only, or {ui} without a launcher). In a terminal: {cmd}":
    "Запуск исследования здесь отключён (только чтение или {ui} без лаунчера). В терминале: {cmd}",
  "Remove from the queue": "Убрать из очереди",
  "Starting — the scan reads the folder, then the agent begins.":
    "Запускается: сначала сканируется папка, потом начинает агент.",
  "The research waits for you (a budget, or the agent asks).":
    "Исследование ждёт вас (бюджет или вопрос агента).",
  "Accepted: {file} is in the working copy — the next run already finds it. Commit it with the drafts below.":
    "Принято: {file} в рабочей копии, следующий прогон его уже найдёт. Закоммитьте его вместе с черновиками ниже.",
  "A candidate waits: {cmd}": "Ждёт кандидат: {cmd}",
  "Knowledge not committed": "Незакоммиченные знания",
  "Commit knowledge": "Закоммитить знания",
  "An agent maps a module or a folder; every claim is checked against the code; what survives waits here. Nothing reaches {dir} until you accept it.":
    "Агент описывает модуль или папку, каждое утверждение сверяется с кодом, и то, что прошло проверку, ждёт здесь. В {dir} ничего не попадёт, пока вы не примете.",
  All: "Все",
  "Need research": "Без описания",
  // ---- services
  "kind ?": "kind ?",
  "not in tools.required": "нет в tools.required",
  "optional:": "необязательные:",
  "Not set, optional: {list}.": "Не заданы, необязательные: {list}.",
  "The map": "Карта",
  "from {file} · services:": "из {file}, раздел services:",
  Service: "Сервис",
  "What it is": "Что это",
  "Checks the agents run": "Проверки, которые запускают агенты",
  "Talks to": "С кем связан",
  "not on this machine": "нет на этой машине",
  "No description yet": "Описания пока нет",
  "→ calls · ← is called by · ⇢ sends to a topic · ⇠ reads one. «What it is» is the first paragraph under the title of the service's {file}.":
    "→ вызывает · ← вызывается · ⇢ пишет в топик · ⇠ читает из топика. «Что это» — первый абзац под заголовком {file} сервиса.",
  "How they connect": "Как они связаны",
  "No links yet: {cmd} writes each service's contracts — what it serves, calls, sends and reads — and the links come from them.":
    "Связей пока нет: {cmd} записывает контракты каждого сервиса — что он отдаёт, вызывает, отправляет и читает, — и связи строятся по ним.",
  "From the contracts catalog. A task that names two linked services is offered as a task across services.":
    "Из каталога контрактов. Задачу, в которой названы два связанных сервиса, предложат сделать задачей на несколько сервисов.",
  Breadcrumb: "Навигация",
  "New task here": "Новая задача здесь",
  "No description yet: the architecture has only the facts {cmd} found. Write what {service} is for in a paragraph under its title, and remove the {marker} marker line so {refresh} keeps it — the agents read it with every task here.":
    "Описания пока нет: в архитектуре только факты, которые нашёл {cmd}. Напишите абзац под заголовком о том, зачем нужен {service}, и уберите строку-маркер {marker}, чтобы {refresh} его не затёр, — агенты читают его в каждой задаче здесь.",
  "No architecture yet: {cmd} writes one from the code; then a paragraph under its title says what {service} is for.":
    "Архитектуры пока нет: {cmd} составит её по коду, а потом абзац под заголовком расскажет, зачем нужен {service}.",
  "Recent tasks here": "Недавние задачи здесь",
  "None yet.": "Пока нет.",
  "Required: {list} ({required}). From {own} over the shared {shared} of {file}.":
    "Обязательные: {list} ({required}). Берутся из {own} поверх общих {shared} из {file}.",
  "published as": "публикуется как",
  "not set — publishes in the map": "не задано — публикации на карте",
  "not set — the services build against the version they have":
    "не задано — сервисы собираются с той версией, что у них есть",
  "{fields} of {key}; {cmd} fills them from the build files.":
    "{fields} из {key}; {cmd} заполняет их по файлам сборки.",
  Contracts: "Контракты",
  "Not read yet: {cmd} writes {file} — what {service} serves, calls, sends and reads.":
    "Ещё не прочитаны: {cmd} записывает {file} — что {service} отдаёт, вызывает, отправляет и читает.",
  Serves: "Отдаёт",
  Calls: "Вызывает",
  Topics: "Топики",
  "None found in the code.": "В коде не найдено.",
  "{path} is not a folder of a module here.": "{path} — не папка модуля в этом проекте.",
  "Pick a module or a folder on the left, or type its path.":
    "Выберите модуль или папку слева либо введите путь.",
  "{n} not committed": "не закоммичено: {n}",
  "to {service}": "в {service}",
  "from {service}": "из {service}",
  shared: "общая",
  "no {checks}": "нет {checks}",
  "{n} to finish": "осталось доделать: {n}",
  "{n} without a required check": "{n} без обязательной проверки",
  "{n} without a description": "{n} без описания",
  "{n} not on this machine": "нет на этой машине: {n}",
  "agents cannot check their changes there": "агенты не могут проверить там свои изменения",
  "not in the map: {repos} — add under services: if it is one":
    "нет на карте: {repos} — если это сервис, добавьте в services:",
  "expected at {path} · {key} in the personal config": "ожидается в {path} · {key} в личном конфиге",
  "{n} described": "описано: {n}",
  "used by {list}": "используют: {list}",
  "uses {list}": "использует {list}",
  "no claim survived the check against the code": "ни одно утверждение не прошло проверку по коду",
  "the run ended {state}": "прогон завершился со статусом «{state}»",
  "No source modules in this repository.": "В этом репозитории нет модулей с исходниками.",
  "{n} here since its last edit": "{n} здесь с последней правки",
  none: "нет",
  "a folder this big may stop at the agent's limit and ask you for more":
    "на такой большой папке агент может упереться в лимит и попросить ещё",
  "usually 30–45 tool calls, 0.5–0.9M input tokens":
    "обычно 30–45 вызовов инструментов, 0,5–0,9 млн входных токенов",
  "usually 20–35 tool calls, 0.3–0.6M input tokens":
    "обычно 20–35 вызовов инструментов, 0,3–0,6 млн входных токенов",
  "e.g. how events are named and where the catalogue lives; skip the legacy adapter":
    "например: как называются события и где лежит каталог; старый адаптер пропустить",
  "Too big for one pass — {files}, about {lines} (one research covers up to {maxFiles} files or {maxLines}k lines well). Pick the parts: they run one after another, each gives its own candidate.":
    "Слишком много для одного прохода — {files}, около {lines} (одно исследование хорошо покрывает до {maxFiles} файлов или {maxLines} тыс. строк). Выберите части: они пойдут друг за другом, и каждая даст своего кандидата.",
  "Parts of {path}": "Части {path}",
  "big itself": "сама большая",
  "Replace it": "Заменить",
  "Accept as a draft": "Принять черновиком",
  "{n} of {m} claims confirmed": "подтверждено {n} из {m} утверждений",
  "dropped: {n}": "отсеяно: {n}",
  "to check: {n}": "проверить: {n}",
  "Asked:": "Просили:",
  "Queued — next. Starts when the research in front of it ends.":
    "В очереди, следующее. Начнётся, когда закончится текущее исследование.",
  "Queued — {n} in line. Starts when the research in front of it ends.":
    "В очереди, {n}-е. Начнётся, когда закончатся исследования перед ним.",
  "Checking every claim against the code (no model)…": "Сверяем каждое утверждение с кодом (без модели)…",
  "The agent maps the folder — read-only.": "Агент разбирает папку — только чтение.",
  "Paused, not failed: the model {model} does not answer.": "Пауза, не ошибка: модель {model} не отвечает.",
  "Paused, not failed: the quota window of pool {pool} is full.":
    "Пауза, не ошибка: окно квоты пула {pool} исчерпано.",
  "Paused, not failed: the quota window is full.": "Пауза, не ошибка: окно квоты исчерпано.",
  "Goes on by itself at {at}.": "Продолжится само в {at}.",
  "The last research found nothing to keep: {reason}.":
    "Последнее исследование не дало ничего стоящего: {reason}.",
  "agents already see them": "агенты их уже видят",
  "Onboard {n}": "Onboard: {n}",
  "Open the description": "Открыть описание",
  "Onboard again": "Onboard заново",
  "{n} in {dir}": "{n} в {dir}",
  "No commands: the agents change {service} without running its tests.":
    "Команд нет: агенты меняют {service}, не запуская его тесты.",
  "Required, no command: {list}.": "Обязательные, но без команды: {list}.",
  "A library": "Библиотека",
  "Libraries it uses": "Какие библиотеки использует",
  "Changes first in a task across services: {list} start once its change is accepted and published.":
    "В задаче на несколько сервисов меняется первой: {list} начнут, когда её изменение примут и опубликуют.",
  "Changes first in a task across services: no service of the map uses it yet.":
    "В задаче на несколько сервисов меняется первой; пока её не использует ни один сервис с карты.",
  "Uses {libs}: in a task that changes it, this service waits for that change.":
    "Использует {libs}: в задаче, которая её меняет, этот сервис ждёт этого изменения.",
  "Uses {libs}: in a task that changes them, this service waits for that change.":
    "Использует {libs}: в задаче, которая их меняет, этот сервис ждёт этого изменения.",
  "+{n} more in {file}": "ещё {n} в {file}",
  "Linked with {list}": "Связан с {list}",
  "the answering run ended {state}": "прогон с ответом завершился со статусом «{state}»",
  "{n} ({from}–{to}) — show": "{n} ({from}–{to}) — показать",
  "changes first in a task across services; who uses it waits for its change":
    "в задаче на несколько сервисов меняется первой; кто её использует, ждёт этого изменения",
  "{a} uses {b}": "{a} использует {b}",
  "{a} calls {b}": "{a} вызывает {b}",
  "{a} sends to {b}": "{a} пишет в {b}",
  // ---- ask
  answered: "есть ответ",
  "general knowledge only": "только общие знания",
  "not in the knowledge": "нет в базе знаний",
  "answering…": "отвечает…",
  "today {at}": "сегодня {at}",
  "by words and the glossary:": "по словам и глоссарию:",
  "— by words": "— по словам",
  Found: "Найдено",
  "Found in the knowledge": "Найдено в базе знаний",
  cited: "процитирован",
  answering: "отвечает",
  "The sources below are what the model reads; the answer comes here, its excerpts checked against them.":
    "Ниже — источники, которые читает модель; ответ появится здесь, а его цитаты сверятся с ними.",
  "No answer document.": "Документа с ответом нет.",
  "The knowledge has no confirmed answer to this question":
    "В базе знаний нет подтверждённого ответа на этот вопрос",
  "the answer's excerpts were not found in their sources": "цитат из ответа нет в их источниках",
  "Not in the knowledge": "Нет в базе знаний",
  "Not from the knowledge — the model's general knowledge": "Не из базы знаний — общие знания модели",
  "{n} found in their sources": "в источниках найдено: {n}",
  "{n} not in the source:": "не нашлось в источнике ({n}):",
  "general knowledge:": "общие знания:",
  "used, labelled": "использованы и помечены",
  "allowed, not used": "разрешены, не понадобились",
  "not allowed": "не разрешены",
  "Ask about this project: where, how, why, who owns it":
    "Спросите о проекте: где, как, почему, кто отвечает",
  "How to answer": "Как отвечать",
  "Sources only": "Только по источникам",
  "General knowledge too": "Можно общими знаниями",
  "when the project has no answer, labelled": "если в проекте ответа нет — с пометкой",
  "The project's knowledge is searched first, without a model; then the model answers from what was found and every excerpt it quotes is checked against its source. A question is a run of its own ({workflow}), in Runs as well.":
    "Сначала поиск по знаниям проекта, без модели; потом модель отвечает по найденному, и каждая её цитата сверяется с источником. Вопрос — отдельный прогон ({workflow}), он есть и в «Прогонах».",
  "Nothing in the knowledge for «{q}». Add a document to {dir} or a term to the glossary.":
    "По запросу «{q}» в базе знаний ничего нет. Добавьте документ в {dir} или термин в глоссарий.",
  "Or ask with General knowledge too for a labelled answer.":
    "Или спросите с «Можно общими знаниями» — ответ будет с пометкой.",
  "Recent questions": "Недавние вопросы",
  "No questions yet.": "Вопросов пока нет.",
  // ---- checks
  "{n} of {m} failed": "упало {n} из {m}",
  "fails on the base commit too": "падает и на базовом коммите",
  "also on the base": "и на базе",
  Where: "Где",
  "changed by this run": "изменено этим прогоном",
  "{n} of the runner and libraries not shown": "скрыто: {n} раннера и библиотек",
  File: "Файл",
  "{n} of {m} tests failed": "упало {n} из {m} тестов",
  "{n} tests failed": "упало тестов: {n}",
  failed: "упала",
  "{n} more failed tests are in the full output.": "Ещё упавших тестов в полном выводе: {n}.",
  "The whole output": "Полный вывод",
  "— what the command printed, every line": "— всё, что напечатала команда, строка в строку",
  "Every check passed.": "Все проверки прошли.",
  "{n} in all": "затронуто {n}",
  "The implementation goes back with these failures as its reasons.":
    "Реализация возвращается на доработку с этими падениями как причиной.",
  "The implementation goes back with their output as its reasons.":
    "Реализация возвращается на доработку с их выводом как причиной.",
  "{n} say what broke, marked · the rest folded":
    "строк о том, что сломалось: {n}, они выделены · остальное свёрнуто",
  "Show every line": "Показать все строки",
  "Copy all": "Скопировать всё",
  // ---- data class banners, restart, start from
  "MCP server {server} goes to the {network} by an exception, reads only: {reason}":
    "MCP-сервер {server} ходит в {network} в порядке исключения, только читает: {reason}",
  "model {model} is a cloud model, allowed by an exception: {reason}":
    "модель {model} облачная, разрешена в порядке исключения: {reason}",
  approved: "одобрено",
  "A failed {workflow} of this task": "Упавший {workflow} этой задачи",
  "A cancelled {workflow} of this task": "Отменённый {workflow} этой задачи",
  "stopped at {step}": "остановился на {step}",
  "can start again from {step}: {kept} go in": "можно перезапустить с {step}: {kept} переносятся",
  "{n} kept": "{n} сохраняются",
  "Start again from {step}": "Перезапустить с {step}",
  "No finished research of {key} in this repository — {workflow} runs from the start.":
    "Законченного research по {key} в этом репозитории нет — {workflow} пойдёт с начала.",
  "No finished research of this task in this repository — {workflow} runs from the start.":
    "Законченного research по этой задаче в этом репозитории нет — {workflow} пойдёт с начала.",
  "no new commits since": "новых коммитов с тех пор нет",
  "{n} since, none touch what it read": "{n} с тех пор, но прочитанное ими не затронуто",
  "can't tell whether the code changed since": "не удалось понять, менялся ли код с тех пор",
  "Start from the {workflow} of {when}": "Продолжить {workflow} от {when}",
  "code changed since: {commits}, {files} it read among them ({list}) — a new research is safer":
    "код с тех пор менялся: {commits}, среди них прочитанные {files} ({list}) — надёжнее новый research",
  "Unchecked: {workflow} runs from the start, with a new research.":
    "Без галочки {workflow} пойдёт с начала, с новым research.",
  "{workflow} begins at {step} with it; the steps it did are not run again.":
    "С ним {workflow} начнётся с {step}; сделанные шаги не повторяются.",
  "Open the {workflow}": "Открыть {workflow}",
  // ---- diff
  new: "новый",
  deleted: "удалён",
  "from {path}": "из {path}",
  "Comment on {path} line {line}": "Комментарий к {path}, строка {line}",
  "Open in the editor": "Открыть в редакторе",
  "Changes in {path}": "Изменения в {path}",
  "{n} more: jarvis diff": "ещё {n}: jarvis diff",
  // ---- the split's start order
  "How the subtasks start": "Как стартуют подзадачи",
  "{libs} is a library of the map ({kind}): it changes first. The services that use it ({uses}) start once its change is accepted and published by {publish}, against the new version.":
    "{libs} — библиотека карты ({kind}): она меняется первой. Сервисы, которые её используют ({uses}), стартуют, когда её изменение примут и опубликуют через {publish}, — уже на новой версии.",
  "{libs} are libraries of the map ({kind}): they change first. The services that use them ({uses}) start once their changes are accepted and published by {publish}, against the new version.":
    "{libs} — библиотеки карты ({kind}): они меняются первыми. Сервисы, которые их используют ({uses}), стартуют, когда их изменения примут и опубликуют через {publish}, — уже на новой версии.",
  "starts after {list} is accepted": "стартует, когда примут {list}",
  "starts at once": "стартует сразу",
  "Started anyway, a service builds against the version it has: «Start now anyway» on the master's page.":
    "Если запустить раньше, сервис соберётся с той версией, что у него есть: «Всё равно запустить» на странице master.",
  // ---- open questions
  "answered from the sources: {n}": "отвечено по источникам: {n}",
  "your call: {n}": "решать вам: {n}",
  "need you: {n}": "нужен человек: {n}",
  "From the sources": "По источникам",
  "The sources don't settle it — your call": "Источники этого не решают — решать вам",
  suggested: "предлагаем",
  "Jarvis's guess — no source confirms it": "Догадка Jarvis — ни один источник её не подтверждает",
  "Only someone else can say: the analyst, legal, another team":
    "Ответить может только кто-то другой: аналитик, юристы, другая команда",
  "My answer": "Свой ответ",
  "Instead of Jarvis's answer…": "Вместо ответа Jarvis…",
  "Your answer…": "Ваш ответ…",
  "Ask the analyst": "Спросить аналитика",
  "Not in scope": "Не в рамках задачи",
  "for the analyst": "к аналитику",
  "out of scope": "вне рамок задачи",
  "Question {n}": "Вопрос {n}",
  "Jarvis prepares answers from the issue, its pages, the design and the research — about a minute":
    "Jarvis готовит ответы по задаче, её страницам, дизайну и research — около минуты",
  "Answer before accepting": "Ответьте перед тем, как принять",
  "Open questions": "Открытые вопросы",
  "Accept: the chosen answers go with this version to every later step. Send back: the next version is written with them. A question left without an answer stays open.":
    "Принять: выбранные ответы идут с этой версией во все следующие шаги. Вернуть: следующая версия будет написана с ними. Вопрос без ответа остаётся открытым.",
  "A note": "Комментарий",
  "Anything else to change": "Что ещё поменять",
  "What the answers above do not cover": "То, чего не покрывают ответы выше",
  "Send back with the answers": "Вернуть с ответами",
  "Accept with the chosen answers": "Принять с выбранными ответами",
  "The terminal waiting there picks the decision up and goes on.":
    "Терминал, который там ждёт, подхватит решение и продолжит.",
  "Same as {a} / {c} on the terminal's card.": "То же, что {a} / {c} на карточке в терминале.",
  // ---- the artifact page
  "awaiting your approval": "ждёт вашего одобрения",
  "agent {id}": "агент {id}",
  "Your decision": "Ваше решение",
  Decision: "Решение",
  "In brief": "Коротко",
  Requirements: "Требования",
  Risks: "Риски",
  "What to change": "Что поменять",
  "for Send back; line comments on the diff go with it":
    "для «Вернуть на доработку»; комментарии к строкам диффа уйдут вместе с ним",
  "No terminal waits: the run goes on with {cmd}.": "Терминал не ждёт: прогон продолжит {cmd}.",
  "Decide in the terminal: {cmd} — {a} accepts, {c} sends back.":
    "Решение — в терминале: {cmd}; {a} принимает, {c} возвращает.",
  Versions: "Версии",
  version: "версия",
  "incomplete: agent {agent} hit its {limit} limit — what it did not cover is unknown":
    "неполное: агент {agent} упёрся в лимит {limit} — что он не охватил, неизвестно",
  Sections: "Разделы",
  Questions: "Вопросы",
  "Try it": "Попробовать",
  Summary: "Итог",
  "Files changed": "Изменённые файлы",
  "No changes against the base.": "Относительно базы изменений нет.",
  "Not found": "Не найдено",
  "Something went wrong": "Что-то пошло не так",
  // ---- models and MCP popovers
  ok: "ok",
  busy: "занят",
  down: "недоступен",
  idle: "простаивает",
  "Models: none configured": "Модели: не настроены",
  "until {at}": "до {at}",
  "unlimited (its pool has no limits)": "без лимитов (у пула их нет)",
  "unlimited hours until {at}": "безлимитные часы до {at}",
  "unlimited hours": "безлимитные часы",
  "unlimited hours from {at}": "безлимитные часы с {at}",
  "failed: {n}": "сбоев: {n}",
  "last at {at}": "последний в {at}",
  "the model": "модель",
  quota: "квота",
  "quota window {n}% used": "окно квоты использовано на {n}%",
  input: "вход",
  "output tok": "выходных ток.",
  requests: "запросов",
  "{n} min window": "окно {n} мин",
  "{n} being answered now": "сейчас в работе: {n}",
  "longest {d}": "самый долгий {d}",
  "last {n} min:": "за последние {n} мин:",
  "last failure {at}": "последний сбой в {at}",
  "waiting:": "ждут:",
  latency: "задержка",
  "first token": "первый токен",
  "streamed: {n}": "потоком: {n}",
  speed: "скорость",
  throughput: "поток",
  "{out} out · {in} in tok/min": "{out} выход · {in} вход ток/мин",
  "in avg {in} (max {inMax}) · out avg {out} (max {outMax})":
    "вход в среднем {in} (макс. {inMax}) · выход в среднем {out} (макс. {outMax})",
  total: "всего",
  "{in} in · {out} out": "{in} вход · {out} выход",
  cache: "кэш",
  "{n}% cached": "{n}% из кэша",
  "prefix reusable p50 {n}%": "переиспользуемый префикс p50 {n}%",
  answers: "ответы",
  "{n} after a retry": "{n} после повтора",
  "{n} cut at maxOutput": "{n} обрезано по maxOutput",
  "at {at}": "на {at}",
  "No models configured — add one to ~/.jarvis/config.yaml.":
    "Модели не настроены — добавьте модель в ~/.jarvis/config.yaml.",
  "In the terminal: {stats} (latency, failures, tokens) · {list} (pools, probes)":
    "В терминале: {stats} (задержки, сбои, токены) · {list} (пулы, проверки)",
  "At once": "Одновременно",
  "no model request now": "запросов к моделям сейчас нет",
  "{n} now": "сейчас {n}",
  "peak today {n} at {at}": "пик сегодня {n} в {at}",
  "waiting {d}": "ждёт {d}",
  "Over every run and process. {max} of a model holds within one run only; nothing caps runs together yet (a pool's {limit}): watch this if the platform starts answering 429.":
    "По всем прогонам и процессам. {max} модели действует только внутри одного прогона, общего ограничения на прогоны пока нет ({limit} пула): следите за этим, если платформа начнёт отвечать 429.",
  "waiting for data": "ждём данные",
  "Collecting the models' stats — each pool's quota window and the last half hour of calls. It shows up here in a moment.":
    "Собираем статистику моделей — окно квоты каждого пула и вызовы за последние полчаса. Через пару секунд она появится здесь.",
  // ---- launch page
  "failed to start · exit {code}": "не запустился · код {code}",
  "started {age} ago": "запущен {age} назад",
  "The task did not become a run. Its output is below; fix the cause and start it again.":
    "Прогон из задачи не получился. Вывод ниже — устраните причину и запустите снова.",
  "Preparing the run's checkout": "Готовим checkout прогона",
  "A worktree of the repository and its workspace setup (installing, building) — for a monorepo that takes a few minutes. This page turns into the run's page by itself as soon as the run begins.":
    "Worktree репозитория и подготовка окружения (установка, сборка) — для монорепо это несколько минут. Как только прогон начнётся, эта страница сама станет его страницей.",
  Output: "Вывод",
  // ---- MCP
  "MCP: no servers configured": "MCP: серверы не настроены",
  "checking now…": "проверяем…",
  "answered {at}": "ответил в {at}",
  "no answer {at}": "не ответил в {at}",
  "{state} by {actor}": "{state}: {actor}",
  error: "ошибка",
  "not checked yet": "ещё не проверялся",
  "denied by policy: {n}": "запрещено политикой: {n}",
  "out of the project's data class by an exception, reads only: {why}":
    "вне класса данных проекта в порядке исключения, только читает: {why}",
  discovered: "обнаружены",
  never: "никогда",
  exposed: "доступны",
  denied: "запрещены",
  unmapped: "не сопоставлены",
  "the server lacks the tool": "у сервера нет такого инструмента",
  "{n} without a profile entry:": "{n} без записи в профиле:",
  "last {n} min": "за {n} мин",
  used: "использование",
  "last failure": "последний сбой",
  "profile {name}": "профиль {name}",
  "no profile": "без профиля",
  "Check now": "Проверить сейчас",
  "No MCP servers — add them under mcp.servers in ~/.jarvis/config.yaml or .jarvis/project.yaml.":
    "MCP-серверов нет — добавьте их в mcp.servers в ~/.jarvis/config.yaml или .jarvis/project.yaml.",
  "In the terminal: {list} (connect and list) · {doctor} (credentials) · {auth} (a token)":
    "В терминале: {list} (подключиться и показать) · {doctor} (доступы) · {auth} (токен)",
  "Reading the MCP servers' state and checking that each answers — the first check of a server started by uvx or npx takes a few seconds.":
    "Читаем состояние MCP-серверов и проверяем, что каждый отвечает. Первая проверка сервера, запущенного через uvx или npx, занимает несколько секунд.",
  // ---- server notices
  "All runs": "Все прогоны",
  "The run's checkout is gone: {path}": "Checkout прогона удалён: {path}",
  "No diff: the checkout is not a git repository here.": "Диффа нет: checkout здесь не git-репозиторий.",
  "your editor": "ваш редактор",
  "opened in {editor} — the page watches the checkout: save there, then run the step again":
    "открыто в {editor} — страница следит за checkout: сохраните там и запустите шаг заново",
  "No editor found — set JARVIS_EDITOR (code, idea, webstorm…) where you start {cmd}":
    "Редактор не найден — задайте JARVIS_EDITOR (code, idea, webstorm…) там, где запускаете {cmd}",
  "The run's checkout is gone": "Checkout прогона удалён",
  "Cannot determine who decides: set JARVIS_ACTOR, actor.id or git config user.email (ADR-0006)":
    "Непонятно, кто принимает решение: задайте JARVIS_ACTOR, actor.id или git config user.email (ADR-0006)",
  "This version was decided meanwhile (in a terminal or another window): yours is not recorded":
    "По этой версии уже решили (в терминале или другом окне) — ваше решение не записано",
  "The run no longer waits for this version: nothing recorded":
    "Прогон больше не ждёт эту версию — ничего не записано",
  "Say what to change — a comment, or comments on lines of the diff":
    "Напишите, что поменять — комментарий или комментарии к строкам диффа",
  "The run no longer waits here: nothing recorded": "Прогон здесь больше не ждёт — ничего не записано",
  "Say how many more — a whole number above zero": "Укажите, сколько ещё — целое число больше нуля",
  "Resumed — it goes on in the background from where it stopped":
    "Продолжен — идёт в фоне с того места, где остановился",
  "Cancelled — nothing runs it any more; its checkout and artifacts stay":
    "Отменён — больше не выполняется; checkout и артефакты остаются",
  "Pause requested — the run stops after its current model or tool call and keeps its place":
    "Пауза запрошена — прогон остановится после текущего вызова модели или инструмента и сохранит место",
  "Nothing runs it now — there is nothing to pause": "Сейчас он не выполняется — ставить на паузу нечего",
  "Cancel requested — the process running it stops at its next safe point (after the current model or tool call)":
    "Отмена запрошена — процесс остановится в ближайшей безопасной точке (после текущего вызова модели или инструмента)",
  "The run has ended already: nothing to cancel": "Прогон уже закончился — отменять нечего",
  "Checkout removed — the files go in the background; the branch stays":
    "Checkout удалён — файлы удаляются в фоне, ветка остаётся",
  "Applied: {n} file(s) as {commit} on the branch checked out in the repository — not pushed":
    "Применено: файлов — {n}, коммит {commit} в текущей ветке репозитория; не запушено",
  "Going on as a task across services: the research and the spec are here — next, the split to approve":
    "Продолжаем как задачу на несколько сервисов: research и спека уже есть, дальше — разбиение на одобрение",
  "Fix a bug runs in one service: pick it in Where — or Implement across services":
    "«Исправить баг» работает в одном сервисе: выберите его в «Где» — или «Реализовать во всех сервисах»",
  "A task across services runs in All services: pick it in Where":
    "Задача на несколько сервисов запускается во «Все сервисы»: выберите это в «Где»",
  "The subtask starts in its service's repository — it shows up here in a moment":
    "Подзадача стартует в репозитории своего сервиса — скоро появится здесь",
  "publish-local runs again in the library's checkout — the services waiting for it start when it passes":
    "publish-local снова запускается в checkout библиотеки — ждущие сервисы стартуют, когда он пройдёт",
  "Dropped from the task; once the others are done the master goes on without it":
    "Убрано из задачи; когда остальные закончат, master продолжит без неё",
  "No such subtask, or its service has no repository on this machine":
    "Такой подзадачи нет, или репозитория её сервиса нет на этой машине",
  "Not applied:": "Не применено:",
  "see jarvis logs": "смотрите jarvis logs",
  "The branch is back — apply it, or remove it again": "Ветка восстановлена — примените её или удалите снова",
  "The branch could not be restored (a branch of that name exists?)":
    "Ветку восстановить не удалось (ветка с таким именем уже есть?)",
  "Checkout and branch removed — the files go in the background":
    "Checkout и ветка удалены — файлы удаляются в фоне",
  "Checkout removed; the branch could not be deleted (checked out somewhere?) — {cmd} it by hand":
    "Checkout удалён, а ветку удалить не удалось (она где-то checkout'нута?) — удалите вручную: {cmd}",
  "The run has not ended: cancel it first, then clean up":
    "Прогон ещё не закончился: сначала отмените его, потом чистите",
  "It is being resumed already": "Его уже продолжают",
  "This page cannot start runs: resume it with {cmd}":
    "Эта страница не умеет запускать прогоны: продолжите через {cmd}",
  "Started — it prepares its checkout and shows up under Running; where it needs you, it waits here":
    "Запущено — готовит checkout и появится в «Идут сейчас»; где понадобитесь вы, будет ждать здесь",
  "Say what to do and pick a workflow": "Напишите, что сделать, и выберите workflow",
  "The note goes to the agent with its next model call — binding, and for every step after it":
    "Заметка уйдёт агенту со следующим вызовом модели — обязательно к исполнению и для всех следующих шагов",
  "Write the note first": "Сначала напишите заметку",
  "The eval case is written: review its case.yaml, then record it once":
    "Eval-кейс записан: проверьте его case.yaml и запишите один раз",
  "{n} knowledge file(s) changed after the run began are not in its overlay":
    "файлов знаний, изменённых после старта прогона, не попало в overlay: {n}",
  "No eval case written — see the log of {cmd} (a run that ended, a repository git can archive)":
    "Eval-кейс не записан — смотрите лог {cmd} (нужен завершённый прогон и репозиторий, который git может заархивировать)",
  "A suite is a short name: lowercase letters, digits and dashes":
    "Suite — короткое имя: строчные буквы, цифры и дефисы",
  "Write the answer first": "Сначала напишите ответ",
  "The rule is recorded — the step goes on with it in the background":
    "Правило записано — шаг продолжается с ним в фоне",
  "Nothing to accept yet: Jarvis has not proposed a rule — answer, or write the rule yourself":
    "Принимать пока нечего: Jarvis не предложил правило — ответьте или напишите правило сами",
  "A hint needs your words: what to look at, what to do":
    "В подсказке нужны ваши слова: куда смотреть, что делать",
  "This run cannot go on: it has not finished, has nowhere to go or went on already":
    "Этот прогон нельзя продолжить: он не закончен, ему некуда идти или его уже продолжили",
  "Not a repository this page knows: start {cmd} in it":
    "Этот репозиторий странице незнаком: запустите в нём {cmd}",
  // ---- an effect whose outcome is unknown (ADR-0002)
  "did it happen?": "получилось ли?",
  "{step} started {capability} and lost track of whether it finished.":
    "{step} начал {capability} и не знает, получилось ли.",
  "Did {capability} happen?": "{capability} — получилось или нет?",
  "The run started it at {at} and lost track of whether it finished; the system cannot be asked. Doing it twice may leave a duplicate — a second comment, a second PR.":
    "Прогон запустил это в {at} и не знает, чем кончилось, а спросить у системы нельзя. Если сделать ещё раз, может появиться дубль — второй комментарий, второй PR.",
  "Look for {marker} where it writes: a comment, a commit trailer, a PR description.":
    "Поищите {marker} там, куда оно пишет: в комментарии, в trailer коммита, в описании PR.",
  "What it was asked": "Что именно запрашивали",
  Note: "Комментарий",
  "optional — for the record": "необязательно — для истории",
  "It is there — go on": "Есть — продолжить",
  "It is not there — do it again": "Нет — сделать ещё раз",
  "In the terminal: {cmd}": "В терминале: {cmd}",
  // ---- untrusted content (ADR-0016)
  "Held until you approve the run's document: {list}.": "Ждёт, пока вы утвердите документ прогона: {list}.",
  "Nothing waits for you now: a PR, a comment or a push will go out only after you approve the run's document at its gate.":
    "Сейчас от вас ничего не нужно: PR, комментарий или push уйдут только после того, как вы утвердите документ прогона на его гейте.",
  "server {name}": "сервер {name}",
  "in {step}": "в {step}",
  "Untrusted content from the internet came in: {where}. Its text went to the agents as data, not instructions.":
    "Пришли недоверенные данные из интернета: {where}. Агенты получили этот текст как данные, а не как инструкции.",
  // ---- a person edits a document as a file (ADR-0005)
  "made from {model}, {tools}": "сделано за {model}, {tools}",
  "edited by a person, {who}": "правка человека, {who}",
  "from @{v}": "из @{v}",
  "Edit it as a file: {file} — the change becomes the next version, yours, before the next step reads it (or {cmd}).":
    "Правьте как файл: {file} — правка станет следующей версией, вашей, до того как её прочитает следующий шаг (или {cmd}).",
  // ---- a conflict with a hand edit (ADR-0019)
  conflict: "конфликт",
  "{step} and a hand edit both changed {files}:":
    "{step} и ручная правка изменили одни и те же файлы ({files}):",
  "decided: {choice}": "решено: {choice}",
  "Keep mine": "Оставить мои",
  "your files stay; the step starts again from them": "ваши файлы остаются, шаг начинается заново с них",
  "Take the run's": "Взять из прогона",
  "the files go back to the run's last commit; yours are kept under refs/jarvis/set-aside":
    "файлы возвращаются к последнему коммиту прогона, ваши сохраняются в refs/jarvis/set-aside",
  "I combined them": "Я объединил сам",
  "you merged both by hand in the checkout: it is taken as it is now, the step goes on":
    "вы свели обе версии вручную в checkout: он берётся как есть, шаг продолжается",
  "Decide in the terminal: {cmd}": "Решите в терминале: {cmd}",
  "{step} had changed a file you then changed by hand":
    "{step} изменил файл, который вы потом поправили вручную",
  "{step} had changed files you then changed by hand":
    "{step} изменил файлы, которые вы потом поправили вручную",
  "Jarvis does not write over a hand edit: say which version goes on.":
    "Jarvis не перезаписывает ручную правку: скажите, с какой версией идти дальше.",
  "{choice} — decided by {who}": "{choice} — решил {who}",
  "Decided — the checkout is as you chose; the step goes on with it":
    "Решено — checkout такой, как вы выбрали, шаг продолжается с ним",
  "Not decided: the checkout could not be changed — see the log of {cmd}":
    "Не решено: checkout не удалось изменить — смотрите лог {cmd}",
  // ---- a step's skills
  "named by the workflow step": "заданы в шаге workflow",
  "picked by {what}": "подобраны по {what}",
  "kind {kind}": "типу {kind}",
  "stack {stacks}": "стеку {stacks}",
  "skills:": "скиллы:",
  "no such skill: {ids}": "нет такого скилла: {ids}",
  "tool schemas {tokens} — {share}% of the input": "схемы инструментов {tokens} — {share}% входа",
  // ---- Agent Skills
  "Agent Skills format, shared with other agents": "Формат Agent Skills, общий с другими агентами",
  "Says nothing about where it applies, so it is never picked by itself: every agent sees it in the list of other skills and reads it when it fits; a workflow step can name it.":
    "Не сказано, где он применим, поэтому сам он не подбирается: каждый агент видит его в списке остальных скиллов и читает, когда тот подходит к работе; шаг workflow может назвать его явно.",
  // ---- ADR-0020 §6
  "standard — a rule to follow": "стандарт — правило, которому следуют",
  "knowledge — what is true about the project": "знание — что верно о проекте",
  "skill improvement — a step to add to a skill": "улучшение скилла — шаг, который добавить в скилл",
  "Propose a candidate": "Предложить кандидата",
  "waits with the ones review proposed: {cmd}": "ждёт вместе с теми, что предложил review: {cmd}",
  Kind: "Вид",
  Skill: "Скилл",
  Title: "Название",
  Text: "Текст",
  Paths: "Пути",
  Evidence: "Где видно",
  "for a skill improvement": "для улучшения скилла",
  "the rule, the knowledge, or the step — as it should be written":
    "правило, знание или шаг — так, как это должно быть записано",
  "optional, comma-separated globs it applies to":
    "необязательно; glob-маски через запятую, к чему относится",
  "optional, comma-separated: path:line, a run, a link":
    "необязательно, через запятую: путь:строка, прогон, ссылка",
  Propose: "Предложить",
  "{n} open besides module maps": "открытых, кроме карт модулей: {n}",
  "Not proposed: {why}": "Не предложено: {why}",
  "pick a kind": "выберите вид",
  // ---- ADR-0012
  "Eval case": "Eval-кейс",
  "eval case": "eval-кейс",
  "Review its {file}, then record the model's answers once; after that the case replays without a model, and {baseline} / {diff} catch a regression.":
    "Проверьте его {file} и один раз запишите ответы модели: дальше кейс проигрывается без модели, а {baseline} / {diff} ловят регресс.",
  "Done and accepted": "Готово и принято",
  "Keep it as an eval case": "Оставить как eval-кейс",
  "Worth keeping: Jarvis learned something on this run.":
    "Стоит оставить: на этом прогоне Jarvis чему-то научился.",
  "Not a case? {cmd}": "Не кейс? {cmd}",
  "It went straight through: nobody sent a document back, no back edge went round, nobody edited the spec. A case from it checks less.":
    "Прогон прошёл напрямую: документы не возвращали, обратные рёбра не срабатывали, спеку никто не правил. Кейс из него проверит меньше.",
  "The task, the repository at the run's base as the fixture, and the gold from what you accepted: the files the implementation changed, the spec's acceptance criteria, your answers to its open questions, the project's test command. Jarvis is then checked against this run whenever its prompts, models or tools change.":
    "Задача, репозиторий на базовом коммите прогона как фикстура и «золото» из того, что вы приняли: файлы, которые изменила реализация, критерии приёмки спеки, ваши ответы на её открытые вопросы, тестовая команда проекта. Потом Jarvis проверяется на этом прогоне при каждом изменении промптов, моделей или инструментов.",
  Suite: "Набор",
  "Make an eval case": "Сделать eval-кейс",
  "same as {cmd}; it lands in {dir} of the repository": "то же, что {cmd}; кейс ляжет в {dir} репозитория",
  "Scheduled evals: suite {suite} did not run — {error}":
    "Evals по расписанию: набор {suite} не прогнался — {error}",
  "Scheduled evals: suite {suite} regressed against its baseline — {what}":
    "Evals по расписанию: набор {suite} просел относительно baseline — {what}",
  "pool {pool}": "пул {pool}",
  "{type} sent back {times}": "{type} возвращали на доработку {times}",
  "back edge {edge} went round {times}": "обратное ребро {edge} сработало {times}",
  "{type} edited by a person (versions {versions})": "{type} правил человек (версии {versions})",
  "Worth keeping as eval cases": "Стоит оставить как eval-кейсы",
  "{n} more: {cmd}": "ещё {n}: {cmd}",
  // ---- ADR-0025
  "contract change": "смена контракта",
  "The subtask asks its master to change the contract; decide on the master's page":
    "Сабтаск просит мастер поменять контракт — решение на странице мастера",
  "Open the master": "Открыть мастер",
  "Waits for the library {service} to change first (subtask {key}); goes on by itself once it is published":
    "Ждёт, пока сначала поменяется библиотека {service} (сабтаск {key}); продолжит сам, когда её опубликуют",
  "The change is in the library {service}, which has no subtask: accepting adds one. It changes first; {asking} waits for its change to be accepted and published, then builds against the new version.":
    "Изменение — в библиотеке {service}, у которой нет сабтаска: принятие добавит его. Она меняется первой; {asking} ждёт, пока её изменение примут и опубликуют, и собирается уже с новой версией.",
  "The change is in {service}, which has no subtask: accepting adds one, delivered before {asking}.":
    "Изменение — в {service}, у которого нет сабтаска: принятие добавит его, поставка — раньше {asking}.",
  "Waits for a library": "Ждёт библиотеку",
  "waits for you · {what}": "ждёт тебя · {what}",
  "paused · {step}": "пауза · {step}",
  "waits for the quota window or the model": "ждёт окна квоты или модели",
  "stopped · {step}": "остановлен · {step}",
  "no process · {step}": "нет процесса · {step}",
  "interrupted or crashed: Retry or resume it": "прерван или упал: Retry или resume",
  "tools {n}/{max}": "инструменты {n}/{max}",
  "the master's own steps": "шаги самого мастера",
  "What the task spent": "Сколько потратила задача",
  "ready to merge": "готов к merge",
  merged: "влит",
  "PR declined": "PR отклонён",
  "PR: not read yet": "PR: ещё не прочитан",
  "not read yet": "ещё не прочитан",
  "the PR's review": "ревью PR",
  "in review": "на ревью",
  "PR tasks open": "открыты задачи в PR",
  "build ✓": "сборка ✓",
  "approvals {a} of {b}": "одобрений {a} из {b}",
  "open threads: {n}": "открытых тредов: {n}",
  "answer the comments": "ответить на комментарии",
  "code review": "код-ревью",
  "not followed": "не отслеживается",
  "merged: {n}": "влито: {n}",
  "ready: {n}": "готово: {n}",
  "with comments: {n}": "с комментариями: {n}",
  "in review: {n}": "на ревью: {n}",
  "the master and its subtasks": "мастер и его сабтаски",
  working: "в работе",
  "model calls": "вызовы модели",
  "{step} left {n} uncovered": "{step}: не покрыто — {n}",
  "its own goal, checked against the spec and the task: more calls go to cover them, with the conversation kept; finish takes the document as it is, marked incomplete":
    "цель шага, сверенная со спекой и задачей: ещё вызовы уйдут на покрытие, разговор сохраняется; «закончить» примет документ как есть, с пометкой «неполный»",
  "incomplete: agent {agent} left {n} uncovered": "неполный: агент {agent} не покрыл пунктов — {n}",
  "Jarvis prepares answers to {n} from the sources — the gate opens after them":
    "Jarvis готовит ответы на {n} по источникам — гейт откроется после них",
  "budget judge: +{n} for {agent} — {why}": "судья бюджета: +{n} для {agent} — {why}",
  "budget judge: no more for {agent} — {why}": "судья бюджета: больше не даёт {agent} — {why}",
  "Looks like the agent goes round: more of the same will not help — finish, or redo the step with a note":
    "Похоже, агент ходит по кругу: ещё ресурсов не помогут — заверши шаг или повтори его с заметкой",
  "Looks like the task needs more than the limit: the agent keeps finding new things":
    "Похоже, задаче нужно больше лимита: агент продолжает находить новое",
  "Hard to tell from the journal: some new work, some repeats":
    "По журналу не понять: есть и новая работа, и повторы",
  "{pct}% of the last {n} calls are new · {repeats} repeats and {rereads} re-reads in {calls} calls of the step":
    "новых — {pct}% из последних {n} вызовов · повторов {repeats}, перечитываний {rereads} на {calls} вызовов шага",
  "Made again:": "Повторялось:",
  "The last calls": "Последние вызовы",
  again: "снова",
  "A separate model is recommended for the budget judge: roles.arbiter.models — the worker's own model judges its own work":
    "Для судьи бюджета лучше отдельная модель: roles.arbiter.models — сейчас модель оценивает собственную работу",
  "judge on the worker's model": "судья на модели исполнителя",
  "The split leaves out tasks of the Story": "Разбиение не покрывает задачи Story",
  "no subtask, while the map has {side} services: {services}":
    "нет сабтаска, хотя в карте есть сервисы стороны {side}: {services}",
  "If it is part of this task, send the split back saying so; if it is not, accept.":
    "Если она часть этой задачи — верни разбиение с этим комментарием; если нет — принимай.",
  "The contract change is the library's: it changes first":
    "Смена контракта — это изменение библиотеки: она меняется первой",
  "The master accepted the change as a change of {service} (subtask {key}). This run goes on by itself once that change is accepted and published, and builds against the new version.":
    "Мастер принял изменение как изменение {service} (сабтаск {key}). Этот прогон продолжится сам, когда то изменение примут и опубликуют, и соберётся с новой версией.",
  "{used} {unit}": "{used} {unit}",
  "{used} of {cap} {unit}": "{used} из {cap} {unit}",
  "Budget, the sum of the subtasks':": "Бюджет — сумма бюджетов сабтасков:",
  "nothing spent yet": "пока ничего не потрачено",
  "no cap: budget.perRun is not set": "без лимита: budget.perRun не задан",
  "the master's own steps: {n} output tokens": "свои шаги мастера: {n} output tokens",
  "The master's budget is spent ({used} of {cap} {unit}): a subtask makes no more model calls — it stops on a budget stop, where more for it grows the sum":
    "Бюджет мастера исчерпан ({used} из {cap} {unit}): сабтаски больше не вызывают модель — каждый встаёт на остановке по бюджету, и добавка ему увеличивает общую сумму",
  "The contract as it will be": "Контракт, каким он станет",
  "Accept: a new version of the split": "Принять — новая версия разбиения",
  "Why it stays (for the subtask)": "Почему остаётся как есть (для сабтаска)",
  "Reject: keep it as agreed": "Отклонить — оставить как договорились",
  "A subtask asks to change the contract": "Сабтаск просит поменять контракт",
  "Only the master changes the contract. Accepted: the split gets a new version, the other subtasks it touches get it as a note, the asking one analyses its impact again. Rejected: it goes on with the contract as agreed.":
    "Контракт меняет только мастер. Если принять, у разбиения появится новая версия, остальные затронутые сабтаски получат её заметкой, а попросивший заново сделает impact. Если отклонить, он продолжит по контракту, о котором договорились.",
  "Agreed: {change}": "Договорились: {change}",
  "Not in the contract yet: accepting adds it": "В контракте этого пока нет — если принять, пункт добавится",
  "Asks for: {change}": "Просит: {change}",
  "Why: {why}": "Почему: {why}",
  "Waits for the master": "Ждёт мастер",
  "This subtask asks to change the contract": "Этот сабтаск просит поменять контракт",
  "Only the master changes the contract: a person accepts or rejects it on the master's page, then this run goes on.":
    "Контракт меняет только мастер: человек принимает или отклоняет просьбу на его странице, после этого прогон идёт дальше.",
  payload: "payload",
  "request body": "тело запроса",
  response: "ответ",
  DTO: "DTO",
  "fields not checked: the type is not seen on both sides": "поля не проверены: тип виден не с обеих сторон",
  same: "без изменений",
  added: "добавлено",
  removed: "удалено",
  renamed: "переименовано",
  "type changed": "другой тип",
  Field: "Поле",
  Change: "Изменение",
  "Writes: {service}": "Пишет: {service}",
  "Reads: {service}": "Читает: {service}",
  Holds: "Сходится",
  mismatch: "расхождение",
  Contract: "Контракт",
  "every side holds": "все стороны сходятся",
  "a side does not hold": "одна из сторон не сходится",
  "Checked in each subtask's checkout without a model: the producer sends or serves it, the consumers read or call it, with the same fields where the type is declared.":
    "Проверено в копии каждого сабтаска, без модели: поставщик отдаёт или шлёт, потребители вызывают или читают, и поля те же — там, где тип объявлен явно.",
  "Contract changed: a new version of the split; the subtasks it touches are told, the asking one goes on":
    "Контракт изменён: новая версия разбиения, затронутым сабтаскам ушла заметка, попросивший продолжает",
  "The contract stays as agreed; the asking subtask goes on with it":
    "Контракт остаётся как договорились, попросивший сабтаск продолжает по нему",
  "No such contract change request, or it is decided already":
    "Такой просьбы о смене контракта нет, или по ней уже решили",
  // ---- the run's feed
  "⇉ {n} tools in parallel": "⇉ {n} инстр. параллельно",
  "{n} tools in a row": "{n} инстр. подряд",
  "model call {n}": "вызов модели {n}",
  running: "идёт",
  "run created": "прогон создан",
  "answers prepared for {questions}: {answers} from the sources, {decisions} your call":
    "подготовлены ответы на {questions}: {answers} из источников, {decisions} решать вам",
  "note from {who} for {step}": "заметка от {who} для {step}",
  "note for {step}": "заметка для {step}",
  "the run": "прогона",
  "{agent} got the note": "{agent} получил заметку",
  "the agent": "агент",
  "{step} stopped: {calls} without an edit": "{step} остановлен: {calls} без единой правки",
  "{step}: {calls} without an edit — told to start editing":
    "{step}: {calls} без правок — велено начать править",
  "many model calls": "много вызовов модели",
  "the step": "шаг",
  "no answers prepared for the open questions: {why}": "ответы на открытые вопросы не подготовлены: {why}",
  "the model failed": "модель не ответила",
  "{step} skipped: {why}": "{step} пропущен: {why}",
  "nothing to do": "делать нечего",
  "{step} done": "{step} готов",
  "{step} error: {why}": "{step}: ошибка — {why}",
  "round {n}": "круг {n}",
  "fixing what {who} sent back": "исправляет то, что вернул {who}",
  "fixing {defects}": "исправляет {defects}",
  "fixing what {step} found": "исправляет то, что нашёл {step}",
  loop: "цикл",
  "one more round of {step}": "ещё круг {step}",
  "run {step} again": "{step} ещё раз",
  "a terminal waits at the loop card": "терминал ждёт на карточке цикла",
  "a terminal waits at the decision card": "терминал ждёт на карточке решения",
  "your edit → checkpoint, {files}": "ваша правка → checkpoint, {files}",
  "{doc} edited by a person{who} in {file}": "{doc} поправлен человеком{who} в {file}",
  document: "документ",
  "its file": "своём файле",
  "edit of {file} not taken: {why}": "правка {file} не принята: {why}",
  "a file": "файла",
  "removed scratch files: {files}": "удалены черновые файлы: {files}",
  "interrupted (Ctrl-C)": "прерван (Ctrl-C)",
  "pause asked": "попросили паузу",
  applied: "применён",
  // ---- notices in the run's feed (src/app/activity.ts noticeOf)
  "after {time}": "через {time}",
  model: "модель",
  "in {time}": "через {time}",
  "retry {n}": "повтор {n}",
  "the summary came back empty: the record of the calls and the sources were kept instead":
    "сводка пришла пустой: вместо неё оставлены запись вызовов и источники",
  "the summary was cut off: the record of the calls was added":
    "сводка обрезана: к ней добавлена запись вызовов",
  "conversation reset": "разговор начат заново",
  "conversation compacted": "разговор сжат",
  "1 block into a summary": "1 блок в сводку",
  "{n} blocks into a summary": "блоков в сводку: {n}",
  "compaction failed: {why} — older results were trimmed harder instead":
    "сжатие не удалось: {why} — вместо этого старые результаты обрезаны сильнее",
  "the summarizer": "сводка",
  "the quota window of pool {pool} is full": "окно квоты пула {pool} заполнено",
  "the quota window is full": "окно квоты заполнено",
  "calls go to {model} until it frees": "вызовы идут в {model}, пока оно не освободится",
  "the next model": "следующую модель",
  "quota used up": "квота исчерпана",
  "the run waits": "прогон ждёт",
  "gave up after 1 attempt": "сдался после 1 попытки",
  "gave up after {n} attempts": "сдался после попыток: {n}",
  "untrusted content from the internet: {tool} — from now on effects wait for a person's approval (ADR-0016 §4)":
    "недоверенное содержимое из интернета: {tool} — дальше эффекты ждут одобрения человека (ADR-0016 §4)",
  "a tool": "инструмент",
  "an internet tool": "инструмент интернета",
  "effect {capability} held: the run read untrusted content ({from}) and no person has approved anything since (ADR-0016 §4)":
    "эффект {capability} задержан: прогон прочитал недоверенное содержимое ({from}), а человек с тех пор ничего не одобрял (ADR-0016 §4)",
  // ---- the page's script (src/ui/assets.ts CLIENT_STRINGS)
  "Fold the rest": "Свернуть остальное",
  "reconnecting…": "переподключаюсь…",
  Copied: "Скопировано",
  "Send back with {n} comment": "Вернуть с {n} комментарием",
  "Send back with {n} comments": "Вернуть с комментариями: {n}",
  "Switch to the light theme": "Светлая тема",
  "Switch to the dark theme": "Тёмная тема",
  "Notifications on: a run that waits for you says so — click to turn off":
    "Уведомления включены: прогон, который ждёт вас, сообщит об этом — нажмите, чтобы выключить",
  "Notify me when a run waits for me": "Сообщать, когда прогон ждёт меня",
  "Notifications are blocked for this page in the browser settings":
    "Уведомления для этой страницы запрещены в настройках браузера",
  "This browser has no system notifications": "В этом браузере нет системных уведомлений",
  run: "прогон",
  "Could not reach jarvis ui": "Не удалось связаться с jarvis ui",
  // ---- Knowledge notices
  "Research started — it shows up under Runs too; the bell tells you when its candidate is ready":
    "Исследование запущено — оно видно и в «Прогонах»; колокольчик скажет, когда кандидат будет готов",
  "Taken out of the queue": "Убрано из очереди",
  "Added to the glossary as a draft — the next run's searches widen with it":
    "Добавлено в глоссарий черновиком — поиск следующего прогона расширится с ним",
  "Not a knowledge file of this repository": "Это не файл знаний этого репозитория",
  "Not a folder of a module here — pick one in the tree or from the path's suggestions":
    "Здесь нет папки модуля — выберите её в дереве или из подсказок пути",
  "Pick at least one part": "Выберите хотя бы одну часть",
  "Tick every statement under «Check these first» — or send it back with a note":
    "Отметьте каждое утверждение в «Сначала проверьте» — или верните с заметкой",
  "The target was written by a person: replace it, or write under another name":
    "Этот файл написал человек: замените его или запишите под другим именем",
  "Discarded — nothing written": "Отброшено — ничего не записано",
  "Discarded, and researching again with your note": "Отброшено, исследую заново с вашей заметкой",
  "This candidate was decided meanwhile (in a terminal or another window)":
    "По этому кандидату уже решили (в терминале или другом окне)",
  "Nothing to commit under .jarvis/": "В .jarvis/ нечего коммитить",
  "{n} queued — they run one after another": "в очереди {n} — идут одно за другим",
  "Written to {file} — not committed yet": "Записано в {file} — ещё не закоммичено",
  "Committed: {file}": "Закоммичено: {file}",
  "Onboarded {name}: the map and the service's documents are written — not committed yet":
    "Онбординг {name}: карта и документы сервиса записаны — ещё не закоммичено",
  "jarvis onboard failed for {name} — see {cmd}": "jarvis onboard для {name} не удался — см. {cmd}",
  "git commit failed — see {cmd}": "git commit не удался — см. {cmd}",
  "opened in {editor}": "открыто в {editor}",
  // ---- the other wait card
  "The run waits for {what}": "Прогон ждёт: {what}",
  "Answer in the terminal: {cmd}": "Ответить в терминале: {cmd}",
  "a decision": "решение",
  // ---- why a run is where it is (src/ui/reasons.ts)
  "approve {type} ({doc})": "одобрить {type} ({doc})",
  "clarification needed by {agent}: {thread}": "{agent} нужно уточнение: {thread}",
  "waits for its subtasks: {done} of {all} done": "ждёт свои сабтаски: готово {done} из {all}",
  "asks the master to change the contract: {item}": "просит мастер изменить контракт: {item}",
  "model {model} is unavailable: {why}": "модель {model} недоступна: {why}",
  "interrupted with Ctrl-C; `jarvis continue` goes on from here":
    "прерван по Ctrl-C; `jarvis continue` продолжит отсюда",
  "paused by {who}; Resume (or `jarvis continue`) goes on from here":
    "на паузе ({who}); «Продолжить» (или `jarvis continue`) пойдёт отсюда",
  "paused; Resume (or `jarvis continue`) goes on from here":
    "на паузе; «Продолжить» (или `jarvis continue`) пойдёт отсюда",
  "cancelled at a safe point": "отменён в безопасной точке",
  "workflow done": "workflow пройден",
  "went on without the failed checks": "пошёл дальше без упавших проверок",
  "resumed from {state}": "возобновлён из {state}",
  started: "запущен",
  // ---- adr-0003-0006-delivery-actor
  "on behalf of {who}": "от имени {who}",
  "Create PR": "Создать PR",
  "Approve and create PR": "Одобрить и создать PR",
  "the approval is recorded as yours": "одобрение запишется на вас",
  "Pull request:": "Pull request:",
  Description: "Описание",
  "Prepare PR": "Подготовить PR",
  "Commit message": "Сообщение коммита",
  "The repository's hooks refused the commit: fix the message below, or the code, and try again":
    "Хуки репозитория не приняли коммит: поправьте сообщение ниже или код и попробуйте снова",
  "shows the branch, target, title and description first; nothing is pushed yet":
    "сначала покажет ветку, цель, заголовок и описание — ничего не пушится",
  "The pull request as it will go out": "Pull request в том виде, в каком уйдёт",
  Branch: "Ветка",
  Into: "В ветку",
  "{n} files": "файлов: {n}",
  "one commit": "один коммит",
  "pushes the branch and opens the pull request through the MCP server, as {cmd}":
    "пушит ветку и открывает pull request через MCP-сервер, как {cmd}",
  "The PR is prepared: check it below, change what is needed and create it":
    "PR подготовлен: проверьте ниже, поправьте нужное и создайте",
  "PR opened": "Открыт PR",
  "No PR:": "PR не создан:",
  "Pushed the run's branch and opened the PR": "Ветка прогона запушена, PR открыт",
  "The project wants the PR approved first: check it below and approve it":
    "В проекте PR сначала одобряют: проверьте его ниже и одобрите",
  // ---- the checkout block
  Checkout: "Рабочая копия",
  "Removed: no folder and no branch of this run are left.":
    "Убрано: ни папки, ни ветки этого прогона не осталось.",
  "Its branch's last commit is kept as {ref}.": "Последний коммит его ветки сохранён как {ref}.",
  "Restore the branch": "Вернуть ветку",
  "then Apply, or remove it again": "потом Apply или снова убрать",
  "folder {path}": "папка {path}",
  "branch {name}": "ветка {name}",
  "The run has ended; its {what} are still there.": "Прогон закончился, но его {what} ещё на месте.",
  "The run has ended; its {what} is still there.": "Прогон закончился, но его {what} ещё на месте.",
  "Apply to {branch}": "Применить в {branch}",
  "the run's changes as one commit on the branch checked out in the repository, as {cmd}; not pushed":
    "изменения прогона одним коммитом на текущую ветку репозитория, как {cmd}; без push",
  "also delete the branch {name}": "заодно удалить ветку {name}",
  "its changes are not applied": "её изменения не применены",
  "The branch is the only copy of the run's work: Apply it first, or keep the branch. Deleted, its last commit stays under {ref} and can be restored here.":
    "Ветка — единственная копия работы прогона: сначала примените её или оставьте ветку. После удаления её последний коммит остаётся в {ref}, и его можно вернуть здесь.",
  "Remove the checkout": "Убрать рабочую копию",
  "Delete the branch": "Удалить ветку",
  "as {cmd} for this run": "как {cmd} для этого прогона",
  // ---- the Candidates page
  Candidates: "Кандидаты",
  Reject: "Отклонить",
  "… {n} more": "… и ещё {n}",
  "Proposed {name} — it waits under {candidates}, or in the terminal: {cmd}":
    "Предложено {name} — ждёт в {candidates} или в терминале: {cmd}",
  "Rejected {name} — nothing written; the decision is kept":
    "{name} отклонён — ничего не записано, решение сохранено",
  "Added to the skill in {file} (v{v}) — not committed yet":
    "Добавлено в скилл, {file} (v{v}) — ещё не закоммичено",
  "Not accepted: {why}": "Не принято: {why}",
  standard: "стандарт",
  knowledge: "знание",
  "skill-improvement": "улучшение скилла",
  "Accepting copies the built-in skill {skill} into {dir} and adds this at the end of its instructions: v{from} → v{to}.":
    "При принятии встроенный скилл {skill} копируется в {dir}, а это дописывается в конец его инструкций: v{from} → v{to}.",
  "Accepting adds this at the end of the instructions of {skill}: v{from} → v{to}.":
    "При принятии это дописывается в конец инструкций {skill}: v{from} → v{to}.",
  "Accepting adds {symbols} to the term {term} in the glossary.":
    "При принятии к термину {term} в глоссарии добавятся {symbols}.",
  "Accepting adds the term {term} with {symbols} to the glossary.":
    "При принятии в глоссарий добавится термин {term} с {symbols}.",
  "Accepting writes {file} — not committed: it goes through the usual review.":
    "При принятии записывается {file} — без коммита: дальше обычное review.",
  "Jarvis wrote the file there now: it is replaced.":
    "Сейчас там файл, который написал Jarvis: он заменится.",
  "A person wrote the file there now: replace it, or give another name.":
    "Сейчас там файл, который написал человек: замените его или дайте другое имя.",
  "File name": "Имя файла",
  "optional; without .md": "необязательно; без .md",
  "replace the file a person wrote": "заменить файл, который написал человек",
  "Why not": "Почему нет",
  "optional; kept with the decision": "необязательно; сохранится вместе с решением",
  "Proposed standards, knowledge, skill improvements and glossary terms: from review, from runs, from people. Accepted, one is written into the project, to commit as usual.":
    "Предложенные стандарты, знания, улучшения скиллов и термины глоссария — из review, из прогонов, от людей. Принятый кандидат записывается в проект, а коммитится как обычно.",
  "Module maps are decided on {modules}: {n} open.":
    "Карты модулей решаются на странице {modules}: открыто {n}.",
  "Open only": "Только открытые",
  "With decided ({n})": "С решёнными ({n})",
  "Nothing waits: review and runs propose candidates as they find things; you can propose one on the Overview.":
    "Ничего не ждёт: review и прогоны предлагают кандидатов по мере находок; предложить своего можно на «Обзоре».",
  "proposed by": "кто предложил",
  skill: "скилл",
  "Pick a candidate.": "Выберите кандидата.",
  // ---- Report a problem
  "Report a problem in Jarvis": "Сообщить о проблеме в Jarvis",
  "A new issue opens in {repo} on GitHub with this text filled in: read it there and submit it.":
    "Откроется новый issue в {repo} на GitHub с этим текстом: проверьте его там и отправьте.",
  "In short, what is wrong": "Коротко, что не так",
  "What happened": "Что случилось",
  "What you expected": "Что ожидали",
  "How to repeat": "Как повторить",
  "Attach to the issue": "Приложить к issue",
  "Jarvis version, OS, Node": "Версия Jarvis, ОС, Node",
  "The run: workflow, step, state, reason": "Прогон: workflow, шаг, состояние, причина",
  "The run's last errors, secrets masked": "Последние ошибки прогона, секреты замаскированы",
  "The task's text": "Текст задачи",
  "may hold the company's data": "может содержать данные компании",
  "Opened from a run's page, the report can carry that run's step, state and errors.":
    "Если открыть форму со страницы прогона, к issue можно приложить его шаг, состояние и ошибки.",
  "The issue is public. The company's code, paths and service names do not get into it unless you write them yourself.":
    "Issue будет публичным. Код, пути и имена сервисов компании в него не попадут, если вы сами их не впишете.",
  "Show the text": "Показать текст",
  "Open the issue on GitHub": "Открыть issue на GitHub",
  "The issue's text": "Текст issue",
  "Open on GitHub": "Открыть на GitHub",
  "Too long for one address: GitHub gets it shortened. Copy the whole text into the issue.":
    "Для одной ссылки текст слишком длинный, и GitHub получит его сокращённым. Скопируйте полный текст в issue.",
  "Back to the run": "Назад к прогону",
  // ---- autonomous runs
  "No person in the loop: gates pass, a question gets the most cautious assumption, a dead end ends the run":
    "Без человека: утверждения проходят сами, на вопрос агента — самое осторожное допущение, в тупике прогон заканчивается",
  autonomous: "автономно",
  Autonomous: "Автономно",
  "full autonomy: no person needed, except when the task gets stuck or internet content comes into it":
    "режим полной автономии — человек не нужен, кроме двух случаев: задача застряла или в неё пришли данные из интернета",
  "autonomous: {type} passed without a person": "автономно: {type} пройден без человека",
  "autonomous: {agent} asked, nobody answers — the most cautious assumption, the step again":
    "автономно: {agent} задал вопрос, отвечать некому — самое осторожное допущение, шаг заново",
  "autonomous: the task stays in this service": "автономно: задача остаётся в этом сервисе",
  "autonomous: the contract stays as agreed": "автономно: контракт остаётся как договорились",
  "autonomous: nobody to decide — the run ends": "автономно: решать некому — прогон закончен",
  // ---- the repository picker
  Repository: "Репозиторий",
  "all repositories": "все репозитории",
  Show: "Показать",
  // ---- MCP servers and their network
  attention: "внимание",
  "Agents do not get it: the project's dataClass keeps them off the {network} network. To let them in, add it to {key} in .jarvis/project.yaml — the top bar then warns about it on every page.":
    "Агентам он недоступен: dataClass проекта не пускает их в сеть {network}. Чтобы пустить, добавьте сервер в {key} в .jarvis/project.yaml — тогда на каждой странице под шапкой будет предупреждение.",
  "the project's dataClass keeps the agents off this network":
    "dataClass проекта не пускает агентов в эту сеть",
  "{network}: off for agents": "{network}: агентам закрыт",
  "{network} by exception": "{network} по исключению",
  // ---- related work (ADR-0026)
  "related work: {issues}, {branches} with a branch, {contract} contract changes":
    "смежная работа: {issues}, с веткой — {branches}, изменений контракта — {contract}",
  "{server}: its {rpm} calls a minute are used, waiting {s} s":
    "{server}: лимит {rpm} запросов в минуту выбран, ждём {s} с",
  "{server} answered 429 (too many requests) {n} times: gave up for now":
    "{server} {n} раз ответил 429 (слишком много запросов): пока отступились",
  "{server} answered 429 (too many requests): asking again in {s} s":
    "{server} ответил 429 (слишком много запросов): повтор через {s} с",
  "related work not read: {why}": "смежная работа не прочитана: {why}",
  "{issue}: its branch was merged since the spec": "{issue}: ветка влита после спеки",
  "{issue}: its branch moved on and its contract changed since the spec — check the spec":
    "{issue}: ветка ушла вперёд, и контракт изменился после спеки — проверьте спеку",
  "{issue}: its branch moved on since the spec, the contract is the same":
    "{issue}: ветка ушла вперёд после спеки, контракт тот же",
  "Look at related tasks and their branches": "Смотреть смежные задачи и их ветки",
  "no PR: the run changed no code": "PR не нужен: прогон не менял код",
  "no PR: the run worked in your checkout, there is no branch to push":
    "PR не выставлен: прогон работал в вашем checkout, ветки для push нет",
  // ---- the PR flow: reading the PR
  unknown: "неизвестно",
  "build failed": "упала",
  "build running": "идёт",
  "build passed": "прошла",
  Build: "Сборка",
  Approvals: "Аппрувы",
  "Open threads": "Открытые треды",
  "Open tasks": "Открытые задачи",
  "{n} of {of}": "{n} из {of}",
  "Ready for merge: merge it in Bitbucket — Jarvis does not merge.":
    "Готово к merge: мержите в Bitbucket — Jarvis этого не делает.",
  "Before the merge:": "До merge:",
  "Not read yet: the comments are read once the PR is up.":
    "Ещё не прочитан: комментарии читаются после выставления PR.",
  "Check comments": "Check comments",
  "Code review": "Код-ревью",
  "read every {n} min while jarvis ui is open{last}": "читается раз в {n} мин, пока открыт jarvis ui{last}",
  "last at {time}": "последний раз в {time}",
  "last read at {time}": "прочитан в {time}",
  "the PR as a whole": "PR целиком",
  task: "задача",
  comment: "комментарий",
  "The PR has not been read yet: «Check comments» reads it now.":
    "PR ещё не прочитан: «Check comments» прочитает его сейчас.",
  "No open threads.": "Открытых тредов нет.",
  "Jarvis's own comments": "Комментарии Jarvis",
  "Open in Bitbucket": "Открыть в Bitbucket",
  "The PR is read: what changed is below": "PR прочитан: что изменилось — ниже",
  "The PR is ready for merge: merge it in Bitbucket": "PR готов к merge: мержите в Bitbucket",
  "The PR could not be read:": "PR не прочитан:",
  "The run has no PR": "У прогона нет PR",
  "the PR is merged": "PR влит",
  "the PR is {state}": "PR: {state}",
  "the PR is ready for merge: merge it in Bitbucket": "PR готов к merge: мержите в Bitbucket",
  "PR: {comments} new, {open} open threads, approvals {approvals}":
    "PR: новых — {comments}, открытых тредов {open}, аппрувов {approvals}",
  "the PR is not ready for merge any more": "PR больше не готов к merge",
  "the PR could not be read: {why}": "PR не прочитан: {why}",
  // ---- the PR flow: the agent weighs the comments
  "for you: the agent disagrees or drafted an answer": "вас: агент не согласен или подготовил ответ",
  "the agent agrees": "агент согласен",
  "the agent disagrees — your call": "агент не согласен — решать вам",
  "a question — the agent drafted an answer": "вопрос — агент подготовил ответ",
  Replied: "Ответ отправлен",
  "edited by {who}": "текст поправил {who}",
  "To be fixed: Jarvis changes the code, pushes a commit and answers in the thread":
    "Будет исправлено: Jarvis правит код, допушивает коммит и отвечает в треде",
  "Left to you": "Оставлено вам",
  "Reply in the PR (you can change it)": "Ответ в PR (можно поправить)",
  "Send reply": "Отправить ответ",
  "Fix it": "Исправить",
  "Fix anyway": "Всё равно исправить",
  "I will answer myself": "Отвечу сам",
  "Change:": "Что поменять:",
  "Sources:": "Источники:",
  "The reply is posted in the PR": "Ответ отправлен в PR",
  Noted: "Принято",
  "No reply:": "Ответ не отправлен:",
  "PR comments weighed: agrees {agree}, disagrees {disagree}, questions {question}, nothing to do {nothing}":
    "Комментарии PR разобраны: согласен {agree}, не согласен {disagree}, вопросы {question}, ничего не нужно {nothing}",
  "the PR comments could not be weighed: {why}": "комментарии PR не разобраны: {why}",
  "reply posted in thread {thread}{by}": "ответ отправлен в тред {thread}{by}",
  "thread {thread}: to be fixed{by}": "тред {thread}: будет исправлено{by}",
  "thread {thread}: left to the person{by}": "тред {thread}: оставлено человеку{by}",
  "Being fixed": "Исправляется",
  Fixed: "Исправлено",
  "run {id}": "прогон {id}",
  "fixing the PR's comments: {threads}, run {run}": "исправляются комментарии PR: {threads}, прогон {run}",
  "the fix is pushed to {branch}: {commit}, {threads} answered":
    "исправление запушено в {branch}: {commit}, ответы в {threads}",
  "The task is finalized": "Задача финализирована",
  "Finalize the task": "Финализировать задачу",
  "Make an eval case of the run": "Сделать eval-кейс из прогона",
  "the task, the spec and the accepted change, to check models and prompts on":
    "задача, спека и принятый diff — для проверки моделей и промптов",
  "Keep the PR's comments in the knowledge": "Учесть комментарии ревью в знаниях",
  "a comment reviewers keep making becomes a standard to approve":
    "повторяющееся замечание ревьюеров станет кандидатом в стандарты на ваш аппрув",
  "The PR is not ready for merge — finalize anyway": "PR не готов к merge — всё равно финализировать",
  Finalize: "Финализировать",
  "the checkout is removed; the branch stays, the PR has it; the merge stays yours":
    "checkout удаляется, ветка остаётся — она в PR; merge остаётся за вами",
  "Not finalized:": "Не финализировано:",
  "the task is finalized": "задача финализирована",
  "the task is finalized, its PR not ready for merge": "задача финализирована, PR не был готов к merge",
  "Put up the PR after the review and follow its comments": "Выставить PR после ревью и вести комментарии",
  "once you approve the work Jarvis pushes the branch and opens the PR, then reads its comments; the merge stays yours":
    "после вашего аппрува Jarvis пушит ветку и открывает PR, затем читает комментарии; merge остаётся за вами",
  "pull requests are off for this project (delivery.pr: deny)": "PR в проекте выключены (delivery.pr: deny)",
  "no MCP server here opens pull requests: add bitbucket.pr.create to the server's allow":
    "нет MCP-сервера, который открывает PR: добавьте bitbucket.pr.create в allow сервера",
  "the branches and PRs of the epic's or Story's other tasks and the contract they change, before the spec; a task in a Story starts from the Story's branch and its PR goes into it":
    "ветки и PR других задач эпика или Story и что они меняют в контракте — до спеки; задача из Story начинается от ветки Story, и её PR идёт в неё",
  "Story {story}: its tasks read first, compared with {branch}":
    "Story {story}: сначала её задачи, сравнение с {branch}",
  "in Story {story}: {branch} was not in the repository — Jarvis made it from the base and pushed it; the run started from it, its PR goes into it":
    "задача из Story {story}: ветки {branch} в репо не было — Jarvis создал её от базы и запушил; прогон начат от неё, PR пойдёт в неё",
  "in Story {story}: the run started from {branch}, its PR goes into it":
    "задача из Story {story}: прогон начат от {branch}, PR пойдёт в неё",
  "in Story {story}: the repository has no {branch} yet, the run started from the usual base":
    "задача из Story {story}: в репо ещё нет {branch}, прогон начат от обычной базы",
  "in Story {story} ({branch}): the run did not start from its branch":
    "задача из Story {story} ({branch}): прогон начат не от её ветки",
};

/**
 * Russian forms of the nouns `plural()` gets (src/ui/i18n.ts): one, a few, many — 1 прогон, 2 прогона,
 * 5 прогонов. A form with `{n}` places the number itself.
 */
export const RU_PLURALS: Readonly<Record<string, readonly [string, string, string]>> = {
  run: ["прогон", "прогона", "прогонов"],
  comment: ["комментарий", "комментария", "комментариев"],
  thread: ["тред", "треда", "тредов"],
  "comment waits": ["комментарий ждёт", "комментария ждут", "комментариев ждут"],
  research: ["исследование", "исследования", "исследований"],
  "related task": ["смежная задача", "смежные задачи", "смежных задач"],
  call: ["вызов", "вызова", "вызовов"],
  "model call": ["вызов модели", "вызова модели", "вызовов модели"],
  "tool call": ["вызов инструмента", "вызова инструмента", "вызовов инструментов"],
  tool: ["инструмент", "инструмента", "инструментов"],
  file: ["файл", "файла", "файлов"],
  commit: ["коммит", "коммита", "коммитов"],
  contradiction: ["противоречие", "противоречия", "противоречий"],
  defect: ["дефект", "дефекта", "дефектов"],
  document: ["документ", "документа", "документов"],
  endpoint: ["эндпоинт", "эндпоинта", "эндпоинтов"],
  failure: ["падение", "падения", "падений"],
  generalisation: ["обобщение", "обобщения", "обобщений"],
  module: ["модуль", "модуля", "модулей"],
  round: ["круг", "круга", "кругов"],
  "round left": ["остался {n} круг", "осталось {n} круга", "осталось {n} кругов"],
  service: ["сервис", "сервиса", "сервисов"],
  thing: ["пункт", "пункта", "пунктов"],
  time: ["раз", "раза", "раз"],
  topic: ["топик", "топика", "топиков"],
  approval: ["одобрение", "одобрения", "одобрений"],
  waits: ["ждёт", "ждут", "ждут"],
  running: ["идёт", "идут", "идут"],
  "waits for you": ["ждёт вас", "ждут вас", "ждут вас"],
  "answer to approve": ["ответ ждёт одобрения", "ответа ждут одобрения", "ответов ждут одобрения"],
  "PR comment": ["комментарий в PR", "комментария в PR", "комментариев в PR"],
  PR: ["PR", "PR", "PR"],
  source: ["источник", "источника", "источников"],
  excerpt: ["цитата", "цитаты", "цитат"],
  frame: ["фрейм", "фрейма", "фреймов"],
  test: ["тест", "теста", "тестов"],
  check: ["проверка", "проверки", "проверок"],
  line: ["строка", "строки", "строк"],
  "agent call": ["вызова агента", "вызовов агента", "вызовов агента"],
  term: ["термин", "термина", "терминов"],
  "candidate waits for review": [
    "{n} кандидат ждёт проверки",
    "{n} кандидата ждут проверки",
    "{n} кандидатов ждут проверки",
  ],
  unit: ["фрагмент", "фрагмента", "фрагментов"],
  symbol: ["символ", "символа", "символов"],
  "knowledge file": ["файл знаний", "файла знаний", "файлов знаний"],
  "open question": ["открытый вопрос", "открытых вопроса", "открытых вопросов"],
  retry: ["повтор", "повтора", "повторов"],
  request: ["запрос", "запроса", "запросов"],
};
