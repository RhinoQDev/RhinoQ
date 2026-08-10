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

export interface TaskCenterPageOptions {
  apiPath?: string;
  title?: string;
  /** Route serving this page and its owner-facing detail pages. */
  basePath?: string;
  /** Optional product-shell links. Omitted for an embeddable standalone page. */
  navigation?: { overviewPath?: string; workbenchPath?: string };
}

/** Self-contained reference page for server frameworks without a React bundle. */
export function rhinoTaskCenterPage(options: TaskCenterPageOptions = {}): string {
  const apiPath = jsonScript(options.apiPath ?? '/tasks');
  const basePath = jsonScript(options.basePath ?? '/task-center');
  const title = escapeHTML(options.title ?? 'Tasks');
  const navigation = taskCenterNavigation(options, title);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${TASK_CENTER_CSS}</style></head><body>${navigation}<main data-rhinoq-task-center aria-busy="true"><div id="notice" class="rhinoq-notice" role="status" aria-live="polite"></div><section id="inbox"><h1>${title}</h1><form id="taskTools" class="rhinoq-tools" role="search"><label>Search tasks<input id="taskSearch" type="search" autocomplete="off" placeholder="Name or task ID"></label><label>Show<select id="taskFilter"><option value="all">All tasks</option><option value="attention">Needs attention</option><option value="active">In progress</option><option value="finished">Finished</option></select></label><label>Sort<select id="taskSort"><option value="updated">Recently updated</option><option value="oldest">Oldest updated</option><option value="type">Task name</option></select></label><button id="clearTools" type="button">Reset</button></form><p id="status" role="status">Loading tasks...</p><div id="tasks" class="rhinoq-task-list" role="list"></div></section><section id="taskDetail" hidden><a class="rhinoq-back" id="backToTasks">← Back to tasks</a><div id="detail"></div></section></main><script>
const api=${apiPath},centerPath=${basePath},root=document.querySelector('[data-rhinoq-task-center]'),inbox=document.getElementById('inbox'),detailView=document.getElementById('taskDetail'),detail=document.getElementById('detail'),list=document.getElementById('tasks'),status=document.getElementById('status'),notice=document.getElementById('notice'),tools=document.getElementById('taskTools'),search=document.getElementById('taskSearch'),filter=document.getElementById('taskFilter'),sort=document.getElementById('taskSort'),clearTools=document.getElementById('clearTools'),byId=new Map(),seen=new Map();let fallback,initial=true,capabilities={cancel:true,retry:false,result:false,stream:true,risk:false,tenant:false,verifications:true,artifacts:false};
const suffix=location.pathname.startsWith(centerPath+'/')?location.pathname.slice(centerPath.length+1):'',directId=suffix&&!suffix.includes('/')?decodeURIComponent(suffix):'';document.getElementById('backToTasks').href=centerPath;
const labels={pending:'Preparing',queued:'Queued',running:'Running',uncertain:'Awaiting confirmation',succeeded:'Completed',failed:'Failed',cancel_requested:'Cancelling',cancelled:'Cancelled'};
const params=new URLSearchParams(location.search);search.value=params.get('q')||'';filter.value=['all','attention','active','finished'].includes(params.get('view'))?params.get('view'):'all';sort.value=['updated','oldest','type'].includes(params.get('sort'))?params.get('sort'):'updated';
function node(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
async function request(path,init){const response=await fetch(api+path,{credentials:'same-origin',...init,headers:{'content-type':'application/json',...(init&&init.headers)}});if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.message||('Request failed: '+response.status))}return response.json()}
function action(label,run){const b=node('button',label);b.type='button';b.onclick=async()=>{const old=b.textContent;b.disabled=true;b.setAttribute('aria-busy','true');b.textContent='Working…';notice.textContent='';try{await run();notice.textContent=label+' completed.';await load()}catch(error){notice.textContent=error.message}finally{b.disabled=false;b.removeAttribute('aria-busy');b.textContent=old}};return b}
function completion(task){if(task.state==='succeeded')return ['Finished','is-finished'];if(task.state==='failed')return ['Not finished · Failed','is-ended'];if(task.state==='cancelled')return ['Not finished · Cancelled','is-ended'];return ['Not finished','is-pending']}
function itemCounts(task){const c=task.itemCounts||task.executionCounts||{};return {total:c.total||0,succeeded:c.succeeded||0,failed:c.failed||0,cancelled:c.cancelled||0}}
function progressText(task){const c=itemCounts(task);if(c.total)return (c.succeeded+c.failed+c.cancelled)+' of '+c.total+' item'+(c.total===1?'':'s')+' finished';if(task.progress.total!==undefined)return task.progress.completed+' of '+task.progress.total+' completed';return task.progress.message||task.progress.completed+' completed'}
function taskRisk(task){if(!capabilities.risk||!['pending','queued','running','cancel_requested'].includes(task.state))return '';const idle=Date.now()-Date.parse(task.updatedAt);return idle>=capabilities.risk.stuckAfterMs?'stuck':idle>=capabilities.risk.atRiskAfterMs?'at_risk':''}
function explain(task){const progress=progressText(task),c=itemCounts(task),risk=taskRisk(task);if(risk==='stuck')return ['This task appears stuck','No progress has been recorded within the configured stuck threshold.',progress,'Open Workbench and inspect the latest attempt'];if(risk==='at_risk')return ['This task may need attention','Progress has been quiet longer than the configured at-risk threshold.',progress,'Check whether work is still advancing'];if(task.cancellation&&task.cancellation.status==='cannot_cancel_safely')return ['This work could not be stopped safely',task.cancellation.reason||'Some work may already be running. Check what completed before taking another action.',progress,'Review completed work'];if(task.cancellation&&task.cancellation.status==='too_late')return ['The work finished before cancellation','The cancellation request arrived after completion. Use the recorded result instead of starting the work again.',progress,task.hasResult?'Download result':'Review the result'];if(task.state==='uncertain')return ['The result still needs confirmation','RhinoQ cannot yet prove whether the real-world result happened. Do not repeat the operation until it is checked.',progress,'Check confirmation'];if(c.failed&&c.succeeded)return [c.failed+' item'+(c.failed===1?' needs':'s need')+' attention',c.succeeded+' completed successfully. Review the failed items before retrying only those items.',progress,'Review failed items'];const copy={pending:['Getting ready','The task was accepted and is being prepared.','No action needed'],queued:['Waiting to start','The task is ready and waiting to begin.','Cancel if no longer needed'],running:['Work is in progress',progress,'Cancel if no longer needed'],cancel_requested:['Cancellation is in progress','RhinoQ is waiting for the active work to report what could safely be stopped.','Wait for the final outcome'],cancelled:['The task was stopped','Not all work completed. Review existing results before deciding whether to start again.','Review completed work'],failed:['The task did not finish','Review the failed attempt before retrying so an uncertain external action is not repeated.','Review the failure'],succeeded:[task.hasResult?'Your result is ready':'The work completed','All recorded work completed successfully.',task.hasResult?'Download result':'No action needed']}[task.state]||['Task status updated','Current status: '+(labels[task.state]||task.state)+'.','Review task details'];return [copy[0],copy[1],progress,copy[2]]}
function taskActions(task){const actions=node('div');actions.className='rhinoq-actions';if(capabilities.cancel&&(task.state==='queued'||task.state==='running'))actions.append(action('Cancel task',()=>request('/'+encodeURIComponent(task.id)+'/cancel',{method:'POST',body:JSON.stringify({expectedVersion:task.entityVersion})})));if(capabilities.retry&&(task.state==='failed'||task.state==='cancelled'))actions.append(action('Retry after review',()=>request('/'+encodeURIComponent(task.id)+'/retry',{method:'POST',body:JSON.stringify({expectedVersion:task.entityVersion,commandId:task.id+'-retry-'+task.entityVersion})})));if(capabilities.result&&task.hasResult)actions.append(action('Download result',async()=>{const result=await request('/'+encodeURIComponent(task.id)+'/result');location.assign(result.url)}));return actions}
function render(task){const card=node('article');card.className='rhinoq-task';card.setAttribute('role','listitem');const outcome=completion(task),pill=node('span',outcome[0]);pill.className='rhinoq-completion '+outcome[1];card.append(node('strong',task.type),node('span',labels[task.state]||task.state),pill);const p=node('progress');p.value=task.progress.completed;if(task.progress.total!==undefined)p.max=task.progress.total;p.setAttribute('aria-label',progressText(task));card.append(p);const guidance=explain(task),explanation=node('section');explanation.className='rhinoq-explanation';explanation.append(node('strong',guidance[0]),node('p',guidance[1]),node('small',guidance[2]+' · Next: '+guidance[3]));card.append(explanation);const meta=node('small','Updated '+new Date(task.updatedAt).toLocaleString());meta.className='rhinoq-meta';card.append(meta);const actions=taskActions(task),open=node('a','View details');open.className='rhinoq-open';open.href=centerPath+'/'+encodeURIComponent(task.id);actions.append(open);card.append(actions);return card}
function cancellationText(task){const state=task.cancellation&&task.cancellation.status;if(state==='cannot_cancel_safely')return task.cancellation.reason||'Cannot be cancelled safely';if(state==='too_late')return 'Cancellation arrived after completion';if(state==='requested'||state==='acknowledged')return 'Cancellation is in progress';if(state==='cancelled')return 'Cancelled safely where possible';if(task.state==='queued'||task.state==='running')return 'Can request cancellation';return 'No cancellation action available'}
function verificationText(task){const latest=task.verifications&&task.verifications[0];if(!latest)return task.state==='uncertain'?'Needs confirmation before retry':'Not independently verified yet';if(latest.status==='verified')return 'Verified '+new Date(latest.verifiedAt).toLocaleString()+(latest.summary?' · '+latest.summary:'');if(latest.status==='mismatch')return 'Business outcome mismatch'+(latest.summary?' · '+latest.summary:'');return 'Verification could not reach a conclusion'+(latest.summary?' · '+latest.summary:'')}
function artifactSection(task){const section=node('section');section.className='rhinoq-waitpoints';section.append(node('h2','Artifacts'));if(!task.artifacts||!task.artifacts.length){section.append(node('p','No artifact metadata has been recorded.'));return section}for(const artifact of task.artifacts){const card=node('article');card.append(node('strong',artifact.name),node('p',artifact.contentType+' · '+artifact.sizeBytes+' bytes'),node('small','SHA-256 '+artifact.checksumSha256+' · expires '+new Date(artifact.expiresAt).toLocaleString()));if(capabilities.artifacts){const actions=node('div');actions.className='rhinoq-actions';actions.append(action('Open artifact',async()=>{const result=await request('/'+encodeURIComponent(task.id)+'/artifacts/'+encodeURIComponent(artifact.id)+'/download');if(result.url)location.assign(result.url)}));card.append(actions)}section.append(card)}return section}
function attemptRow(item){const row=node('tr');[item.itemKey||'default',String(item.attempt),item.state,item.failureReason||(item.hasResult?'Result recorded':'—')].forEach(x=>row.append(node('td',x)));return row}
function waitpointSection(task){const section=node('section');section.className='rhinoq-waitpoints';section.append(node('h2','Requests and approvals'));if(!task.waitpoints||!task.waitpoints.length){section.append(node('p','This Task is not waiting for input or approval.'));return section}for(const waitpoint of task.waitpoints){const card=node('article'),title=waitpoint.kind==='approval'?'Approval requested':waitpoint.kind==='input'?'Information requested':'Waiting for an external callback';card.append(node('strong',title),node('p',waitpoint.key+' · '+waitpoint.state));if(waitpoint.deadline)card.append(node('small','Due '+new Date(waitpoint.deadline).toLocaleString()));if(waitpoint.kind==='approval'&&waitpoint.state==='waiting'){const actions=node('div');actions.className='rhinoq-actions';for(const [label,value] of [['Approve',true],['Decline',false]])actions.append(action(label,()=>request('/'+encodeURIComponent(task.id)+'/waitpoints/'+encodeURIComponent(waitpoint.id),{method:'POST',body:JSON.stringify({expectedVersion:waitpoint.entityVersion,resolutionId:task.id+'-'+waitpoint.id+'-'+waitpoint.entityVersion+'-'+String(value),resolution:value})})));card.append(actions)}else if(waitpoint.kind==='input'&&waitpoint.state==='waiting')card.append(node('p','Return to the application form that requested this information.'));else if(waitpoint.kind==='webhook'&&waitpoint.state==='waiting')card.append(node('p','No action is required here; RhinoQ is waiting for the external system.'));section.append(card)}return section}
function renderDetail(task,nextCursor){inbox.hidden=true;detailView.hidden=false;root.setAttribute('aria-busy','false');const guidance=explain(task),heading=node('div');heading.className='rhinoq-detail-head';heading.append(node('p',task.type),node('h1',guidance[0]),node('p',guidance[1]));const summary=node('section');summary.className='rhinoq-detail-summary';summary.append(node('strong','Status'),node('p',labels[task.state]||task.state),node('strong','Progress'),node('p',guidance[2]),node('strong','Result'),node('p',task.hasResult?(capabilities.result?'Ready to download':'Recorded; ask the application owner to configure secure download'):'No result recorded'),node('strong','Cancellation'),node('p',cancellationText(task)),node('strong','Verification'),node('p',verificationText(task)),node('strong','Next action'),node('p',guidance[3]));const attempts=node('section');attempts.className='rhinoq-attempts';attempts.append(node('h2','Attempts'));if(!task.executions||!task.executions.length)attempts.append(node('p','No attempts have been recorded yet.'));else{const table=node('table'),head=node('tr');['Item','Attempt','Status','Outcome'].forEach(x=>head.append(node('th',x)));table.append(head,...task.executions.map(attemptRow));attempts.append(table);if(nextCursor){let cursor=nextCursor;const more=node('button','Load more attempts');more.type='button';more.onclick=async()=>{more.disabled=true;more.setAttribute('aria-busy','true');more.textContent='Loading…';try{const page=await request('/'+encodeURIComponent(task.id)+'/executions/page?limit=100&cursor='+encodeURIComponent(cursor));table.append(...(page.executions||[]).map(attemptRow));cursor=page.nextCursor;if(!cursor)more.remove();else{more.disabled=false;more.removeAttribute('aria-busy');more.textContent='Load more attempts'}}catch(error){notice.textContent=error.message;more.disabled=false;more.removeAttribute('aria-busy');more.textContent='Try loading attempts again'}};attempts.append(more)}}detail.replaceChildren(heading,summary,taskActions(task),waitpointSection(task),artifactSection(task),attempts)}
function skeletons(){return [1,2,3].map(()=>{const n=node('article');n.className='rhinoq-task rhinoq-skeleton';n.setAttribute('aria-hidden','true');return n})}
function announce(task,old){if(!old||old===task.state)return;if(task.state==='succeeded')notice.textContent=(task.type||'Task')+' finished.';else if(task.state==='failed')notice.textContent=(task.type||'Task')+' did not finish: failed.';else if(task.state==='cancelled')notice.textContent=(task.type||'Task')+' did not finish: cancelled.'}
function put(task){const old=byId.get(task.id);if(!old||task.entityVersion>old.entityVersion){byId.set(task.id,task);if(!initial)announce(task,seen.get(task.id));seen.set(task.id,task.state)}}
function needsAttention(task){const c=itemCounts(task),cancel=task.cancellation&&task.cancellation.status;return Boolean(taskRisk(task))||task.state==='failed'||task.state==='uncertain'||(c.failed>0&&c.succeeded>0)||cancel==='too_late'||cancel==='cannot_cancel_safely'}
function visibleTasks(){const query=search.value.trim().toLocaleLowerCase(),view=filter.value;return [...byId.values()].filter(task=>{if(query&&!String(task.type+' '+task.id).toLocaleLowerCase().includes(query))return false;if(view==='attention')return needsAttention(task);if(view==='active')return ['pending','queued','running','cancel_requested'].includes(task.state);if(view==='finished')return ['succeeded','failed','cancelled'].includes(task.state);return true}).sort((a,b)=>sort.value==='oldest'?a.updatedAt.localeCompare(b.updatedAt):sort.value==='type'?a.type.localeCompare(b.type):b.updatedAt.localeCompare(a.updatedAt))}
function syncTools(){const next=new URLSearchParams(location.search);search.value.trim()?next.set('q',search.value.trim()):next.delete('q');filter.value==='all'?next.delete('view'):next.set('view',filter.value);sort.value==='updated'?next.delete('sort'):next.set('sort',sort.value);history.replaceState(null,'',location.pathname+(next.size?'?'+next:''));renderAll()}
function renderAll(){const tasks=visibleTasks(),total=byId.size;list.replaceChildren(...tasks.map(render));root.setAttribute('aria-busy','false');status.textContent=!total?'No tasks yet. New async work will appear here automatically.':!tasks.length?'No tasks match this view. Reset the filters to see all tasks.':(tasks.length===total?total+' task(s)':tasks.length+' of '+total+' task(s)')+' · '+(fallback?'Polling fallback':'Live');initial=false}
async function load(){if(directId){try{const id=encodeURIComponent(directId),reads=await Promise.all([request('/'+id+'/summary'),request('/'+id+'/executions/page?limit=100'),request('/'+id+'/waitpoints?limit=100'),request('/'+id+'/verifications?limit=20'),request('/'+id+'/artifacts?limit=100')]);renderDetail({...reads[0],executions:reads[1].executions||[],waitpoints:reads[2].waitpoints||[],verifications:reads[3].verifications||[],artifacts:reads[4].artifacts||[]},reads[1].nextCursor)}catch(error){root.setAttribute('aria-busy','false');inbox.hidden=true;detailView.hidden=false;detail.replaceChildren(node('h1','Task unavailable'),node('p',error.message))}return}status.textContent='Loading tasks...';if(!byId.size)list.replaceChildren(...skeletons());try{const body=await request('');for(const task of body.tasks||[])put(task);renderAll()}catch(error){root.setAttribute('aria-busy','false');status.textContent=error.message}}
function polling(){if(!fallback)fallback=setInterval(load,2000);if(!directId)renderAll()}
async function start(){capabilities=await request('/_capabilities').catch(()=>capabilities);await load();if(!capabilities.stream||typeof EventSource!=='function'){polling();return}const eventPath=directId?'/'+encodeURIComponent(directId)+'/events':'/_events',events=new EventSource(api+eventPath,{withCredentials:true});events.addEventListener('task.page',event=>{const next=JSON.parse(event.data).tasks||[];const keep=new Set(next.map(task=>task.id));for(const id of byId.keys())if(!keep.has(id))byId.delete(id);for(const task of next)put(task);renderAll()});events.addEventListener('task.snapshot',event=>{if(directId)load();else{put(JSON.parse(event.data));renderAll()}});events.onopen=()=>{if(fallback){clearInterval(fallback);fallback=undefined}if(!directId)renderAll()};events.onerror=polling}
tools.addEventListener('submit',event=>event.preventDefault());search.addEventListener('input',syncTools);filter.addEventListener('change',syncTools);sort.addEventListener('change',syncTools);clearTools.addEventListener('click',()=>{search.value='';filter.value='all';sort.value='updated';syncTools()});
start();
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
.rhinoq-shell{font:14px/1.45 system-ui,sans-serif;display:flex;align-items:center;gap:1.25rem;padding:.8rem 1rem;border-bottom:1px solid color-mix(in srgb,CanvasText 16%,transparent)}.rhinoq-brand{font-weight:750;color:inherit;text-decoration:none}.rhinoq-shell nav{display:flex;gap:.85rem}.rhinoq-shell nav a{color:inherit;text-decoration:none}.rhinoq-shell nav [aria-current="page"]{font-weight:700;text-decoration:underline;text-underline-offset:.3rem}
[data-rhinoq-task-center]{font:14px/1.45 system-ui,sans-serif;color:CanvasText;background:Canvas;padding:1rem;max-width:1100px;margin:auto}
.rhinoq-task-list{display:grid;gap:.75rem}.rhinoq-task{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:.5rem 1rem;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:.75rem;padding:1rem}
.rhinoq-tools{display:grid;grid-template-columns:minmax(12rem,1fr) auto auto auto;align-items:end;gap:.65rem;margin:1rem 0}.rhinoq-tools label{display:grid;gap:.25rem;font-weight:650}.rhinoq-tools input,.rhinoq-tools select,.rhinoq-tools button{min-height:2.5rem;padding:.45rem .6rem;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);border-radius:.45rem;color:inherit;background:Canvas}.rhinoq-tools button{cursor:pointer}.rhinoq-meta{grid-column:1/-1;color:color-mix(in srgb,CanvasText 65%,transparent)}
.rhinoq-task progress,.rhinoq-task p,.rhinoq-task div,.rhinoq-task section{grid-column:1/-1}.rhinoq-task div{display:flex;gap:.5rem}.rhinoq-task button{padding:.45rem .7rem;border-radius:.45rem;border:1px solid currentColor;background:Canvas;cursor:pointer}
.rhinoq-explanation{padding:.7rem .8rem;border-radius:.55rem;background:color-mix(in srgb,CanvasText 5%,Canvas)}.rhinoq-explanation p{margin:.25rem 0}.rhinoq-explanation small{color:color-mix(in srgb,CanvasText 70%,transparent)}
.rhinoq-actions{align-items:center;flex-wrap:wrap}.rhinoq-open,.rhinoq-back{color:inherit;text-underline-offset:.2rem}.rhinoq-detail-head>p:first-child{opacity:.65;margin-bottom:0}.rhinoq-detail-head h1{margin:.2rem 0}.rhinoq-detail-summary{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;margin:1rem 0;padding:1rem;border-radius:.65rem;background:color-mix(in srgb,CanvasText 5%,Canvas)}.rhinoq-detail-summary p{margin:0}.rhinoq-attempts{margin-top:1.5rem;overflow-x:auto}.rhinoq-attempts table{width:100%;border-collapse:collapse}.rhinoq-attempts th,.rhinoq-attempts td{text-align:left;padding:.55rem;border-bottom:1px solid color-mix(in srgb,CanvasText 14%,transparent)}.rhinoq-attempts>button{margin-top:.75rem;padding:.45rem .7rem;border-radius:.45rem;border:1px solid currentColor;color:inherit;background:Canvas;cursor:pointer}
.rhinoq-waitpoints{margin-top:1.5rem}.rhinoq-waitpoints article{margin:.65rem 0;padding:.8rem;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:.6rem}.rhinoq-waitpoints article p{margin:.25rem 0}.rhinoq-waitpoints article small{display:block;color:color-mix(in srgb,CanvasText 65%,transparent)}
.rhinoq-completion{font-size:.78rem;font-weight:700;padding:.15rem .45rem;border-radius:999px;white-space:nowrap}.rhinoq-completion.is-finished{color:#176b3a;background:#dff7e8}.rhinoq-completion.is-pending{color:#765b00;background:#fff3bf}.rhinoq-completion.is-ended{color:#9a3412;background:#ffedd5}.rhinoq-notice:not(:empty){margin:.5rem 0;padding:.65rem .8rem;border-radius:.55rem;background:#e8f1ff}
.rhinoq-skeleton{min-height:5.5rem;border-color:transparent;background:linear-gradient(90deg,color-mix(in srgb,CanvasText 7%,Canvas) 25%,color-mix(in srgb,CanvasText 13%,Canvas) 50%,color-mix(in srgb,CanvasText 7%,Canvas) 75%);background-size:200% 100%;animation:rhinoq-loading 1.2s ease-in-out infinite}@keyframes rhinoq-loading{to{background-position:-200% 0}}@media(prefers-reduced-motion:reduce){.rhinoq-skeleton{animation:none}}
@media(max-width:700px){.rhinoq-shell{align-items:flex-start;flex-direction:column;gap:.45rem}.rhinoq-tools{grid-template-columns:1fr 1fr}.rhinoq-tools label:first-child{grid-column:1/-1}.rhinoq-task{grid-template-columns:1fr}.rhinoq-task>*{grid-column:1!important}.rhinoq-detail-summary{grid-template-columns:1fr}.rhinoq-detail-summary p{margin-bottom:.5rem}}
@media(max-width:430px){.rhinoq-tools{grid-template-columns:1fr}.rhinoq-tools label:first-child{grid-column:auto}}
`;

function taskCenterNavigation(options: TaskCenterPageOptions, title: string): string {
  if (!options.navigation) return '';
  const overview = options.navigation.overviewPath
    ? `<a href="${escapeHTML(options.navigation.overviewPath)}">Overview</a>`
    : '';
  const workbench = options.navigation.workbenchPath
    ? `<a href="${escapeHTML(options.navigation.workbenchPath)}">Workbench</a>`
    : '';
  return `<header class="rhinoq-shell"><a class="rhinoq-brand" href="${escapeHTML(options.navigation.overviewPath ?? options.basePath ?? '/task-center')}">RhinoQ</a><nav aria-label="Product">${overview}<span aria-current="page">${title}</span>${workbench}</nav></header>`;
}

function escapeHTML(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[character]!); }
function jsonScript(value: string): string { return JSON.stringify(value).replace(/</g, '\\u003c'); }
