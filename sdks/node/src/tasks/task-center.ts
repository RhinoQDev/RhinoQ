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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#2563eb"><title>${title}</title><style>${TASK_CENTER_CSS}</style></head><body>${navigation}<main data-rhinoq-task-center aria-busy="true"><div id="notice" class="rhinoq-notice" role="status" aria-live="polite"></div><section id="inbox"><div class="rhinoq-intro"><div class="rhinoq-hero-copy"><div class="rhinoq-kicker"><span class="rhinoq-live-dot" aria-hidden="true"></span>Background activity <span>Private to your account</span></div><h1>${title}</h1><p>Follow work as it happens, understand what needs attention, and collect every result from one calm workspace.</p></div><div class="rhinoq-orbit" aria-hidden="true"><span class="rhinoq-orbit-ring"></span><span class="rhinoq-orbit-ring"></span><strong>RQ</strong><i></i><i></i><i></i></div><div id="taskMetrics" class="rhinoq-metrics" aria-label="Task overview"><div><strong data-metric="all">—</strong><span>All tasks</span></div><div><strong data-metric="active">—</strong><span>In progress</span></div><div><strong data-metric="ready">—</strong><span>Ready</span></div><div><strong data-metric="attention">—</strong><span>Attention</span></div></div></div><form id="taskTools" class="rhinoq-tools" role="search"><label class="rhinoq-search">Search tasks<input id="taskSearch" type="search" autocomplete="off" placeholder="Search by task name or ID"><span aria-hidden="true">⌕</span></label><label>Show<select id="taskFilter"><option value="all">All tasks</option><option value="attention">Needs attention</option><option value="active">In progress</option><option value="finished">Finished</option></select></label><label>Sort<select id="taskSort"><option value="updated">Recently updated</option><option value="oldest">Oldest updated</option><option value="type">Task name</option></select></label><button id="clearTools" type="button">Reset filters</button></form><p id="status" class="rhinoq-status-line" role="status">Loading tasks...</p><div id="tasks" class="rhinoq-task-list" role="list"></div></section><section id="taskDetail" hidden><a class="rhinoq-back" id="backToTasks">← Back to tasks</a><div id="detail"></div></section></main><script>
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
function humanize(value){return String(value).replace(/[._-]+/g,' ').replace(/\b\w/g,letter=>letter.toUpperCase())}
function initials(value){return String(value).split(/[._-]+/).slice(0,2).map(part=>part[0]?part[0].toUpperCase():'').join('')||'T'}
function relativeTime(value){const elapsed=Date.now()-Date.parse(value);if(!Number.isFinite(elapsed)||elapsed<60000)return 'just now';const minutes=Math.floor(elapsed/60000);if(minutes<60)return minutes+'m ago';const hours=Math.floor(minutes/60);return hours<24?hours+'h ago':Math.floor(hours/24)+'d ago'}
function render(task){const card=node('article');card.className='rhinoq-task';card.dataset.state=task.state;card.setAttribute('role','listitem');const guidance=explain(task),head=node('div'),icon=node('span',initials(task.type)),identity=node('div'),state=node('span',labels[task.state]||task.state);head.className='rhinoq-card-head';icon.className='rhinoq-task-icon';identity.className='rhinoq-task-identity';identity.append(node('strong',humanize(task.type)),node('small',task.id));state.className='rhinoq-state';head.append(icon,identity,state);card.append(head);const progressHead=node('div'),progressLabel=node('span',guidance[2]),progressValue=node('strong');progressHead.className='rhinoq-progress-head';const percent=task.progress.total?Math.round(task.progress.completed/task.progress.total*100):undefined;progressValue.textContent=percent===undefined?(task.state==='running'?'In progress':'—'):percent+'%';progressHead.append(progressLabel,progressValue);card.append(progressHead);const p=node('progress');p.value=task.progress.completed;if(task.progress.total!==undefined)p.max=task.progress.total;p.setAttribute('aria-label',progressText(task));if(percent!==undefined)p.style.setProperty('--rq-progress',percent+'%');card.append(p);const explanation=node('section');explanation.className='rhinoq-explanation';explanation.append(node('strong',guidance[0]),node('p',guidance[1]),node('small','Next: '+guidance[3]));card.append(explanation);const footer=node('div'),meta=node('small','Updated '+relativeTime(task.updatedAt)),actions=taskActions(task),open=node('a','View details →');footer.className='rhinoq-task-footer';meta.className='rhinoq-meta';open.className='rhinoq-open';open.href=centerPath+'/'+encodeURIComponent(task.id);actions.append(open);footer.append(meta,actions);card.append(footer);return card}
function cancellationText(task){const state=task.cancellation&&task.cancellation.status;if(state==='cannot_cancel_safely')return task.cancellation.reason||'Cannot be cancelled safely';if(state==='too_late')return 'Cancellation arrived after completion';if(state==='requested'||state==='acknowledged')return 'Cancellation is in progress';if(state==='cancelled')return 'Cancelled safely where possible';if(task.state==='queued'||task.state==='running')return 'Can request cancellation';return 'No cancellation action available'}
function verificationText(task){const latest=task.verifications&&task.verifications[0];if(!latest)return task.state==='uncertain'?'Needs confirmation before retry':'Not independently verified yet';if(latest.status==='verified')return 'Verified '+new Date(latest.verifiedAt).toLocaleString()+(latest.summary?' · '+latest.summary:'');if(latest.status==='mismatch')return 'Business outcome mismatch'+(latest.summary?' · '+latest.summary:'');return 'Verification could not reach a conclusion'+(latest.summary?' · '+latest.summary:'')}
function fileSize(bytes){if(bytes<1024)return bytes+' B';const units=['KB','MB','GB','TB'];let value=bytes/1024,index=0;while(value>=1024&&index<units.length-1){value/=1024;index++}return value.toFixed(value>=10?1:2)+' '+units[index]}
function artifactSection(task){const section=node('section');section.className='rhinoq-artifacts';const head=node('div');head.className='rhinoq-section-head';head.append(node('div'));head.firstChild.append(node('p','Task output'),node('h2','Files & artifacts'));head.append(node('span',(task.artifacts||[]).length+' file(s)'));section.append(head);if(!task.artifacts||!task.artifacts.length){const empty=node('p','No file has been produced by this Task yet.');empty.className='rhinoq-empty';section.append(empty);return section}const grid=node('div');grid.className='rhinoq-artifact-grid';for(const artifact of task.artifacts){const expired=artifact.expiresAt&&Date.parse(artifact.expiresAt)<=Date.now(),card=node('article'),top=node('div'),identity=node('div'),badge=node('span',expired?'Expired':'Available');card.className='rhinoq-artifact-card';top.className='rhinoq-artifact-top';identity.className='rhinoq-artifact-name';badge.className='rhinoq-artifact-status '+(expired?'is-expired':'is-available');identity.append(node('span','FILE'),node('strong',artifact.name));top.append(identity,badge);const facts=node('dl');[['Type',artifact.contentType],['Size',fileSize(artifact.sizeBytes)],['Expires',artifact.expiresAt?new Date(artifact.expiresAt).toLocaleString():'No metadata expiry'],['Integrity',artifact.checksumSha256.slice(0,12)+'…']].forEach(([label,value])=>{facts.append(node('dt',label),node('dd',value))});card.append(top,facts);const actions=node('div');actions.className='rhinoq-actions';if(capabilities.artifacts)actions.append(action(expired?'Request fresh link':'Download',async()=>{const result=await request('/'+encodeURIComponent(task.id)+'/artifacts/'+encodeURIComponent(artifact.id)+'/download');if(result.url)location.assign(result.url)}));actions.append(action('Copy checksum',async()=>{await navigator.clipboard.writeText(artifact.checksumSha256);notice.textContent='Artifact checksum copied.'}));card.append(actions);grid.append(card)}section.append(grid);return section}
function attemptRow(item){const row=node('tr');[item.itemKey||'default',String(item.attempt),item.state,item.failureReason||(item.hasResult?'Result recorded':'—')].forEach(x=>row.append(node('td',x)));return row}
function waitpointSection(task){const section=node('section');section.className='rhinoq-waitpoints';section.append(node('h2','Requests and approvals'));if(!task.waitpoints||!task.waitpoints.length){section.append(node('p','This Task is not waiting for input or approval.'));return section}for(const waitpoint of task.waitpoints){const card=node('article'),title=waitpoint.kind==='approval'?'Approval requested':waitpoint.kind==='input'?'Information requested':'Waiting for an external callback';card.append(node('strong',title),node('p',waitpoint.key+' · '+waitpoint.state));if(waitpoint.deadline)card.append(node('small','Due '+new Date(waitpoint.deadline).toLocaleString()));if(waitpoint.kind==='approval'&&waitpoint.state==='waiting'){const actions=node('div');actions.className='rhinoq-actions';for(const [label,value] of [['Approve',true],['Decline',false]])actions.append(action(label,()=>request('/'+encodeURIComponent(task.id)+'/waitpoints/'+encodeURIComponent(waitpoint.id),{method:'POST',body:JSON.stringify({expectedVersion:waitpoint.entityVersion,resolutionId:task.id+'-'+waitpoint.id+'-'+waitpoint.entityVersion+'-'+String(value),resolution:value})})));card.append(actions)}else if(waitpoint.kind==='input'&&waitpoint.state==='waiting')card.append(node('p','Return to the application form that requested this information.'));else if(waitpoint.kind==='webhook'&&waitpoint.state==='waiting')card.append(node('p','No action is required here; RhinoQ is waiting for the external system.'));section.append(card)}return section}
function renderDetail(task,nextCursor){inbox.hidden=true;detailView.hidden=false;root.setAttribute('aria-busy','false');const guidance=explain(task),heading=node('div');heading.className='rhinoq-detail-head';heading.append(node('p',task.type),node('h1',guidance[0]),node('p',guidance[1]));const summary=node('section');summary.className='rhinoq-detail-summary';summary.append(node('strong','Status'),node('p',labels[task.state]||task.state),node('strong','Progress'),node('p',guidance[2]),node('strong','Result'),node('p',task.hasResult?(capabilities.result?'Ready to download':'Recorded; ask the application owner to configure secure download'):'No result recorded'),node('strong','Cancellation'),node('p',cancellationText(task)),node('strong','Verification'),node('p',verificationText(task)),node('strong','Next action'),node('p',guidance[3]));const attempts=node('section');attempts.className='rhinoq-attempts';attempts.append(node('h2','Attempts'));if(!task.executions||!task.executions.length)attempts.append(node('p','No attempts have been recorded yet.'));else{const table=node('table'),head=node('tr');['Item','Attempt','Status','Outcome'].forEach(x=>head.append(node('th',x)));table.append(head,...task.executions.map(attemptRow));attempts.append(table);if(nextCursor){let cursor=nextCursor;const more=node('button','Load more attempts');more.type='button';more.onclick=async()=>{more.disabled=true;more.setAttribute('aria-busy','true');more.textContent='Loading…';try{const page=await request('/'+encodeURIComponent(task.id)+'/executions/page?limit=100&cursor='+encodeURIComponent(cursor));table.append(...(page.executions||[]).map(attemptRow));cursor=page.nextCursor;if(!cursor)more.remove();else{more.disabled=false;more.removeAttribute('aria-busy');more.textContent='Load more attempts'}}catch(error){notice.textContent=error.message;more.disabled=false;more.removeAttribute('aria-busy');more.textContent='Try loading attempts again'}};attempts.append(more)}}detail.replaceChildren(heading,summary,taskActions(task),waitpointSection(task),artifactSection(task),attempts)}
function skeletons(){return [1,2,3].map(()=>{const n=node('article');n.className='rhinoq-task rhinoq-skeleton';n.setAttribute('aria-hidden','true');return n})}
function announce(task,old){if(!old||old===task.state)return;if(task.state==='succeeded')notice.textContent=(task.type||'Task')+' finished.';else if(task.state==='failed')notice.textContent=(task.type||'Task')+' did not finish: failed.';else if(task.state==='cancelled')notice.textContent=(task.type||'Task')+' did not finish: cancelled.'}
function put(task){const old=byId.get(task.id);if(!old||task.entityVersion>old.entityVersion){byId.set(task.id,task);if(!initial)announce(task,seen.get(task.id));seen.set(task.id,task.state)}}
function needsAttention(task){const c=itemCounts(task),cancel=task.cancellation&&task.cancellation.status;return Boolean(taskRisk(task))||task.state==='failed'||task.state==='uncertain'||(c.failed>0&&c.succeeded>0)||cancel==='too_late'||cancel==='cannot_cancel_safely'}
function visibleTasks(){const query=search.value.trim().toLocaleLowerCase(),view=filter.value;return [...byId.values()].filter(task=>{if(query&&!String(task.type+' '+task.id).toLocaleLowerCase().includes(query))return false;if(view==='attention')return needsAttention(task);if(view==='active')return ['pending','queued','running','cancel_requested'].includes(task.state);if(view==='finished')return ['succeeded','failed','cancelled'].includes(task.state);return true}).sort((a,b)=>sort.value==='oldest'?a.updatedAt.localeCompare(b.updatedAt):sort.value==='type'?a.type.localeCompare(b.type):b.updatedAt.localeCompare(a.updatedAt))}
function syncTools(){const next=new URLSearchParams(location.search);search.value.trim()?next.set('q',search.value.trim()):next.delete('q');filter.value==='all'?next.delete('view'):next.set('view',filter.value);sort.value==='updated'?next.delete('sort'):next.set('sort',sort.value);history.replaceState(null,'',location.pathname+(next.size?'?'+next:''));renderAll()}
function renderAll(){const tasks=visibleTasks(),all=[...byId.values()],total=all.length,counts={all:total,active:all.filter(task=>['pending','queued','running','cancel_requested'].includes(task.state)).length,ready:all.filter(task=>task.state==='succeeded').length,attention:all.filter(needsAttention).length};for(const [key,value] of Object.entries(counts)){const metric=document.querySelector('[data-metric="'+key+'"]');if(metric)metric.textContent=String(value)}list.replaceChildren(...tasks.map(render));root.setAttribute('aria-busy','false');status.textContent=!total?'No tasks yet. New async work will appear here automatically.':!tasks.length?'No tasks match this view. Reset the filters to see all tasks.':(tasks.length===total?total+' task(s)':tasks.length+' of '+total+' task(s)')+' · '+(fallback?'Polling fallback':'Live');initial=false}
const renderAllBase=renderAll;renderAll=function(){renderAllBase();const newest=[...byId.values()].map(task=>Date.parse(task.updatedAt)).filter(Number.isFinite).sort((a,b)=>b-a)[0];if(newest)status.textContent+=' · Last authoritative snapshot '+new Date(newest).toLocaleString();if(fallback)status.textContent+=' · reconnect diagnostics: SSE unavailable, bounded polling active'};
async function load(){if(directId){try{const id=encodeURIComponent(directId),reads=await Promise.all([request('/'+id+'/summary'),request('/'+id+'/executions/page?limit=100'),request('/'+id+'/waitpoints?limit=100'),request('/'+id+'/verifications?limit=20'),request('/'+id+'/artifacts?limit=100')]);renderDetail({...reads[0],executions:reads[1].executions||[],waitpoints:reads[2].waitpoints||[],verifications:reads[3].verifications||[],artifacts:reads[4].artifacts||[]},reads[1].nextCursor)}catch(error){root.setAttribute('aria-busy','false');inbox.hidden=true;detailView.hidden=false;detail.replaceChildren(node('h1','Task unavailable'),node('p',error.message))}return}status.textContent='Loading tasks...';if(!byId.size)list.replaceChildren(...skeletons());try{const body=await request('');for(const task of body.tasks||[])put(task);renderAll()}catch(error){root.setAttribute('aria-busy','false');status.textContent=error.message}}
function polling(){if(!fallback)fallback=setInterval(load,2000);if(!directId)renderAll()}
async function start(){capabilities=await request('/_capabilities').catch(()=>capabilities);await load();if(!capabilities.stream||typeof EventSource!=='function'){polling();return}const eventPath=directId?'/'+encodeURIComponent(directId)+'/events':'/_events',events=new EventSource(api+eventPath,{withCredentials:true});events.addEventListener('task.page',event=>{const next=JSON.parse(event.data).tasks||[];const keep=new Set(next.map(task=>task.id));for(const id of byId.keys())if(!keep.has(id))byId.delete(id);for(const task of next)put(task);renderAll()});events.addEventListener('task.snapshot',event=>{if(directId)load();else{put(JSON.parse(event.data));renderAll()}});events.onopen=()=>{if(fallback){clearInterval(fallback);fallback=undefined}if(!directId)renderAll()};events.onerror=polling}
tools.addEventListener('submit',event=>event.preventDefault());search.addEventListener('input',syncTools);filter.addEventListener('change',syncTools);sort.addEventListener('change',syncTools);clearTools.addEventListener('click',()=>{search.value='';filter.value='all';sort.value='updated';syncTools()});
addEventListener('keydown',event=>{if(event.key==='/'&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement&&document.activeElement.tagName)){event.preventDefault();search.focus()}if(event.key==='Escape'&&document.activeElement===search){search.value='';syncTools();search.blur()}});
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
    const diagnosticParts = [
      state.lastAuthoritativeAt ? `Last authoritative snapshot ${new Date(state.lastAuthoritativeAt).toLocaleString()}` : undefined,
      state.status === 'reconnecting' ? `reconnect attempt ${state.reconnectAttempts ?? 1}` : undefined,
      state.lastErrorAt ? `last transport error ${new Date(state.lastErrorAt).toLocaleString()}` : undefined,
    ].filter(Boolean);
    if (diagnosticParts.length) status.textContent += ` · ${diagnosticParts.join(' · ')}`;
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
    card.dataset.state = task.state;
    card.setAttribute('role', 'listitem');
    const head = document.createElement('div');
    head.className = 'rhinoq-card-head';
    const icon = element('span', taskInitials(task.type));
    icon.className = 'rhinoq-task-icon';
    const identity = document.createElement('div');
    identity.className = 'rhinoq-task-identity';
    identity.append(element('strong', humanizeTaskType(task.type)), element('small', task.id));
    const stateLabel = element('span', ui.label);
    stateLabel.className = 'rhinoq-state';
    head.append(icon, identity, stateLabel);
    card.append(head);
    const progressHead = document.createElement('div');
    progressHead.className = 'rhinoq-progress-head';
    progressHead.append(element('span', ui.explanation.progressText), element('strong', ui.progress.percent === undefined ? 'In progress' : `${Math.round(ui.progress.percent)}%`));
    card.append(progressHead);
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
    const footer = document.createElement('div');
    footer.className = 'rhinoq-task-footer';
    const updated = element('small', `Updated ${relativeUpdated(task.updatedAt)}`);
    updated.className = 'rhinoq-meta';
    const actions = document.createElement('div');
    actions.className = 'rhinoq-actions';
    if (ui.canCancel) actions.append(button('Cancel task', async () => action(task, 'cancel')));
    if (ui.canRetry && client.retryTask) actions.append(button('Retry after review', async () => action(task, 'retry')));
    if (ui.hasResult) actions.append(button('Download result', async () => action(task, 'result')));
    footer.append(updated, actions);
    card.append(footer);
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

