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
  --ground:#F7F7F5;--panel:#FFFFFF;--sunken:#F4F3F0;--line:#E7E5E0;--line-soft:#EFEEEA;--field-line:#D9D6CF;
  --ink:#1B1A18;--ink-2:#45433E;--muted:#615F58;--faint:#8F8C84;--faint-2:#6B6962;
  --accent:#3256C8;--accent-dark:#22409E;--accent-soft:#EEF1FB;--accent-fill:#3256C8;--accent-fill-hover:#22409E;
  --primary-fill:#1B1A18;--primary-fill-hover:#3A3934;--on-primary:#FFFFFF;--hover:#EFEEEA;
  --r-sm:6px;--r:8px;--r-lg:12px;
  --lift:0 1px 2px rgba(24,22,18,.04),0 4px 16px rgba(24,22,18,.04);--lift-btn:0 1px 1px rgba(24,22,18,.04);
  --on-fill:#FFFFFF;--info-bg:#E6ECFB;--wait-bg:#FBEFD9;--wait:#7A4100;
  --ok:#1E7A3E;--ok-bg:#E7F4EA;--ok-ink:#14552B;--ok-fill:#1E7A3E;
  --bad:#B3261E;--bad-fill:#B3261E;--bad-bg:#FBECEA;--chip:#F2F1EE;--focus-row:#FBF4E6;--track:#ECEBE7;--border-btn:#D9D6CF;
  --spin-track:#C9D5F5;--code-on-banner:rgba(255,255,255,.6);--warn-dot:#C27A12;--held:#7C5CD6;--shadow:rgba(20,20,18,.14);
  --sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}`;

const DARK = `
  color-scheme:dark;
  --ground:#121211;--panel:#1A1A18;--sunken:#161614;--line:#2B2B28;--line-soft:#232320;--field-line:#3A3A36;
  --ink:#EDECE8;--ink-2:#CFCDC6;--muted:#A19F97;--faint:#7A7871;--faint-2:#8F8D86;
  --accent:#8EA8FF;--accent-dark:#B6C8FF;--accent-soft:#1E2438;--accent-fill:#3559C9;--accent-fill-hover:#2A49AD;
  --primary-fill:#EDECE8;--primary-fill-hover:#FFFFFF;--on-primary:#121211;--hover:#22221F;
  --lift:0 1px 2px rgba(0,0,0,.3);--lift-btn:none;
  --on-fill:#FFFFFF;--info-bg:#1E2740;--wait-bg:#36270F;--wait:#F2B861;
  --ok:#6CCB88;--ok-bg:#16301E;--ok-ink:#9BE0AF;--ok-fill:#23793F;
  --bad:#FF948A;--bad-fill:#C2362C;--bad-bg:#3A1B18;--chip:#242421;--focus-row:#2A2214;--track:#2A2A27;--border-btn:#3E3E3A;
  --spin-track:#2E3A5C;--code-on-banner:rgba(0,0,0,.25);--warn-dot:#F2B861;--held:#9B82F0;--shadow:rgba(0,0,0,.5);
