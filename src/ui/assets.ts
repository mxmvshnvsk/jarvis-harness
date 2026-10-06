/**
 * The page's style and its one small script (ADR-0023 §5: no build step, no framework). Served from
 * `/assets/`, so a strict Content-Security-Policy can forbid inline scripts.
 */
export const STYLE = `
:root{
  --ground:#F7F6F3;--panel:#FFFFFF;--line:#E3E1DB;--line-soft:#EFEDE8;--ink:#1D1C1A;--ink-2:#3B3934;
  --muted:#5E5B53;--faint:#8C897F;--accent:#1F4FD1;--accent-dark:#163A9C;--accent-soft:#EEF1FB;
  --info-bg:#E6ECFB;--wait-bg:#FBEFD9;--wait:#7A4100;--ok:#1E7A3E;--ok-bg:#E7F4EA;--ok-ink:#14552B;
  --bad:#B3261E;--bad-bg:#FBECEA;--chip:#F3F1EC;--focus-row:#FBF3E4;--track:#ECEAE4;--border-btn:#C9C6BE;
  --sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.45}
a{color:var(--accent)}a:hover{color:var(--accent-dark)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.mono,code,pre{font-family:var(--mono)}
.muted{color:var(--muted)}
.ok{color:var(--ok)}.warn{color:var(--wait)}.bad{color:var(--bad)}
.skip-link{position:absolute;left:-9999px}.skip-link:focus{left:16px;top:8px;background:#fff;padding:8px;z-index:9}
.top{background:var(--panel);border-bottom:1px solid var(--line)}
.wrap{max-width:1240px;margin:0 auto;padding:0 24px}
.top .wrap{padding-top:12px;padding-bottom:12px;display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px}
.brand{font-family:var(--mono);font-weight:600;font-size:17px;color:var(--ink);text-decoration:none}
.top nav a{display:inline-block;padding:10px 12px;border-radius:6px;color:var(--ink-2);text-decoration:none;font-size:14px}
.top nav a[aria-current=page]{background:var(--accent-soft);color:var(--accent);font-weight:500}
.back{font-size:14px;padding:10px 0}
.repo{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--muted)}
select,textarea,input[type=text]{font-family:inherit;font-size:14px;color:var(--ink);border:1px solid #D4D1C9;border-radius:6px;background:#fff}
select{height:36px;padding:0 8px;max-width:60vw}
.live{margin-left:auto;display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:4px;background:var(--faint)}
.live[data-state=live] .dot{background:var(--ok)}
.live[data-state=lost] .dot{background:var(--bad)}
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
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:8px;border:1px solid var(--border-btn);background:#fff;font-family:inherit;font-size:14px;color:var(--ink);text-decoration:none;cursor:pointer}
.btn:hover{border-color:var(--ink-2);color:var(--ink)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:500}
.btn.primary:hover{background:var(--accent-dark)}
.btn.accept{background:var(--ok);border-color:var(--ok);color:#fff;font-weight:500}
.btn.strong{border-color:var(--ink);font-weight:500}
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
.step.pending .nm b,.step.skipped .nm b{color:#6B6860;font-weight:400}
.step .note{font-size:12px;line-height:17px;color:var(--muted);overflow-wrap:anywhere}
.step .took{font-family:var(--mono);font-size:12px;color:var(--muted);white-space:nowrap}
.reasons{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}
.reasons li{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
.reasons li span:last-child{flex:1 1 300px;font-size:14px;line-height:21px;overflow-wrap:anywhere}
.checkout{border-top:1px solid var(--line-soft);padding-top:16px;display:flex;flex-direction:column;gap:10px}
.path{flex:1 1 320px;min-width:0;padding:10px 12px;border-radius:8px;background:var(--chip);font-size:13px;overflow-x:auto;white-space:nowrap}
.changed{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:8px;background:#FAFAF8;border:1px dashed #D4D1C9;font-family:var(--mono);font-size:13px;overflow-wrap:anywhere}
.changed .hint{font-family:var(--sans)}
.now{padding:20px 24px;display:flex;flex-direction:column;gap:10px}
.spin{width:14px;height:14px;border-radius:7px;border:2px solid #C9D5F5;border-top-color:var(--accent);animation:spin 1s linear infinite;flex-shrink:0}
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
.banner code{background:rgba(255,255,255,.6);padding:1px 4px;border-radius:4px}
.doc{padding:24px;font-size:15px;line-height:1.6;overflow-wrap:anywhere}
.doc h2{font-size:20px;margin:22px 0 8px}.doc h2:first-child{margin-top:0}
.doc h3{font-size:17px;margin:18px 0 6px}.doc h4,.doc h5,.doc h6{font-size:15px;margin:14px 0 4px}
.doc p{margin:0 0 10px}
.doc ul,.doc ol{margin:0 0 10px;padding-left:22px}
.doc li{margin:2px 0}
.doc code{background:var(--chip);padding:1px 5px;border-radius:4px;font-size:13px}
.doc pre{background:#FAFAF8;border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;font-size:13px;line-height:1.5}
.doc pre code{background:none;padding:0}
.doc blockquote{margin:0 0 10px;padding-left:12px;border-left:3px solid var(--line);color:var(--ink-2)}
.doc mark{background:var(--wait-bg);color:var(--wait);padding:0 3px;border-radius:3px}
.doc table{margin:0 0 12px}.doc th,.doc td{padding:6px 10px;border:1px solid var(--line)}
.doc hr{border:0;border-top:1px solid var(--line);margin:16px 0}
.tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--line)}
.tabs a{padding:12px 14px;font-size:14px;color:var(--ink-2);text-decoration:none}
.tabs a[aria-current=true]{color:var(--ink);font-weight:600;border-bottom:2px solid var(--ink)}
.file{overflow:hidden}
.file>summary{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:12px 16px;background:#FAFAF8;cursor:pointer;list-style:none}
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
.dl .cm button{width:22px;height:22px;padding:0;border:1px solid var(--border-btn);border-radius:5px;background:#fff;color:var(--accent);font-size:16px;line-height:18px;cursor:pointer;opacity:.5}
@media (hover:hover){.dl .cm button{opacity:0}.dl:hover .cm button{opacity:1}}
.dl .cm button:focus-visible{opacity:1}
.dl.commented{box-shadow:inset 3px 0 0 var(--accent)}
.thread{padding:12px 16px 14px 120px;background:#FAFAF8;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-family:var(--sans);display:flex;flex-direction:column;gap:8px}
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
.versions span{background:var(--ink);color:#fff}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:640px){
  .wrap{padding:0 16px}
  main.wrap{padding-top:20px;gap:22px}
  h1{font-size:24px;line-height:31px}
  .card{flex-basis:100%;padding:16px}
  .decision{padding:18px}
  .live{margin-left:0}
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

  // replace the live regions with the server's fresh rendering; forms being typed in stay
  let busy = false, again = false;
  async function refresh() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const res = await fetch(location.href, { headers: { 'X-Jarvis-Refresh': '1' }, credentials: 'same-origin' });
      if (!res.ok) return;
      const next = new DOMParser().parseFromString(await res.text(), 'text/html');
      for (const el of document.querySelectorAll('[data-live]')) {
        const fresh = next.querySelector('[data-live="' + el.dataset.live + '"]');
        if (!fresh) continue;
        if (el.contains(document.activeElement) && document.activeElement !== document.body) continue;
        if (el.querySelector('textarea') && [...el.querySelectorAll('textarea')].some((t) => t.value)) continue;
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
    source.addEventListener('journal', (e) => {
      let data = {};
      try { data = JSON.parse(e.data); } catch {}
      if (!runId || (data.runs || []).includes(runId)) refresh();
    });
  }
  const tick = Number(body.dataset.tick || 0);
  if (tick > 0) setInterval(refresh, tick);

  document.addEventListener('click', async (e) => {
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