function humanizeTaskType(value: string): string { return value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function taskInitials(value: string): string { return value.split(/[._-]+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'T'; }
function relativeUpdated(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
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
/* Professional workspace density: compact type, restrained radii and one token system. */
:root{color-scheme:light;--rq-bg:#f5f7fa;--rq-panel:#fff;--rq-raised:#f8fafc;--rq-line:#dde3ec;--rq-line-strong:#c7d0dd;--rq-ink:#10233f;--rq-muted:#68768b;--rq-accent:#2563eb;--rq-accent-strong:#1d4ed8;--rq-accent-soft:#edf4ff;--rq-success:#159a65;--rq-success-soft:#eaf9f2;--rq-warn:#c77b0a;--rq-warn-soft:#fff5e4;--rq-bad:#cf415a;--rq-bad-soft:#fff0f3;--rq-shadow:0 1px 3px rgba(15,35,63,.07);--rq-font:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--rq-mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--rq-bg);color:var(--rq-ink);font:14px/1.5 var(--rq-font);letter-spacing:0}
.rhinoq-shell{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;min-height:58px;padding:0 max(20px,calc((100vw - 1240px)/2));border-bottom:1px solid var(--rq-line);background:#fff}.rhinoq-brand{display:flex;align-items:center;color:var(--rq-ink);font-size:16px;font-weight:800;letter-spacing:-.02em;text-decoration:none}.rhinoq-brand:before{content:"";width:9px;height:9px;margin-right:8px;border-radius:3px;background:var(--rq-accent);box-shadow:0 0 0 4px var(--rq-accent-soft)}.rhinoq-shell nav{display:flex;align-items:center;gap:2px;margin-left:auto}.rhinoq-shell nav a,.rhinoq-shell nav [aria-current="page"]{padding:7px 11px;border-radius:6px;color:var(--rq-muted);text-decoration:none}.rhinoq-shell nav [aria-current="page"]{background:var(--rq-accent-soft);color:var(--rq-accent-strong);font-weight:750}
[data-rhinoq-task-center]{max-width:1240px;margin:auto;padding:20px 20px 56px;color:var(--rq-ink)}
.rhinoq-intro{margin:0 0 14px;padding:3px 0 0}.rhinoq-hero-copy{max-width:760px}.rhinoq-kicker{display:flex;align-items:center;gap:7px;margin-bottom:5px;color:var(--rq-accent);font-size:10px;font-weight:800;letter-spacing:.075em;text-transform:uppercase}.rhinoq-kicker>span:last-child{margin-left:4px;padding-left:11px;border-left:1px solid var(--rq-line-strong);color:var(--rq-muted);font-weight:650;letter-spacing:0;text-transform:none}.rhinoq-live-dot{width:6px;height:6px;border-radius:50%;background:var(--rq-success);box-shadow:0 0 0 3px rgba(21,154,101,.1);animation:rq-live 2.4s ease-in-out infinite}.rhinoq-intro h1{margin:0;font-size:26px;line-height:1.2;letter-spacing:-.025em}.rhinoq-intro .rhinoq-hero-copy>p{margin:6px 0 0;color:var(--rq-muted);font-size:13px}.rhinoq-orbit{display:none}
.rhinoq-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:15px}.rhinoq-metrics>div{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:10px 14px;border:1px solid var(--rq-line);border-radius:8px;background:var(--rq-panel);box-shadow:var(--rq-shadow)}.rhinoq-metrics strong{order:2;font-size:21px;line-height:1}.rhinoq-metrics span{order:1;color:var(--rq-muted);font-size:11px;font-weight:700}
.rhinoq-tools{display:grid;grid-template-columns:minmax(16rem,1fr) minmax(10rem,auto) minmax(11rem,auto) auto;align-items:end;gap:8px;margin:0 0 5px;padding:10px;border:1px solid var(--rq-line);border-radius:8px;background:#fff;box-shadow:var(--rq-shadow)}.rhinoq-tools label{position:relative;display:grid;gap:4px;color:var(--rq-muted);font-size:10px;font-weight:800;letter-spacing:.055em;text-transform:uppercase}.rhinoq-tools input,.rhinoq-tools select,.rhinoq-tools button{min-height:38px;padding:7px 10px;border:1px solid var(--rq-line);border-radius:6px;background:#fff;color:var(--rq-ink);font:inherit}.rhinoq-tools input{padding-left:34px}.rhinoq-search>span{position:absolute;left:11px;bottom:7px;color:var(--rq-muted);font-size:20px;line-height:1;pointer-events:none}.rhinoq-tools input:focus,.rhinoq-tools select:focus{border-color:var(--rq-accent);outline:3px solid rgba(37,99,235,.14)}.rhinoq-tools button{border-color:var(--rq-accent);background:var(--rq-accent);color:#fff;font-weight:700;cursor:pointer}.rhinoq-tools button:hover{background:var(--rq-accent-strong)}
.rhinoq-status-line{display:flex;align-items:center;min-height:24px;margin:6px 2px 9px;color:var(--rq-muted);font-size:12px}.rhinoq-status-line:before{content:"";width:5px;height:5px;margin-right:7px;border-radius:50%;background:var(--rq-success)}
.rhinoq-task-list{display:grid;grid-template-columns:1fr;gap:8px}.rhinoq-task{position:relative;display:grid;grid-template-columns:minmax(235px,.72fr) minmax(280px,1.28fr);gap:0 16px;overflow:hidden;padding:13px 15px;border:1px solid var(--rq-line);border-radius:8px;background:#fff;box-shadow:var(--rq-shadow);animation:rq-enter .2s ease both;transition:border-color .14s ease,box-shadow .14s ease}.rhinoq-task:before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--rq-accent)}.rhinoq-task[data-state="succeeded"]:before{background:var(--rq-success)}.rhinoq-task[data-state="failed"]:before,.rhinoq-task[data-state="cancelled"]:before{background:var(--rq-bad)}.rhinoq-task[data-state="uncertain"]:before{background:var(--rq-warn)}.rhinoq-task:hover{border-color:#b9c9e2;box-shadow:0 3px 9px rgba(15,35,63,.08)}
.rhinoq-card-head{grid-column:1;grid-row:1;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;margin:0 0 8px}.rhinoq-task-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:8px;background:var(--rq-accent-soft);color:var(--rq-accent);font-size:10px;font-weight:900}.rhinoq-task-identity{min-width:0}.rhinoq-task-identity strong,.rhinoq-task-identity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rhinoq-task-identity strong{font-size:14px;letter-spacing:-.01em}.rhinoq-task-identity small{color:var(--rq-muted);font:9px/1.4 var(--rq-mono)}.rhinoq-state{align-self:center;padding:3px 7px;border-radius:4px;background:var(--rq-accent-soft);color:var(--rq-accent);font-size:9px;font-weight:850;letter-spacing:.04em;text-transform:uppercase}.rhinoq-task[data-state="succeeded"] .rhinoq-state{background:var(--rq-success-soft);color:var(--rq-success)}.rhinoq-task[data-state="failed"] .rhinoq-state,.rhinoq-task[data-state="cancelled"] .rhinoq-state{background:var(--rq-bad-soft);color:var(--rq-bad)}.rhinoq-task[data-state="uncertain"] .rhinoq-state{background:var(--rq-warn-soft);color:var(--rq-warn)}
.rhinoq-progress-head{grid-column:1;grid-row:2;display:flex;align-items:center;justify-content:space-between;margin:0 0 5px;color:var(--rq-muted);font-size:11px}.rhinoq-progress-head strong{color:var(--rq-ink)}.rhinoq-task progress{grid-column:1;grid-row:3;width:100%;height:5px;margin:0;border:0;border-radius:999px;overflow:hidden;background:var(--rq-line);accent-color:var(--rq-accent)}.rhinoq-task progress::-webkit-progress-bar{background:var(--rq-line)}.rhinoq-task progress::-webkit-progress-value{border-radius:999px;background:var(--rq-accent)}.rhinoq-task progress::-moz-progress-bar{border-radius:999px;background:var(--rq-accent)}
.rhinoq-explanation{grid-column:2;grid-row:1/4;align-self:stretch;padding:10px 12px;border:1px solid var(--rq-line);border-radius:6px;background:var(--rq-raised)}.rhinoq-explanation strong{display:block;font-size:12px}.rhinoq-explanation p{margin:3px 0 6px;color:var(--rq-muted);font-size:12px;line-height:1.45}.rhinoq-explanation small{color:var(--rq-accent-strong);font-size:10px;font-weight:700}.rhinoq-task[data-state="uncertain"] .rhinoq-explanation{background:var(--rq-warn-soft)}.rhinoq-task[data-state="failed"] .rhinoq-explanation{background:var(--rq-bad-soft)}
.rhinoq-task-footer{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;padding-top:9px;border-top:1px solid var(--rq-line)}.rhinoq-meta{color:var(--rq-muted);font-size:10px}.rhinoq-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap}.rhinoq-task button,.rhinoq-attempts>button,.rhinoq-artifact-card button{min-height:30px;padding:5px 9px;border:1px solid var(--rq-line);border-radius:5px;background:#fff;color:var(--rq-ink);font:inherit;font-size:11px;font-weight:700;cursor:pointer}.rhinoq-open,.rhinoq-back{display:inline-flex;padding:6px 9px;border-radius:5px;color:var(--rq-accent);font-size:11px;font-weight:800;text-decoration:none}.rhinoq-open:hover,.rhinoq-back:hover{background:var(--rq-accent-soft)}
.rhinoq-notice:not(:empty){position:sticky;top:64px;z-index:30;margin:0 0 10px;padding:9px 12px;border:1px solid #cbdcff;border-radius:7px;background:var(--rq-accent-soft);box-shadow:var(--rq-shadow)}.rhinoq-skeleton{min-height:132px;border:1px solid var(--rq-line);background:linear-gradient(100deg,#eef1f5 20%,#fafbfc 40%,#eef1f5 60%);background-size:220% 100%;animation:rq-skeleton 1.25s ease infinite}
.rhinoq-back{margin-bottom:12px;border:1px solid var(--rq-line);background:#fff}.rhinoq-detail-head{padding:18px;border:1px solid var(--rq-line);border-radius:8px;background:#fff;box-shadow:var(--rq-shadow)}.rhinoq-detail-head>p:first-child{margin:0;color:var(--rq-accent);font:700 10px/1.4 var(--rq-mono);text-transform:uppercase}.rhinoq-detail-head h1{margin:3px 0;font-size:28px;line-height:1.2;letter-spacing:-.025em}.rhinoq-detail-head>p:last-child{max-width:760px;margin:6px 0 0;color:var(--rq-muted)}
.rhinoq-detail-summary{display:grid;grid-template-columns:minmax(110px,auto) 1fr;gap:7px 20px;margin:12px 0;padding:15px;border:1px solid var(--rq-line);border-radius:8px;background:#fff;box-shadow:var(--rq-shadow)}.rhinoq-detail-summary strong{color:var(--rq-muted);font-size:10px;text-transform:uppercase}.rhinoq-detail-summary p{margin:0}
.rhinoq-attempts,.rhinoq-waitpoints,.rhinoq-artifacts{margin-top:12px;padding:15px;border:1px solid var(--rq-line);border-radius:8px;background:#fff;box-shadow:var(--rq-shadow)}.rhinoq-attempts h2,.rhinoq-waitpoints h2{margin:0 0 10px;font-size:15px}.rhinoq-attempts{overflow-x:auto}.rhinoq-attempts table{width:100%;border-collapse:collapse}.rhinoq-attempts th,.rhinoq-attempts td{padding:8px;border-bottom:1px solid var(--rq-line);text-align:left}.rhinoq-attempts th{color:var(--rq-muted);font-size:10px;text-transform:uppercase}.rhinoq-waitpoints article{margin:7px 0;padding:10px;border:1px solid var(--rq-line);border-radius:6px;background:var(--rq-raised)}.rhinoq-waitpoints article p{margin:3px 0}.rhinoq-waitpoints article small{color:var(--rq-muted)}
.rhinoq-section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:10px}.rhinoq-section-head p{margin:0;color:var(--rq-accent);font-size:10px;font-weight:800;text-transform:uppercase}.rhinoq-section-head h2{margin:2px 0 0;font-size:16px}.rhinoq-section-head>span{padding:3px 7px;border:1px solid var(--rq-line);border-radius:999px;color:var(--rq-muted);font-size:10px}.rhinoq-artifact-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:8px}.rhinoq-artifact-card{padding:11px;border:1px solid var(--rq-line);border-radius:6px;background:var(--rq-raised)}.rhinoq-artifact-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.rhinoq-artifact-name{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px}.rhinoq-artifact-name>span{display:grid;place-items:center;width:32px;height:32px;border-radius:6px;background:var(--rq-accent-soft);color:var(--rq-accent);font:800 8px/1 var(--rq-mono)}.rhinoq-artifact-status{padding:3px 6px;border-radius:4px;font-size:9px;font-weight:800;text-transform:uppercase}.rhinoq-artifact-status.is-available{background:var(--rq-success-soft);color:var(--rq-success)}.rhinoq-artifact-status.is-expired{background:var(--rq-warn-soft);color:var(--rq-warn)}.rhinoq-artifact-card dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:10px 0}.rhinoq-artifact-card dt{color:var(--rq-muted);font-size:10px}.rhinoq-artifact-card dd{margin:0;text-align:right;font:600 10px/1.5 var(--rq-mono)}.rhinoq-empty{padding:18px;border:1px dashed var(--rq-line-strong);border-radius:6px;color:var(--rq-muted);text-align:center}
button:focus-visible,a:focus-visible{outline:3px solid rgba(37,99,235,.22);outline-offset:2px}button:disabled{opacity:.5;cursor:not-allowed}
@keyframes rq-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@keyframes rq-live{50%{box-shadow:0 0 0 6px rgba(21,154,101,.02)}}@keyframes rq-skeleton{to{background-position:-220% 0}}
@media(max-width:760px){[data-rhinoq-task-center]{padding:16px 12px 42px}.rhinoq-shell{padding:0 12px}.rhinoq-task{grid-template-columns:1fr}.rhinoq-card-head,.rhinoq-progress-head,.rhinoq-task progress,.rhinoq-explanation,.rhinoq-task-footer{grid-column:1;grid-row:auto}.rhinoq-explanation{margin-top:10px}.rhinoq-metrics{grid-template-columns:1fr 1fr}.rhinoq-tools{grid-template-columns:1fr 1fr}.rhinoq-tools label:first-child{grid-column:1/-1}.rhinoq-detail-summary{grid-template-columns:1fr}.rhinoq-detail-summary p{margin-bottom:4px}}
@media(max-width:480px){.rhinoq-intro h1{font-size:23px}.rhinoq-kicker>span:last-child{display:none}.rhinoq-metrics{gap:7px}.rhinoq-metrics>div{min-height:48px;padding:9px 10px}.rhinoq-metrics strong{font-size:18px}.rhinoq-tools{grid-template-columns:1fr}.rhinoq-tools label:first-child{grid-column:auto}.rhinoq-card-head{grid-template-columns:auto minmax(0,1fr)}.rhinoq-state{grid-column:2;justify-self:start}.rhinoq-shell nav{max-width:68%;overflow:auto}.rhinoq-shell nav a,.rhinoq-shell nav [aria-current="page"]{white-space:nowrap}}
@media(prefers-reduced-motion:reduce){.rhinoq-task,.rhinoq-live-dot,.rhinoq-skeleton{animation:none!important}.rhinoq-task{transition:none!important}}
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