`;

export const STYLE = `
${LIGHT}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}:root:not([data-theme=light]) .theme .sun{display:block}:root:not([data-theme=light]) .theme .moon{display:none}}
:root[data-theme=dark]{${DARK}}
:root[data-theme=light]{color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}a:hover{color:var(--accent-dark)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.mono,code,pre{font-family:var(--mono)}
.muted{color:var(--muted)}
.ok{color:var(--ok)}.warn{color:var(--wait)}.bad{color:var(--bad)}
.skip-link{position:absolute;left:-9999px}.skip-link:focus{left:16px;top:8px;background:var(--panel);padding:8px;z-index:9}
.top{background:color-mix(in srgb,var(--ground) 86%,transparent);-webkit-backdrop-filter:saturate(1.4) blur(10px);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
/* the header stays while the page scrolls: the models' and MCP popovers are looked at often (pilot);
   on a narrow screen it wraps into rows and would eat the page, so it scrolls away there */
@media (min-width:720px){.top{position:sticky;top:0;z-index:40}html{scroll-padding-top:72px}}
.wrap{max-width:1240px;margin:0 auto;padding:0 24px}
.top .bar{min-height:56px;padding:10px 24px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 6px}
.brand{display:inline-flex;align-items:center;gap:8px;margin-right:14px;font-family:var(--mono);font-weight:600;font-size:15px;color:var(--ink);text-decoration:none}
.brand .mark{width:16px;height:16px;border-radius:5px;background:var(--ink)}
.top nav a{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 10px;border-radius:var(--r);color:var(--muted);text-decoration:none;font-size:14px}
.top nav .n{font-size:12px;color:var(--faint);font-weight:400}
.top nav .n.w{color:var(--wait);font-weight:600}
.newtask-btn{margin-left:6px}
.newtask-btn svg{width:14px;height:14px}
.newtask-btn kbd{font-family:var(--mono);font-size:11px;line-height:14px;padding:0 5px;border-radius:4px;background:rgba(127,127,127,.25);color:inherit}
.crumb{font-size:13px;margin-bottom:-16px}
.crumb a{color:var(--muted);text-decoration:none}
.crumb a:hover{color:var(--ink)}
.top nav a:hover{background:var(--hover);color:var(--ink)}
.top nav a[aria-current=page]{background:var(--panel);color:var(--ink);font-weight:500;box-shadow:0 0 0 1px var(--line)}
.back{font-size:14px;padding:10px 0}
.repo{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--muted);min-width:0}
/* pilot: one long repository name stretched the select across the top bar and pushed the status off it */
.repo select{width:auto;max-width:220px;height:32px;text-overflow:ellipsis}
select,textarea,input[type=text],input[type=search]{font-family:inherit;font-size:14px;color:var(--ink);border:1px solid var(--field-line);border-radius:var(--r);background:var(--panel)}
textarea:focus,input[type=text]:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
textarea::placeholder,input::placeholder{color:var(--faint);opacity:1}
/* a search field drawn by the page, not the system's inset box */
input[type=search]{-webkit-appearance:none;appearance:none;box-shadow:none;outline-offset:0}
input[type=search]::placeholder{color:var(--faint);opacity:1}
input[type=search]:hover{border-color:var(--border-btn)}
input[type=search]:focus{border-color:var(--accent)}
input[type=search]:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-soft)}
select{height:36px;padding:0 8px;max-width:60vw}
input.amount{height:36px;width:11em;padding:0 10px;font-family:inherit;font-size:14px;color:var(--ink);border:1px solid var(--field-line);border-radius:var(--r);background:var(--panel)}
.status{margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.status .live{padding:0 8px}
.live{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
.live[data-state=live] .dot{background:var(--ok)}
.live[data-state=lost] .dot{background:var(--bad)}
.theme{display:inline-flex;align-items:center;justify-content:center;min-height:32px;min-width:32px;padding:0 8px;border:1px solid transparent;border-radius:var(--r);background:transparent;color:var(--ink-2);font-family:inherit;font-size:13px;cursor:pointer}
.theme:hover{background:var(--hover);color:var(--ink)}
.notify[aria-pressed=true]{color:var(--accent);border-color:var(--accent)}
.notify[data-state=blocked],.notify[data-state=unsupported]{opacity:.55}
.theme svg{width:16px;height:16px}
a.theme{text-decoration:none}
.report{padding:20px 24px;display:flex;flex-direction:column;gap:14px;max-width:820px}
.report .grow{flex:1 1 auto}
.report h2{margin:0;font-size:16px}
.report .field>span{color:var(--ink);font-weight:500}
.report .field>span .hint{font-weight:400;margin-left:4px}
.report input[type=text]{height:40px;padding:0 12px;border-radius:8px}
.rgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
@media (max-width:640px){.rgrid{grid-template-columns:1fr}}
.rattach{margin:0;padding:4px 14px 12px;border:1px solid var(--line);border-radius:8px}
.rattach legend{padding:0 6px;font-size:13px;font-weight:500}
.rattach code{font-size:12px}
.rtext{margin:0;padding:14px 16px;background:var(--sunken);border-radius:8px;font-size:12.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow:auto}
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
.models{display:inline-flex;align-items:center;gap:7px;min-height:30px;padding:0 10px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--muted);font-family:var(--sans);font-size:12.5px;cursor:pointer}
.models:hover,.models[aria-expanded=true]{background:var(--hover);color:var(--ink)}
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
h1{margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere}
h2{margin:0;font-size:16px;line-height:22px;font-weight:600}
h3{margin:0;font-size:18px;line-height:24px;font-weight:600;overflow-wrap:anywhere}
.lede{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 20px}
.lede .muted{font-size:13.5px}
section.group{display:flex;flex-direction:column;gap:14px}
.cards{display:flex;flex-wrap:wrap;gap:16px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--lift);min-width:0}
.card{flex:1 1 420px;padding:20px;display:flex;flex-direction:column;gap:12px}
.decision{padding:22px 24px;display:flex;flex-direction:column;gap:16px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.meta{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.pill{display:inline-flex;align-items:center;gap:6px;min-height:22px;padding:0 9px;border-radius:999px;font-size:12px;font-weight:500;line-height:16px;white-space:nowrap}
.pill.wait{background:var(--wait-bg);color:var(--wait)}
.pill.info{background:var(--info-bg);color:var(--accent-dark)}
.pill.ok{background:var(--ok-bg);color:var(--ok-ink)}
.pill.bad{background:var(--bad-bg);color:var(--bad)}
.pill.plain{background:var(--chip);color:var(--ink-2)}
.tf-all{display:flex;flex-direction:column;gap:16px}
.choose{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.choose .opt{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 10px;border-radius:8px;cursor:pointer}
.choose .opt.rec{background:var(--accent-soft)}
.choose .opt .hint{margin-left:auto}
.redo{padding:14px 20px}
.redo summary{cursor:pointer}
.redo-body{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.redo-body select,.redo-body textarea{font:inherit;font-size:15px;padding:8px 10px;border:1px solid var(--field-line);border-radius:8px;background:var(--panel);color:var(--ink)}
.tf-check{padding:18px 20px;display:flex;flex-direction:column;gap:14px}
.tf-check h2{margin:0;font-size:17px}
.tf{border:1px solid var(--line);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;min-width:0}
.tf-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;min-width:0}
.tf-head h3{margin:0;font-size:16px;overflow-wrap:anywhere}
.tf-head .grow{flex:1 1 auto}
.tf-facts{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px 14px;margin:0}
.tf-facts dt{color:var(--muted);font-size:14px}
.tf-facts dd{margin:0;min-width:0}
.tf-facts pre,.tf-tail{margin:0;padding:8px 10px;border-radius:8px;background:var(--chip);font-family:var(--mono);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
.tf-facts code.ok{color:var(--ok-ink)}.tf-facts code.bad{color:var(--bad)}
.tf-frames{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.chip{display:inline-block;padding:2px 8px;border-radius:6px;background:var(--chip);font-family:var(--mono);font-size:12px;font-weight:600}
p{margin:0}
.card p,.decision p{font-size:14px;line-height:21px;color:var(--ink-2)}
.actions{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:0 14px;border-radius:var(--r);border:1px solid var(--border-btn);background:var(--panel);box-shadow:var(--lift-btn);font-family:inherit;font-size:14px;font-weight:500;color:var(--ink);text-decoration:none;cursor:pointer;transition:background .12s,border-color .12s}
.btn:hover{background:var(--sunken);border-color:var(--border-btn);color:var(--ink)}
.btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--panel),0 0 0 4px var(--accent)}
.btn.primary{background:var(--primary-fill);border-color:var(--primary-fill);color:var(--on-primary);box-shadow:none}
.btn.primary:hover{background:var(--primary-fill-hover);border-color:var(--primary-fill-hover);color:var(--on-primary)}
.btn.accept{background:var(--ok-fill);border-color:var(--ok-fill);color:var(--on-fill);font-weight:500}
.btn.accept:hover{color:var(--on-fill);filter:brightness(1.08)}
.btn.strong{border-color:var(--ink);font-weight:500}
.btn.small{min-height:30px;padding:0 10px;font-size:13px;border-radius:var(--r-sm)}
.btn.big{min-height:40px;font-size:14px;padding:0 18px}
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
/* fewer boxes: an empty section is one quiet line; the waits a list of rows; the steps and «Redo» on the page */
section.group>.panel.empty,section.group>[data-live=recent]>.panel.empty{background:none;border:0;box-shadow:none;padding:2px 0;color:var(--faint)}
section.group>.cards{flex-direction:column;flex-wrap:nowrap;gap:0;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--lift);overflow:hidden}
section.group>.cards>.card{flex:none;border:0;border-radius:0;box-shadow:none;border-top:1px solid var(--line-soft);padding:14px 18px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 20px;align-items:center}
section.group>.cards>.card:first-child{border-top:0}
section.group>.cards>.card>*{grid-column:1}
section.group>.cards>.card>.actions{grid-column:2;grid-row:1/span 3;justify-content:flex-end}
section.group>.cards>.card h3{font-size:15px;line-height:22px;font-weight:500}
section.group>.cards>.card p{font-size:13px;line-height:19px;color:var(--muted)}
@media (max-width:720px){section.group>.cards>.card{grid-template-columns:minmax(0,1fr)}section.group>.cards>.card>.actions{grid-column:1;grid-row:auto;justify-content:flex-start}}
.panel.side.steps{background:none;border:0;box-shadow:none;padding:4px 0 0;flex:0 1 280px}
.panel.side.steps h2{font-size:13px;font-weight:500;color:var(--faint);margin-bottom:6px;padding-left:8px}
.step.focus{background:var(--panel);box-shadow:0 0 0 1px var(--line)}
details.panel.redo{background:none;border:0;box-shadow:none;padding:0 2px}
details.panel.redo>summary{color:var(--muted);font-size:13.5px}
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
.tests-stop .rounds-strip{display:flex;gap:8px;flex-wrap:wrap}
.tests-stop .rb{display:flex;flex-direction:column;gap:2px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:13px;min-width:150px}
.tests-stop .rb.bad{border-color:var(--bad-bg);background:var(--bad-bg)}
.tests-stop .said{margin:0;border-left:3px solid var(--field-line);padding:6px 0 6px 12px;font-size:14px;line-height:1.5;color:var(--ink-2);display:flex;flex-direction:column;gap:2px}
.tests-stop form{display:flex;flex-direction:column;gap:12px}
.tests-stop .choices{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.tests-stop .choice{display:grid;grid-template-columns:20px minmax(0,1fr);gap:10px;align-items:start;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);cursor:pointer}
.tests-stop .choice input{margin:3px 0 0;accent-color:var(--ink)}
.tests-stop .choice>span{display:flex;flex-direction:column;gap:2px;font-size:14px}
.tests-stop .choice .about{font-size:13px;color:var(--muted)}
.tests-stop .choice:has(input:checked){border-color:var(--ink);box-shadow:0 0 0 1px var(--ink)}
.tests-stop .checkout-fold summary{cursor:pointer}
.clarify .answers{display:flex;flex-wrap:wrap;gap:8px}
.clarify .answers .btn{white-space:normal;text-align:left;height:auto;min-height:32px;padding:6px 12px}
.steer{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center}
.steer .hint{display:none}
/* the dock: the page's actions at the bottom of the screen, the full width behind them */
.dock{position:sticky;bottom:0;z-index:30;margin-top:auto;padding:12px 0;background:color-mix(in srgb,var(--panel) 92%,transparent);-webkit-backdrop-filter:saturate(1.4) blur(10px);backdrop-filter:saturate(1.4) blur(10px);box-shadow:0 0 0 100vmax color-mix(in srgb,var(--panel) 92%,transparent),0 -6px 24px rgba(24,22,18,.05);clip-path:inset(-24px -100vmax 0 -100vmax);border-top:1px solid var(--line);border-image:linear-gradient(var(--line),var(--line)) 1/1px 0 0 0/0 100vmax 0 100vmax}
.dock-in{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.dock .what{display:flex;flex-direction:column;gap:1px;min-width:0;flex:0 1 auto}
.dock .what b{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dock .what span{font-size:12.5px;color:var(--muted)}
.dock .grow{flex:1 1 auto}
.dock form{display:inline}
kbd.key{font-family:var(--mono);font-size:11px;padding:0 5px;border-radius:4px;border:1px solid var(--field-line);color:var(--muted)}
main.wrap{min-height:calc(100vh - 57px)}
main.wrap:has(>.dock){padding-bottom:0}
.steer .swf{display:inline}
.sw{display:inline-flex;align-items:center;gap:8px;border:0;background:none;padding:2px 0;font:inherit;font-size:14px;color:var(--ink);cursor:pointer}
.sw i{width:32px;height:18px;border-radius:999px;background:var(--border-btn);position:relative;display:inline-block;flex:none;transition:background .15s}
.sw i::after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:var(--on-primary);box-shadow:0 1px 2px rgba(0,0,0,.2)}
.sw.on i{background:var(--primary-fill)}
.sw.on i::after{left:16px}
.sw:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.tf-log{display:flex;flex-direction:column;gap:10px}
.tf-log .log{margin:0;padding:12px 14px;border-radius:10px;background:var(--sunken);border:1px solid var(--line);font-family:var(--mono);font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;max-height:none}
.tf-log mark{background:var(--bad-bg);color:var(--bad)}
.tf-log .fold{display:block;margin:2px 0}
.tf-log .fold>summary{cursor:pointer;color:var(--muted);list-style:none}
.tf-log .fold>summary::-webkit-details-marker{display:none}
.tf-log .fold[open]>summary{margin-bottom:2px}
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
.banner.warn{background:var(--wait-bg);color:var(--wait)}
.banner code{background:var(--code-on-banner);padding:1px 4px;border-radius:4px}
.doc{padding:24px;font-size:15px;line-height:1.6;overflow-wrap:anywhere}
.doc h2{font-size:20px;margin:22px 0 8px}.doc h2:first-child{margin-top:0}
.doc h3{font-size:17px;margin:18px 0 6px}.doc h4,.doc h5,.doc h6{font-size:15px;margin:14px 0 4px}
.doc p{margin:0 0 10px}
.doc ul,.doc ol{margin:0 0 10px;padding-left:22px}
.doc li{margin:2px 0}
.doc code{background:var(--chip);padding:1px 5px;border-radius:4px;font-size:13px}
code.sym>span,a.ref code>span{display:inline-block;max-width:100%;overflow-wrap:anywhere}
code .cq{color:var(--muted)}
.toast{white-space:pre-line;position:fixed;right:16px;bottom:16px;z-index:50;max-width:min(520px,calc(100vw - 32px));padding:10px 14px;border-radius:10px;font-size:13px;overflow-wrap:anywhere;box-shadow:0 4px 16px rgba(0,0,0,.18)}.toast.ok{background:var(--ok-bg);color:var(--ok-ink)}.toast.bad{background:var(--bad-bg);color:var(--bad)}
a.ref{text-decoration:none}a.ref code{color:var(--accent)}a.ref:hover code{text-decoration:underline}
.dl .n a{color:inherit;text-decoration:none}.dl .n a:hover{color:var(--accent);text-decoration:underline}.fname a.open{text-decoration:none;font-size:12px}
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
.newtask .composer{border:1px solid var(--field-line);border-radius:10px;background:var(--panel)}
.newtask .composer:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.newtask .composer textarea{display:block;width:100%;box-sizing:border-box;min-height:76px;border:0;outline:0;resize:vertical;padding:12px 14px 6px;font:inherit;font-size:15px;line-height:1.45;background:transparent;color:var(--ink)}
.newtask .cbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid var(--line-soft)}
.newtask .grow{flex:1 1 auto}
.newtask .pick{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 10px 0 8px;border:1px solid var(--field-line);border-radius:8px;background:var(--sunken);font-size:14px;color:var(--ink);cursor:pointer;white-space:nowrap;list-style:none;max-width:100%}
.newtask .pick::-webkit-details-marker{display:none}
.newtask .pick:hover{border-color:var(--faint)}
.newtask .pick.still{cursor:default}
.newtask .where[open]>.pick{border-color:var(--accent);background:var(--panel)}
.newtask .pick .ic{width:18px;height:18px;border-radius:5px;background:var(--accent-soft);color:var(--accent-dark);display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex:none}
.newtask .pick .ic.all{background:var(--chip);color:var(--held)}
.newtask .pick .car{color:var(--muted);font-size:11px}
.newtask .badge{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--line-soft);color:var(--muted);white-space:nowrap}
.newtask .badge.lib{background:var(--chip);color:var(--held)}
.newtask .where{position:relative}
.newtask .pop{position:absolute;z-index:5;left:0;top:calc(100% + 6px);width:min(380px,calc(100vw - 48px));max-height:420px;overflow:auto;background:var(--panel);border:1px solid var(--field-line);border-radius:12px;box-shadow:0 12px 32px rgba(20,20,18,.16);padding:8px;display:flex;flex-direction:column;gap:2px}
.newtask .pop .find{height:36px;border:1px solid var(--field-line);border-radius:8px;padding:0 10px;font-size:14px;margin-bottom:6px}
.newtask .grp{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--faint-2);padding:8px 8px 4px}
.newtask .opt{position:relative;display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:2px 8px;align-items:center;padding:7px 8px;border-radius:8px;font-size:14px;cursor:pointer}
.newtask .opt[hidden]{display:none}
.newtask .opt:hover{background:var(--sunken)}
.newtask .opt input{position:absolute;opacity:0;pointer-events:none}
.newtask .opt .ck{visibility:hidden;color:var(--accent);font-weight:700}
.newtask .opt:has(input:checked){background:var(--accent-soft)}
.newtask .opt:has(input:checked) .ck{visibility:visible}
.newtask .opt:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:-2px}
.newtask .opt .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.newtask .opt .p{grid-column:2/4;font-family:var(--mono);font-size:11px;color:var(--faint-2);overflow-wrap:anywhere}
.newtask .pop .none{margin:6px 8px;font-size:13px;color:var(--muted)}
.newtask .seg{display:inline-flex;flex-wrap:wrap;padding:3px;border-radius:9px;background:var(--line-soft);gap:2px}
.newtask .seg label{position:relative;display:inline-flex}
.newtask .seg input{position:absolute;opacity:0;pointer-events:none}
.newtask .seg span{display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:7px;font-size:14px;color:var(--ink-2);cursor:pointer;white-space:nowrap}
.newtask .seg input:checked+span{background:var(--panel);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(20,20,18,.14)}
.newtask .seg input:focus-visible+span{outline:2px solid var(--accent);outline-offset:1px}
.newtask .seg input:disabled+span{color:var(--faint);cursor:not-allowed}
.newtask .what{font-size:13px;color:var(--muted);margin:0}
.newtask .cnote{display:flex;gap:8px;align-items:baseline;font-size:13px;color:var(--ink-2);padding:8px 10px;border-radius:8px;background:var(--accent-soft)}
.newtask .linkish{border:0;background:none;padding:0;font:inherit;color:var(--accent);text-decoration:underline;cursor:pointer}
.newtask .more{font-size:13px}
.newtask .more summary{cursor:pointer;color:var(--muted)}
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
.qs .q{display:grid;grid-template-columns:28px minmax(0,1fr);gap:4px 10px;padding:16px 20px;margin:0;border:0;border-bottom:1px solid var(--line);min-width:0}
.qs .q .n{font-family:var(--mono);font-size:13px;color:var(--muted);padding-top:2px}
.qs .q .n.ok{color:var(--ok)}
.qs .q .body{display:flex;flex-direction:column;gap:8px;min-width:0}
.qs .q .qtext{font-size:15px;line-height:22px;color:var(--ink);margin:0}
.qs .q .about{display:flex;gap:6px;flex-wrap:wrap}
.qs .q .tag{font-family:var(--mono);font-size:11px;padding:2px 8px;border-radius:999px;background:var(--chip);color:var(--ink-2)}
.qs .q .lbl{display:block;font-size:12px;font-weight:500;color:var(--accent);margin:0 0 2px}
.qs .q .guess .lbl,.qs .q p.lbl{color:var(--muted)}
.qs .q .opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:8px;cursor:pointer;background:var(--panel)}
.qs .q .opt:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.qs .q .opt input{margin-top:3px;accent-color:var(--accent);flex:none}
.qs .q .opt>span{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.qs .q .said{font-size:14px;line-height:21px;color:var(--ink);white-space:pre-wrap}
.qs .q .opt small{color:var(--muted);font-size:12px}
.qs .q .src{display:flex;gap:6px;flex-wrap:wrap}
.qs .q .src>span,.qs .q .src>a{font-family:var(--mono);font-size:11px;padding:1px 7px;border-radius:6px;border:1px solid var(--line);color:var(--ink-2)}
.qs .q .src>a{color:var(--accent);text-decoration:none}.qs .q .src>a:hover{border-color:var(--accent)}
.qs .q .src a.ref code{font-size:11px}
.qs .q .own textarea{width:100%;min-height:40px;padding:8px 10px;border-radius:6px;resize:vertical;font-size:14px;line-height:20px}
.qs .q .qrow{display:flex;gap:8px;flex-wrap:wrap}
.qs .q .pick{display:inline-flex;gap:6px;align-items:center;font-size:13px;color:var(--ink-2);padding:5px 10px;border:1px solid var(--line);border-radius:999px;cursor:pointer}
.qs .q .pick:has(input:checked){border-color:var(--wait);color:var(--wait)}
.qs .q .pick input{margin:0;accent-color:var(--wait)}
.qs .q .done{font-size:14px;line-height:21px;padding:8px 12px;border-radius:8px;background:var(--ok-bg);color:var(--ink);white-space:pre-wrap}
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
.tryit .checks{margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:10px}
.tryit .checks .rq{font-size:14px}
.tryit .checks ul{margin:4px 0 0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.tryit .checks label{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:19px;color:var(--ink-2);cursor:pointer}
.tryit .checks input{margin-top:3px}
.tryit .checks label:has(input:checked){color:var(--muted);text-decoration:line-through}
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
.notesw>summary .warn,.notesw>summary .ok{font-size:13px;white-space:nowrap}
.notesw>summary .d{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
.notesw .planbox{display:flex;flex-direction:column;gap:10px}
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
.headact{gap:8px;flex-shrink:0;align-items:flex-start}
.now .resumed{display:block;margin-top:2px}
.headact form{margin:0}
.cancel{position:relative;flex-shrink:0}
.cancel>summary{list-style:none;width:max-content}
.cancel>summary::-webkit-details-marker{display:none}
.timew{position:relative;display:inline-block;cursor:default;border-bottom:1px dashed var(--muted);color:var(--ink)}
.timew .work{color:var(--muted)}
.timew .tpop{display:none;position:absolute;left:-12px;top:calc(100% + 10px);z-index:30;width:420px;max-width:calc(100vw - 32px);padding:16px 18px;border-radius:12px;border:1px solid var(--line);background:var(--panel);box-shadow:0 16px 40px var(--shadow);font-family:var(--sans,inherit);font-size:13px;color:var(--ink);flex-direction:column;gap:12px;white-space:normal;cursor:auto}
.timew:hover .tpop,.timew:focus .tpop,.timew:focus-within .tpop{display:flex}
@media (max-width:640px){.timew .tpop{position:fixed;left:16px;right:16px;top:50%;width:auto;max-width:none;max-height:80vh;overflow:auto;transform:translateY(-50%)}}
.tpop .ttl{font-size:14px;font-weight:600}
.tpop .bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--chip)}
.tpop .bar i{display:block;height:100%}
.tpop .w{background:var(--accent)}.tpop .h{background:var(--warn-dot)}.tpop .b{background:var(--held)}.tpop .p{background:var(--faint)}
.tpop table{border-collapse:collapse;width:100%}
.tpop td{padding:5px 0;vertical-align:top}
.tpop td.k{display:flex;gap:8px;align-items:center}
.tpop td.k i{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
.tpop td.v{text-align:right;font-family:var(--mono);white-space:nowrap}
.tpop td.pc{text-align:right;color:var(--muted);font-family:var(--mono);width:44px}
.tpop .sub{color:var(--muted);font-size:12px;line-height:17px;padding-left:18px}
.tpop tr.total td{border-top:1px solid var(--line-soft);padding-top:9px;font-weight:600}
.tpop .note{color:var(--muted);font-size:12px;line-height:17px}
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
/* Knowledge → Services */
.banner.wait{background:var(--wait-bg);color:var(--wait)}
.sv-todo{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
.kr.sv{grid-template-columns:minmax(0,1fr) minmax(0,1.5fr) minmax(0,1fr) minmax(0,1.1fr);align-items:start;padding:12px 20px}
.kr.sv>span{min-width:0;overflow-wrap:anywhere}
.sv-name{display:flex;flex-direction:column;gap:4px;align-items:flex-start;min-width:0}
.sv-name a{text-decoration:none;overflow-wrap:anywhere}
.sv-sub{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;font-size:13px;margin-top:4px}
.sv-about{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sv-check{white-space:nowrap;font-size:13px;color:var(--ok-ink)}
.sv-miss{color:var(--wait);font-size:13px}
p.sv-miss{font-size:14px}
.sv-opt{font-size:13px}
.sub-pub{flex:1 1 100%;margin:0}
.start-order{padding:18px 20px;display:flex;flex-direction:column;gap:8px}
.start-order h2{margin:0;font-size:16px}
.start-list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px;font-size:14px}
.pill.lib{background:var(--chip);color:var(--held)}
.sub-wait{border:1px dashed var(--line)}
.sv-links{font-size:13px;display:flex;flex-direction:column;gap:2px;min-width:0;overflow-wrap:anywhere}
.sv-legend{padding:12px 20px;margin:0;border-top:1px solid var(--line-soft)}
.pill.front{background:transparent;border:1px solid var(--line);color:var(--ink-2);padding:2px 9px}
.linkbtn{background:none;border:0;padding:0;font:inherit;color:var(--accent);text-decoration:underline;cursor:pointer}
.sg{width:100%;height:auto;font-family:var(--sans);font-size:12px}
.sg-node{fill:var(--panel);stroke:var(--line);stroke-width:1.2}
.sg-node.backend{fill:var(--info-bg);stroke:var(--accent-soft)}
.sg-node.frontend{stroke:var(--ink-2)}
.sg text{fill:var(--ink)}
.sg a:hover .sg-node{stroke:var(--accent)}
.sg-edge{fill:none;stroke:var(--muted);stroke-width:1.3}
.sg-edge.topic{stroke-dasharray:4 4}
.sg-edge.uses{stroke:var(--held);stroke-dasharray:1 3;stroke-linecap:round}
.sg-node.library{fill:var(--panel);stroke:var(--held)}
p.sv-pair{margin:0;font-size:14px}
.sg-head{fill:var(--muted)}
.sv-pair summary{cursor:pointer;font-size:14px}
.sv-pair ul{margin:6px 0 0;padding-left:18px;font-size:13px}
.sv-title{gap:8px 12px}
.sv-h1{margin:0;font-size:24px}
.sv-lead{font-size:15px;line-height:1.55}
.sv-h3{margin:6px 0 0;font-size:14px;font-weight:500}
.sv-kv{display:grid;grid-template-columns:90px minmax(0,1fr);gap:6px 12px;margin:0;font-size:14px}
.sv-kv dt{color:var(--muted)}.sv-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.sv-ep{display:grid;grid-template-columns:48px minmax(0,1fr);gap:6px 8px;align-items:baseline;font-size:13px}
.sv-verb{font-family:var(--mono);font-size:11px;font-weight:500;padding:1px 4px;border-radius:4px;background:var(--chip);text-align:center}
.sv-ep>span{min-width:0;overflow-wrap:anywhere}
.sv-runs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:14px}
.sv-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:var(--accent)}
.sv-dot.ok{background:var(--ok)}.sv-dot.bad{background:var(--bad)}.sv-dot.plain{background:var(--muted)}
@media (max-width:900px){.kr.sv{grid-template-columns:minmax(0,1fr) minmax(0,1.4fr)}}
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
.kdecide{padding:16px 24px;border-top:1px solid var(--line-soft);display:flex;flex-direction:column;gap:12px}
.kdecide form{display:flex;flex-direction:column;gap:8px}
.kdecide input[type=text]{height:40px;padding:0 12px;border-radius:8px;font-size:14px;max-width:480px}
.kdecide input.mono{font-family:var(--mono);font-size:13px}
.kdecide .row{gap:8px}
.kdecide .field>span{color:var(--ink);font-weight:500}
.kdecide .field>span .hint{font-weight:400;margin-left:4px}
.kdecide form+form{padding-top:12px;border-top:1px dashed var(--line-soft)}
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
.field.inline{flex-direction:row;align-items:center;gap:8px;flex-wrap:wrap}
.field.inline select{width:auto;height:36px;flex:none}
.kindline{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:13px;color:var(--muted);margin-top:-4px}
.kchip{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--field-line);border-radius:999px;background:var(--sunken);cursor:pointer}
.kchip label{display:none;cursor:pointer}
.kchip label:has(input:checked),.kchip:hover label,.kchip:focus-within label{display:inline-flex}
.kchip input{position:absolute;opacity:0;pointer-events:none}
.kchip label>span{padding:3px 10px;border-radius:999px;color:var(--ink-2);white-space:nowrap}
.kchip input:checked+span{background:var(--panel);color:var(--ink);font-weight:600;box-shadow:0 0 0 1px var(--line)}
.kchip label:hover>span{color:var(--ink)}
.kchip input:focus-visible+span{outline:2px solid var(--accent);outline-offset:1px}
.kchip .ak{display:none}
.kchip:hover .ak,.kchip:focus-within .ak{display:inline}
.kchip:not(:hover):not(:focus-within) label:has(input:checked)>span::after{content:" ▸";color:var(--faint)}
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
/**
 * The strings the page's script says, given to it in the page's language (src/ui/pages.ts puts them in a
 * JSON block the script reads — not code, so the page's script policy is untouched).
 */
