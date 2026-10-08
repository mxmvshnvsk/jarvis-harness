/**
 * The page's style and its one small script (ADR-0023 §5: no build step, no framework). Served from
 * `/assets/`, so a strict Content-Security-Policy can forbid inline scripts.
 */
/**
 * Colours as tokens: light by default, dark when the system asks for it (prefers-color-scheme) or the
 * person picks it with the header's switch (a cookie, so the server renders `data-theme` and the page
 * never flashes the other theme). Fills under white text (`--accent-fill`, `--ok-fill`) are separate
 * from the accent used for text, which must be light on a dark ground.
 */
const LIGHT = `:root{
  color-scheme:light;
  --ground:#F7F6F3;--panel:#FFFFFF;--sunken:#FAFAF8;--line:#E3E1DB;--line-soft:#EFEDE8;--field-line:#D4D1C9;
  --ink:#1D1C1A;--ink-2:#3B3934;--muted:#5E5B53;--faint:#8C897F;--faint-2:#6B6860;
  --accent:#1F4FD1;--accent-dark:#163A9C;--accent-soft:#EEF1FB;--accent-fill:#1F4FD1;--accent-fill-hover:#163A9C;
  --on-fill:#FFFFFF;--info-bg:#E6ECFB;--wait-bg:#FBEFD9;--wait:#7A4100;
  --ok:#1E7A3E;--ok-bg:#E7F4EA;--ok-ink:#14552B;--ok-fill:#1E7A3E;
  --bad:#B3261E;--bad-fill:#B3261E;--bad-bg:#FBECEA;--chip:#F3F1EC;--focus-row:#FBF3E4;--track:#ECEAE4;--border-btn:#C9C6BE;
  --spin-track:#C9D5F5;--code-on-banner:rgba(255,255,255,.6);--warn-dot:#C27A12;--shadow:rgba(20,20,18,.14);
  --sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}`;

const DARK = `
  color-scheme:dark;
  --ground:#141513;--panel:#1C1D1A;--sunken:#181917;--line:#33342F;--line-soft:#292A26;--field-line:#45463F;
  --ink:#ECEAE4;--ink-2:#D0CDC5;--muted:#A3A097;--faint:#7E7B72;--faint-2:#8F8C83;
  --accent:#8AADFF;--accent-dark:#B3CAFF;--accent-soft:#1E2740;--accent-fill:#3559C9;--accent-fill-hover:#2A49AD;
  --on-fill:#FFFFFF;--info-bg:#1E2740;--wait-bg:#36270F;--wait:#F2B861;
  --ok:#6CCB88;--ok-bg:#16301E;--ok-ink:#9BE0AF;--ok-fill:#23793F;
  --bad:#FF948A;--bad-fill:#C2362C;--bad-bg:#3A1B18;--chip:#272824;--focus-row:#2E2512;--track:#2C2D29;--border-btn:#4A4B44;
  --spin-track:#2E3A5C;--code-on-banner:rgba(0,0,0,.25);--warn-dot:#F2B861;--shadow:rgba(0,0,0,.5);
`;

