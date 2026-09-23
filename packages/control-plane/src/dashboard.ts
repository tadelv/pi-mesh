// SPDX-License-Identifier: GPL-3.0-or-later

export const dashboard = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Mesh Control Plane</title>
<style>body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#222}button,input{font:inherit;padding:.5rem;margin:.25rem}article{border:1px solid #ccc;padding:1rem;margin:1rem 0}small{color:#555}.result{padding:.5rem;background:#f2f2f2;border-left:3px solid #777}#pairing{white-space:pre-wrap}</style>
<h1 id="title">Pi Mesh</h1><form id="auth" hidden><label>Dashboard token <input id="auth-token" type="password" autocomplete="off" size="44" placeholder="pi-mesh-control-plane token"></label> <button>Connect</button></form><p id="auth-note" role="status"></p><button id="pair">Pair agent</button><button id="sync">Sync</button><p id="pairing"></p><p id="status" role="status"></p><label>Filter sessions <input id="filter" type="search"></label><main id="agents"></main>
<script>
(() => {
  // The token is pasted once and kept here. It is deliberately NOT read from
  // the URL or a cookie any more (ADR 0014): a URL token is plaintext, and it
  // ends up in history, referrers and server logs.
  let token = localStorage.getItem('pi_mesh_token') || '';
  const root = document.querySelector('#agents');
  const messages = new Map();
  const node = (tag, text, parent) => { const e = document.createElement(tag); if(text !== undefined) e.textContent = String(text ?? ''); parent.append(e); return e; };
  function needToken(message) { token = ''; localStorage.removeItem('pi_mesh_token'); document.querySelector('#auth').hidden = false; document.querySelector('#auth-note').textContent = message || ''; root.replaceChildren(); }
  async function api(path, method='GET', body) {
    const r = await fetch(path, {method, headers:{'X-Pi-Mesh-Ui':token, ...(body === undefined ? {} : {'content-type':'application/json'})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const result = await r.json();
    if(!r.ok) { const error=Error(result.message || result.error || ('Request failed: '+r.status)); error.status=r.status; if(r.status === 401) needToken('The dashboard token was rejected. Paste it again.'); throw error; }
    return result;
  }
  let state;
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
    } catch(error) {
      messages.set(key, {kind:'transport', text:error.message || 'The agent could not be reached.'});
    }
    try { await load(); }
    catch(error) { render(); showMessage(root, key); }
  }
  async function openSession(agentId, sessionId, item) {
    try { const data = await api('/api/sessions/'+encodeURIComponent(agentId)+'/'+encodeURIComponent(sessionId)); node('pre', JSON.stringify(data.events, null, 2) + (data.stale ? '\\n(cached; agent offline)' : ''), item); }
    catch(err) { node('p', err.message, item); }
  }
  function render() {
    root.replaceChildren(); if(!state) return;
    if(state.execution_transport && state.execution_transport !== 'confidential')
      node('p', state.execution_transport === 'insecure_override'
        ? 'WARNING: execution is allowed over this plaintext connection (--allow-insecure-execution). Anyone who captures a dashboard request can spawn on an opted-in agent.'
        : 'Execution is unavailable over this connection. It needs TLS or loopback, or PI_MESH_ALLOW_INSECURE_EXECUTION=1 on a LAN you trust.', root).className = 'result';
    document.querySelector('#title').textContent = state.control.name;
    const filter = document.querySelector('#filter').value.toLowerCase();
    for (const agent of state.agents) {
      const section = document.createElement('article'); root.append(section);
      node('h2', agent.name, section); node('small', agent.host + ':' + agent.port, section);
      const capable = agent.controls.spawn;
      if(capable) node('p', 'Execution enabled on this agent.', section);
      else {
        const status = agent.skills === null ? 'Execution capability unknown (agent has not been reached).' : 'Execution is not advertised by this agent.';
        node('p', status, section);
        const controlLabel = node('label', 'Control id to copy ', section);
        const controlId = document.createElement('input'); controlId.readOnly = true; controlId.value = state.control.id; controlLabel.append(controlId);
        const copy = node('button', 'Copy id', section);
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(state.control.id); copy.textContent = 'Copied'; }
          catch { controlId.select(); copy.textContent = 'Select and copy'; }
        });
        node('p', 'Start the agent with --allow-execution='+state.control.id, section);
      }
      if(capable) {
        const form = document.createElement('form'); section.append(form);
        const projectLabel = node('label', 'Project ', form); const project = node('input', undefined, projectLabel); project.required = true;
        const promptLabel = node('label', 'Prompt ', form); const prompt = node('textarea', undefined, promptLabel); prompt.required = true;
        const cwdLabel = node('label', 'Working directory (optional) ', form); const cwd = node('input', undefined, cwdLabel);
        node('button', 'Start', form);
        form.addEventListener('submit', event => {
          event.preventDefault();
          if(!window.confirm('Start a session on '+agent.name+'?')) return;
          const body = {project:project.value, prompt:prompt.value, ...(cwd.value ? {cwd:cwd.value} : {})};
          void act(agent, 'spawn', body, agent.peer_id+':spawn');
        });
        showMessage(section, agent.peer_id+':spawn');
      }
      const jobs = state.jobs.filter(job => job.agent_id === agent.peer_id);
      const jobsFresh = typeof agent.jobs_synced_at === 'number';
      const jobsAge = jobsFresh ? Date.now() - agent.jobs_synced_at : 0;
      const jobsAgeLabel = jobsAge < 60_000
        ? Math.floor(jobsAge / 1000)+'s ago'
        : Math.floor(jobsAge / 60_000)+'m ago';
      node('h3', jobsFresh ? 'Jobs — from the agent ('+jobsAgeLabel+')' : 'Jobs — cached, not synced from this agent', section);
      if(jobs.length === 0) node('p', jobsFresh ? 'No jobs reported by the agent.' : 'No cached jobs.', section);
      for(const job of jobs) {
        const item = document.createElement('div'); section.append(item);
        node('p', job.project+' — '+job.job_id+' ('+job.state+(jobsFresh ? '' : ' (last known)')+')', item);
        const key = agent.peer_id+':'+job.job_id;
        if(agent.controls.stop) {
          const stop = node('button', 'Stop', item);
          stop.addEventListener('click', () => void act(agent, 'stop', {job_id:job.job_id}, key+':stop'));
        }
        if(agent.controls.abort) {
          const abort = node('button', 'Abort', item);
          abort.addEventListener('click', () => void act(agent, 'abort', {job_id:job.job_id}, key+':abort'));
        }
        if(job.state === 'running' && agent.controls.steer) {
          const steer = document.createElement('form'); item.append(steer);
          const messageLabel = node('label', 'Steer ', steer); const message = node('input', undefined, messageLabel); message.required = true;
          node('button', 'Send', steer);
          steer.addEventListener('submit', event => { event.preventDefault(); void act(agent, 'steer', {job_id:job.job_id, message:message.value}, key+':steer'); });
        }
        showMessage(item, key+':stop'); showMessage(item, key+':abort'); showMessage(item, key+':steer');
      }
      const list = document.createElement('ul'); section.append(list);
      for (const session of state.sessions.filter(s => s.agent_id === agent.peer_id && (s.session_id+' '+s.project+' '+(s.name||'')).toLowerCase().includes(filter))) {
        const item = document.createElement('li'); list.append(item);
        const link = document.createElement('a'); link.href = '#'; link.textContent = (session.name || session.session_id) + ' — ' + session.project; item.append(link);
        link.addEventListener('click', e => { e.preventDefault(); openSession(agent.peer_id, session.session_id, item); });
      }
    }
  }
  async function load(){ state=await api('/api/state'); render(); }
  async function sync(){ await api('/api/sync','POST'); await load(); }
  document.querySelector('#filter').addEventListener('input', render);
  document.querySelector('#sync').addEventListener('click', async()=>{ try { await sync(); document.querySelector('#status').textContent=''; } catch(e){ document.querySelector('#status').textContent=e.message; } });
  document.querySelector('#pair').addEventListener('click', async()=>{ try { const result=await api('/api/pair/token','POST'); document.querySelector('#pairing').textContent='Token: '+result.token+'\\nRun on the agent: pi-mesh-agent pair '+result.token+' --control-host '+location.hostname+':'+location.port; } catch(e){ document.querySelector('#pairing').textContent=e.message; } });
  document.querySelector('#auth').addEventListener('submit', event => {
    event.preventDefault();
    token = document.querySelector('#auth-token').value.trim();
    if(!token) return;
    localStorage.setItem('pi_mesh_token', token);
    void connect();
  });
  async function connect() {
    try { await load(); document.querySelector('#auth').hidden = true; document.querySelector('#auth-note').textContent = ''; }
    catch(error) { if(error.status !== 401) { document.querySelector('#auth').hidden = true; root.textContent = error.message; } }
  }
  if(!token) needToken('Paste the dashboard token to connect. Get it with: pi-mesh-control-plane token');
  else void connect();
})();
</script></html>`;