export const CLIENT_STRINGS = [
  "Fold the rest",
  "Show every line",
  "reconnecting…",
  "Copied",
  "Send back",
  "Send back with {n} comment",
  "Send back with {n} comments",
  "Switch to the light theme",
  "Switch to the dark theme",
  "Notifications on: a run that waits for you says so — click to turn off",
  "Notify me when a run waits for me",
  "Notifications are blocked for this page in the browser settings",
  "This browser has no system notifications",
  "run",
  "Could not reach jarvis ui",
] as const;
// t("Fold the rest") t("Show every line") t("reconnecting…") t("Copied") t("Send back") t("Send back with {n} comment") t("Send back with {n} comments") t("Switch to the light theme") t("Switch to the dark theme") t("Notifications on: a run that waits for you says so — click to turn off") t("Notify me when a run waits for me") t("Notifications are blocked for this page in the browser settings") t("This browser has no system notifications") t("run") t("Could not reach jarvis ui")

export const SCRIPT = `
(() => {
  const body = document.body;
  const dict = (() => {
    try {
      return JSON.parse(document.getElementById('jarvis-strings')?.textContent || '{}');
    } catch {
      return {};
    }
  })();
  const T = (key, vars) => (dict[key] || key).replace(/\\{(\\w+)\\}/g, (all, name) => (vars && name in vars ? String(vars[name]) : all));
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

  // "New task": Where (a list of places in a popover) and How far (four segments); the line under the box,
  // the button and what cannot run in the place follow the choice. The research to start from, the
  // restart and the note on linked services are looked up as the task is typed (GET /runs/from)
  const newForm = document.querySelector('form[data-newtask]');
  if (newForm) {
    const startFrom = newForm.querySelector('[data-from]');
    const where = newForm.querySelector('[data-where]');
    const whatLine = newForm.querySelector('[data-said]');
    const taskField = newForm.elements.namedItem('task');
    const LAST = 'jarvis.newtask.repo';
    const radios = (name) => [...newForm.querySelectorAll('input[name="' + name + '"]')];
    const place = () => radios('repo').find((r) => r.checked) || newForm.querySelector('input[name="repo"]');
    const how = () => radios('workflow').find((r) => r.checked);
    const keyOf = (text) => (text.match(/\\b[A-Z][A-Z0-9]+-\\d+\\b/) || [])[0];
    const sync = () => {
      const p = place();
      const across = !!(p && p.hasAttribute('data-across'));
      const name = p ? p.dataset.name || '' : '';
      for (const r of radios('workflow')) {
        const off = across && r.hasAttribute('data-one-only');
        r.disabled = off;
        const label = r.closest('label');
        if (off) label.title = newForm.dataset.oneOnlyTitle;
        else label.removeAttribute('title');
      }
      let h = how();
      if (!h || h.disabled) {
        h = radios('workflow').find((r) => r.value === 'sdd' && !r.disabled) || radios('workflow').find((r) => !r.disabled);
        if (h) h.checked = true;
      }
      if (!h) return;
      const acrossHere = across && h.dataset.acrossWhat;
      const b = document.createElement('b');
      b.textContent = h.dataset.label;
      const key = keyOf(taskField.value || '');
      whatLine.replaceChildren(
        b,
        (acrossHere ? ' ' + newForm.dataset.acrossWord + ' — ' + h.dataset.acrossWhat : ' — ' + h.dataset.what) +
          '.' +
          (key ? ' ' + newForm.dataset.reads.replace('{key}', key) : ''),
      );
      if (where && p) {
        const summary = where.querySelector('summary');
        const icon = document.createElement('span');
        icon.className = across ? 'ic all' : 'ic';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = across ? '◎' : (name[0] || '?').toUpperCase();
        const nm = document.createElement('span');
        nm.textContent = name;
        const badge = p.closest('label').querySelector('.badge');
        summary.replaceChildren(icon, nm, ...(badge ? [badge.cloneNode(true)] : []), summary.querySelector('.car'));
      }
    };
    // the kind of task: the line says what was picked and why; «Change» opens the kinds, «Auto» goes back
    const kindLine = newForm.querySelector('[data-kind-line]');
    const showKind = (headers) => {
      if (!kindLine) return;
      const name = headers.get('X-Task-Kind-Name');
      const why = headers.get('X-Task-Kind-Why');
      if (name) kindLine.querySelector('[data-kind-name]').textContent = decodeURIComponent(name);
      if (why) kindLine.querySelector('[data-kind-why]').textContent = '— ' + decodeURIComponent(why);
    };
    let timer;
    let asked = '';
    const look = () => {
      const p = place();
      const h = how();
      const k = radios('kind').find((r) => r.checked);
      const q = new URLSearchParams({ task: taskField.value, workflow: h ? h.value : '', repo: p ? p.value : '', kind: k ? k.value : '' }).toString();
      if (q === asked) return;
      asked = q;
      fetch('/runs/from?' + q, { headers: { Accept: 'text/html' } })
        .then((res) => {
          if (res.ok && asked === q) showKind(res.headers);
          return res.ok ? res.text() : '';
        })
        .then((text) => {
          if (asked === q) startFrom.innerHTML = text;
        })
        .catch(() => {});
    };
    const choosePlace = (radio, close) => {
      radio.checked = true;
      try {
        localStorage.setItem(LAST, radio.value);
      } catch {}
      if (where && close) {
        where.open = false;
        where.querySelector('summary').focus();
      }
      sync();
      look();
    };
    // the place chosen last time, unless the page is of one repository's runs
    if (!new URL(location.href).searchParams.get('repo')) {
      let last = null;
      try {
        last = localStorage.getItem(LAST);
      } catch {}
      const r = last && radios('repo').find((x) => x.value === last);
      if (r) r.checked = true;
    }
    newForm.addEventListener('input', (e) => {
      const t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-where-find')) {
        const q = t.value.trim().toLowerCase();
        let shown = 0;
        for (const opt of where.querySelectorAll('.opt')) {
          const hit = !q || (opt.dataset.find || '').includes(q);
          opt.hidden = !hit;
          if (hit) shown++;
        }
        where.querySelector('[data-where-none]').hidden = shown > 0;
        return;
      }
      if (!t || t.name !== 'task') return;
      sync();
      clearTimeout(timer);
      timer = setTimeout(look, 300);
    });
    newForm.addEventListener('change', (e) => {
      const t = e.target;
      if (!t) return;
      // arrows move the choice and keep the list open; a click or Enter closes it
      if (t.name === 'repo') choosePlace(t, false);
      else if (t.name === 'workflow' || t.name === 'kind') {
        sync();
        look();
      }
    });
    if (where) {
      where.addEventListener('click', (e) => {
        const opt = e.target.closest('.opt');
        if (opt && e.target.tagName === 'INPUT') choosePlace(e.target, true);
      });
      where.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.name === 'repo') {
          e.preventDefault();
          choosePlace(e.target, true);
        } else if (e.key === 'Enter' && e.target.hasAttribute('data-where-find')) {
          e.preventDefault();
          const first = [...where.querySelectorAll('.opt')].find((o) => !o.hidden);
          if (first) choosePlace(first.querySelector('input'), true);
        } else if (e.key === 'Escape' && where.open) {
          where.open = false;
          where.querySelector('summary').focus();
        }
      });
      where.addEventListener('toggle', () => {
        if (!where.open) return;
        const find = where.querySelector('[data-where-find]');
        const on = place();
        (find || on).focus();
      });
      document.addEventListener('click', (e) => {
        if (where.open && !where.contains(e.target)) where.open = false;
      });
    }
    // the note on linked services: its link changes only Where
    newForm.addEventListener('click', (e) => {
      const cross = e.target.closest('[data-cross]');
      if (!cross) return;
      const r = radios('repo').find((x) => x.value === cross.dataset.repo);
      if (r) choosePlace(r, false);
    });
    sync();
    look();
  }

  // a check's whole output: every fold open at once
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-unfold]');
    if (!b) return;
    const folds = [...b.closest('.tf-log').querySelectorAll('details.fold')];
    const open = folds.some((d) => !d.open);
    for (const d of folds) d.open = open;
    b.textContent = open ? T('Fold the rest') : T('Show every line');
  });

  // N anywhere but in a field: New task, its box in focus
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'n' && e.key !== 'N') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const link = document.querySelector('[data-new-task]');
    if (!link) return;
    e.preventDefault();
    const box = document.querySelector('form[data-newtask] textarea[name="task"]');
    if (box) {
      box.scrollIntoView({ block: 'center' });
      box.focus();
    } else location.href = link.getAttribute('href');
  });

  // failed checks: the button says what the chosen way does
  // (the button is in the dock, outside the form it submits; the dock is refreshed apart from the card)
  function syncChoice() {
    const r = document.querySelector('[data-choices] input[name="choice"]:checked');
    if (!r) return;
    for (const go of document.querySelectorAll('[data-choice-go]')) if (r.dataset.go) go.textContent = r.dataset.go;
    const title = r.closest('label') && r.closest('label').querySelector('b');
    for (const l of document.querySelectorAll('[data-choice-label]')) if (title) l.textContent = title.textContent;
  }
  document.addEventListener('change', (e) => {
    if (e.target && e.target.name === 'choice' && e.target.closest('[data-choices]')) syncChoice();
  });

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
      syncChoice();
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
    source.onerror = () => say('lost', T('reconnecting…'));
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
        copy.textContent = T('Copied');
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
    if (btn) btn.textContent = n > 0 ? T(n === 1 ? 'Send back with {n} comment' : 'Send back with {n} comments', { n }) : T('Send back');
  }

  // the theme switch: the system's theme by default; a click flips light ↔ dark and remembers the
  // pick in a cookie (the server renders it next time) — unless the pick is the system's own again
  const themeButton = document.querySelector('[data-theme-switch]');
  const systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const effective = () => document.documentElement.dataset.theme || (systemDark && systemDark.matches ? 'dark' : 'light');
  const labelTheme = () => {
    if (!themeButton) return;
    const to = effective() === 'dark' ? 'light' : 'dark';
    const switchTo = T(to === 'light' ? 'Switch to the light theme' : 'Switch to the dark theme');
    themeButton.setAttribute('aria-label', switchTo);
    themeButton.title = switchTo;
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
      on: T('Notifications on: a run that waits for you says so — click to turn off'),
      off: T('Notify me when a run waits for me'),
      blocked: T('Notifications are blocked for this page in the browser settings'),
      unsupported: T('This browser has no system notifications'),
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
        const n = new Notification('Jarvis: ' + w.what, { body: w.task + '\\n' + w.workflow + ' · ' + T('run') + ' ' + w.id, tag: 'jarvis-' + key });
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

  // a file a page refers to opens in the editor; the page stays where it is, a toast says what happened
  document.addEventListener('click', async (e) => {
    const ref = e.target.closest('a[href^="/open?"]');
    if (!ref || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    let text = T('Could not reach jarvis ui');
    let ok = false;
    try {
      const res = await fetch(ref.getAttribute('href') + '&js=1', { credentials: 'same-origin' });
      const body = await res.json();
      ok = res.ok;
      text = (ok ? '↗ ' + body.path + ' — opened in ' + body.opened : body.error) + (body.command ? '\\n$ ' + body.command : '');
    } catch {}
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.setAttribute('role', 'status');
      document.body.append(toast);
    }
    toast.className = 'toast ' + (ok ? 'ok' : 'bad');
    toast.textContent = text;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toast.remove(), ok ? 2500 : 6000);
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