export const STYLE = `
${LIGHT}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}:root:not([data-theme=light]) .theme .sun{display:block}:root:not([data-theme=light]) .theme .moon{display:none}}
:root[data-theme=dark]{${DARK}}
:root[data-theme=light]{color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.45}
a{color:var(--accent)}a:hover{color:var(--accent-dark)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.mono,code,pre{font-family:var(--mono)}
.muted{color:var(--muted)}
.ok{color:var(--ok)}.warn{color:var(--wait)}.bad{color:var(--bad)}
.skip-link{position:absolute;left:-9999px}.skip-link:focus{left:16px;top:8px;background:var(--panel);padding:8px;z-index:9}
.top{background:var(--panel);border-bottom:1px solid var(--line)}
.wrap{max-width:1240px;margin:0 auto;padding:0 24px}
.top .wrap{padding-top:12px;padding-bottom:12px;display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px}
.brand{font-family:var(--mono);font-weight:600;font-size:17px;color:var(--ink);text-decoration:none}
.top nav a{display:inline-block;padding:10px 12px;border-radius:6px;color:var(--ink-2);text-decoration:none;font-size:14px}
.top nav a[aria-current=page]{background:var(--accent-soft);color:var(--accent);font-weight:500}
.back{font-size:14px;padding:10px 0}
.repo{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--muted)}
select,textarea,input[type=text],input[type=search]{font-family:inherit;font-size:14px;color:var(--ink);border:1px solid var(--field-line);border-radius:6px;background:var(--panel)}
/* a search field drawn by the page, not the system's inset box */
input[type=search]{-webkit-appearance:none;appearance:none;box-shadow:none;outline-offset:0}
input[type=search]::placeholder{color:var(--muted);opacity:1}
input[type=search]:hover{border-color:var(--border-btn)}
input[type=search]:focus{border-color:var(--accent)}
input[type=search]:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-soft)}
select{height:36px;padding:0 8px;max-width:60vw}
input.amount{height:44px;width:11em;padding:0 10px;font-family:inherit;font-size:14px;color:var(--ink);border:1px solid var(--field-line);border-radius:6px;background:var(--panel)}
.status{margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
.live{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:4px;background:var(--faint)}
.live[data-state=live] .dot{background:var(--ok)}
.live[data-state=lost] .dot{background:var(--bad)}
.theme{display:inline-flex;align-items:center;justify-content:center;min-height:36px;min-width:36px;padding:0 9px;border:1px solid var(--border-btn);border-radius:6px;background:var(--panel);color:var(--ink-2);font-family:inherit;font-size:13px;cursor:pointer}
.theme:hover{border-color:var(--ink-2);color:var(--ink)}
.notify[aria-pressed=true]{color:var(--accent);border-color:var(--accent)}
.notify[data-state=blocked],.notify[data-state=unsupported]{opacity:.55}
.theme svg{width:16px;height:16px}
/* the switch shows where it goes: a moon on the light theme, a sun on the dark one */
.theme .sun{display:none}
:root[data-theme=dark] .theme .sun{display:block}
:root[data-theme=dark] .theme .moon{display:none}
.dot[data-state=ok]{background:var(--ok)}
.dot[data-state=busy]{background:var(--warn-dot)}
.dot[data-state=down]{background:var(--bad)}
.dot[data-state=idle]{background:var(--faint)}
.dot[data-state=pending]{background:var(--faint);animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dot[data-state=pending]{animation:none}}
.pop-head .spin{width:12px;height:12px}
.egress{background:var(--wait-bg);border-bottom:1px solid var(--line);color:var(--wait)}
.egress .wrap{padding-top:8px;padding-bottom:8px}
.egress p{margin:0;font-size:13px;line-height:19px}
.egress code{font-family:var(--mono);font-size:12px}
.launch-link{display:block;color:inherit;text-decoration:none}
.launch-link:hover .panel{border-color:var(--ink-2)}
.models-wrap{position:relative}
.models{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:0 10px;border:1px solid var(--border-btn);border-radius:6px;background:var(--panel);color:var(--ink-2);font-family:var(--mono);font-size:12px;cursor:pointer}
.models:hover,.models[aria-expanded=true]{border-color:var(--ink-2);color:var(--ink)}
.models .dot[data-state=down]{box-shadow:0 0 0 3px var(--bad-bg)}
.models .free{padding:1px 6px;border-radius:999px;background:var(--ok-bg);color:var(--ok);font-size:11px;white-space:nowrap}
.pop{position:absolute;right:0;top:calc(100% + 8px);width:min(520px,calc(100vw - 32px));max-height:min(70vh,640px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 16px 40px var(--shadow);padding:14px 16px;z-index:30}
.pop[hidden]{display:none}
.pop>div{display:flex;flex-direction:column;gap:12px}
.pop-head{display:flex;align-items:center;gap:10px}
.pop-head .meta{margin-left:auto}
.mhs{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:12px}
.mh{display:flex;flex-direction:column;gap:6px;padding-top:12px;border-top:1px solid var(--line-soft)}
.mload .row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.mload-runs{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px;font-size:13px}
.mh:first-child{border-top:0;padding-top:0}
.mh .why{margin:0;padding-left:18px;font-size:13px;line-height:19px;color:var(--ink-2)}
.win{display:flex;flex-direction:column;gap:4px}
.perf{margin:2px 0 0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;font-family:var(--mono);font-size:12px;line-height:17px}
.perf dt{color:var(--muted)}
.perf dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.now-line{display:flex;align-items:center;gap:8px;color:var(--accent)}
.now-line .spin{width:12px;height:12px}
.bar>span.soft{background:var(--warn-dot)}
.bar>span.full{background:var(--bad)}
main.wrap{padding-top:28px;padding-bottom:48px;display:flex;flex-direction:column;gap:28px}
h1{margin:0;font-size:30px;line-height:38px;font-weight:600;overflow-wrap:anywhere}
h2{margin:0;font-size:18px;font-weight:600}
h3{margin:0;font-size:18px;line-height:24px;font-weight:600;overflow-wrap:anywhere}
.lede{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 20px}
.lede .muted{font-size:15px}
section.group{display:flex;flex-direction:column;gap:14px}
.cards{display:flex;flex-wrap:wrap;gap:16px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;min-width:0}
.card{flex:1 1 420px;padding:20px;display:flex;flex-direction:column;gap:12px}
.decision{border-color:var(--ink);padding:24px;display:flex;flex-direction:column;gap:16px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.meta{font-family:var(--mono);font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:13px;font-weight:500;white-space:nowrap}
.pill.wait{background:var(--wait-bg);color:var(--wait)}
.pill.info{background:var(--info-bg);color:var(--accent-dark)}
.pill.ok{background:var(--ok-bg);color:var(--ok-ink)}
.pill.bad{background:var(--bad-bg);color:var(--bad)}
.pill.plain{background:var(--chip);color:var(--ink-2)}
.chip{display:inline-block;padding:2px 8px;border-radius:6px;background:var(--chip);font-family:var(--mono);font-size:12px;font-weight:600}
p{margin:0}
.card p,.decision p{font-size:14px;line-height:21px;color:var(--ink-2)}
.actions{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:8px;border:1px solid var(--border-btn);background:var(--panel);font-family:inherit;font-size:14px;color:var(--ink);text-decoration:none;cursor:pointer}
.btn:hover{border-color:var(--ink-2);color:var(--ink)}
.btn.primary{background:var(--accent-fill);border-color:var(--accent-fill);color:var(--on-fill);font-weight:500}
.btn.primary:hover{background:var(--accent-fill-hover);border-color:var(--accent-fill-hover);color:var(--on-fill)}
.btn.accept{background:var(--ok-fill);border-color:var(--ok-fill);color:var(--on-fill);font-weight:500}
.btn.accept:hover{color:var(--on-fill);filter:brightness(1.08)}
.btn.strong{border-color:var(--ink);font-weight:500}
.btn.small{min-height:36px;padding:0 12px;font-size:13px}
.btn.big{min-height:48px;font-size:15px;padding:0 22px}
.btn[disabled]{opacity:.55;cursor:not-allowed}
.hint{font-size:13px;color:var(--muted)}
.hint code,.meta code{font-size:12px}
.bar{height:8px;border-radius:4px;background:var(--track);overflow:hidden}
.bar>span{display:block;height:8px;background:var(--accent)}
.running{padding:16px 20px;display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px}
.running .what{flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:4px}
.running .what a{font-size:16px;font-weight:600;color:var(--ink);text-decoration:none;overflow-wrap:anywhere}
.running .budget{flex:0 1 260px;display:flex;flex-direction:column;gap:6px;min-width:160px}
.scroll{overflow-x:auto;max-width:100%}
table{width:100%;border-collapse:collapse;font-size:14px}
.recent table{min-width:720px}
.group-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.search input{height:36px;width:min(360px,100%);padding:0 12px;border-radius:8px;font-size:14px;line-height:36px}
.search{flex:0 1 360px;min-width:0}
.pager{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:10px 0 0;font-size:14px}
.pager .pages{display:flex;gap:16px;align-items:center;margin-left:auto}
.sizes{display:inline-flex;border:1px solid var(--field-line);border-radius:8px;overflow:hidden}
.sizes a{min-width:40px;min-height:32px;display:inline-flex;align-items:center;justify-content:center;padding:0 10px;color:var(--ink-2);text-decoration:none;font-variant-numeric:tabular-nums}
.sizes a+a{border-left:1px solid var(--field-line)}
.sizes a:hover{background:var(--sunken);color:var(--ink)}
.sizes a[aria-current]{background:var(--accent-soft);color:var(--accent);font-weight:600}
mark{background:var(--accent-soft);color:inherit;border-radius:3px;padding:0 1px}
th{text-align:left;color:var(--muted);font-size:13px;font-weight:500;padding:12px 20px;border-bottom:1px solid var(--line)}
td{padding:12px 20px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tr:last-child td{border-bottom:0}
.empty{padding:20px;color:var(--muted);font-size:14px}
.cols{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
.side{flex:1 1 340px;min-width:0;padding:18px 20px;display:flex;flex-direction:column;gap:2px}
.mainc{flex:999 1 560px;min-width:0;display:flex;flex-direction:column;gap:20px}
.steps h2,.feed h2,.arts h2{margin-bottom:10px;font-size:16px}
.step{display:flex;gap:12px;align-items:flex-start;padding:7px 8px;border-radius:8px}
.step.focus{background:var(--focus-row)}
.step .ic{width:18px;text-align:center;font-size:14px;line-height:20px;flex-shrink:0}
.step .nm{flex:1;min-width:0;display:flex;flex-direction:column}
.step .nm b{font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.step.child{padding-left:22px}
.step.child .nm b{font-weight:400;color:var(--ink-2)}
.step.pending .nm b,.step.skipped .nm b{color:var(--faint-2);font-weight:400}
.step .note{font-size:12px;line-height:17px;color:var(--muted);overflow-wrap:anywhere}
.step .took{font-family:var(--mono);font-size:12px;color:var(--muted);white-space:nowrap}
.reasons{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}
.reasons li{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
.reasons li span:last-child{flex:1 1 300px;font-size:14px;line-height:21px;overflow-wrap:anywhere}
.checkout{border-top:1px solid var(--line-soft);padding-top:16px;display:flex;flex-direction:column;gap:10px}
.path{flex:1 1 320px;min-width:0;padding:10px 12px;border-radius:8px;background:var(--chip);font-size:13px;overflow-x:auto;white-space:nowrap}
.changed{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:8px;background:var(--sunken);border:1px dashed var(--field-line);font-family:var(--mono);font-size:13px;overflow-wrap:anywhere}
.changed .hint{font-family:var(--sans)}
.now{padding:20px 24px;display:flex;flex-direction:column;gap:10px}
.spin{width:14px;height:14px;border-radius:7px;border:2px solid var(--spin-track);border-top-color:var(--accent);animation:spin 1s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.feed{padding:18px 20px;display:flex;flex-direction:column;gap:8px}
.feed ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.feed .earlier>summary{list-style:none;cursor:pointer;width:max-content;font-size:13px;color:var(--accent);padding:2px 0}
.feed .earlier>summary::-webkit-details-marker{display:none}
.feed .earlier>summary::before{content:'▸ ';color:var(--muted)}
.feed .earlier[open]>summary::before{content:'▾ '}
.feed .earlier[open]>summary{margin-bottom:8px}
.feed .earlier>ol{padding-bottom:8px;border-bottom:1px dashed var(--line);margin-bottom:8px}
.askwrap{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
.askmain{display:flex;flex-direction:column;gap:16px;min-width:0}
@media (max-width:900px){.askwrap{grid-template-columns:1fr}}
.ask{padding:20px 24px;display:flex;flex-direction:column;gap:12px}
.ask textarea{width:100%;min-height:76px;padding:12px 14px;font-size:15px;line-height:1.45;border-radius:8px;resize:vertical}
.ask .row{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.seg{display:inline-flex;border:1px solid var(--field-line);border-radius:8px;overflow:hidden;font-size:13px}
.seg label{display:inline-flex;cursor:pointer}.seg label+label{border-left:1px solid var(--field-line)}
.seg input{position:absolute;opacity:0;pointer-events:none}
.seg span{padding:8px 12px;color:var(--ink-2)}
.seg input:checked+span{background:var(--accent-soft);color:var(--accent);font-weight:600}
.seg input:focus-visible+span{outline:2px solid var(--accent);outline-offset:-2px}
.ask-answer{padding:20px 24px;display:flex;flex-direction:column;gap:12px}
.ask-answer .q{font-size:13px;color:var(--muted)}
.ask-answer .a{font-size:15px;line-height:1.6}
.ask-answer .a.doc{padding:0;border:0;background:none}
.ask-answer .a.doc>:first-child{margin-top:0}.ask-answer .a.doc>:last-child{margin-bottom:0}
.askmain>[data-live=ask]{display:flex;flex-direction:column;gap:16px}
.ask-answer .row{display:flex;gap:10px;align-items:center}
.cites{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:6px;font-size:13px}
.cites li{color:var(--ink-2)}.cites q{display:block;color:var(--ink);margin-top:2px}
.ask-answer .gaps{background:var(--wait-bg);color:var(--wait);border-radius:8px;padding:10px 14px;font-size:14px}
.ask-answer .gaps ul{margin:4px 0 0;padding-left:20px}
.ask-answer .general{border:1px dashed var(--field-line);border-radius:8px;padding:10px 14px;font-size:14px;color:var(--ink-2)}
.ask-answer .checks{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ask-answer .checks .pill{white-space:normal;overflow-wrap:anywhere}
h2.ask-sec{font-size:15px;margin:4px 0 -4px}
.ask-found{display:flex;flex-direction:column}
.ask-found a.item{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:10px;padding:12px 20px;border-top:1px solid var(--line-soft);text-decoration:none;color:inherit}
.ask-found a.item:first-of-type{border-top:none}
.ask-found .n{font-family:var(--mono);font-size:12px;color:var(--accent)}
.ask-found .t{display:flex;flex-direction:column;gap:3px;min-width:0}
.ask-found .t b{font-size:14px;font-weight:500}
.ask-found .t span:not(.pill){font-size:13px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ask-terms{padding:14px 20px;display:flex;flex-direction:column;gap:8px;font-size:14px}
.ask-terms div{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}
.ask-recent{padding:16px 20px;display:flex;flex-direction:column;gap:4px}
.ask-recent h3{font-size:14px;font-weight:600;margin-bottom:6px}
.ask-recent a{display:flex;flex-direction:column;gap:2px;text-decoration:none;color:var(--ink);font-size:14px;padding:8px 0;border-top:1px solid var(--line-soft)}
.ask-recent a[aria-current]{color:var(--accent)}
.ask-recent a span{font-size:12px;color:var(--muted)}
.feed li{display:flex;gap:14px;font-size:13px;line-height:19px;align-items:baseline}
.feed time{font-family:var(--mono);color:var(--muted);width:64px;flex-shrink:0}
.feed li span{flex:1;min-width:0;overflow-wrap:anywhere}
.feed .grp{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.feed .grp .sub{font-family:var(--mono);font-size:12px;color:var(--ink-2);padding-left:12px;border-left:2px solid var(--line);margin-left:2px;overflow-wrap:anywhere}
.feed .grp .sub.bad{color:var(--bad)}
.batch{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:8px;background:var(--sunken);border:1px solid var(--line-soft)}
.batch.past{opacity:.75}
.batch .bh{display:flex;gap:8px;align-items:baseline;font-size:13px;color:var(--ink-2);flex-wrap:wrap}
.batch .bh b{color:var(--ink);font-weight:600}
.lane{display:grid;grid-template-columns:16px 84px minmax(0,1fr) minmax(60px,150px) 52px;gap:10px;align-items:center;font-family:var(--mono);font-size:12px}
.lane .spin{width:10px;height:10px;border-width:2px}
.lane .k{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lane .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;color:var(--ink)}
.lane .t{color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.track{position:relative;height:6px;border-radius:3px;background:var(--track)}
.track span{position:absolute;top:0;bottom:0;border-radius:3px;background:var(--accent)}
.track span.run{background:repeating-linear-gradient(90deg,var(--accent) 0 6px,transparent 6px 10px);opacity:.8}
.kpi{display:inline-flex;gap:4px;align-items:center;padding:1px 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:600;white-space:nowrap}
@media (max-width:640px){.lane{grid-template-columns:16px 64px minmax(0,1fr) 44px}.lane .track{display:none}}
.arts{padding:18px 20px}
.arts ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.arts li{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:14px;align-items:baseline}
.arts li a{font-family:var(--mono);font-size:13px;overflow-wrap:anywhere}
.banner{padding:12px 16px;border-radius:10px;font-size:14px;overflow-wrap:anywhere}
.banner.ok{background:var(--ok-bg);color:var(--ok-ink)}
.banner.info{background:var(--accent-soft);color:var(--accent-dark)}
.banner.bad{background:var(--bad-bg);color:var(--bad)}
.banner code{background:var(--code-on-banner);padding:1px 4px;border-radius:4px}
.doc{padding:24px;font-size:15px;line-height:1.6;overflow-wrap:anywhere}
.doc h2{font-size:20px;margin:22px 0 8px}.doc h2:first-child{margin-top:0}
.doc h3{font-size:17px;margin:18px 0 6px}.doc h4,.doc h5,.doc h6{font-size:15px;margin:14px 0 4px}
.doc p{margin:0 0 10px}
.doc ul,.doc ol{margin:0 0 10px;padding-left:22px}
.doc li{margin:2px 0}
.doc code{background:var(--chip);padding:1px 5px;border-radius:4px;font-size:13px}
.doc pre{background:var(--sunken);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;font-size:13px;line-height:1.5}
.doc pre code{background:none;padding:0}
.doc blockquote{margin:0 0 10px;padding-left:12px;border-left:3px solid var(--line);color:var(--ink-2)}
.doc mark{background:var(--wait-bg);color:var(--wait);padding:0 3px;border-radius:3px}
.doc table{margin:0 0 12px}.doc th,.doc td{padding:6px 10px;border:1px solid var(--line)}
.doc hr{border:0;border-top:1px solid var(--line);margin:16px 0}
.tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--line)}
.tabs a{padding:12px 14px;font-size:14px;color:var(--ink-2);text-decoration:none}
.tabs a[aria-current=true]{color:var(--ink);font-weight:600;border-bottom:2px solid var(--ink)}
.file{overflow:hidden}
.file>summary{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:12px 16px;background:var(--sunken);cursor:pointer;list-style:none}
.file>summary::-webkit-details-marker{display:none}
.file>summary::before{content:'▸';color:var(--muted);font-size:12px}
.file[open]>summary::before{content:'▾'}
.file[open]>summary{border-bottom:1px solid var(--line)}
.file .fname{font-family:var(--mono);font-size:13px;font-weight:600;overflow-wrap:anywhere}
.file .fstat{font-family:var(--mono);font-size:12px}
.diff{font-family:var(--mono);font-size:12.5px;line-height:22px;min-width:640px}
.dl{display:flex;align-items:stretch;padding-right:16px}
.dl .n{width:48px;flex-shrink:0;text-align:right;padding-right:8px;color:var(--faint);user-select:none}
.dl .s{width:18px;flex-shrink:0;text-align:center;color:var(--muted);user-select:none}
.dl .c{white-space:pre;flex:1}
.dl.hunk{background:var(--accent-soft);color:var(--accent-dark)}
.dl.del{background:var(--bad-bg)}
.dl.add{background:var(--ok-bg)}
.dl.note{color:var(--muted);font-style:italic}
.dl .cm{width:28px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.dl .cm button{width:22px;height:22px;padding:0;border:1px solid var(--border-btn);border-radius:5px;background:var(--panel);color:var(--accent);font-size:16px;line-height:18px;cursor:pointer;opacity:.5}
@media (hover:hover){.dl .cm button{opacity:0}.dl:hover .cm button{opacity:1}}
.dl .cm button:focus-visible{opacity:1}
.dl.commented{box-shadow:inset 3px 0 0 var(--accent)}
.thread{padding:12px 16px 14px 120px;background:var(--sunken);border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-family:var(--sans);display:flex;flex-direction:column;gap:8px}
.thread label{display:flex;flex-direction:column;gap:6px;max-width:620px;font-size:12px;color:var(--muted)}
.thread textarea{padding:8px 10px;border-radius:8px;resize:vertical}
.thread .actions .btn{min-height:36px}
.aside{flex:1 1 320px;min-width:0;padding:20px;display:flex;flex-direction:column;gap:16px;border-color:var(--ink)}
.aside h2{font-size:18px}
.facts{display:flex;flex-direction:column;gap:6px;font-size:14px}
.facts .lbl{font-size:13px;font-weight:500;color:var(--muted)}
.decide{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line-soft);padding-top:16px}
.decide textarea{width:100%;padding:8px 10px;border-radius:8px;resize:vertical;min-height:84px}
.decide label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted)}
.decide .btn{width:100%}
.versions{display:flex;flex-wrap:wrap;gap:6px;font-size:13px;align-items:center}
.versions a,.versions span{padding:2px 8px;border-radius:6px;font-family:var(--mono)}
.versions span{background:var(--ink);color:var(--ground)}
.newtask{padding:18px 20px}
.newtask form{display:flex;flex-direction:column;gap:12px}
.newtask h2{font-size:16px}
.field{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted)}
.field textarea{padding:10px 12px;border-radius:8px;resize:vertical;min-height:72px;font-size:15px;line-height:1.45}
.field{min-width:0}
.check{display:flex;align-items:baseline;gap:8px;margin-top:10px;font-size:14px;cursor:pointer}
.check input{margin:0;accent-color:var(--accent)}
.field select{height:44px;width:100%;text-overflow:ellipsis}
.newtask .row{align-items:flex-end}
.newtask .row .field{flex:1 1 240px;max-width:520px}
.convo{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.convo .msg{display:flex;flex-direction:column;gap:4px;padding:10px 14px;border-radius:8px;border:1px solid var(--line);max-width:860px}
.convo .msg.jarvis{background:var(--ground)}
.convo .msg.human{background:var(--accent-soft);border-color:transparent;align-self:flex-end}
.convo .who{font-size:12px;font-family:var(--mono);color:var(--muted)}
.convo .said{white-space:pre-wrap;font-size:14px;line-height:21px;color:var(--ink)}
.rule{border-left:3px solid var(--ok);padding:4px 0 4px 14px;display:flex;flex-direction:column;gap:4px}
.rule p,.rule li{font-size:14px;line-height:21px;margin:0}
.rule ul{margin:0;padding-left:20px}
form.clarify{display:flex;flex-direction:column;gap:12px}
.earlier{display:flex;flex-direction:column;gap:10px}
form.clarify>.actions{margin:4px 0}
.ownrule summary{cursor:pointer;font-size:13px;color:var(--accent)}
.ownrule[open]{display:flex;flex-direction:column;gap:10px}
.qs{padding:0}
.qs-head{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:16px 20px;border-bottom:1px solid var(--line)}
.qs-head h2{font-size:17px;margin:0}
.qs-prep{padding:12px 20px;border-bottom:1px solid var(--line)}
.q{display:grid;grid-template-columns:28px minmax(0,1fr);gap:4px 10px;padding:16px 20px;margin:0;border:0;border-bottom:1px solid var(--line);min-width:0}
.q .n{font-family:var(--mono);font-size:13px;color:var(--muted);padding-top:2px}
.q .n.ok{color:var(--ok)}
.q .body{display:flex;flex-direction:column;gap:8px;min-width:0}
.q .qtext{font-size:15px;line-height:22px;color:var(--ink);margin:0}
.q .about{display:flex;gap:6px;flex-wrap:wrap}
.q .tag{font-family:var(--mono);font-size:11px;padding:2px 8px;border-radius:999px;background:var(--chip);color:var(--ink-2)}
.q .lbl{display:block;font-size:12px;font-weight:500;color:var(--accent);margin:0 0 2px}
.q .guess .lbl,.q p.lbl{color:var(--muted)}
.q .opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:8px;cursor:pointer;background:var(--panel)}
.q .opt:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.q .opt input{margin-top:3px;accent-color:var(--accent);flex:none}
.q .opt>span{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.q .said{font-size:14px;line-height:21px;color:var(--ink);white-space:pre-wrap}
.q .opt small{color:var(--muted);font-size:12px}
.q .src{display:flex;gap:6px;flex-wrap:wrap}
.q .src span{font-family:var(--mono);font-size:11px;padding:1px 7px;border-radius:6px;border:1px solid var(--line);color:var(--ink-2)}
.q .own textarea{width:100%;min-height:40px;padding:8px 10px;border-radius:6px;resize:vertical;font-size:14px;line-height:20px}
.q .qrow{display:flex;gap:8px;flex-wrap:wrap}
.q .pick{display:inline-flex;gap:6px;align-items:center;font-size:13px;color:var(--ink-2);padding:5px 10px;border:1px solid var(--line);border-radius:999px;cursor:pointer}
.q .pick:has(input:checked){border-color:var(--wait);color:var(--wait)}
.q .pick input{margin:0;accent-color:var(--wait)}
.q .done{font-size:14px;line-height:21px;padding:8px 12px;border-radius:8px;background:var(--ok-bg);color:var(--ink);white-space:pre-wrap}
.qs .dock{display:flex;flex-direction:column;gap:10px;padding:14px 20px;background:var(--panel);border-top:1px solid var(--line);border-bottom-left-radius:inherit;border-bottom-right-radius:inherit}
.qs .dock .sum{font-size:13px;line-height:19px;color:var(--muted)}
.qs .dock .note summary{cursor:pointer;font-size:13px;color:var(--accent)}
.qs .dock .note[open]{display:flex;flex-direction:column;gap:8px}
.qs .dock .note textarea{padding:8px 10px;border-radius:6px;resize:vertical;min-height:64px}
.tryit{padding:20px 24px;display:flex;flex-direction:column;gap:14px}
.tryit h2{font-size:18px;line-height:24px}
.trysteps{margin:0;padding-left:22px;list-style:decimal;display:flex;flex-direction:column;gap:14px}
.trysteps>li{display:flex;flex-direction:column;gap:6px;font-size:14px}
.trysteps>li::marker{color:var(--muted);font-weight:500}
.cmd{display:flex;gap:8px;align-items:center}
.cmd code{flex:1 1 auto;min-width:0;padding:8px 10px;border-radius:8px;background:var(--chip);font-size:13px;overflow-x:auto;white-space:nowrap}
.checks{margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:10px}
.checks .rq{font-size:14px}
.checks ul{margin:4px 0 0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.checks label{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:19px;color:var(--ink-2);cursor:pointer}
.checks input{margin-top:3px}
.checks label:has(input:checked){color:var(--muted);text-decoration:line-through}
.tryact{gap:8px;flex-wrap:wrap}
.inrepo{display:flex;flex-direction:column;gap:6px}
.inrepo[open]{display:flex}
.inrepo summary{cursor:pointer;font-size:13px;color:var(--accent)}
.tryit .after{border-top:1px solid var(--line-soft);padding-top:12px;font-size:13px;color:var(--ink-2)}
.trybar{display:flex;flex-direction:column;gap:6px}
.trybar .lbl{font-size:13px;font-weight:500;color:var(--muted)}
.planw{border:1px solid var(--line);border-radius:10px;background:var(--ground)}
.sentback{display:flex;flex-direction:column;gap:8px}
.sentback .said{white-space:pre-wrap;font-size:14px;line-height:21px;padding:10px 12px;border-left:3px solid var(--warn-dot);background:var(--sunken);border-radius:6px}
.planw>summary{display:flex;align-items:baseline;gap:10px;padding:10px 14px;cursor:pointer;list-style:none;flex-wrap:wrap}
.planw>summary::-webkit-details-marker{display:none}
.planw>summary::before{content:"▸";color:var(--muted);font-size:12px}
.planw[open]>summary::before{content:"▾"}
.planw .of{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--accent);white-space:nowrap}
.planw summary .d{font-size:14px;line-height:20px;color:var(--ink);flex:1;min-width:0}
.planbox{display:flex;flex-direction:column;gap:10px;padding:0 14px 14px}
.segs{display:flex;gap:4px}
.segs i{flex:1;height:6px;border-radius:3px;background:var(--line)}
.segs i.ok{background:var(--ok)}.segs i.on{background:var(--accent)}
.pmeta{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--ink-2)}
.pmeta code{font-size:12px}
.pmeta .k{color:var(--muted);display:inline-block;min-width:44px}
.plist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.plist li{display:grid;grid-template-columns:18px 22px minmax(0,1fr) auto;gap:8px;align-items:baseline;font-size:13px;line-height:19px;padding:4px 6px;border-radius:6px}
.plist li.on{background:var(--accent-soft)}
.plist .spin{width:10px;height:10px;border-width:2px}
.plist .n{font-family:var(--mono);color:var(--muted)}
.plist .d{color:var(--ink)}
.plist li.todo .d{color:var(--muted)}
.plist .f{font-family:var(--mono);font-size:11px;color:var(--muted)}
.planat{color:var(--accent);font-weight:600}
.fixw .of{color:var(--bad)}
.fixw .plist li.on{background:var(--bad-bg)}
.notes{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.notes li{font-size:13px;padding:8px 12px;border-radius:8px;background:var(--accent-soft)}
.notes .said{white-space:pre-wrap;font-size:14px;line-height:20px;color:var(--ink);margin-top:2px}
.addnote summary{cursor:pointer;font-size:13px;color:var(--accent)}
.addnote[open]>form{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.addnote textarea{padding:8px 10px;border-radius:6px;resize:vertical;min-height:64px}
.startfrom:empty{display:none}
.from{border:1px solid var(--line);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;background:var(--ground)}
.from .check{margin:0}
.from .sub{margin:0 0 0 22px;font-size:13px;line-height:19px}
.from .sub code{font-size:12px}
.launch .what b{font-size:16px;font-weight:600;overflow-wrap:anywhere}
.launch .spin{margin-left:auto}
.launch.failed{border-color:var(--bad)}
.tail{margin:6px 0 0;padding:10px 12px;border-radius:8px;background:var(--sunken);border:1px solid var(--line);font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.tabs a[aria-current=page]{color:var(--ink);font-weight:600;border-bottom:2px solid var(--ink)}
.runtitle{display:flex;align-items:flex-start;justify-content:space-between;gap:16px 24px}
.runtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.runtext p{margin:0}
.cancel{position:relative;flex-shrink:0}
.cancel>summary{list-style:none;width:max-content}
.cancel>summary::-webkit-details-marker{display:none}
.cancel-pop{position:absolute;right:0;top:calc(100% + 8px);z-index:20;width:320px;max-width:calc(100vw - 32px);padding:16px;border-radius:10px;border:1px solid var(--line);background:var(--panel);box-shadow:0 12px 32px var(--shadow);display:flex;flex-direction:column;gap:10px}
.cancel-pop p{margin:0;font-size:14px;line-height:20px}
.btn.danger{color:var(--bad);border-color:var(--bad)}
.btn.danger:hover{background:var(--bad-bg);color:var(--bad);border-color:var(--bad)}
.btn.danger-fill{background:var(--bad-fill);border-color:var(--bad-fill);color:var(--on-fill);font-weight:500}
.btn.danger-fill:hover{filter:brightness(1.1);color:var(--on-fill)}
@media (max-width:640px){.runtitle{flex-direction:column}.cancel-pop{left:0;right:auto}}
/* Knowledge: overview, documents, standards, skills, glossary */
.row>.grow,.mpath>.grow{flex:1 1 280px;min-width:0}
.ksearch,.kbox{padding:18px 20px;display:flex;flex-direction:column;gap:12px}
.ksearch{border-color:var(--ink)}
.ksearch h2,.kbox h2{margin:0;font-size:16px}
.ksearch input,.kfields input,.kfilter input{height:44px;padding:0 12px;border:1px solid var(--field-line);border-radius:8px;background:var(--panel);color:var(--ink);font-family:inherit;font-size:15px}
.kexp{gap:6px}
.khits{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.khits li{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;font-size:14px}
.khits .meta{width:40px}
.khead{padding:16px 20px;border-bottom:1px solid var(--line)}
.khead h2{margin:0;font-size:16px}
.kdocs{padding:0;gap:0;overflow:hidden}
.ktable{display:flex;flex-direction:column;font-size:14px}
.kr{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1.2fr) 80px 110px;gap:12px;padding:10px 20px;border-top:1px solid var(--line-soft);color:inherit;text-decoration:none;align-items:baseline}
.kr.kh{border-top:0;color:var(--muted);font-size:12px;font-weight:500}
a.kr:hover{background:var(--sunken)}
.kr.warn{background:var(--focus-row)}
.kr.current{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.kr.kg{grid-template-columns:170px minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.4fr)}
.kr.kg>span:first-child{display:flex;flex-direction:column;gap:2px}
.kprob{display:block;font-family:var(--sans);color:var(--bad);margin-top:4px}
.kside{padding:0;gap:16px}
.kbox p{margin:0;font-size:14px;line-height:21px}
.kbox.warn{background:var(--focus-row)}
.kres{justify-content:space-between}
.kdoccols{display:grid;grid-template-columns:260px minmax(0,1fr) 300px;gap:20px;align-items:start}
.kdoccols.kstd{grid-template-columns:minmax(0,1fr) minmax(0,1.5fr)}
.ktree,.klist{padding:10px 8px;display:flex;flex-direction:column;gap:2px}
.ktree h3,.klist h3{margin:10px 10px 4px;font-size:12px;font-weight:500;color:var(--muted)}
.ktree ul{list-style:none;margin:0;padding:0}
.ktree a,.kli{display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:40px;padding:6px 10px;border-radius:6px;color:var(--ink-2);text-decoration:none;font-family:var(--mono);font-size:13px;overflow-wrap:anywhere}
.kli{font-family:var(--sans);font-size:14px;min-height:48px}
.kli>span:first-child{display:flex;flex-direction:column;gap:2px;min-width:0}
.ktree a:hover,.kli:hover{background:var(--sunken)}
.ktree a[aria-current=page],.kli[aria-current=page]{background:var(--accent-soft);color:var(--accent-dark);font-weight:600}
.kli.off code{text-decoration:line-through;color:var(--faint)}
.kmeta{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0}
.kmeta .pill{font-size:12px;padding:2px 8px}
.kdoc{overflow:hidden}
.kdochead{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:10px}
.kdochead h2{margin:0;font-size:17px}
.kpath{font-weight:600;font-size:14px}
.kchips{gap:6px}
.klead{margin:0;font-size:16px;line-height:24px}
.kaside{display:flex;flex-direction:column;gap:16px}
.kunits{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:13px}
.kunits li{display:flex;justify-content:space-between;gap:10px}
.kfound{padding:16px 24px;border-top:1px solid var(--line-soft);display:flex;flex-direction:column;gap:8px}
.kfound h3{margin:0;font-size:14px}
.kfound ul{margin:0;padding-left:18px;font-size:13px;line-height:20px}
.kadd>summary{padding:14px 20px;cursor:pointer}
.kadd form{padding:0 20px 18px;display:flex;flex-direction:column;gap:12px}
.kfields{align-items:flex-start}
.kfields .field{min-width:180px}
.kfields input.mono{font-family:var(--mono);font-size:13px}
.kchecks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:13px}
.kchecks li.ok{color:var(--ok)}.kchecks li.warn{color:var(--wait)}
.kgloss{padding:0;gap:0;overflow-x:auto}
.kgloss .ktable{min-width:760px}
@media (max-width:1100px){.kdoccols{grid-template-columns:minmax(0,1fr)}.kdoccols.kstd{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){.kr{grid-template-columns:minmax(0,1fr)}.kr.kh{display:none}}
/* Knowledge → Modules */
.mcols{gap:20px}
.mleft{flex:1 1 400px;min-width:0;display:flex;flex-direction:column;gap:12px}
.mright{flex:1.4 1 560px;min-width:0}
.mpath{display:flex;align-items:flex-end;gap:8px}
.mpath .field{flex:1}
.mpath input{height:44px;padding:0 12px;border:1px solid var(--field-line);border-radius:8px;background:var(--panel);color:var(--ink);font-family:var(--mono);font-size:14px}
.mtree{overflow:hidden}
.mtree ul{list-style:none;margin:0;padding:0}
.mtree ul ul{padding-left:18px}
.mtree summary{list-style:none;display:block;cursor:pointer}
.mtree summary::-webkit-details-marker{display:none}
.mtree summary .mname::before{content:"▸";display:inline-block;width:16px;color:var(--muted)}
.mtree details[open]>summary .mname::before{content:"▾"}
.mhead,.mrow{display:grid;grid-template-columns:minmax(0,1fr) auto 48px;gap:10px;align-items:center;padding:8px 14px}
.mhead{color:var(--muted);font-size:12px;font-weight:500;border-bottom:1px solid var(--line)}
.mrow{min-height:44px;box-sizing:border-box;border-top:1px solid var(--line-soft);color:var(--ink);text-decoration:none}
.mrow:hover{background:var(--sunken)}
.mrow.current{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.mname{font-family:var(--mono);font-size:13px;overflow-wrap:anywhere}
.mtree li>.mrow .mname{padding-left:16px}
.mfiles{font-family:var(--mono);font-size:12px;color:var(--muted);text-align:right}
.mfiles.big{color:var(--wait);font-weight:600}
.mrow .pill{font-size:12px;padding:2px 8px}
.mresearch{padding:20px 24px;display:flex;flex-direction:column;gap:16px}
.mresearch h2{margin:0;font-size:18px}
.mfacts{display:grid;grid-template-columns:130px minmax(0,1fr);gap:8px 14px;margin:0;font-size:13px;line-height:19px}
.mfacts dt{color:var(--muted)}.mfacts dd{margin:0}
.mstart,.mresearch form{display:flex;flex-direction:column;gap:12px}
.mparts,.mchecks{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.mchecks legend{margin-bottom:6px;font-size:14px}
.mpart,.mcheck{display:flex;align-items:center;gap:12px;min-height:44px;padding:6px 12px;border-radius:8px;border:1px solid var(--line-soft);cursor:pointer}
.mcheck{align-items:flex-start;background:var(--wait-bg)}
.mcheck:has(input:checked){background:var(--ok-bg)}
.mpart input,.mcheck input{width:20px;height:20px;margin:0;flex-shrink:0;accent-color:var(--accent-fill)}
.mpart code{flex:1;min-width:0;overflow-wrap:anywhere}
.mdropped h3{margin:0 0 6px;font-size:14px}
.mdropped ul{margin:0;padding-left:18px;font-size:13px;line-height:20px}
.mdoc,.mdiff,.magain{border:1px solid var(--line-soft);border-radius:8px}
.mdoc>summary,.mdiff>summary,.magain>summary{padding:10px 14px;cursor:pointer;font-size:14px}
.mdoc .doc{max-height:360px;overflow:auto;padding:12px 16px;border-top:1px solid var(--line-soft)}
.magain form{padding:0 14px 14px}
.field.inline{flex-direction:row;align-items:center;gap:8px}
.field.inline input{height:40px;padding:0 10px;border:1px solid var(--field-line);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--panel);color:var(--ink)}
.mdrafts{margin-top:20px;padding:16px 20px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 20px}
.mdrafts>div{display:flex;flex-direction:column;gap:4px}
@media (max-width:640px){
  .wrap{padding:0 16px}
  main.wrap{padding-top:20px;gap:22px}
  h1{font-size:24px;line-height:31px}
  .card{flex-basis:100%;padding:16px}
  .decision{padding:18px}
  .status{margin-left:0}
  .pop{position:fixed;left:16px;right:16px;width:auto;max-height:calc(100vh - 120px)}
  th,td{padding:10px 14px}
  /* the diff scrolls sideways on a phone; a comment under a line stays in view */
  .thread{padding-left:16px;position:sticky;left:0;width:calc(100vw - 34px)}
  .doc{padding:16px}
  .mainc{order:-1}
}
`;

