/**
 * The page's script (served as /assets/app.js): no framework — the server renders, this follows the
 * journal and keeps what a person does on the page. Bundled by scripts/build-client.ts into
 * src/ui/client.gen.ts; tests/ui/client*.test.ts run it on a DOM.
 */
import { initBell, initClicks, initIndicators, initKeys, initSearch, initTheme } from "./chrome.ts";
import { initDecisions, syncChoice } from "./decisions.ts";
import { inPhase, startClocks, startLive } from "./live.ts";
import { initNewTask } from "./newTask.ts";
import { loadStrings } from "./strings.ts";

loadStrings();
inPhase(document);
const countOn = startClocks();
setInterval(countOn, 1000);
initTheme();
const checkWaiting = initBell();
const refreshIndicators = initIndicators();
const refresh = startLive({
  afterRefresh: () => {
    syncChoice();
    countOn();
  },
  onJournal: () => {
    void refreshIndicators();
    void checkWaiting();
  },
});
initSearch(refresh);
initNewTask();
initDecisions();
initKeys();
initClicks();
