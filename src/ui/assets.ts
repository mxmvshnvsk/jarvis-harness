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
select,textarea,input[type=text]{font-family:inherit;font-size:14px;color:var(--ink);border:1px solid var(--field-line);border-radius:6px;background:var(--panel)}
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
.feed li{display:flex;gap:14px;font-size:13px;line-height:19px;align-items:baseline}
.feed time{font-family:var(--mono);color:var(--muted);width:64px;flex-shrink:0}
.feed li span{flex:1;min-width:0;overflow-wrap:anywhere}
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
        // something typed and not sent yet (a comment, an amount) stays: the refresh waits for it
        if ([...el.querySelectorAll('textarea, input[type=number]')].some((t) => t.value)) continue;
        inPhase(fresh);
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
