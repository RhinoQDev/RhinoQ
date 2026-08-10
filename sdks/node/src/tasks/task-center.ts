import type { TaskSnapshot } from '../gateway/types.js';
import { TaskListStore, type TaskListClient, type TaskListQuery } from './list-store.js';
import type { TaskBrowserClient } from './store.js';
import { taskUIModel } from './ui.js';

export interface TaskCenterClient extends TaskListClient, TaskBrowserClient {}
export interface TaskCenterNotice { kind: 'success' | 'error' | 'info'; message: string; taskId?: string; }
export interface TaskCenterOptions {
  query?: TaskListQuery;
  pollIntervalMs?: number;
  notify?: (notice: TaskCenterNotice) => void;
  retryCommandId?: (task: TaskSnapshot) => string;
  openResult?: (url: string) => unknown;
  title?: string;
}

export interface TaskCenterPageOptions { apiPath?: string; title?: string; }

/** Self-contained reference page for server frameworks without a React bundle. */
export function rhinoTaskCenterPage(options: TaskCenterPageOptions = {}): string {
  const apiPath = jsonScript(options.apiPath ?? '/tasks');
  const title = escapeHTML(options.title ?? 'Tasks');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${TASK_CENTER_CSS}</style></head><body><main data-rhinoq-task-center aria-busy="true"><h1>${title}</h1><p id="status" role="status">Loading tasks...</p><div id="notice" class="rhinoq-notice" role="status" aria-live="polite"></div><div id="tasks" class="rhinoq-task-list" role="list"></div></main><script>
const api=${apiPath},root=document.querySelector('[data-rhinoq-task-center]'),list=document.getElementById('tasks'),status=document.getElementById('status'),notice=document.getElementById('notice'),byId=new Map(),seen=new Map();let fallback,initial=true;
const labels={pending:'Preparing',queued:'Queued',running:'Running',uncertain:'Awaiting confirmation',succeeded:'Completed',failed:'Failed',cancel_requested:'Cancelling',cancelled:'Cancelled'};
function node(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
async function request(path,init){const response=await fetch(api+path,{credentials:'same-origin',...init,headers:{'content-type':'application/json',...(init&&init.headers)}});if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.message||('Request failed: '+response.status))}return response.json()}
function action(label,run){const b=node('button',label);b.type='button';b.onclick=async()=>{const old=b.textContent;b.disabled=true;b.setAttribute('aria-busy','true');b.textContent='Working…';try{await run();await load()}catch(error){status.textContent=error.message}finally{b.disabled=false;b.removeAttribute('aria-busy');b.textContent=old}};return b}
function completion(task){if(task.state==='succeeded')return ['Finished','is-finished'];if(task.state==='failed')return ['Not finished · Failed','is-ended'];if(task.state==='cancelled')return ['Not finished · Cancelled','is-ended'];return ['Not finished','is-pending']}
function itemCounts(task){const c=task.itemCounts||task.executionCounts||{};return {total:c.total||0,succeeded:c.succeeded||0,failed:c.failed||0,cancelled:c.cancelled||0}}
function progressText(task){const c=itemCounts(task);if(c.total)return (c.succeeded+c.failed+c.cancelled)+' of '+c.total+' item'+(c.total===1?'':'s')+' finished';if(task.progress.total!==undefined)return task.progress.completed+' of '+task.progress.total+' completed';return task.progress.message||task.progress.completed+' completed'}
function explain(task){const progress=progressText(task),c=itemCounts(task);if(task.cancellation&&task.cancellation.status==='cannot_cancel_safely')return ['This work could not be stopped safely',task.cancellation.reason||'Some work may already be running. Check what completed before taking another action.',progress,'Review completed work'];if(task.cancellation&&task.cancellation.status==='too_late')return ['The work finished before cancellation','The cancellation request arrived after completion. Use the recorded result instead of starting the work again.',progress,task.hasResult?'Download result':'Review the result'];if(task.state==='uncertain')return ['The result still needs confirmation','RhinoQ cannot yet prove whether the real-world result happened. Do not repeat the operation until it is checked.',progress,'Check confirmation'];if(c.failed&&c.succeeded)return [c.failed+' item'+(c.failed===1?' needs':'s need')+' attention',c.succeeded+' completed successfully. Review the failed items before retrying only those items.',progress,'Review failed items'];const copy={pending:['Getting ready','The task was accepted and is being prepared.','No action needed'],queued:['Waiting to start','The task is ready and waiting to begin.','Cancel if no longer needed'],running:['Work is in progress',progress,'Cancel if no longer needed'],cancel_requested:['Cancellation is in progress','RhinoQ is waiting for the active work to report what could safely be stopped.','Wait for the final outcome'],cancelled:['The task was stopped','Not all work completed. Review existing results before deciding whether to start again.','Review completed work'],failed:['The task did not finish','Review the failed attempt before retrying so an uncertain external action is not repeated.','Review the failure'],succeeded:[task.hasResult?'Your result is ready':'The work completed','All recorded work completed successfully.',task.hasResult?'Download result':'No action needed']}[task.state]||['Task status updated','Current status: '+(labels[task.state]||task.state)+'.','Review task details'];return [copy[0],copy[1],progress,copy[2]]}
function render(task){const card=node('article');card.className='rhinoq-task';card.setAttribute('role','listitem');const outcome=completion(task),pill=node('span',outcome[0]);pill.className='rhinoq-completion '+outcome[1];card.append(node('strong',task.type),node('span',labels[task.state]||task.state),pill);const p=node('progress');p.value=task.progress.completed;if(task.progress.total!==undefined)p.max=task.progress.total;card.append(p);const guidance=explain(task),explanation=node('section');explanation.className='rhinoq-explanation';explanation.append(node('strong',guidance[0]),node('p',guidance[1]),node('small',guidance[2]+' · Next: '+guidance[3]));card.append(explanation);const actions=node('div');if(task.state==='queued'||task.state==='running')actions.append(action('Cancel task',()=>request('/'+encodeURIComponent(task.id)+'/cancel',{method:'POST',body:JSON.stringify({expectedVersion:task.entityVersion})})));if(task.state==='failed'||task.state==='cancelled')actions.append(action('Retry after review',()=>request('/'+encodeURIComponent(task.id)+'/retry',{method:'POST',body:JSON.stringify({expectedVersion:task.entityVersion,commandId:task.id+'-retry-'+task.entityVersion})})));if(task.hasResult)actions.append(action('Download result',async()=>{const result=await request('/'+encodeURIComponent(task.id)+'/result');location.assign(result.url)}));card.append(actions);return card}
function skeletons(){return [1,2,3].map(()=>{const n=node('article');n.className='rhinoq-task rhinoq-skeleton';n.setAttribute('aria-hidden','true');return n})}
function announce(task,old){if(!old||old===task.state)return;if(task.state==='succeeded')notice.textContent=(task.type||'Task')+' finished.';else if(task.state==='failed')notice.textContent=(task.type||'Task')+' did not finish: failed.';else if(task.state==='cancelled')notice.textContent=(task.type||'Task')+' did not finish: cancelled.'}
function put(task){const old=byId.get(task.id);if(!old||task.entityVersion>old.entityVersion){byId.set(task.id,task);if(!initial)announce(task,seen.get(task.id));seen.set(task.id,task.state)}}
function renderAll(){const tasks=[...byId.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));list.replaceChildren(...tasks.map(render));root.setAttribute('aria-busy','false');status.textContent=tasks.length?tasks.length+' task(s) · '+(fallback?'Polling fallback':'Live'):'No tasks yet. New async work will appear here automatically.';initial=false}
async function load(){status.textContent='Loading tasks...';if(!byId.size)list.replaceChildren(...skeletons());try{const body=await request('');for(const task of body.tasks||[])put(task);renderAll()}catch(error){root.setAttribute('aria-busy','false');status.textContent=error.message}}
function polling(){if(!fallback)fallback=setInterval(load,2000);renderAll()}
load();if(typeof EventSource==='function'){const events=new EventSource(api+'/_events',{withCredentials:true});events.addEventListener('task.page',event=>{const next=JSON.parse(event.data).tasks||[];const keep=new Set(next.map(task=>task.id));for(const id of byId.keys())if(!keep.has(id))byId.delete(id);for(const task of next)put(task);renderAll()});events.addEventListener('task.snapshot',event=>{put(JSON.parse(event.data));renderAll()});events.onopen=()=>{if(fallback){clearInterval(fallback);fallback=undefined}renderAll()};events.onerror=polling}else polling();
</script></body></html>`;
}

/**
 * Dependency-free reference Task Center. It is intentionally small and
 * headless-friendly: applications can use taskUIModel/TaskListStore directly
 * when they need their own design system.
 */
export function mountRhinoTaskCenter(
  root: HTMLElement,
  client: TaskCenterClient,
  options: TaskCenterOptions = {},
): { destroy(): void; refresh(): Promise<TaskSnapshot[]> } {
  if (!root || typeof root.replaceChildren !== 'function') throw new TypeError('Task Center root element is required');
  const store = new TaskListStore(client, options.query, options.pollIntervalMs);
  root.dataset.rhinoqTaskCenter = '1';
  const heading = element('h2', options.title ?? 'Tasks');
  const status = element('p', 'Loading tasks…');
  const list = document.createElement('div');
  status.setAttribute('role', 'status');
  const notice = element('div', '');
  notice.className = 'rhinoq-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  list.setAttribute('role', 'list');
  list.className = 'rhinoq-task-list';
  const style = document.createElement('style');
  style.textContent = TASK_CENTER_CSS;
  root.setAttribute('aria-busy', 'true');
  root.replaceChildren(style, heading, status, notice, list);
  list.replaceChildren(...skeletonCards());
  const previousStates = new Map<string, string>();
  let initialized = false;

  const render = () => {
    const state = store.getSnapshot();
    status.textContent = state.status === 'reconnecting'
      ? 'Connection lost. Retrying…'
      : state.tasks.length === 0 ? 'No tasks yet. New async work will appear here automatically.' : `${state.tasks.length} task(s) - ${state.transport === 'live' ? 'Live' : state.transport === 'polling_fallback' ? 'Polling fallback' : 'Polling'}`;
    if (state.status === 'loading' && state.tasks.length === 0) {
      root.setAttribute('aria-busy', 'true');
      list.replaceChildren(...skeletonCards());
      return;
    }
    root.setAttribute('aria-busy', 'false');
    if (initialized) for (const task of state.tasks) announceCompletion(task, previousStates.get(task.id));
    previousStates.clear();
    for (const task of state.tasks) previousStates.set(task.id, task.state);
    initialized = true;
    list.replaceChildren(...state.tasks.map(renderTask));
  };
  const renderTask = (task: TaskSnapshot): HTMLElement => {
    const ui = taskUIModel(task);
    const card = document.createElement('article');
    card.className = 'rhinoq-task';
    card.setAttribute('role', 'listitem');
    const completion = completionState(task.state);
    const pill = element('span', completion.label);
    pill.className = `rhinoq-completion ${completion.className}`;
    card.append(element('strong', task.type), element('span', ui.label), pill);
    const progress = document.createElement('progress');
    progress.value = ui.progress.completed;
    if (ui.progress.total !== undefined) progress.max = ui.progress.total;
    progress.setAttribute('aria-label', `${ui.progress.completed}${ui.progress.total === undefined ? '' : ` of ${ui.progress.total}`}`);
    card.append(progress);
    const explanation = document.createElement('section');
    explanation.className = 'rhinoq-explanation';
    explanation.append(element('strong', ui.explanation.headline), element('p', ui.explanation.explanation));
    const next = ui.explanation.recommendedAction?.label ?? 'Review task details';
    explanation.append(element('small', `${ui.explanation.progressText} · Next: ${next}`));
    card.append(explanation);
    const actions = document.createElement('div');
    if (ui.canCancel) actions.append(button('Cancel task', async () => action(task, 'cancel')));
    if (ui.canRetry && client.retryTask) actions.append(button('Retry after review', async () => action(task, 'retry')));
    if (ui.hasResult) actions.append(button('Download result', async () => action(task, 'result')));
    card.append(actions);
    return card;
  };
  const announceCompletion = (task: TaskSnapshot, previous?: string) => {
    if (!previous || previous === task.state) return;
    if (task.state !== 'succeeded' && task.state !== 'failed' && task.state !== 'cancelled') return;
    const message = task.state === 'succeeded' ? `${task.type} finished.` : `${task.type} did not finish: ${task.state}.`;
    notice.textContent = message;
    try {
      options.notify?.({ kind: task.state === 'succeeded' ? 'success' : task.state === 'failed' ? 'error' : 'info', message, taskId: task.id });
    } catch { /* notification UI cannot break Task rendering */ }
  };
  const action = async (task: TaskSnapshot, name: 'cancel' | 'retry' | 'result') => {
    try {
      if (name === 'cancel') await client.cancelTask(task.id, task.entityVersion);
      if (name === 'retry') {
        const commandId = options.retryCommandId?.(task) ?? `${task.id}-retry-${task.entityVersion}`;
        await client.retryTask!(task.id, task.entityVersion, commandId);
      }
      if (name === 'result') {
        const result = await client.getTaskResult(task.id);
        const url = typeof result === 'string' ? result : result && typeof result === 'object' && 'url' in result ? String(result.url) : '';
        if (!url) throw new TypeError('Task result has no download URL');
        (options.openResult ?? ((value) => window.location.assign(value)))(url);
      }
      options.notify?.({ kind: 'success', message: `${name} completed`, taskId: task.id });
      await store.refresh();
    } catch (error) {
      options.notify?.({ kind: 'error', message: error instanceof Error ? error.message : String(error), taskId: task.id });
    }
  };
  const unsubscribe = store.subscribe(render);
  store.start();
  render();
  return { destroy: () => { unsubscribe(); store.stop(); root.replaceChildren(); }, refresh: () => store.refresh() };
}

function element<K extends keyof HTMLElementTagNameMap>(name: K, text: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(name); node.textContent = text; return node;
}
function button(label: string, run: () => Promise<void>): HTMLButtonElement {
  const node = element('button', label);
  node.type = 'button';
  node.addEventListener('click', () => void (async () => {
    const old = node.textContent ?? label;
    node.disabled = true; node.setAttribute('aria-busy', 'true'); node.textContent = 'Working...';
    try { await run(); }
    finally { node.disabled = false; node.removeAttribute('aria-busy'); node.textContent = old; }
  })());
  return node;
}

function completionState(state: string): { label: string; className: string } {
  if (state === 'succeeded') return { label: 'Finished', className: 'is-finished' };
  if (state === 'failed') return { label: 'Not finished - Failed', className: 'is-ended' };
  if (state === 'cancelled') return { label: 'Not finished - Cancelled', className: 'is-ended' };
  return { label: 'Not finished', className: 'is-pending' };
}

function skeletonCards(): HTMLElement[] {
  return [0, 1, 2].map(() => {
    const card = document.createElement('article');
    card.className = 'rhinoq-task rhinoq-skeleton';
    card.setAttribute('aria-hidden', 'true');
    return card;
  });
}

const TASK_CENTER_CSS = `
[data-rhinoq-task-center]{font:14px/1.45 system-ui,sans-serif;color:CanvasText;background:Canvas;padding:1rem}
.rhinoq-task-list{display:grid;gap:.75rem}.rhinoq-task{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:.5rem 1rem;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:.75rem;padding:1rem}
.rhinoq-task progress,.rhinoq-task p,.rhinoq-task div,.rhinoq-task section{grid-column:1/-1}.rhinoq-task div{display:flex;gap:.5rem}.rhinoq-task button{padding:.45rem .7rem;border-radius:.45rem;border:1px solid currentColor;background:Canvas;cursor:pointer}
.rhinoq-explanation{padding:.7rem .8rem;border-radius:.55rem;background:color-mix(in srgb,CanvasText 5%,Canvas)}.rhinoq-explanation p{margin:.25rem 0}.rhinoq-explanation small{color:color-mix(in srgb,CanvasText 70%,transparent)}
.rhinoq-completion{font-size:.78rem;font-weight:700;padding:.15rem .45rem;border-radius:999px;white-space:nowrap}.rhinoq-completion.is-finished{color:#176b3a;background:#dff7e8}.rhinoq-completion.is-pending{color:#765b00;background:#fff3bf}.rhinoq-completion.is-ended{color:#9a3412;background:#ffedd5}.rhinoq-notice:not(:empty){margin:.5rem 0;padding:.65rem .8rem;border-radius:.55rem;background:#e8f1ff}
.rhinoq-skeleton{min-height:5.5rem;border-color:transparent;background:linear-gradient(90deg,color-mix(in srgb,CanvasText 7%,Canvas) 25%,color-mix(in srgb,CanvasText 13%,Canvas) 50%,color-mix(in srgb,CanvasText 7%,Canvas) 75%);background-size:200% 100%;animation:rhinoq-loading 1.2s ease-in-out infinite}@keyframes rhinoq-loading{to{background-position:-200% 0}}@media(prefers-reduced-motion:reduce){.rhinoq-skeleton{animation:none}}
`;

function escapeHTML(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[character]!); }
function jsonScript(value: string): string { return JSON.stringify(value).replace(/</g, '\\u003c'); }
