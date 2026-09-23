// SPDX-License-Identifier: GPL-3.0-or-later

export const dashboard = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Mesh Control Plane</title>
<style>body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#222}button,input{font:inherit;padding:.5rem;margin:.25rem}article{border:1px solid #ccc;padding:1rem;margin:1rem 0}small{color:#555}#pairing{white-space:pre-wrap}</style>
<h1 id="title">Pi Mesh</h1><button id="pair">Pair agent</button><button id="sync">Sync</button><p id="pairing"></p><form id="command"><label>Ask <input id="intent-text" type="text" autocomplete="off"></label><button>Send</button></form><p id="intent-note" role="status"></p><label>Filter sessions <input id="filter" type="search"></label><main id="agents"></main>
<script>
(() => {
  const query = new URLSearchParams(location.search);
  const token = query.get('token') || document.cookie.split('; ').find(v => v.startsWith('pi_mesh_ui='))?.slice(11) || '';
  const root = document.querySelector('#agents');
  const node = (tag, text, parent) => { const e = document.createElement(tag); e.textContent = String(text ?? ''); parent.append(e); return e; };
  async function api(path, method='GET', body) { const r = await fetch(path + (token ? (path.includes('?')?'&':'?') + 'token=' + encodeURIComponent(token) : ''), {method, headers:{'X-Pi-Mesh-Ui':token, ...(body === undefined ? {} : {'content-type':'application/json'})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})}); if(!r.ok) { const error=Error('Request failed: '+r.status); error.status=r.status; throw error; } return r.json(); }
  let state, agentFilter;
  async function openSession(agentId, sessionId, item) { try { const data = await api('/api/sessions/'+encodeURIComponent(agentId)+'/'+encodeURIComponent(sessionId)); const out = document.createElement('pre'); out.textContent = JSON.stringify(data.events, null, 2) + (data.stale ? '\\n(cached; agent offline)' : ''); item.append(out); } catch(err) { alert(err.message); } }
  function render() {
    root.replaceChildren(); if(!state) return;
    document.querySelector('#title').textContent = state.control.name;
    const filter = document.querySelector('#filter').value.toLowerCase();
    for (const agent of state.agents.filter(a => !agentFilter || a.peer_id === agentFilter)) {
      const section = document.createElement('article'); root.append(section);
      node('h2', agent.name, section); node('small', agent.host + ':' + agent.port, section);
      const list = document.createElement('ul'); section.append(list);
      for (const session of state.sessions.filter(s => s.agent_id === agent.peer_id && (s.session_id+' '+s.project+' '+(s.name||'')).toLowerCase().includes(filter))) {
        const item = document.createElement('li'); list.append(item);
        const link = document.createElement('a'); link.href = '#'; link.textContent = (session.name || session.session_id) + ' — ' + session.project; item.append(link);
        link.addEventListener('click', e => { e.preventDefault(); openSession(agent.peer_id, session.session_id, item); });
      }
    }
  }
  async function load(){ state=await api('/api/state'); if(!state.intent_enabled){ document.querySelector('#command').hidden=true; document.querySelector('#intent-note').textContent='Natural-language routing is not enabled.'; } render(); }
  async function sync(){ await api('/api/sync','POST'); await load(); }
  document.querySelector('#filter').addEventListener('input', render);
  document.querySelector('#sync').addEventListener('click', async()=>{ try { await sync(); } catch(e){ alert(e.message); } });
  document.querySelector('#pair').addEventListener('click', async()=>{ try { const result=await api('/api/pair/token','POST'); document.querySelector('#pairing').textContent='Token: '+result.token+'\\nRun on the agent: pi-mesh-agent pair '+result.token+' --control-host '+location.hostname+':'+location.port; } catch(e){ alert(e.message); } });
  document.querySelector('#command').addEventListener('submit', async e => {
    e.preventDefault();
    const note=document.querySelector('#intent-note');
    try {
      const result=await api('/api/intent','POST',{text:document.querySelector('#intent-text').value});
      note.textContent=''; agentFilter=undefined;
      if(result.action==='show_devices'){ document.querySelector('#filter').value=''; render(); root.scrollIntoView(); }
      else if(result.action==='show_sessions'){ agentFilter=result.arguments.agent_id; render(); root.scrollIntoView(); }
      else if(result.action==='sync_now') await sync();
      else if(result.action==='open_session') {
        document.querySelector('#filter').value='';
        const agent=state.agents.find(a=>a.peer_id===result.arguments.agent_id);
        const session=state.sessions.find(s=>s.agent_id===result.arguments.agent_id&&s.session_id===result.arguments.session_id);
        if(agent&&session){ render(); const item=[...root.querySelectorAll('li')].find(li=>li.textContent.includes(session.name||session.session_id)); if(item) openSession(agent.peer_id,session.session_id,item); }
      } else note.textContent='I did not understand that';
    } catch(error) {
      if(error.status===501||error.status===503){ document.querySelector('#command').hidden=true; note.textContent='Natural-language routing is not enabled.'; }
      else alert(error.message);
    }
  });
  load().catch(e => { root.textContent=e.message; });
})();
</script></html>`;
