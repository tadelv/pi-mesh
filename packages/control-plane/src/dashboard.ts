// SPDX-License-Identifier: GPL-3.0-or-later

export const dashboard = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Pi Mesh Control Plane</title>
  <style>
    :root {
      color-scheme: light;
      --line-height: 18px;
      --sidebar-width: 320px;
      --body-bg: #f5f6f7;
      --container-bg: #fff;
      --info-bg: #edf0f2;
      --text: #20262b;
      --dim: #56616a;
      --muted: #697680;
      --accent: #176b86;
      --selectedBg: #dcecf1;
      --userMessageBg: #e7f0f3;
      --userMessageText: #20262b;
      --assistantBg: transparent;
      --toolPendingBg: #edf0f2;
      --toolSuccessBg: #e8f2ed;
      --toolErrorBg: #f8e9e7;
      --warning: #76500a;
      --error: #a32d22;
      --success: #286341;
      --border: #cbd1d5;
      --focus: #176b86;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --body-bg: #1c2023;
        --container-bg: #24292d;
        --info-bg: #2b3135;
        --text: #e4e8ea;
        --dim: #b3bdc3;
        --muted: #9ba7ae;
        --accent: #82c9df;
        --selectedBg: #303d42;
        --userMessageBg: #29383e;
        --userMessageText: #e4e8ea;
        --assistantBg: transparent;
        --toolPendingBg: #292f33;
        --toolSuccessBg: #263730;
        --toolErrorBg: #3b2c2b;
        --warning: #edc879;
        --error: #ff9589;
        --success: #8ad1a5;
        --border: #424b50;
        --focus: #82c9df;
      }
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      background: var(--body-bg);
      color: var(--text);
      font: 12px/var(--line-height) ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace;
      font-variant-numeric: tabular-nums;
    }
    ::selection { background: var(--selectedBg); color: var(--text); }
    :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    button, input, textarea { font: inherit; color: inherit; }
    button {
      min-height: 30px;
      padding: 4px 9px;
      border: 1px solid var(--border);
      border-radius: 3px;
      background: var(--container-bg);
      cursor: pointer;
    }
    button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    button:disabled { opacity: .55; cursor: wait; }
    input, textarea {
      min-height: 30px;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 3px;
      background: var(--body-bg);
    }
    textarea { min-height: 64px; resize: vertical; }
    a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .topbar {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 52px;
      padding: 8px 16px;
      background: var(--container-bg);
      border-bottom: 1px solid var(--border);
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 13px; line-height: 18px; }
    h2 { font-size: 13px; line-height: 18px; }
    h3 { font-size: 12px; line-height: 18px; }
    .topbar h1 { margin-right: auto; }
    .workspace { display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); min-height: calc(100vh - 52px); }
    .sidebar {
      position: sticky;
      top: 0;
      align-self: start;
      height: calc(100vh - 52px);
      min-height: 360px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: var(--container-bg);
      border-right: 1px solid var(--border);
    }
    .sidebar-head { padding: 12px; border-bottom: 1px solid var(--border); }
    .sidebar-head label { display: block; margin-bottom: 5px; color: var(--dim); }
    #search { width: 100%; }
    #session-list { overflow: auto; padding: 4px 0; }
    .session-link {
      display: block;
      width: 100%;
      min-height: 0;
      padding: 7px 12px;
      border: 0;
      border-radius: 0;
      text-align: left;
      background: transparent;
      color: var(--text);
    }
    .session-link:hover, .session-link[aria-current="true"] { background: var(--selectedBg); color: var(--text); }
    .session-name, .session-project { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-name { font-weight: 700; }
    .session-project, .session-age, .dim { color: var(--dim); }
    .agent-label { padding: 9px 12px 4px; color: var(--muted); border-top: 1px solid var(--border); }
    .empty { padding: 12px; color: var(--dim); }
    .content { min-width: 0; max-width: 1000px; width: 100%; padding: 18px 24px 40px; }
    .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
    #status, #auth-note { min-height: 18px; color: var(--dim); }
    #status[data-error="true"] { color: var(--error); }
    #pairing { margin: 8px 0 14px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--warning); }
    #auth { padding: 10px 0 16px; }
    #auth label { display: block; margin-bottom: 6px; }
    #auth input { width: min(100%, 420px); }
    .session-heading { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
    .session-heading h2 { overflow-wrap: anywhere; }
    .transcript { display: flex; flex-direction: column; gap: 18px; padding: 16px 0; }
    .entry { min-width: 0; }
    .entry-meta { display: flex; gap: 10px; margin-bottom: 4px; color: var(--dim); font-size: 10px; }
    .entry-role { font-weight: 700; color: var(--accent); }
    .entry.assistant .entry-role { color: var(--success); }
    .entry.tool-result .entry-role, .entry.meta-entry .entry-role { color: var(--muted); }
    .entry-body { max-width: 75ch; overflow-wrap: anywhere; white-space: pre-wrap; }
    .entry.user .entry-body { padding: 8px 10px; background: var(--userMessageBg); color: var(--userMessageText); }
    .entry.assistant .entry-body { padding: 0; }
    .entry.tool-call, .entry.tool-result, .entry.meta-entry { padding: 7px 10px; background: var(--info-bg); }
    .entry.tool-call { background: var(--toolPendingBg); }
    .entry.tool-result { background: var(--toolSuccessBg); }
    .entry.tool-result.failed { background: var(--toolErrorBg); }
    details.tool-payload { margin-top: 6px; color: var(--dim); }
    details.tool-payload summary { cursor: pointer; }
    pre { margin: 6px 0 0; max-width: 100%; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); font: inherit; }
    .transcript-actions { display: flex; gap: 8px; padding-top: 6px; border-top: 1px solid var(--border); }
    .agent-section { padding: 15px 0; border-bottom: 1px solid var(--border); }
    .agent-title { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; margin-bottom: 9px; }
    .agent-section h3 { margin: 12px 0 5px; }
    .job { padding: 6px 0; border-top: 1px solid var(--border); }
    .job-line { overflow-wrap: anywhere; }
    .job form, .agent-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
    .agent-form label { display: flex; gap: 5px; align-items: center; }
    .agent-form textarea { width: min(100%, 420px); }
    .agent-form input { width: min(100%, 280px); }
    .result { margin: 6px 0; color: var(--warning); white-space: pre-wrap; overflow-wrap: anywhere; }
    .notice { margin: 8px 0; padding: 8px 10px; background: var(--info-bg); color: var(--dim); overflow-wrap: anywhere; }
    .notice.warning { color: var(--warning); }
    [hidden] { display: none !important; }
    @media (max-width: 760px) {
      .workspace { display: block; }
      .sidebar { position: static; height: min(38vh, 300px); min-height: 150px; border-right: 0; border-bottom: 1px solid var(--border); }
      .content { padding: 14px 12px 28px; }
      .topbar { padding-inline: 12px; }
      .session-heading { align-items: flex-start; flex-direction: column; gap: 3px; }
    }
    @media (prefers-reduced-motion: no-preference) {
      .entry { animation: arrive .18s ease-out both; }
      @keyframes arrive { from { opacity: .65; transform: translateY(3px); } to { opacity: 1; transform: none; } }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <h1 id="title">Pi Mesh</h1>
    <button id="pair" type="button">Pair agent</button>
    <button id="sync" type="button">Sync</button>
  </header>
  <div class="workspace">
    <aside class="sidebar" aria-label="Sessions">
      <div class="sidebar-head"><label for="search">Find a session</label><input id="search" type="search" placeholder="Name or project" autocomplete="off"></div>
      <nav id="session-list" aria-label="Recent sessions"></nav>
    </aside>
    <main class="content">
      <form id="auth" hidden>
        <label for="auth-token">Paste dashboard token</label>
        <input id="auth-token" type="password" autocomplete="off" placeholder="pi-mesh-control-plane token">
        <button type="submit">Connect</button>
      </form>
      <p id="auth-note" role="status"></p>
      <p id="status" role="status"></p>
      <p id="pairing"></p>
      <section id="transcript-panel" hidden aria-live="polite"></section>
      <section id="agents" aria-label="Agents and jobs"></section>
    </main>
  </div>
<script>
(() => {
  // Paste the dashboard token once; it stays in localStorage and is sent only
  // as X-Pi-Mesh-Ui, never read from or written into a URL.
  let token = localStorage.getItem('pi_mesh_token') || '';
  const root = document.querySelector('#agents');
  const sessionList = document.querySelector('#session-list');
  const transcriptPanel = document.querySelector('#transcript-panel');
  const messages = new Map();
  const node = (tag, text, parent) => { const e = document.createElement(tag); if(text !== undefined) e.textContent = String(text ?? ''); parent.append(e); return e; };
  function needToken(message) { token = ''; localStorage.removeItem('pi_mesh_token'); document.querySelector('#auth').hidden = false; document.querySelector('#auth-note').textContent = message || ''; root.replaceChildren(); sessionList.replaceChildren(); }
  async function api(path, method='GET', body) {
    const r = await fetch(path, {method, headers:{'X-Pi-Mesh-Ui':token, ...(body === undefined ? {} : {'content-type':'application/json'})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const result = await r.json();
    if(!r.ok) { const error=Error(result.message || result.error || ('Request failed: '+r.status)); error.status=r.status; if(r.status === 401) needToken('The dashboard token was rejected. Paste it again.'); throw error; }
    return result;
  }
  let state;
  let selected;
  const relative = new Intl.RelativeTimeFormat(undefined, {numeric:'auto'});
  function ago(value) {
    const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
    const units = [[31536000,'year'],[2592000,'month'],[604800,'week'],[86400,'day'],[3600,'hour'],[60,'minute'],[1,'second']];
    for(const [size, name] of units) if(Math.abs(seconds) >= size || size === 1) return relative.format(Math.round(seconds / size), name);
    return 'unknown time';
  }
  function basename(path) { return String(path || 'unknown project').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'unknown project'; }
  function visibleSessions() {
    const term = document.querySelector('#search').value.trim().toLowerCase();
    return state.sessions.filter(session => {
      const agent = state.agents.find(candidate => candidate.peer_id === session.agent_id);
      return (session.name+' '+session.session_id+' '+session.project+' '+(agent?.name || '')).toLowerCase().includes(term);
    }).sort((a,b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }
  function renderSessions() {
    sessionList.replaceChildren();
    if(!state) return;
    const sessions = visibleSessions();
    if(!sessions.length) { node('p', state.sessions.length ? 'No sessions match this search.' : 'No sessions synced yet.', sessionList).className = 'empty'; return; }
    let lastAgent = '';
    for(const session of sessions) {
      if(session.agent_id !== lastAgent) {
        lastAgent = session.agent_id;
        const agent = state.agents.find(candidate => candidate.peer_id === lastAgent);
        node('div', agent?.name || lastAgent, sessionList).className = 'agent-label';
      }
      const button = node('button', undefined, sessionList);
      button.type = 'button';
      button.className = 'session-link';
      button.setAttribute('aria-current', selected?.agentId === session.agent_id && selected?.sessionId === session.session_id ? 'true' : 'false');
      node('span', (session.name || session.session_id)+' - '+basename(session.project), button).className = 'session-name';
      node('span', ago(session.updated_at), button).className = 'session-age';
      button.addEventListener('click', () => void openSession(session.agent_id, session.session_id));
    }
  }
  function showMessage(parent, key) {
    const message = messages.get(key);
    if(message) node('p', message.text, parent).className = 'result';
  }
  async function act(agent, action, body, key) {
    try {
      const result = await api('/api/agents/'+encodeURIComponent(agent.peer_id)+'/'+action, 'POST', body);
      if(result.ok === false) {
        const why = result.code === -32102 ? 'This machine has not enabled execution. ' : '';
        messages.set(key, {kind:'refusal', text:why+'Agent said: “'+String(result.message ?? '')+'”'});
      } else messages.set(key, {kind:'success', text:'Action completed.'});
    } catch(error) { messages.set(key, {kind:'transport', text:error.message || 'The agent could not be reached.'}); }
    try { await load(); } catch(error) { render(); showMessage(root, key); }
  }
  function parseEntry(event) {
    if(typeof event.data !== 'string') return event.data || {};
    try { return JSON.parse(event.data); } catch { return {text:event.data}; }
  }
  function payload(parent, label, value) {
    const details = node('details', undefined, parent);
    details.className = 'tool-payload';
    node('summary', label+' (expand)', details);
    const pre = node('pre', typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2), details);
    return pre;
  }
  function renderEntry(event, parent) {
    const data = parseEntry(event);
    const type = String(data.type || event.type || 'entry');
    const message = data.message && typeof data.message === 'object' ? data.message : data;
    const role = String(message.role || data.role || '');
    const cssRole = type === 'session_info' || type === 'model_change' ? 'meta-entry' : role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : role === 'toolResult' || role === 'tool' ? 'tool-result' : type === 'tool_call' ? 'tool-call' : 'meta-entry';
    const entry = node('article', undefined, parent);
    entry.className = 'entry '+cssRole;
    if(cssRole === 'tool-result' && (message.isError || data.isError)) entry.classList.add('failed');
    const meta = node('div', undefined, entry);
    meta.className = 'entry-meta';
    const label = type === 'session_info' ? 'Session info' : type === 'model_change' ? 'Model change' : role === 'toolResult' || role === 'tool' ? 'Tool result' : type === 'tool_call' ? 'Tool call' : role || type;
    node('span', label, meta).className = 'entry-role';
    const time = node('time', event.timestamp ? new Date(event.timestamp).toLocaleString() : '', meta);
    if(event.timestamp) time.dateTime = event.timestamp;
    const body = node('div', undefined, entry);
    body.className = 'entry-body';
    if(type === 'session_info') {
      node('div', data.name || data.cwd || 'Session details updated', body);
      if(data.cwd && data.name) node('div', data.cwd, body).className = 'dim';
    } else if(type === 'model_change') {
      node('div', [data.provider, data.modelId || data.model].filter(Boolean).join(' / ') || 'Model settings updated', body);
    } else if(type === 'tool_call') {
      payload(body, 'Tool call', data);
    } else if(cssRole === 'tool-result') {
      payload(body, data.toolName || data.name || 'Tool output', message.content ?? data.content ?? data);
    } else {
      const content = message.content ?? data.text ?? data.content;
      const parts = Array.isArray(content) ? content : [{type:'text', text:content}];
      for(const part of parts) {
        if(!part || typeof part !== 'object') { if(part != null) node('div', part, body); continue; }
        if(part.type === 'text') node('div', part.text || '', body);
        else if(part.type === 'thinking') payload(body, 'Thinking', part.thinking || part.text || '');
        else if(part.type === 'toolCall' || part.type === 'tool_call') payload(body, 'Tool call · '+(part.name || part.toolName || 'tool'), part.arguments || part.input || {});
        else if(part.type === 'image') node('div', 'Image attachment', body).className = 'dim';
        else payload(body, part.type || 'Content', part);
      }
      if(!body.childNodes.length && type !== 'message') node('div', data.text || type, body);
    }
  }
  async function fetchSessionPage(agentId, sessionId, before, all) {
    const query = all ? '?all=1' : before ? '?before='+encodeURIComponent(before) : '';
    return api('/api/sessions/'+encodeURIComponent(agentId)+'/'+encodeURIComponent(sessionId)+query);
  }
  async function openSession(agentId, sessionId) {
    selected = {agentId, sessionId};
    // Every await below re-checks ownership before touching the transcript. A
    // slow request for one session must never render over, or erase, another
    // session the operator has since opened.
    const owner = selected;
    renderSessions();
    transcriptPanel.hidden = false;
    transcriptPanel.replaceChildren();
    node('p', 'Loading session…', transcriptPanel).className = 'dim';
    try {
      const data = await fetchSessionPage(agentId, sessionId);
      if(selected === owner) renderTranscript(data, owner);
    } catch(error) {
      if(selected !== owner) return;
      transcriptPanel.replaceChildren();
      node('p', error.message, transcriptPanel).className = 'result';
    }
  }
  // The owner is the selection this transcript belongs to. Paging controls carry
  // it because they outlive the click that opened them: a page that arrives
  // after a different session was opened belongs to a transcript that is gone.
  function renderTranscript(data, owner) {
    transcriptPanel.replaceChildren();
    const session = state.sessions.find(item => item.agent_id === owner.agentId && item.session_id === owner.sessionId);
    const heading = node('header', undefined, transcriptPanel);
    heading.className = 'session-heading';
    node('h2', session?.name || selected.sessionId, heading);
    node('span', basename(session?.project), heading).className = 'dim';
    if(data.stale) node('p', 'Cached transcript · agent offline', transcriptPanel).className = 'notice';
    const list = node('div', undefined, transcriptPanel);
    list.className = 'transcript';
    for(const event of data.events) renderEntry(event, list);
    const actions = node('div', undefined, transcriptPanel);
    actions.className = 'transcript-actions';
    if(data.hasEarlier) {
      const earlier = node('button', 'Load earlier entries', actions);
      earlier.addEventListener('click', async () => {
        const oldest = data.events[0]?.entry_id;
        if(!oldest) return;
        earlier.disabled = true;
        try {
          const older = await fetchSessionPage(owner.agentId, owner.sessionId, oldest);
          if(selected !== owner) return;
          const combined = {...data, events:[...older.events, ...data.events], hasEarlier:older.hasEarlier};
          renderTranscript(combined, owner);
        } catch(error) {
          if(selected !== owner) return;
          node('span', error.message, actions).className = 'result';
          earlier.disabled = false;
        }
      });
    }
    if(!data.all && data.total > data.events.length) {
      const all = node('button', 'Load all '+data.total+' entries', actions);
      all.addEventListener('click', async () => {
        all.disabled = true;
        try {
          const everything = await fetchSessionPage(owner.agentId, owner.sessionId, undefined, true);
          if(selected === owner) renderTranscript(everything, owner);
        } catch(error) {
          if(selected !== owner) return;
          node('span', error.message, actions).className = 'result';
          all.disabled = false;
        }
      });
    }
  }
  function showTransportNotice() {
    if(state.execution_transport && state.execution_transport !== 'confidential') {
      node('p', state.execution_transport === 'insecure_override'
        ? 'Warning: execution is allowed over this plaintext connection (--allow-insecure-execution). Anyone who captures a dashboard request can spawn on an opted-in agent.'
        : 'Execution is unavailable over this connection. It needs TLS or loopback, or PI_MESH_ALLOW_INSECURE_EXECUTION=1 on a LAN you trust.', root).className = 'notice warning';
    }
  }
  function renderAgent(agent) {
    const section = node('section', undefined, root);
    section.className = 'agent-section';
    const head = node('header', undefined, section);
    head.className = 'agent-title';
    node('h2', agent.name, head);
    node('span', agent.host+':'+agent.port, head).className = 'dim';
    const capable = agent.controls.spawn;
    if(capable) node('p', 'Execution enabled on this agent.', section).className = 'dim';
    else {
      const status = agent.skills === null ? 'Execution capability unknown (agent has not been reached).' : 'Execution is not advertised by this agent.';
      node('p', status, section).className = 'dim';
      const controlLabel = node('label', 'Control id to copy ', section);
      const controlId = node('input', undefined, controlLabel); controlId.readOnly = true; controlId.value = state.control.id;
      const copy = node('button', 'Copy id', section);
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(state.control.id); copy.textContent = 'Copied'; }
        catch { controlId.select(); copy.textContent = 'Select and copy'; }
      });
      node('p', 'Start the agent with --allow-execution='+state.control.id, section).className = 'dim';
    }
    if(capable) {
      const form = node('form', undefined, section); form.className = 'agent-form';
      const projectLabel = node('label', 'Project ', form); const project = node('input', undefined, projectLabel); project.required = true;
      const promptLabel = node('label', 'Prompt ', form); const prompt = node('textarea', undefined, promptLabel); prompt.required = true;
      const cwdLabel = node('label', 'Working directory (optional) ', form); const cwd = node('input', undefined, cwdLabel);
      node('button', 'Start', form);
      form.addEventListener('submit', event => {
        event.preventDefault();
        if(!window.confirm('Start a session on '+agent.name+'?')) return;
        void act(agent, 'spawn', {project:project.value, prompt:prompt.value, ...(cwd.value ? {cwd:cwd.value} : {})}, agent.peer_id+':spawn');
      });
      showMessage(section, agent.peer_id+':spawn');
    }
    const jobs = state.jobs.filter(job => job.agent_id === agent.peer_id);
    const jobsFresh = typeof agent.jobs_synced_at === 'number';
    const jobsAge = jobsFresh ? Date.now() - agent.jobs_synced_at : 0;
    const jobsAgeLabel = jobsAge < 60_000 ? Math.floor(jobsAge / 1000)+'s ago' : Math.floor(jobsAge / 60_000)+'m ago';
    node('h3', jobsFresh ? 'Jobs — from the agent ('+jobsAgeLabel+')' : 'Jobs — cached, not synced from this agent', section);
    if(jobs.length === 0) node('p', jobsFresh ? 'No jobs reported by the agent.' : 'No cached jobs.', section).className = 'dim';
    for(const job of jobs) {
      const item = node('div', undefined, section); item.className = 'job';
      node('p', job.project+' — '+job.job_id+' ('+job.state+(jobsFresh ? '' : ' (last known)')+')', item).className = 'job-line';
      const key = agent.peer_id+':'+job.job_id;
      if(agent.controls.stop) { const stop = node('button', 'Stop', item); stop.addEventListener('click', () => void act(agent, 'stop', {job_id:job.job_id}, key+':stop')); }
      if(agent.controls.abort) { const abort = node('button', 'Abort', item); abort.addEventListener('click', () => void act(agent, 'abort', {job_id:job.job_id}, key+':abort')); }
      if(job.state === 'running' && agent.controls.steer) {
        const steer = node('form', undefined, item); steer.className = 'job form';
        const messageLabel = node('label', 'Steer ', steer); const message = node('input', undefined, messageLabel); message.required = true;
        node('button', 'Send', steer);
        steer.addEventListener('submit', event => { event.preventDefault(); void act(agent, 'steer', {job_id:job.job_id, message:message.value}, key+':steer'); });
      }
      showMessage(item, key+':stop'); showMessage(item, key+':abort'); showMessage(item, key+':steer');
    }
  }
  function render() {
    root.replaceChildren(); if(!state) return;
    document.querySelector('#title').textContent = state.control.name;
    showTransportNotice();
    renderSessions();
    if(selected) {
      const session = state.sessions.find(item => item.agent_id === selected.agentId && item.session_id === selected.sessionId);
      if(session && transcriptPanel.hidden === false) void refreshSelected();
    }
    for(const agent of state.agents) renderAgent(agent);
  }
  let refreshPending = false;
  async function refreshSelected() {
    if(refreshPending || !selected) return;
    refreshPending = true;
    const current = selected;
    try {
      const data = await fetchSessionPage(current.agentId, current.sessionId);
      if(selected === current) renderTranscript(data, current);
    } catch {} finally { refreshPending = false; }
  }
  async function load(){ state=await api('/api/state'); render(); }
  async function sync(){ await api('/api/sync','POST'); await load(); }
  document.querySelector('#search').addEventListener('input', renderSessions);
  document.querySelector('#sync').addEventListener('click', async()=>{ try { await sync(); document.querySelector('#status').textContent=''; document.querySelector('#status').removeAttribute('data-error'); } catch(e){ const status=document.querySelector('#status'); status.textContent=e.message; status.dataset.error='true'; } });
  document.querySelector('#pair').addEventListener('click', async()=>{ try { const result=await api('/api/pair/token','POST'); document.querySelector('#pairing').textContent='Token: '+result.token+'\\nRun on the agent: pi-mesh-agent pair '+result.token+' --control-host '+location.hostname+':'+location.port; } catch(e){ document.querySelector('#pairing').textContent=e.message; } });
  document.querySelector('#auth').addEventListener('submit', event => {
    event.preventDefault(); token = document.querySelector('#auth-token').value.trim();
    if(!token) return;
    localStorage.setItem('pi_mesh_token', token); void connect();
  });
  async function connect() {
    try { await load(); document.querySelector('#auth').hidden = true; document.querySelector('#auth-note').textContent = ''; }
    catch(error) { if(error.status !== 401) { document.querySelector('#auth').hidden = true; root.textContent = error.message; } }
  }
  if(!token) needToken('Paste the dashboard token to connect. Get it with: pi-mesh-control-plane token');
  else void connect();
})();
</script>
</body>
</html>`;