/** Live updates (SSE), copy buttons, line comments on the diff. No framework, no build. */
export const SCRIPT = `
(() => {
  const body = document.body;
  const status = document.querySelector('.live');
  const say = (state, text) => {
    if (!status) return;
    status.dataset.state = state;
    const label = status.querySelector('.label');
    if (label) label.textContent = text;
  };

  // a spinner keeps its turn across refreshes: a replaced region is a new element whose animation
  // would start again at 0° on every event (pilot: the loader jerked once a second or two). Every
  // spinner takes its phase from the page's clock instead, so the new one goes on where the old one was.
  const SPIN_MS = 1000;
  const inPhase = (root) => {
    for (const s of root.querySelectorAll('.spin')) s.style.animationDelay = -(performance.now() % SPIN_MS) + 'ms';
  };
  inPhase(document);

  // Recent searches as you type: the address keeps the query (a reload, a link), the list comes with a refresh
  const search = document.querySelector('[data-search]');
  if (search) {
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const url = new URL(location.href);
        const q = search.value.trim();
        if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
        url.searchParams.delete('page');
        const repo = search.form && search.form.elements.namedItem('repo');
        if (repo && !url.searchParams.has('repo')) url.searchParams.set('repo', repo.value);
        history.replaceState(null, '', url);
        refresh();
      }, 250);
    });
  }

  // "New task" for a workflow a research goes on as (sdd): the finished research of the same issue
  // to start from, looked up as the task is typed (GET /runs/from)
  const startFrom = document.querySelector('[data-from]');
  const newForm = startFrom && startFrom.closest('form');
  if (newForm) {
    let timer;
    let asked = '';
    const look = () => {
      const field = (name) => {
        const el = newForm.elements.namedItem(name);
        return el && 'value' in el ? el.value : '';
      };
      const q = new URLSearchParams({ task: field('task'), workflow: field('workflow'), repo: field('repo') }).toString();
      if (q === asked) return;
      asked = q;
      fetch('/runs/from?' + q, { headers: { Accept: 'text/html' } })
        .then((res) => (res.ok ? res.text() : ''))
        .then((text) => {
          if (asked === q) startFrom.innerHTML = text;
        })
        .catch(() => {});
    };
    newForm.addEventListener('input', (e) => {
      const name = e.target && e.target.name;
      if (name !== 'task' && name !== 'workflow' && name !== 'repo') return;
      clearTimeout(timer);
      timer = setTimeout(look, name === 'task' ? 300 : 0);
    });
    newForm.addEventListener('change', (e) => {
      if (e.target && (e.target.name === 'workflow' || e.target.name === 'repo')) look();
    });
    look();
  }

  // an open question answered in one's own words: that answer is the one picked
  document.addEventListener('input', (e) => {
    const n = e.target && e.target.dataset && e.target.dataset.own;
    if (!n) return;
    const own = document.querySelector('input[name="qa-' + n + '"][value="own"]');
    if (own && e.target.value.trim()) own.checked = true;
  });

  // the rows of Recent a person picked stay for the next visit, like the theme
  document.addEventListener('click', (e) => {
    const size = e.target.closest && e.target.closest('[data-size]');
    if (size) document.cookie = 'jarvis_recent_size=' + size.dataset.size + '; Path=/; SameSite=Strict; Max-Age=31536000';
  });

  // running clocks count on between refreshes: the server's value plus the time since it arrived
  // (an element a refresh brought is new, so it starts from its own value; no clock skew involved)
  const arrived = new WeakMap();
  const clockOf = (ms) => {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + sec : m + ':' + sec;
  };
  const countOn = () => {
    const now = performance.now();
    for (const el of document.querySelectorAll('[data-ms]')) {
      if (!arrived.has(el)) arrived.set(el, now);
      const text = clockOf(Number(el.dataset.ms) + now - arrived.get(el));
      if (el.textContent !== text) el.textContent = text;
    }
  };
  countOn();
  setInterval(countOn, 1000);

  /** A field in the region differs from how the server rendered it. */
  const edited = (region) =>
    [...region.querySelectorAll('input, textarea, select')].some((f) => {
      if (f.type === 'checkbox' || f.type === 'radio') return f.checked !== f.defaultChecked;
      if (f.tagName === 'SELECT') return [...f.options].some((o) => o.selected !== o.defaultSelected);
      if (f.type === 'hidden' || f.type === 'submit' || f.type === 'button') return false;
      return f.value !== f.defaultValue;
    });

  // replace the live regions with the server's fresh rendering; forms being typed in stay
  let busy = false, again = false;
  async function refresh() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const res = await fetch(location.href, { headers: { 'X-Jarvis-Refresh': '1' }, credentials: 'same-origin' });
      if (!res.ok) return;
      // the page moved on (a launch whose run began): follow it
      if (res.redirected && res.url !== location.href) { location.href = res.url; return; }
      const next = new DOMParser().parseFromString(await res.text(), 'text/html');
      for (const el of document.querySelectorAll('[data-live]')) {
        let fresh = next.querySelector('[data-live="' + el.dataset.live + '"]');
        if (!fresh) {
          // the region is gone from the fresh page (a finished run has no "now" card): keep its slot empty
          fresh = document.createElement('div');
          fresh.dataset.live = el.dataset.live;
          fresh.hidden = true;
        }
        if (el.contains(document.activeElement) && document.activeElement !== document.body) continue;
        // what a person changed and has not sent yet stays: the refresh waits for it — a comment, an amount,
        // ticked boxes (pilot: a refresh while reviewing a module's claims cleared the ticks), a choice
        if (edited(el)) continue;
        inPhase(fresh);
        // a fold a person opened (or closed) stays so: the fresh rendering comes folded
        for (const d of el.querySelectorAll('details[data-keep]')) {
          const same = fresh.querySelector('details[data-keep="' + d.dataset.keep + '"]');
          if (same) same.open = d.open;
        }
        el.replaceWith(fresh);
      }
      const title = next.querySelector('title');
      if (title) document.title = title.textContent;
    } catch {
      /* the next event tries again */
    } finally {
      busy = false;
      if (again) { again = false; setTimeout(refresh, 50); }
    }
  }

  if (window.EventSource) {
    const runId = body.dataset.run;
    const source = new EventSource('/live' + (runId ? '?run=' + encodeURIComponent(runId) : ''));
    source.onopen = () => say('live', 'live');
    source.onerror = () => say('lost', 'reconnecting…');
    let modelsSoon;
    source.addEventListener('journal', (e) => {
      let data = {};
      try { data = JSON.parse(e.data); } catch {}
      if (!runId || (data.runs || []).includes(runId)) refresh();
      clearTimeout(modelsSoon);
      modelsSoon = setTimeout(() => { refreshModels(); checkWaiting(); }, 1000);
    });
  }
  const tick = Number(body.dataset.tick || 0);
  if (tick > 0) setInterval(refresh, tick);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const d of document.querySelectorAll('details[data-dismiss][open]')) { d.open = false; d.querySelector('summary')?.focus(); }
  });
  document.addEventListener('click', async (e) => {
    const close = e.target.closest('[data-close]');
    if (close) { const d = close.closest('details'); if (d) d.open = false; return; }
    for (const d of document.querySelectorAll('details[data-dismiss][open]')) if (!d.contains(e.target)) d.open = false;
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        const was = copy.textContent;
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = was; }, 1500);
      } catch {
        window.prompt('Copy:', copy.dataset.copy);
      }
      return;
    }
    const add = e.target.closest('[data-comment]');
    if (add) openThread(add.closest('.dl'));
    const drop = e.target.closest('[data-drop]');
    if (drop) {
      const thread = drop.closest('.thread');
      thread.previousElementSibling?.classList.remove('commented');
      thread.remove();
      count();
    }
  });

  // a comment on a line of the diff: a textarea under it; all of them go back with the decision
  function openThread(line) {
    if (!line) return;
    const next = line.nextElementSibling;
    if (next && next.classList.contains('thread')) { next.querySelector('textarea').focus(); return; }
    const where = line.dataset.path + ':' + line.dataset.line;
    const box = document.createElement('div');
    box.className = 'thread';
    box.innerHTML = '<label><span></span><textarea rows="2" name="line"></textarea></label>' +
      '<div class="actions"><button type="button" class="btn" data-drop>Remove</button></div>';
    box.querySelector('span').textContent = where + ' · goes back with the decision';
    const area = box.querySelector('textarea');
    area.dataset.where = where;
    area.addEventListener('input', count);
    line.after(box);
    line.classList.add('commented');
    area.focus();
    count();
  }

  function comments() {
    return [...document.querySelectorAll('.thread textarea')]
      .map((t) => ({ where: t.dataset.where, text: t.value.trim() }))
      .filter((c) => c.text);
  }
  function count() {
    const n = comments().length;
    const btn = document.querySelector('[data-send-back]');
    if (btn) btn.textContent = n > 0 ? 'Send back with ' + n + ' comment' + (n === 1 ? '' : 's') : 'Send back';
  }

  // the theme switch: the system's theme by default; a click flips light ↔ dark and remembers the
  // pick in a cookie (the server renders it next time) — unless the pick is the system's own again
  const themeButton = document.querySelector('[data-theme-switch]');
  const systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const effective = () => document.documentElement.dataset.theme || (systemDark && systemDark.matches ? 'dark' : 'light');
  const labelTheme = () => {
    if (!themeButton) return;
    const to = effective() === 'dark' ? 'light' : 'dark';
    themeButton.setAttribute('aria-label', 'Switch to the ' + to + ' theme');
    themeButton.title = 'Switch to the ' + to + ' theme';
  };
  if (themeButton) {
    labelTheme();
    systemDark?.addEventListener?.('change', labelTheme);
    themeButton.addEventListener('click', () => {
      const next = effective() === 'dark' ? 'light' : 'dark';
      const system = systemDark && systemDark.matches ? 'dark' : 'light';
      if (next === system) {
        delete document.documentElement.dataset.theme;
        document.cookie = 'jarvis_theme=; Path=/; SameSite=Strict; Max-Age=0';
      } else {
        document.documentElement.dataset.theme = next;
        document.cookie = 'jarvis_theme=' + next + '; Path=/; SameSite=Strict; Max-Age=31536000';
      }
      const meta = document.querySelector('meta[name=color-scheme]');
      if (meta) meta.setAttribute('content', document.documentElement.dataset.theme || 'light dark');
      labelTheme();
    });
  }

  // system notifications: a run that starts waiting for you while this page is not in front says so
  // through the system; the bell asks the browser once (a click), the choice stays in this browser.
  // A run whose card waits in a terminal is left to the terminal, which notifies by itself.
  const bell = document.querySelector('[data-notify]');
  const canNotify = 'Notification' in window;
  const stored = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const notifyOn = () => canNotify && Notification.permission === 'granted' && stored('jarvis_notify', 'off') === 'on';
  function labelBell() {
    if (!bell) return;
    const state = !canNotify ? 'unsupported' : Notification.permission === 'denied' ? 'blocked' : notifyOn() ? 'on' : 'off';
    bell.dataset.state = state;
    bell.setAttribute('aria-pressed', String(state === 'on'));
    const title = {
      on: 'Notifications on: a run that waits for you says so — click to turn off',
      off: 'Notify me when a run waits for me',
      blocked: 'Notifications are blocked for this page in the browser settings',
      unsupported: 'This browser has no system notifications',
    }[state];
    bell.title = title;
    bell.setAttribute('aria-label', title);
  }
  const seenOf = () => { try { return JSON.parse(stored('jarvis_notified', '{}')) || {}; } catch { return {}; } };
  let baseline = true;
  async function checkWaiting() {
    if (!bell) return;
    let data;
    try {
      const res = await fetch('/waiting.json', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return;
    }
    const seen = seenOf();
    const now = Date.now();
    for (const [key, at] of Object.entries(seen)) if (now - at > 7 * 86400000) delete seen[key];
    for (const w of data.waiting || []) {
      const key = w.id + ':' + w.parked;
      if (seen[key]) continue;
      seen[key] = now;
      // what waits when the page opens is on the page; a terminal at the card notifies by itself
      if (baseline || w.terminal || !notifyOn() || document.hasFocus()) continue;
      try {
        const n = new Notification('Jarvis: ' + w.what, { body: w.task + '\\n' + w.workflow + ' · run ' + w.id, tag: 'jarvis-' + key });
        n.onclick = () => { window.focus(); location.href = w.href || '/runs/' + w.id; n.close(); };
      } catch {
        /* a browser that only notifies from a service worker: the page still shows it */
      }
    }
    baseline = false;
    store('jarvis_notified', JSON.stringify(seen));
  }
  if (bell) {
    labelBell();
    checkWaiting();
    setInterval(checkWaiting, 20000);
    bell.addEventListener('click', async () => {
      if (!canNotify) return;
      if (Notification.permission === 'granted') store('jarvis_notify', notifyOn() ? 'off' : 'on');
      else if (Notification.permission === 'default') {
        const answer = await Notification.requestPermission();
        if (answer === 'granted') store('jarvis_notify', 'on');
      }
      labelBell();
    });
  }

  // the header's indicators — models and MCP: a dot that says how they are doing, details in a popover
  // on click; the numbers come from the server's last round, so a click never waits for the journal
  function indicator(name, url) {
    const button = document.querySelector('[data-' + name + ']');
    const pop = document.getElementById(name + '-pop');
    let busy = false;
    function show(data) {
      button.querySelector('.dot').dataset.state = data.state;
      button.title = data.title;
      button.setAttribute('aria-label', data.title);
      // ∞ while a model is not limited (unlimited hours, a pool with no limits)
      const badge = button.querySelector('[data-badge]');
      if (badge) {
        badge.textContent = data.badge || '';
        badge.hidden = !data.badge;
      }
      const body = pop.querySelector('[data-' + name + '-body]');
      if (body) {
        body.innerHTML = data.html;
        inPhase(body);
      }
      // the server is still collecting or checking: ask again shortly; the popover says it waits
      if (data.state === 'pending' || data.checking) setTimeout(() => refresh(), 1500);
    }
    async function refresh() {
      if (!button || !pop || busy) return;
      busy = true;
      try {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (res.ok) show(await res.json());
      } catch {
        /* the next tick tries again */
      } finally {
        busy = false;
      }
    }
    function setOpen(open) {
      if (!button || !pop) return;
      pop.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      // on a phone the popover is fixed to the window's width, right under the button (the header wraps)
      pop.style.top = open && window.innerWidth <= 640 ? button.getBoundingClientRect().bottom + 8 + 'px' : '';
      if (open) {
        for (const other of indicators) if (other.pop !== pop) other.setOpen(false);
        refresh();
      }
    }
    if (button && pop) {
      refresh();
      setInterval(refresh, 10000);
      button.addEventListener('click', () => setOpen(pop.hidden));
    }
    return { button, pop, refresh, show, setOpen };
  }
  const indicators = [];
  const models = indicator('models', '/models.json');
  const mcp = indicator('mcp', '/mcp.json');
  indicators.push(models, mcp);
  async function refreshModels() {
    await models.refresh();
    await mcp.refresh();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const x of indicators) if (x.pop && !x.pop.hidden) { x.setOpen(false); x.button.focus(); }
  });
  document.addEventListener('click', async (e) => {
    // a click on something the refresh just replaced is no click outside
    if (!e.target.isConnected) return;
    const check = e.target.closest('[data-mcp-check]');
    if (check) {
      // "Check now": the server connects to each MCP server anew; the popover follows the check
      check.disabled = true;
      try {
        const res = await fetch('/mcp/check', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 't=' + encodeURIComponent(check.dataset.mcpCheck),
        });
        if (res.ok) mcp.show(Object.assign(await res.json(), { checking: true }));
      } catch {
        check.disabled = false;
      }
      return;
    }
    for (const x of indicators) if (x.pop && !x.pop.hidden && !e.target.closest('[data-pop-wrap]')) x.setOpen(false);
  });

  // "New task" from the header: straight into the text box
  const focusNew = () => { if (location.hash === '#new') document.querySelector('#new textarea')?.focus(); };
  window.addEventListener('hashchange', focusNew);
  focusNew();

  document.addEventListener('change', (e) => {
    if (e.target.matches('select[data-autosubmit]')) e.target.form.submit();
  });

  // the decision form carries the line comments as \`path:line — text\` (ADR-0019 §5)
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.matches('[data-decision]')) {
      const field = form.querySelector('input[name=lines]');
      if (field) field.value = JSON.stringify(comments());
    }
    for (const b of form.querySelectorAll('button')) setTimeout(() => { b.disabled = true; }, 0);
  });
})();
`;
