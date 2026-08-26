import type { TaskArtifact, TaskSnapshot, TaskSummary, TaskWaitpoint, TaskWaitpointResolveRequest } from '../gateway/types.js';
import type { TaskBrowserClient, TaskStoreOptions } from './store.js';
import type { TaskListClient, TaskListQuery } from './list-store.js';
import { ApplicationTaskClient, type ApplicationTaskClientOptions } from './http.js';
import { createUseRhinoTask, createUseRhinoTasks, type ReactTaskHooks } from './react.js';
import { taskUIModel } from './ui.js';

export interface ReactElementFactory<Element> extends ReactTaskHooks {
  createElement(type: string | ((props: Record<string, unknown>) => Element), props?: Record<string, unknown> | null, ...children: unknown[]): Element;
}
export interface RhinoQTheme {
  accent?: string; background?: string; surface?: string; foreground?: string;
  muted?: string; border?: string; success?: string; warning?: string;
  danger?: string; radius?: string; fontFamily?: string;
}

interface StyledComponentProps {
  theme?: RhinoQTheme;
  /** Skip the zero-config stylesheet when the host supplies all styles. */
  unstyled?: boolean;
  className?: string;
}

export interface RhinoQTaskListProps extends StyledComponentProps {
  client: TaskListClient; query?: TaskListQuery; pollIntervalMs?: number;
  onSelectTask?(task: TaskSnapshot): void; emptyLabel?: string;
}
export interface RhinoQTaskDetailProps extends StyledComponentProps {
  client: TaskBrowserClient; taskId: string; options?: TaskStoreOptions;
  retryCommandId?(task: TaskSummary | TaskSnapshot): string;
  openResult?(url: string): unknown;
  onChanged?(task: TaskSummary | TaskSnapshot): void;
  onClose?(): void;
  onNotice?(notice: RhinoQComponentNotice): void;
  waitpointResolutionId?(waitpoint: TaskWaitpoint, resolution: unknown): string;
  onRequestInput?(waitpoint: TaskWaitpoint): void;
  openArtifact?(url: string, artifact: TaskArtifact): unknown;
}
export interface RhinoQProgressProps extends StyledComponentProps { task: TaskSummary | TaskSnapshot; }

export interface RhinoQCurrentUser {
  /** Display text only. The server must derive owner and tenant from authentication. */
  name: string;
  avatarUrl?: string;
}

export interface RhinoQComponentNotice {
  kind: 'success' | 'error' | 'info';
  title: string;
  message: string;
  taskId?: string;
}

export type RhinoQTaskFilter = 'all' | 'attention' | 'active' | 'finished';
export type RhinoQTaskSort = 'updated' | 'oldest' | 'type';
export interface RhinoQTaskCenterView {
  search: string;
  filter: RhinoQTaskFilter;
  sort: RhinoQTaskSort;
  savedFilterId?: string;
}
export interface RhinoQSavedFilter extends Partial<Omit<RhinoQTaskCenterView, 'savedFilterId'>> {
  id: string;
  label: string;
}

export type RhinoQTaskCenterDensity = 'comfortable' | 'compact' | 'minimal';
export interface RhinoQTaskCenterDisplay {
  density?: RhinoQTaskCenterDensity;
  showHeader?: boolean;
  showMetrics?: boolean;
  showToolbar?: boolean;
  showTaskIcon?: boolean;
  showTaskState?: boolean;
  showProgress?: boolean;
  showUpdatedAt?: boolean;
  /** Render this many matching rows initially; the user can reveal the next batch. */
  pageSize?: number;
  /** Keep a large activity list inside a stable, independently scrolling region. */
  maxListHeight?: number | string;
  /** Disable RhinoQ's drawer when the host handles selection in its own router or panel. */
  detailMode?: 'drawer' | 'none';
}

export interface RhinoQTaskRenderContext {
  task: TaskSnapshot;
  selected: boolean;
  label: string;
  description?: string;
  progressPercent?: number;
  open(): void;
}

export interface RhinoQTaskCenterProps extends StyledComponentProps {
  /** A browser client whose endpoint already enforces owner and tenant access. */
  client?: TaskListClient & TaskBrowserClient;
  /** Convenience alternative to `client`; same-origin cookies are used by default. */
  apiUrl?: string;
  fetch?: ApplicationTaskClientOptions['fetch'];
  headers?: ApplicationTaskClientOptions['headers'];
  /** Presentation only; never used as an authorization claim. */
  currentUser?: RhinoQCurrentUser;
  title?: string;
  subtitle?: string;
  initialTaskId?: string;
  initialView?: Partial<RhinoQTaskCenterView>;
  savedFilters?: RhinoQSavedFilter[];
  /** Control information density and large-list behavior without replacing data logic. */
  display?: RhinoQTaskCenterDisplay;
  /** Application-owned display name, for example a video title or user-supplied job name. */
  taskLabel?(task: TaskSnapshot): string;
  taskDescription?(task: TaskSnapshot): string | undefined;
  /** Replace the complete row while retaining RhinoQ filtering, realtime state and paging. */
  renderTask?(context: RhinoQTaskRenderContext): unknown;
  /** Add application-owned business/order/provider aliases without widening RhinoQ's browser contract. */
  taskSearchText?(task: TaskSnapshot): string;
  query?: TaskListQuery;
  pollIntervalMs?: number;
  retryCommandId?(task: TaskSummary | TaskSnapshot): string;
  openResult?(url: string): unknown;
  waitpointResolutionId?(waitpoint: TaskWaitpoint, resolution: unknown): string;
  onRequestInput?(waitpoint: TaskWaitpoint): void;
  openArtifact?(url: string, artifact: TaskArtifact): unknown;
  onTaskChange?(taskId: string | undefined): void;
  onViewChange?(view: RhinoQTaskCenterView): void;
  emptyLabel?: string;
}

/** Zero-config styles shared by the React/Next.js components. */
export const RHINOQ_EMBED_CSS = `
/* Compact workspace defaults: one token system, clear hierarchy and restrained motion. */
.rhinoq-embed{--rq-accent:#2563eb;--rq-bg:#f5f7fa;--rq-surface:#fff;--rq-ink:#10233f;--rq-muted:#64748b;--rq-border:#dfe5ee;--rq-success:#15803d;--rq-warning:#c76b08;--rq-danger:#dc2626;--rq-radius:8px;--rq-font:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box;color:var(--rq-ink);font:14px/1.45 var(--rq-font)}
.rhinoq-embed *{box-sizing:border-box}.rhinoq-embed button{font:inherit}
.rhinoq-embed-shell{padding:18px;border:1px solid var(--rq-border);border-radius:var(--rq-radius);background:var(--rq-surface);box-shadow:0 1px 3px rgba(15,35,63,.07)}
.rhinoq-embed-head,.rhinoq-detail-top{display:flex;align-items:center;justify-content:space-between;gap:16px}.rhinoq-embed-head{margin-bottom:14px}.rhinoq-detail-top>div:last-child{display:flex;align-items:center;gap:8px}
.rhinoq-embed-eyebrow{display:flex;align-items:center;gap:6px;margin:0 0 3px;color:var(--rq-accent);font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}
.rhinoq-embed-live{width:6px;height:6px;border-radius:50%;background:var(--rq-success);box-shadow:0 0 0 3px color-mix(in srgb,var(--rq-success) 10%,transparent);animation:rq-breathe 2.4s ease-in-out infinite}
.rhinoq-embed h2{margin:0;font-size:22px;line-height:1.2;letter-spacing:-.025em}
.rhinoq-embed-count{display:grid;place-items:center;min-width:38px;height:28px;padding:0 9px;border:1px solid color-mix(in srgb,var(--rq-accent) 22%,var(--rq-border));border-radius:6px;background:color-mix(in srgb,var(--rq-accent) 7%,var(--rq-surface));color:var(--rq-accent);font-size:12px;font-weight:800}
.rhinoq-embed-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}.rhinoq-embed-item{animation:rq-enter .2s ease both}.rhinoq-embed-item:nth-child(2){animation-delay:35ms}.rhinoq-embed-item:nth-child(3){animation-delay:70ms}.rhinoq-embed-item:nth-child(4){animation-delay:105ms}
.rhinoq-task-card{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;padding:12px 13px;border:1px solid var(--rq-border);border-radius:var(--rq-radius);background:var(--rq-surface);color:inherit;text-align:left;cursor:pointer;box-shadow:0 1px 2px rgba(15,35,63,.05);transition:border-color .14s ease,box-shadow .14s ease}
.rhinoq-task-card.no-icon{grid-template-columns:minmax(0,1fr) auto}.rhinoq-task-card.no-icon.no-state{grid-template-columns:minmax(0,1fr)}.rhinoq-task-card.no-icon .rhinoq-progress{grid-column:1/-1}
.rhinoq-task-card:hover{border-color:color-mix(in srgb,var(--rq-accent) 30%,var(--rq-border));box-shadow:0 3px 9px rgba(15,35,63,.08)}
.rhinoq-task-card:focus-visible,.rhinoq-action:focus-visible{outline:3px solid color-mix(in srgb,var(--rq-accent) 25%,transparent);outline-offset:2px}
.rhinoq-task-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:7px;background:color-mix(in srgb,var(--rq-accent) 9%,var(--rq-surface));color:var(--rq-accent);font-size:10px;font-weight:900}
.rhinoq-task-copy{min-width:0}.rhinoq-task-copy strong,.rhinoq-task-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rhinoq-task-copy strong{font-size:14px;letter-spacing:-.01em}.rhinoq-task-copy small{margin-top:1px;color:var(--rq-muted);font-size:11px}
.rhinoq-state{align-self:center;padding:3px 7px;border-radius:4px;background:color-mix(in srgb,var(--rq-accent) 8%,var(--rq-surface));color:var(--rq-accent);font-size:9px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
.rhinoq-state[data-state="succeeded"]{background:color-mix(in srgb,var(--rq-success) 10%,var(--rq-surface));color:var(--rq-success)}.rhinoq-state[data-state="failed"],.rhinoq-state[data-state="cancelled"]{background:color-mix(in srgb,var(--rq-danger) 9%,var(--rq-surface));color:var(--rq-danger)}.rhinoq-state[data-state="uncertain"]{background:color-mix(in srgb,var(--rq-warning) 11%,var(--rq-surface));color:var(--rq-warning)}
.rhinoq-progress{grid-column:2/-1;display:grid;grid-template-columns:1fr auto;align-items:center;gap:5px 10px;color:var(--rq-muted);font-size:11px}.rhinoq-progress-track{position:relative;grid-column:1/-1;overflow:hidden;height:5px;border-radius:999px;background:color-mix(in srgb,var(--rq-border) 80%,var(--rq-bg))}.rhinoq-progress-fill{position:absolute;inset:0 auto 0 0;width:var(--rq-progress,0%);border-radius:inherit;background:var(--rq-accent);transition:width .45s cubic-bezier(.22,1,.36,1)}.rhinoq-progress-native{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.rhinoq-empty-state,.rhinoq-error-state{display:grid;place-items:center;min-height:140px;padding:22px;border:1px dashed var(--rq-border);border-radius:var(--rq-radius);background:var(--rq-bg);color:var(--rq-muted);text-align:center}.rhinoq-empty-state strong,.rhinoq-error-state strong{color:var(--rq-ink);font-size:15px}
.rhinoq-action{min-height:34px;padding:7px 11px;border:1px solid var(--rq-border);border-radius:6px;background:var(--rq-surface);color:var(--rq-ink);font-weight:750;cursor:pointer;transition:background .14s ease,border-color .14s ease}.rhinoq-action:hover{border-color:color-mix(in srgb,var(--rq-accent) 30%,var(--rq-border));background:color-mix(in srgb,var(--rq-accent) 4%,var(--rq-surface))}.rhinoq-action-primary{border-color:var(--rq-accent);background:var(--rq-accent);color:#fff}.rhinoq-action:disabled{opacity:.5;cursor:not-allowed}
.rhinoq-detail{padding:18px}.rhinoq-detail-top{align-items:flex-start}.rhinoq-detail-type{margin:0 0 4px;color:var(--rq-accent);font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.rhinoq-detail-lead{max-width:680px;margin:7px 0 14px;color:var(--rq-muted);font-size:13px}.rhinoq-detail-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(230px,.6fr);gap:10px}.rhinoq-detail-panel{padding:13px;border:1px solid var(--rq-border);border-radius:7px;background:var(--rq-bg)}.rhinoq-detail-panel dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 14px;margin:0}.rhinoq-detail-panel dt{color:var(--rq-muted);font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}.rhinoq-detail-panel dd{margin:0;text-align:right;font-weight:650}.rhinoq-attention{margin:10px 0 0;padding:9px 11px;border:1px solid color-mix(in srgb,var(--rq-warning) 34%,var(--rq-border));border-radius:6px;background:color-mix(in srgb,var(--rq-warning) 8%,var(--rq-surface))}.rhinoq-detail-actions{display:flex;gap:8px;margin-top:11px}.rhinoq-reconnect{margin:10px 0 0;color:var(--rq-warning);font-size:11px}
.rhinoq-resource-section{margin-top:12px;border:1px solid var(--rq-border);border-radius:8px;background:var(--rq-surface);overflow:hidden}.rhinoq-resource-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border-bottom:1px solid var(--rq-border)}.rhinoq-resource-head h3{margin:0;font-size:13px}.rhinoq-resource-head span{color:var(--rq-muted);font-size:10px;font-weight:750}.rhinoq-resource-empty{margin:0;padding:13px;color:var(--rq-muted);font-size:11px}.rhinoq-resource-list{display:grid;margin:0;padding:0;list-style:none}.rhinoq-resource-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:12px 13px}.rhinoq-resource-row+.rhinoq-resource-row{border-top:1px solid var(--rq-border)}.rhinoq-resource-copy{min-width:0}.rhinoq-resource-copy strong,.rhinoq-resource-copy small{display:block}.rhinoq-resource-copy strong{overflow-wrap:anywhere;font-size:12px}.rhinoq-resource-copy small{margin-top:3px;color:var(--rq-muted);font-size:10px}.rhinoq-resource-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}.rhinoq-resource-actions .rhinoq-action{min-height:30px;padding:5px 9px;font-size:11px}.rhinoq-artifact-preview{grid-column:1/-1;overflow:hidden;min-height:180px;border:1px solid var(--rq-border);border-radius:7px;background:#eef2f7}.rhinoq-artifact-preview img,.rhinoq-artifact-preview video,.rhinoq-artifact-preview iframe{display:block;width:100%;height:min(48vh,420px);border:0;object-fit:contain}.rhinoq-artifact-preview audio{display:block;width:calc(100% - 24px);margin:24px 12px}.rhinoq-waitpoint-state{display:inline-flex;align-items:center;gap:5px;color:var(--rq-warning);font-size:10px;font-weight:800}.rhinoq-waitpoint-state:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.rhinoq-skeleton-card{height:72px;border-radius:var(--rq-radius);background:linear-gradient(100deg,var(--rq-bg) 20%,color-mix(in srgb,var(--rq-accent) 7%,var(--rq-surface)) 40%,var(--rq-bg) 60%);background-size:220% 100%;animation:rq-skeleton 1.35s ease infinite}.rhinoq-skeleton-card+.rhinoq-skeleton-card{margin-top:8px}
.rhinoq-center{position:relative;min-height:560px;padding:22px;background:var(--rq-bg);border:1px solid var(--rq-border);border-radius:calc(var(--rq-radius) + 4px);overflow:hidden}.rhinoq-center-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:18px}.rhinoq-center-header h1{margin:3px 0 5px;font-size:26px;line-height:1.15;letter-spacing:-.035em}.rhinoq-center-subtitle{max-width:720px;margin:0;color:var(--rq-muted)}.rhinoq-viewer{display:flex;align-items:center;gap:9px;min-width:0;padding:6px 9px;border:1px solid var(--rq-border);border-radius:999px;background:var(--rq-surface)}.rhinoq-viewer-avatar{display:grid;place-items:center;width:28px;height:28px;overflow:hidden;border-radius:50%;background:var(--rq-ink);color:#fff;font-size:10px;font-weight:850}.rhinoq-viewer-avatar img{width:100%;height:100%;object-fit:cover}.rhinoq-viewer strong{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.rhinoq-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}.rhinoq-metric{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 14px;border:1px solid var(--rq-border);border-radius:var(--rq-radius);background:var(--rq-surface);box-shadow:0 1px 2px rgba(15,35,63,.04)}.rhinoq-metric span{color:var(--rq-muted);font-size:11px;font-weight:750}.rhinoq-metric strong{font-size:20px;letter-spacing:-.03em}
.rhinoq-center-tools{display:grid;grid-template-columns:minmax(220px,1fr) 180px 170px auto;gap:8px;margin-bottom:12px;padding:10px;border:1px solid var(--rq-border);border-radius:var(--rq-radius);background:var(--rq-surface)}.rhinoq-center-tools.has-saved-filters{grid-template-columns:minmax(220px,1fr) minmax(150px,.55fr) 150px 145px auto}.rhinoq-field{display:grid;gap:4px;color:var(--rq-muted);font-size:9px;font-weight:850;letter-spacing:.055em;text-transform:uppercase}.rhinoq-field input,.rhinoq-field select{min-width:0;height:38px;padding:0 11px;border:1px solid var(--rq-border);border-radius:6px;background:var(--rq-surface);color:var(--rq-ink);font:650 12px/1 var(--rq-font);outline:none}.rhinoq-field input:focus,.rhinoq-field select:focus{border-color:var(--rq-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--rq-accent) 12%,transparent)}.rhinoq-tool-reset{align-self:end;height:38px}.rhinoq-center-status{display:flex;align-items:center;gap:7px;margin:0 2px 12px;color:var(--rq-muted);font-size:11px}.rhinoq-center-status:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--rq-success)}
.rhinoq-center-list{display:grid;gap:9px;margin:0;padding:0;list-style:none}.rhinoq-center-list .rhinoq-task-card{grid-template-columns:auto minmax(0,1fr) auto;min-height:88px;padding:14px 15px}.rhinoq-center-list .rhinoq-task-card[aria-current="true"]{border-color:var(--rq-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--rq-accent) 12%,transparent)}
.rhinoq-center-list-scroll{overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.rhinoq-center-more{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px}.rhinoq-center-more span{color:var(--rq-muted);font-size:11px}
.rhinoq-center[data-density="compact"]{padding:16px}.rhinoq-center[data-density="compact"] .rhinoq-center-header{margin-bottom:12px}.rhinoq-center[data-density="compact"] .rhinoq-center-list{gap:6px}.rhinoq-center[data-density="compact"] .rhinoq-center-list .rhinoq-task-card{min-height:64px;padding:9px 11px}.rhinoq-center[data-density="compact"] .rhinoq-task-icon{width:30px;height:30px}.rhinoq-center[data-density="compact"] .rhinoq-progress-track{height:4px}
.rhinoq-center[data-density="minimal"]{min-height:0;padding:10px}.rhinoq-center[data-density="minimal"] .rhinoq-center-list{gap:4px}.rhinoq-center[data-density="minimal"] .rhinoq-center-list .rhinoq-task-card{min-height:48px;padding:7px 9px;box-shadow:none}.rhinoq-center[data-density="minimal"] .rhinoq-task-icon{width:26px;height:26px}.rhinoq-center[data-density="minimal"] .rhinoq-task-copy strong{font-size:12px}.rhinoq-center[data-density="minimal"] .rhinoq-progress{font-size:10px}.rhinoq-center[data-density="minimal"] .rhinoq-progress-track{height:3px}
.rhinoq-drawer-backdrop{position:fixed;inset:0;z-index:40;background:rgba(8,22,42,.24);backdrop-filter:blur(2px);animation:rq-fade .18s ease both}.rhinoq-drawer{position:fixed;z-index:41;inset:10px 10px 10px auto;width:min(640px,calc(100vw - 32px));overflow:auto;border:1px solid var(--rq-border);border-radius:12px;background:var(--rq-bg);box-shadow:-18px 0 48px rgba(15,35,63,.18);animation:rq-drawer .24s cubic-bezier(.22,1,.36,1) both}.rhinoq-drawer .rhinoq-detail{min-height:100%;border:0;border-radius:0;box-shadow:none}.rhinoq-detail-close{display:grid;place-items:center;width:34px;height:34px;padding:0;border:1px solid var(--rq-border);border-radius:7px;background:var(--rq-surface);color:var(--rq-ink);cursor:pointer}.rhinoq-detail-close:hover{border-color:var(--rq-accent);color:var(--rq-accent)}.rhinoq-detail-close:focus-visible{outline:3px solid color-mix(in srgb,var(--rq-accent) 25%,transparent);outline-offset:2px}
.rhinoq-toast-region{position:fixed;z-index:60;top:18px;right:18px;display:grid;gap:8px;width:min(390px,calc(100vw - 32px));pointer-events:none}.rhinoq-toast{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;padding:12px;border:1px solid var(--rq-border);border-radius:9px;background:var(--rq-surface);box-shadow:0 14px 36px rgba(15,35,63,.16);pointer-events:auto;animation:rq-toast .25s cubic-bezier(.22,1,.36,1) both}.rhinoq-toast-icon{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:color-mix(in srgb,var(--rq-accent) 10%,var(--rq-surface));color:var(--rq-accent);font-weight:900}.rhinoq-toast[data-kind="success"] .rhinoq-toast-icon{background:color-mix(in srgb,var(--rq-success) 11%,var(--rq-surface));color:var(--rq-success)}.rhinoq-toast[data-kind="error"] .rhinoq-toast-icon{background:color-mix(in srgb,var(--rq-danger) 10%,var(--rq-surface));color:var(--rq-danger)}.rhinoq-toast-copy strong,.rhinoq-toast-copy span{display:block}.rhinoq-toast-copy strong{font-size:12px}.rhinoq-toast-copy span{margin-top:2px;color:var(--rq-muted);font-size:11px}.rhinoq-toast-close{align-self:start;padding:2px;border:0;background:transparent;color:var(--rq-muted);cursor:pointer}.rhinoq-action-busy{position:relative;color:transparent!important}.rhinoq-action-busy:after{content:"";position:absolute;inset:0;margin:auto;width:13px;height:13px;border:2px solid var(--rq-accent);border-right-color:transparent;border-radius:50%;animation:rq-spin .7s linear infinite}.rhinoq-action-primary.rhinoq-action-busy:after{border-color:#fff;border-right-color:transparent}
@keyframes rq-fade{from{opacity:0}}@keyframes rq-drawer{from{opacity:0;transform:translateX(22px)}}@keyframes rq-toast{from{opacity:0;transform:translateY(-8px)}}@keyframes rq-spin{to{transform:rotate(360deg)}}
@keyframes rq-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@keyframes rq-breathe{50%{box-shadow:0 0 0 6px color-mix(in srgb,var(--rq-success) 3%,transparent)}}@keyframes rq-skeleton{to{background-position:-220% 0}}
@media(max-width:900px){.rhinoq-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.rhinoq-center-tools,.rhinoq-center-tools.has-saved-filters{grid-template-columns:minmax(0,1fr) minmax(140px,.45fr)}.rhinoq-tool-reset{align-self:end}}
@media(max-width:640px){.rhinoq-embed-shell{padding:14px}.rhinoq-center{padding:14px;border-radius:var(--rq-radius)}.rhinoq-center-header{display:block}.rhinoq-viewer{width:max-content;margin-top:12px}.rhinoq-center-tools,.rhinoq-center-tools.has-saved-filters{grid-template-columns:1fr}.rhinoq-metrics{gap:7px}.rhinoq-metric{padding:10px}.rhinoq-task-card{grid-template-columns:auto minmax(0,1fr)}.rhinoq-state{grid-column:2;justify-self:start}.rhinoq-progress{grid-column:1/-1}.rhinoq-detail-grid{grid-template-columns:1fr}.rhinoq-detail-top{display:flex}.rhinoq-detail-top .rhinoq-state{display:inline-block;margin-top:8px}.rhinoq-drawer{inset:0;width:100%;border:0;border-radius:0}.rhinoq-drawer-backdrop{display:none}.rhinoq-toast-region{top:10px;right:10px;width:calc(100vw - 20px)}}
@media(prefers-reduced-motion:reduce){.rhinoq-embed *{animation:none!important;transition:none!important}}
`;

/** Dependency-injected components keep React optional for server-only users. */
export function createRhinoQComponents<Element>(react: ReactElementFactory<Element>) {
  if (typeof react?.createElement !== 'function') throw new TypeError('React createElement is required');
  const useTask = createUseRhinoTask(react);
  const useTasks = createUseRhinoTasks(react);
  const h = react.createElement.bind(react);
  const styles = (unstyled?: boolean): Element | null => unstyled ? null : h('style', { 'data-rhinoq-styles': 'embedded' }, RHINOQ_EMBED_CSS);
  function RhinoQStyles(): Element { return h('style', { 'data-rhinoq-styles': 'embedded' }, RHINOQ_EMBED_CSS); }

  function RhinoQProgress(props: RhinoQProgressProps): Element {
    const ui = taskUIModel(props.task);
    const percent = ui.progress.percent;
    const width = percent === undefined ? (props.task.state === 'running' ? 32 : 0) : Math.max(0, Math.min(100, percent));
    return h('div', { className: join('rhinoq-embed rhinoq-progress', props.className), style: { ...themeStyle(props.theme), '--rq-progress': `${width}%` } },
      styles(props.unstyled), h('span', { role: 'status', 'aria-live': 'polite' }, ui.explanation.progressText),
      h('span', { 'aria-hidden': true }, percent === undefined ? 'In progress' : `${Math.round(percent)}%`),
      h('span', { className: 'rhinoq-progress-track', 'aria-hidden': true }, h('span', { className: 'rhinoq-progress-fill' })),
      h('progress', { className: 'rhinoq-progress-native', max: percent === undefined ? undefined : 100, value: percent, 'aria-label': `Task progress: ${ui.explanation.progressText}` }));
  }

  function RhinoQTaskCenter(props: RhinoQTaskCenterProps): Element {
    const client = react.useMemo(
      () => resolveTaskCenterClient(props),
      [props.client, props.apiUrl, props.fetch, props.headers],
    );
    const pageSize = taskCenterPageSize(props.display?.pageSize);
    const viewStore = react.useMemo(() => new TaskCenterViewStore(props.initialTaskId, props.initialView, pageSize), []);
    const focusState = react.useMemo(() => ({ previous: undefined as HTMLElement | undefined }), []);
    const view = react.useSyncExternalStore(viewStore.subscribe, viewStore.getSnapshot, viewStore.getSnapshot);
    react.useEffect(() => { viewStore.configurePageSize(pageSize); return () => undefined; }, [viewStore, pageSize]);
    const tasks = useTasks(client, props.query ?? {}, { pollIntervalMs: props.pollIntervalMs });
    const taskStateKey = tasks.tasks.map((task) => `${task.id}:${task.entityVersion}:${task.state}`).join('|');
    const selectTask = (taskId: string | undefined) => {
      viewStore.select(props.display?.detailMode === 'none' ? undefined : taskId);
      props.onTaskChange?.(taskId);
    };
    const publishView = () => props.onViewChange?.(publicView(viewStore.getSnapshot()));
    react.useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (!viewStore.getSnapshot().selectedTaskId) return;
        if (event.key === 'Escape') { event.preventDefault(); selectTask(undefined); return; }
        if (event.key !== 'Tab' || typeof document === 'undefined') return;
        const drawer = document.querySelector<HTMLElement>('.rhinoq-drawer[role="dialog"]');
        if (!drawer) return;
        const focusable = [...drawer.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
        if (!focusable.length) return;
        const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      if (typeof document !== 'undefined') document.addEventListener('keydown', onKeyDown);
      return () => { if (typeof document !== 'undefined') document.removeEventListener('keydown', onKeyDown); };
    }, [viewStore, props.onTaskChange]);
    react.useEffect(() => {
      if (typeof document === 'undefined' || !view.selectedTaskId) return () => undefined;
      const selectedTaskId = view.selectedTaskId;
      focusState.previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      queueMicrotask(() => document.querySelector<HTMLElement>('.rhinoq-drawer[role="dialog"]')?.focus());
      return () => {
        const previous = focusState.previous; focusState.previous = undefined;
        queueMicrotask(() => {
          if (previous && previous !== document.body) { previous.focus(); return; }
          [...document.querySelectorAll<HTMLElement>('[data-rhinoq-task-id]')].find((item) => item.dataset.rhinoqTaskId === selectedTaskId)?.focus();
        });
      };
    }, [Boolean(view.selectedTaskId), focusState]);
    react.useEffect(() => { viewStore.observe(tasks.tasks); return () => undefined; }, [viewStore, taskStateKey]);
    const newestNotice = view.notices[view.notices.length - 1];
    react.useEffect(() => {
      if (!newestNotice) return () => undefined;
      const timer = setTimeout(() => viewStore.dismiss(newestNotice.id), newestNotice.kind === 'error' ? 9_000 : 6_000);
      return () => clearTimeout(timer);
    }, [viewStore, newestNotice?.id]);

    const allTasks = tasks.tasks;
    const visible = filterTasks(allTasks, view.search, view.filter, view.sort, props.taskSearchText);
    const renderedTasks = view.visibleLimit ? visible.slice(0, view.visibleLimit) : visible;
    const metrics = taskMetrics(allTasks);
    const title = props.title ?? 'My activity';
    const countLabel = visible.length === allTasks.length
      ? `${visible.length} task${visible.length === 1 ? '' : 's'}`
      : `${visible.length} of ${allTasks.length} tasks`;
    const status = tasks.status === 'reconnecting'
      ? `${countLabel} · reconnecting with polling fallback`
      : `${countLabel} · ${tasks.transport === 'live' ? 'live' : 'up to date'}`;
    const density = props.display?.density ?? 'comfortable';
    const listStyle = props.display?.maxListHeight === undefined ? undefined : { maxHeight: cssLength(props.display.maxListHeight) };
    const rootProps = { className: join('rhinoq-embed rhinoq-center', props.className), style: themeStyle(props.theme), 'data-density': density, 'aria-busy': tasks.status === 'loading' };
    const notices = h('div', { className: 'rhinoq-toast-region', 'aria-live': 'polite', 'aria-label': 'Task notifications' },
      ...view.notices.map((notice) => toast(notice, () => viewStore.dismiss(notice.id), h)));
    const drawer = view.selectedTaskId ? h('div', null,
      h('div', { className: 'rhinoq-drawer-backdrop', 'aria-hidden': true, onClick: () => selectTask(undefined) }),
      h('aside', { className: 'rhinoq-drawer', role: 'dialog', 'aria-modal': true, 'aria-label': 'Task details', tabIndex: -1 },
        h(RhinoQTaskDetail as unknown as (componentProps: Record<string, unknown>) => Element, {
          client, taskId: view.selectedTaskId, options: { pollIntervalMs: props.pollIntervalMs },
          theme: props.theme, unstyled: true, retryCommandId: props.retryCommandId,
          openResult: props.openResult, onClose: () => selectTask(undefined),
          waitpointResolutionId: props.waitpointResolutionId, onRequestInput: props.onRequestInput,
          openArtifact: props.openArtifact,
          onChanged: () => void tasks.refresh(), onNotice: (notice: RhinoQComponentNotice) => viewStore.notice(notice),
        }))) : null;

    return h('section', rootProps, styles(props.unstyled),
      props.display?.showHeader === false ? null : h('header', { className: 'rhinoq-center-header' },
        h('div', null, h('p', { className: 'rhinoq-embed-eyebrow' }, h('span', { className: 'rhinoq-embed-live', 'aria-hidden': true }), 'Background activity'), h('h1', null, title), h('p', { className: 'rhinoq-center-subtitle' }, props.subtitle ?? 'Follow work as it happens, understand what needs attention, and collect every result from one calm workspace.')),
        props.currentUser ? viewer(props.currentUser, h) : null),
      props.display?.showMetrics === false ? null : h('div', { className: 'rhinoq-metrics', 'aria-label': 'Task overview' },
        metric('All tasks', metrics.all, h), metric('In progress', metrics.active, h), metric('Ready', metrics.ready, h), metric('Attention', metrics.attention, h)),
      props.display?.showToolbar === false ? null : h('div', { className: join('rhinoq-center-tools', props.savedFilters?.length ? 'has-saved-filters' : ''), role: 'search' },
        h('label', { className: 'rhinoq-field' }, 'Search tasks', h('input', { type: 'search', value: view.search, placeholder: 'Search by task name or business ID', onInput: (event: unknown) => { viewStore.setSearch(eventValue(event)); publishView(); }, 'aria-label': 'Search tasks' })),
        props.savedFilters?.length ? h('label', { className: 'rhinoq-field' }, 'Saved view', h('select', { value: view.savedFilterId ?? '', onChange: (event: unknown) => { viewStore.applySavedFilter(eventValue(event), props.savedFilters ?? []); publishView(); }, 'aria-label': 'Saved task view' },
          h('option', { value: '' }, 'Custom view'), ...props.savedFilters.map((saved) => h('option', { value: saved.id, key: saved.id }, saved.label)))) : null,
        h('label', { className: 'rhinoq-field' }, 'Show', h('select', { value: view.filter, onChange: (event: unknown) => { viewStore.setFilter(asTaskFilter(eventValue(event))); publishView(); }, 'aria-label': 'Filter tasks' },
          h('option', { value: 'all' }, 'All tasks'), h('option', { value: 'attention' }, 'Needs attention'), h('option', { value: 'active' }, 'In progress'), h('option', { value: 'finished' }, 'Finished'))),
        h('label', { className: 'rhinoq-field' }, 'Sort', h('select', { value: view.sort, onChange: (event: unknown) => { viewStore.setSort(asTaskSort(eventValue(event))); publishView(); }, 'aria-label': 'Sort tasks' },
          h('option', { value: 'updated' }, 'Recently updated'), h('option', { value: 'oldest' }, 'Oldest updated'), h('option', { value: 'type' }, 'Task name'))),
        h('button', { className: 'rhinoq-action rhinoq-tool-reset', type: 'button', onClick: () => { viewStore.reset(); publishView(); }, disabled: !view.search && view.filter === 'all' && view.sort === 'updated' }, 'Reset filters')),
      h('p', { className: 'rhinoq-center-status', role: 'status', 'aria-live': 'polite' }, status),
      tasks.error && allTasks.length === 0 ? h('div', { className: 'rhinoq-error-state', role: 'alert' }, h('div', null, h('strong', null, 'Tasks could not be loaded'), h('p', null, errorMessage(tasks.error)), h('button', { className: 'rhinoq-action', type: 'button', onClick: () => void tasks.refresh() }, 'Try again'))) :
        tasks.status === 'loading' && allTasks.length === 0 ? h('div', { role: 'status', 'aria-label': 'Loading tasks' }, ...[1, 2, 3].map((key) => h('div', { key, className: 'rhinoq-skeleton-card', 'aria-hidden': true }))) :
          visible.length === 0 ? h('div', { className: 'rhinoq-empty-state', role: 'status' }, h('div', null, h('strong', null, allTasks.length ? 'No tasks match this view' : 'Everything is quiet'), h('p', null, allTasks.length ? 'Reset the filters to see all tasks.' : props.emptyLabel ?? 'New background work will appear here automatically.'))) :
            h('div', null,
              h('ul', { className: join('rhinoq-center-list', listStyle ? 'rhinoq-center-list-scroll' : ''), style: listStyle, role: 'list', 'aria-label': 'Background tasks' }, ...renderedTasks.map((task) => taskCenterRow(task, view.selectedTaskId === task.id, () => selectTask(task.id), props, h))),
              renderedTasks.length < visible.length ? h('div', { className: 'rhinoq-center-more' },
                h('button', { className: 'rhinoq-action', type: 'button', onClick: () => viewStore.showMore(), 'aria-label': `Show ${Math.min(pageSize ?? visible.length, visible.length - renderedTasks.length)} more tasks` }, 'Load more'),
                h('span', null, `${renderedTasks.length} of ${visible.length} shown`)) : null),
      notices, drawer);
  }

  function RhinoQTaskList(props: RhinoQTaskListProps): Element {
    const state = useTasks(props.client, props.query ?? {}, { pollIntervalMs: props.pollIntervalMs });
    const shell = (content: unknown, busy = false): Element => h('section', { className: join('rhinoq-embed rhinoq-embed-shell', props.className), style: themeStyle(props.theme), 'aria-busy': busy }, styles(props.unstyled), content);
    if ((state.status === 'idle' || state.status === 'loading') && state.tasks.length === 0) return shell(h('div', null,
      header('Your activity', 'Loading', h), h('div', { role: 'status', 'aria-label': 'Loading tasks' }, ...[1, 2, 3].map((key) => h('div', { key, className: 'rhinoq-skeleton-card', 'aria-hidden': true })))), true);
    if (state.error && state.tasks.length === 0) return shell(h('div', null, header('Your activity', 'Offline', h), h('div', { className: 'rhinoq-error-state', role: 'alert' }, h('div', null,
      h('strong', null, 'Tasks could not be loaded'), h('p', null, 'Check the connection and try again.'), h('button', { className: 'rhinoq-action', type: 'button', onClick: () => void state.refresh() }, 'Try again')))));
    if (state.tasks.length === 0) return shell(h('div', null, header('Your activity', '0', h), h('div', { className: 'rhinoq-empty-state', role: 'status' }, h('div', null,
      h('strong', null, 'Everything is quiet'), h('p', null, props.emptyLabel ?? 'New background work will appear here automatically.')))));
    return shell(h('div', null, header('Your activity', String(state.tasks.length), h),
      h('ul', { className: 'rhinoq-embed-list', role: 'list', 'aria-label': 'Background tasks' }, ...state.tasks.map((task) => taskCard(task, props, h))),
      state.status === 'reconnecting' ? h('p', { className: 'rhinoq-reconnect', role: 'status', 'aria-live': 'polite' }, 'Reconnecting… showing the latest saved status.') : null));
  }

  function RhinoQTaskDetail(props: RhinoQTaskDetailProps): Element {
    const state = useTask(props.client, props.taskId, props.options);
    const actionStore = react.useMemo(() => new TaskActionStore(), [props.taskId]);
    const actionState = react.useSyncExternalStore(actionStore.subscribe, actionStore.getSnapshot, actionStore.getSnapshot);
    const resourceStore = react.useMemo(() => new TaskDetailResourceStore(props.client, props.taskId), [props.client, props.taskId]);
    react.useEffect(() => { void resourceStore.refresh(); return () => resourceStore.stop(); }, [resourceStore]);
    const resources = react.useSyncExternalStore(resourceStore.subscribe, resourceStore.getSnapshot, resourceStore.getSnapshot);
    const rootProps = { className: join('rhinoq-embed rhinoq-embed-shell rhinoq-detail', props.className), style: themeStyle(props.theme) };
    if (!state.snapshot && (state.status === 'idle' || state.status === 'loading')) return h('article', { ...rootProps, 'aria-busy': true }, styles(props.unstyled), h('div', { className: 'rhinoq-skeleton-card', role: 'status', 'aria-label': 'Loading task' }));
    if (!state.snapshot) return h('article', rootProps, styles(props.unstyled), h('div', { className: 'rhinoq-error-state', role: 'alert' }, h('strong', null, 'Task could not be loaded')));
    const task = state.snapshot;
    const ui = state.ui ?? taskUIModel(task);
    const invoke = (kind: TaskActionKind) => void actionStore.run(kind, async () => {
      try {
        let changed: TaskSnapshot | undefined;
        if (kind === 'cancel') changed = await state.cancel();
        else if (kind === 'retry') {
          const commandId = props.retryCommandId?.(task);
          if (!commandId) throw new TypeError('retryCommandId is required for retry');
          changed = await state.retry(commandId);
        } else await state.downloadResult(props.openResult);
        if (changed) props.onChanged?.(changed);
        props.onNotice?.(actionNotice(kind, task.id));
      } catch (error) {
        props.onNotice?.(actionErrorNotice(kind, task.id, error));
      }
    });
    return h('article', { ...rootProps, 'aria-labelledby': `rhinoq-task-${task.id}` }, styles(props.unstyled),
      h('div', { className: 'rhinoq-detail-top' }, h('div', null, h('p', { className: 'rhinoq-detail-type' }, task.type), h('h2', { id: `rhinoq-task-${task.id}` }, ui.explanation.headline)), h('div', null, h('span', { className: 'rhinoq-state', 'data-state': task.state }, ui.label), props.onClose ? h('button', { className: 'rhinoq-detail-close', type: 'button', onClick: props.onClose, 'aria-label': 'Close task details' }, '×') : null)),
      h('p', { className: 'rhinoq-detail-lead' }, ui.explanation.explanation),
      h('div', { className: 'rhinoq-detail-grid' }, h('section', { className: 'rhinoq-detail-panel', 'aria-label': 'Task progress' }, RhinoQProgress({ task, theme: props.theme, unstyled: true })),
        h('section', { className: 'rhinoq-detail-panel', 'aria-label': 'Task facts' }, h('dl', null, h('dt', null, 'Status'), h('dd', null, ui.label), h('dt', null, 'Verification'), h('dd', null, humanize(ui.verification.status)), h('dt', null, 'Updated'), h('dd', null, relativeTime(task.updatedAt))))),
      state.attentionReason ? h('p', { className: 'rhinoq-attention', role: 'alert' }, state.attentionReason) : null,
      resourceSections(task, resources, {
        refresh: () => void resourceStore.refresh(),
        resolveApproval: (waitpoint, resolution) => void resourceStore.resolveApproval(waitpoint, resolution, props.waitpointResolutionId).then(() => {
          props.onNotice?.({ kind: 'success', title: resolution === true ? 'Approval recorded' : 'Decision recorded', message: 'The Task can continue from the durable waitpoint.', taskId: task.id });
          props.onChanged?.(task);
        }).catch((error) => props.onNotice?.({ kind: 'error', title: 'Decision was not recorded', message: errorMessage(error), taskId: task.id })),
        requestInput: props.onRequestInput,
        previewArtifact: (artifact) => void resourceStore.previewArtifact(artifact).catch((error) => props.onNotice?.({ kind: 'error', title: 'Preview could not be prepared', message: errorMessage(error), taskId: task.id })),
        downloadArtifact: (artifact) => void resourceStore.downloadArtifact(artifact, props.openArtifact).then(() => props.onNotice?.({ kind: 'success', title: 'Download ready', message: `${artifact.name} is being opened securely.`, taskId: task.id })).catch((error) => props.onNotice?.({ kind: 'error', title: 'Download could not be prepared', message: errorMessage(error), taskId: task.id })),
      }, h),
      h('div', { className: 'rhinoq-detail-actions', 'aria-busy': actionState.busy !== undefined },
        state.canCancel ? actionButton('cancel', 'Cancel task', actionState.busy, invoke, h) : null,
        state.canRetry ? actionButton('retry', 'Retry after review', actionState.busy, invoke, h, !props.retryCommandId) : null,
        task.hasResult ? actionButton('download', 'Download result', actionState.busy, invoke, h, false, true) : null),
      state.status === 'reconnecting' ? h('p', { className: 'rhinoq-reconnect', role: 'status', 'aria-live': 'polite' }, 'Reconnecting… showing the latest saved status.') : null);
  }
  return { RhinoQStyles, RhinoQTaskCenter, RhinoQTaskList, RhinoQTaskDetail, RhinoQProgress, useRhinoTask: useTask, useRhinoTasks: useTasks };
}

function header<Element>(title: string, count: string, h: ReactElementFactory<Element>['createElement']): Element {
  return h('header', { className: 'rhinoq-embed-head' }, h('div', null, h('p', { className: 'rhinoq-embed-eyebrow' }, h('span', { className: 'rhinoq-embed-live', 'aria-hidden': true }), 'Live updates'), h('h2', null, title)), h('span', { className: 'rhinoq-embed-count', 'aria-label': `${count} tasks` }, count));
}
function taskCard<Element>(task: TaskSnapshot, props: RhinoQTaskListProps, h: ReactElementFactory<Element>['createElement']): Element {
  const ui = taskUIModel(task);
  return h('li', { className: 'rhinoq-embed-item', key: task.id }, h('button', { className: 'rhinoq-task-card', type: 'button', onClick: () => props.onSelectTask?.(task), 'aria-label': `Open ${task.type}: ${ui.label}` },
    h('span', { className: 'rhinoq-task-icon', 'aria-hidden': true }, initials(task.type)), h('span', { className: 'rhinoq-task-copy' }, h('strong', null, humanize(task.type)), h('small', null, `${ui.explanation.progressText} · Updated ${relativeTime(task.updatedAt)}`)), h('span', { className: 'rhinoq-state', 'data-state': task.state }, ui.label),
    h('span', { className: 'rhinoq-progress', style: { '--rq-progress': `${ui.progress.percent ?? (task.state === 'running' ? 32 : 0)}%` } }, h('span', { className: 'rhinoq-progress-track', 'aria-hidden': true }, h('span', { className: 'rhinoq-progress-fill' })), h('progress', { className: 'rhinoq-progress-native', max: ui.progress.percent === undefined ? undefined : 100, value: ui.progress.percent, 'aria-label': `Task progress: ${ui.explanation.progressText}` }))));
}

type TaskFilter = RhinoQTaskFilter;
type TaskSort = RhinoQTaskSort;
type TaskActionKind = 'cancel' | 'retry' | 'download';
interface StoredNotice extends RhinoQComponentNotice { id: number; }
interface TaskCenterViewState {
  search: string; filter: TaskFilter; sort: TaskSort; savedFilterId?: string; selectedTaskId?: string; notices: StoredNotice[]; visibleLimit?: number;
}

class TaskCenterViewStore {
  private nextNoticeId = 1;
  private observed = false;
  private readonly taskStates = new Map<string, string>();
  private state: TaskCenterViewState;
  private readonly listeners = new Set<() => void>();
  constructor(initialTaskId?: string, initialView: Partial<RhinoQTaskCenterView> = {}, private pageSize?: number) { this.state = { search: initialView.search ?? '', filter: asTaskFilter(initialView.filter ?? 'all'), sort: asTaskSort(initialView.sort ?? 'updated'), ...(initialView.savedFilterId ? { savedFilterId: initialView.savedFilterId } : {}), ...(initialTaskId ? { selectedTaskId: initialTaskId } : {}), ...(pageSize ? { visibleLimit: pageSize } : {}), notices: [] }; }
  getSnapshot = (): Readonly<TaskCenterViewState> => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  setSearch(search: string): void { this.set(this.firstPage({ ...this.state, search, savedFilterId: undefined })); }
  setFilter(filter: TaskFilter): void { this.set(this.firstPage({ ...this.state, filter, savedFilterId: undefined })); }
  setSort(sort: TaskSort): void { this.set(this.firstPage({ ...this.state, sort, savedFilterId: undefined })); }
  applySavedFilter(id: string, savedFilters: RhinoQSavedFilter[]): void { const saved = savedFilters.find((item) => item.id === id); this.set(this.firstPage(saved ? { ...this.state, search: saved.search ?? '', filter: saved.filter ?? 'all', sort: saved.sort ?? 'updated', savedFilterId: saved.id } : { ...this.state, savedFilterId: undefined })); }
  select(selectedTaskId: string | undefined): void { this.set({ ...this.state, ...(selectedTaskId ? { selectedTaskId } : { selectedTaskId: undefined }) }); }
  reset(): void { this.set(this.firstPage({ ...this.state, search: '', filter: 'all', sort: 'updated', savedFilterId: undefined })); }
  configurePageSize(pageSize: number | undefined): void { if (this.pageSize === pageSize) return; this.pageSize = pageSize; this.set({ ...this.state, visibleLimit: pageSize }); }
  showMore(): void { if (this.pageSize) this.set({ ...this.state, visibleLimit: (this.state.visibleLimit ?? this.pageSize) + this.pageSize }); }
  notice(notice: RhinoQComponentNotice): void {
    const entry = { ...notice, id: this.nextNoticeId++ };
    this.set({ ...this.state, notices: [...this.state.notices.slice(-2), entry] });
  }
  observe(tasks: TaskSnapshot[]): void {
    if (!this.observed) {
      for (const task of tasks) this.taskStates.set(task.id, task.state);
      if (tasks.length) this.observed = true;
      return;
    }
    for (const task of tasks) {
      const previous = this.taskStates.get(task.id);
      this.taskStates.set(task.id, task.state);
      if (!previous || previous === task.state) continue;
      if (task.state === 'succeeded') this.notice({ kind: 'success', title: 'Task completed', message: `${humanize(task.type)} finished successfully.`, taskId: task.id });
      else if (task.state === 'failed') this.notice({ kind: 'error', title: 'Task did not finish', message: `Review ${humanize(task.type)} before deciding whether retry is safe.`, taskId: task.id });
      else if (task.state === 'cancelled') this.notice({ kind: 'info', title: 'Task cancelled', message: `Review any work completed by ${humanize(task.type)} before starting it again.`, taskId: task.id });
    }
  }
  dismiss(id: number): void { this.set({ ...this.state, notices: this.state.notices.filter((notice) => notice.id !== id) }); }
  private firstPage(state: TaskCenterViewState): TaskCenterViewState { return this.pageSize ? { ...state, visibleLimit: this.pageSize } : { ...state, visibleLimit: undefined }; }
  private set(state: TaskCenterViewState): void { this.state = state; for (const listener of this.listeners) listener(); }
}

interface TaskActionState { busy?: TaskActionKind; }
class TaskActionStore {
  private state: TaskActionState = {};
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): Readonly<TaskActionState> => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  async run(kind: TaskActionKind, action: () => Promise<void>): Promise<void> {
    if (this.state.busy) return;
    this.set({ busy: kind });
    try { await action(); } finally { this.set({}); }
  }
  private set(state: TaskActionState): void { this.state = state; for (const listener of this.listeners) listener(); }
}

interface TaskDetailResourceClient extends TaskBrowserClient {
  listTaskWaitpoints?(taskId: string, limit?: number): Promise<TaskWaitpoint[]>;
  resolveTaskWaitpoint?(taskId: string, waitpointId: string, request: TaskWaitpointResolveRequest): Promise<TaskWaitpoint>;
  listTaskArtifacts?(taskId: string, limit?: number): Promise<TaskArtifact[]>;
  getTaskArtifactDownload?(taskId: string, artifactId: string): Promise<unknown>;
}
interface ArtifactPreview { artifactId: string; url: string; }
interface TaskDetailResourceState {
  loading: boolean;
  waitpoints: TaskWaitpoint[];
  artifacts: TaskArtifact[];
  busy?: string;
  preview?: ArtifactPreview;
  error?: unknown;
}

class TaskDetailResourceStore {
  private state: TaskDetailResourceState = { loading: false, waitpoints: [], artifacts: [] };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  constructor(private readonly client: TaskDetailResourceClient, private readonly taskId: string) {}
  getSnapshot = (): Readonly<TaskDetailResourceState> => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  stop(): void { this.generation++; }
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.set({ ...this.state, loading: true, error: undefined });
    try {
      const [waitpoints, artifacts] = await Promise.all([
        this.client.listTaskWaitpoints?.(this.taskId, 100) ?? Promise.resolve([]),
        this.client.listTaskArtifacts?.(this.taskId, 100) ?? Promise.resolve([]),
      ]);
      if (generation !== this.generation) return;
      this.set({ ...this.state, loading: false, waitpoints, artifacts, error: undefined });
    } catch (error) {
      if (generation !== this.generation) return;
      this.set({ ...this.state, loading: false, error });
    }
  }
  async resolveApproval(waitpoint: TaskWaitpoint, resolution: boolean, identify?: RhinoQTaskDetailProps['waitpointResolutionId']): Promise<TaskWaitpoint> {
    if (!this.client.resolveTaskWaitpoint) throw new TypeError('Task client does not support waitpoint resolution');
    if (waitpoint.state !== 'waiting' || waitpoint.kind !== 'approval') throw new TypeError('Only a waiting approval can be resolved here');
    const resolutionId = identify?.(waitpoint, resolution) ?? `${this.taskId}:${waitpoint.id}:${waitpoint.entityVersion}:${resolution ? 'approve' : 'decline'}`;
    this.set({ ...this.state, busy: `waitpoint:${waitpoint.id}`, error: undefined });
    try {
      const changed = await this.client.resolveTaskWaitpoint(this.taskId, waitpoint.id, { expectedVersion: waitpoint.entityVersion, resolutionId, resolution });
      this.set({ ...this.state, busy: undefined, waitpoints: this.state.waitpoints.map((item) => item.id === changed.id ? changed : item) });
      return changed;
    } catch (error) {
      this.set({ ...this.state, busy: undefined, error });
      throw error;
    }
  }
  async previewArtifact(artifact: TaskArtifact): Promise<void> {
    const url = await this.resolveArtifactURL(artifact, `preview:${artifact.id}`);
    this.set({ ...this.state, busy: undefined, preview: { artifactId: artifact.id, url } });
  }
  async downloadArtifact(artifact: TaskArtifact, open?: RhinoQTaskDetailProps['openArtifact']): Promise<void> {
    const url = await this.resolveArtifactURL(artifact, `download:${artifact.id}`);
    (open ?? defaultOpenArtifact)(url, artifact);
    this.set({ ...this.state, busy: undefined });
  }
  private async resolveArtifactURL(artifact: TaskArtifact, busy: string): Promise<string> {
    if (!this.client.getTaskArtifactDownload) throw new TypeError('Task client does not support artifact download');
    this.set({ ...this.state, busy, error: undefined });
    try {
      const resolved = await this.client.getTaskArtifactDownload(this.taskId, artifact.id);
      const url = resolvedURL(resolved);
      if (!url) throw new TypeError('resolved artifact does not contain a URL');
      return url;
    } catch (error) {
      this.set({ ...this.state, busy: undefined, error });
      throw error;
    }
  }
  private set(state: TaskDetailResourceState): void { this.state = state; for (const listener of this.listeners) listener(); }
}

interface ResourceActions {
  refresh(): void;
  resolveApproval(waitpoint: TaskWaitpoint, resolution: boolean): void;
  requestInput?(waitpoint: TaskWaitpoint): void;
  previewArtifact(artifact: TaskArtifact): void;
  downloadArtifact(artifact: TaskArtifact): void;
}

function resourceSections<Element>(task: TaskSummary | TaskSnapshot, state: Readonly<TaskDetailResourceState>, actions: ResourceActions, h: ReactElementFactory<Element>['createElement']): Element {
  const waiting = state.waitpoints.filter((waitpoint) => waitpoint.state === 'waiting');
  const result = task.hasResult ? h('li', { className: 'rhinoq-resource-row' }, h('span', { className: 'rhinoq-resource-copy' }, h('strong', null, 'Primary Task result'), h('small', null, 'Resolved by the application at download time')), h('span', { className: 'rhinoq-resource-actions' }, h('span', { className: 'rhinoq-state', 'data-state': 'succeeded' }, 'Ready'))) : null;
  return h('div', null,
    waiting.length || state.waitpoints.length ? h('section', { className: 'rhinoq-resource-section', 'aria-label': 'Requests and approvals' },
      h('header', { className: 'rhinoq-resource-head' }, h('h3', null, 'Requests & approvals'), h('span', null, `${waiting.length} waiting`)),
      h('ul', { className: 'rhinoq-resource-list' }, ...state.waitpoints.map((waitpoint) => waitpointRow(waitpoint, state.busy, actions, h)))) : null,
    h('section', { className: 'rhinoq-resource-section', 'aria-label': 'Results and artifacts', 'aria-busy': state.loading },
      h('header', { className: 'rhinoq-resource-head' }, h('h3', null, 'Results & files'), h('span', null, state.loading ? 'Loading…' : `${state.artifacts.length} file${state.artifacts.length === 1 ? '' : 's'}`)),
      state.error ? h('p', { className: 'rhinoq-resource-empty', role: 'alert' }, errorMessage(state.error), ' ', h('button', { className: 'rhinoq-action', type: 'button', onClick: actions.refresh }, 'Try again')) :
        !task.hasResult && !state.artifacts.length ? h('p', { className: 'rhinoq-resource-empty' }, state.loading ? 'Loading recorded outputs…' : 'No result or file has been recorded yet.') :
          h('ul', { className: 'rhinoq-resource-list' }, result, ...state.artifacts.map((artifact) => artifactRow(artifact, state, actions, h)))));
}

function waitpointRow<Element>(waitpoint: TaskWaitpoint, busy: string | undefined, actions: ResourceActions, h: ReactElementFactory<Element>['createElement']): Element {
  const pending = busy === `waitpoint:${waitpoint.id}`;
  const title = waitpoint.kind === 'approval' ? humanize(waitpoint.key) : waitpoint.kind === 'input' ? 'Information requested' : 'Waiting for an external update';
  const detail = waitpoint.deadline ? `Due ${absoluteTime(waitpoint.deadline)}` : `Updated ${relativeTime(waitpoint.updatedAt)}`;
  return h('li', { className: 'rhinoq-resource-row', key: waitpoint.id },
    h('span', { className: 'rhinoq-resource-copy' }, h('strong', null, title), h('small', null, detail), h('span', { className: 'rhinoq-waitpoint-state' }, humanize(waitpoint.state))),
    h('span', { className: 'rhinoq-resource-actions' },
      waitpoint.kind === 'approval' && waitpoint.state === 'waiting' ? h('span', null,
        h('button', { className: 'rhinoq-action rhinoq-action-primary', type: 'button', disabled: Boolean(busy), 'aria-busy': pending, onClick: () => actions.resolveApproval(waitpoint, true) }, 'Approve'),
        h('button', { className: 'rhinoq-action', type: 'button', disabled: Boolean(busy), onClick: () => actions.resolveApproval(waitpoint, false) }, 'Decline')) : null,
      waitpoint.kind === 'input' && waitpoint.state === 'waiting' && actions.requestInput ? h('button', { className: 'rhinoq-action', type: 'button', onClick: () => actions.requestInput?.(waitpoint) }, 'Provide information') : null));
}

function artifactRow<Element>(artifact: TaskArtifact, state: Readonly<TaskDetailResourceState>, actions: ResourceActions, h: ReactElementFactory<Element>['createElement']): Element {
  const preview = state.preview?.artifactId === artifact.id ? state.preview.url : undefined;
  const expired = Date.parse(artifact.expiresAt) <= Date.now();
  const busy = state.busy?.endsWith(`:${artifact.id}`) ?? false;
  return h('li', { className: 'rhinoq-resource-row', key: artifact.id },
    h('span', { className: 'rhinoq-resource-copy' }, h('strong', null, artifact.name), h('small', null, `${artifact.contentType} · ${fileSize(artifact.sizeBytes)} · ${expired ? 'link refresh required' : `expires ${absoluteTime(artifact.expiresAt)}`}`), h('small', null, `SHA-256 ${artifact.checksumSha256.slice(0, 12)}…${artifact.lineage.length ? ` · ${artifact.lineage.length} source${artifact.lineage.length === 1 ? '' : 's'}` : ''}`)),
    h('span', { className: 'rhinoq-resource-actions' },
      canPreview(artifact.contentType) ? h('button', { className: 'rhinoq-action', type: 'button', disabled: busy, onClick: () => actions.previewArtifact(artifact) }, preview ? 'Refresh preview' : 'Preview') : null,
      h('button', { className: 'rhinoq-action rhinoq-action-primary', type: 'button', disabled: busy, 'aria-busy': state.busy === `download:${artifact.id}`, onClick: () => actions.downloadArtifact(artifact) }, expired ? 'Request fresh link' : 'Download')),
    preview ? artifactPreview(artifact, preview, h) : null);
}

function artifactPreview<Element>(artifact: TaskArtifact, url: string, h: ReactElementFactory<Element>['createElement']): Element {
  const content = artifact.contentType.startsWith('image/') ? h('img', { src: url, alt: artifact.name }) :
    artifact.contentType.startsWith('video/') ? h('video', { src: url, controls: true, preload: 'metadata', 'aria-label': artifact.name }) :
      artifact.contentType.startsWith('audio/') ? h('audio', { src: url, controls: true, preload: 'metadata', 'aria-label': artifact.name }) :
        h('iframe', { src: url, title: artifact.name });
  return h('div', { className: 'rhinoq-artifact-preview' }, content);
}

function canPreview(contentType: string): boolean { return contentType === 'application/pdf' || /^(image|video|audio)\//.test(contentType); }
function fileSize(bytes: number): string { if (bytes < 1024) return `${bytes} B`; const units = ['KB', 'MB', 'GB', 'TB']; let value = bytes / 1024; let unit = 0; while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; } return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`; }
function absoluteTime(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : value; }
function resolvedURL(value: unknown): string | undefined { return typeof value === 'string' ? value : value && typeof value === 'object' && 'url' in value && typeof value.url === 'string' ? value.url : undefined; }
function defaultOpenArtifact(url: string): unknown { if (typeof window === 'undefined') return url; return window.location.assign(url); }

function resolveTaskCenterClient(props: RhinoQTaskCenterProps): TaskListClient & TaskBrowserClient {
  if (props.client) return props.client;
  if (!props.apiUrl?.trim()) throw new TypeError('RhinoQTaskCenter requires client or apiUrl');
  return new ApplicationTaskClient({ url: props.apiUrl, ...(props.fetch ? { fetch: props.fetch } : {}), ...(props.headers ? { headers: props.headers } : {}) });
}

function publicView(view: Readonly<TaskCenterViewState>): RhinoQTaskCenterView {
  return { search: view.search, filter: view.filter, sort: view.sort, ...(view.savedFilterId ? { savedFilterId: view.savedFilterId } : {}) };
}

function filterTasks(tasks: TaskSnapshot[], search: string, filter: TaskFilter, sort: TaskSort, extraSearchText?: (task: TaskSnapshot) => string): TaskSnapshot[] {
  const query = search.trim().toLocaleLowerCase();
  return tasks.filter((task) => {
    if (query && !`${task.type} ${humanize(task.type)} ${task.id} ${taskUIModel(task).label} ${extraSearchText?.(task) ?? ''}`.toLocaleLowerCase().includes(query)) return false;
    if (filter === 'attention') return needsAttention(task);
    if (filter === 'active') return ['pending', 'queued', 'running', 'cancel_requested'].includes(task.state);
    if (filter === 'finished') return ['succeeded', 'failed', 'cancelled'].includes(task.state);
    return true;
  }).sort((left, right) => sort === 'oldest' ? left.updatedAt.localeCompare(right.updatedAt) : sort === 'type' ? left.type.localeCompare(right.type) : right.updatedAt.localeCompare(left.updatedAt));
}

function taskMetrics(tasks: TaskSnapshot[]): { all: number; active: number; ready: number; attention: number } {
  return {
    all: tasks.length,
    active: tasks.filter((task) => ['pending', 'queued', 'running', 'cancel_requested'].includes(task.state)).length,
    ready: tasks.filter((task) => task.state === 'succeeded').length,
    attention: tasks.filter(needsAttention).length,
  };
}

function needsAttention(task: TaskSnapshot): boolean {
  return task.state === 'failed' || task.state === 'uncertain' || Boolean(taskUIModel(task).attention);
}

function taskCenterRow<Element>(task: TaskSnapshot, selected: boolean, onSelect: () => void, props: RhinoQTaskCenterProps, h: ReactElementFactory<Element>['createElement']): Element {
  const ui = taskUIModel(task);
  const label = props.taskLabel?.(task).trim() || humanize(task.type);
  const defaultDescription = props.display?.showUpdatedAt === false ? task.id : `${task.id} · Updated ${relativeTime(task.updatedAt)}`;
  const description = props.taskDescription ? props.taskDescription(task) : defaultDescription;
  if (props.renderTask) return h('li', { className: 'rhinoq-embed-item', key: task.id }, props.renderTask({ task, selected, label, description, progressPercent: ui.progress.percent, open: onSelect }));
  const showIcon = props.display?.showTaskIcon !== false;
  const showState = props.display?.showTaskState !== false;
  const accessibleLabel = props.taskLabel ? label : task.type;
  return h('li', { className: 'rhinoq-embed-item', key: task.id }, h('button', { className: join('rhinoq-task-card', showIcon ? '' : 'no-icon', showState ? '' : 'no-state'), type: 'button', onClick: onSelect, 'data-rhinoq-task-id': task.id, 'aria-current': selected ? 'true' : undefined, 'aria-label': `Open ${accessibleLabel}: ${ui.label}` },
    showIcon ? h('span', { className: 'rhinoq-task-icon', 'aria-hidden': true }, initials(task.type)) : null,
    h('span', { className: 'rhinoq-task-copy' }, h('strong', null, label), description ? h('small', null, description) : null),
    showState ? h('span', { className: 'rhinoq-state', 'data-state': task.state }, ui.label) : null,
    props.display?.showProgress === false ? null : h('span', { className: 'rhinoq-progress', style: { '--rq-progress': `${ui.progress.percent ?? (task.state === 'running' ? 32 : 0)}%` } }, h('span', { role: 'status', 'aria-live': 'polite' }, ui.explanation.progressText), h('strong', { 'aria-hidden': true }, ui.progress.percent === undefined ? (task.state === 'running' ? 'In progress' : '—') : `${ui.progress.percent}%`), h('span', { className: 'rhinoq-progress-track', 'aria-hidden': true }, h('span', { className: 'rhinoq-progress-fill' })), h('progress', { className: 'rhinoq-progress-native', max: ui.progress.percent === undefined ? undefined : 100, value: ui.progress.percent, 'aria-label': `Task progress: ${ui.explanation.progressText}` }))));
}

function viewer<Element>(user: RhinoQCurrentUser, h: ReactElementFactory<Element>['createElement']): Element {
  return h('div', { className: 'rhinoq-viewer', 'aria-label': `Signed in as ${user.name}` },
    h('span', { className: 'rhinoq-viewer-avatar', 'aria-hidden': true }, user.avatarUrl ? h('img', { src: user.avatarUrl, alt: '' }) : initials(user.name)), h('strong', null, user.name));
}

function metric<Element>(label: string, value: number, h: ReactElementFactory<Element>['createElement']): Element {
  return h('div', { className: 'rhinoq-metric' }, h('span', null, label), h('strong', null, String(value)));
}

function toast<Element>(notice: StoredNotice, dismiss: () => void, h: ReactElementFactory<Element>['createElement']): Element {
  return h('div', { className: 'rhinoq-toast', key: notice.id, 'data-kind': notice.kind, role: notice.kind === 'error' ? 'alert' : 'status' },
    h('span', { className: 'rhinoq-toast-icon', 'aria-hidden': true }, notice.kind === 'success' ? '✓' : notice.kind === 'error' ? '!' : 'i'),
    h('span', { className: 'rhinoq-toast-copy' }, h('strong', null, notice.title), h('span', null, notice.message)),
    h('button', { className: 'rhinoq-toast-close', type: 'button', onClick: dismiss, 'aria-label': 'Dismiss notification' }, '×'));
}

function actionButton<Element>(kind: TaskActionKind, label: string, busy: TaskActionKind | undefined, invoke: (kind: TaskActionKind) => void, h: ReactElementFactory<Element>['createElement'], disabled = false, primary = false): Element {
  const isBusy = busy === kind;
  return h('button', { className: join('rhinoq-action', primary ? 'rhinoq-action-primary' : '', isBusy ? 'rhinoq-action-busy' : ''), type: 'button', onClick: () => invoke(kind), disabled: disabled || busy !== undefined, 'aria-busy': isBusy, title: disabled && kind === 'retry' ? 'Provide retryCommandId to enable safe retry' : undefined }, label);
}

function actionNotice(kind: TaskActionKind, taskId: string): RhinoQComponentNotice {
  if (kind === 'cancel') return { kind: 'info', title: 'Cancellation requested', message: 'The final outcome will update when active work reports what stopped safely.', taskId };
  if (kind === 'retry') return { kind: 'success', title: 'Retry started', message: 'A new recorded attempt was requested and will update here automatically.', taskId };
  return { kind: 'success', title: 'Download ready', message: 'The recorded result is being opened securely.', taskId };
}

function actionErrorNotice(kind: TaskActionKind, taskId: string, error: unknown): RhinoQComponentNotice {
  const title = kind === 'cancel' ? 'Cancellation was not requested' : kind === 'retry' ? 'Retry could not be started' : 'Download could not be prepared';
  return { kind: 'error', title, message: errorMessage(error), taskId };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'The request failed. Nothing was changed.';
}

function eventValue(event: unknown): string {
  if (!event || typeof event !== 'object' || !('currentTarget' in event)) return '';
  const target = event.currentTarget;
  return target && typeof target === 'object' && 'value' in target && typeof target.value === 'string' ? target.value : '';
}

function asTaskFilter(value: string): TaskFilter { return ['attention', 'active', 'finished'].includes(value) ? value as TaskFilter : 'all'; }
function asTaskSort(value: string): TaskSort { return ['oldest', 'type'].includes(value) ? value as TaskSort : 'updated'; }
function taskCenterPageSize(value: number | undefined): number | undefined { if (value === undefined) return undefined; if (!Number.isInteger(value) || value < 1 || value > 100) throw new RangeError('display.pageSize must be 1..100'); return value; }
function cssLength(value: number | string): string { if (typeof value === 'number') { if (!Number.isFinite(value) || value < 1) throw new RangeError('display.maxListHeight must be positive'); return `${value}px`; } if (!value.trim()) throw new TypeError('display.maxListHeight must not be empty'); return value.trim(); }
function themeStyle(theme: RhinoQTheme = {}): Record<string, string> { return {
  '--rq-accent': theme.accent ?? '#2563eb', '--rq-bg': theme.background ?? '#f5f7fa', '--rq-surface': theme.surface ?? '#ffffff', '--rq-ink': theme.foreground ?? '#10233f', '--rq-muted': theme.muted ?? '#68768b', '--rq-border': theme.border ?? '#dde3ec', '--rq-success': theme.success ?? '#159a65', '--rq-warning': theme.warning ?? '#c77b0a', '--rq-danger': theme.danger ?? '#cf415a', '--rq-radius': theme.radius ?? '8px', '--rq-font': theme.fontFamily ?? 'Inter, ui-sans-serif, system-ui, sans-serif',
}; }
function humanize(value: string): string { return value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function initials(value: string): string { return value.split(/[._-]+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'T'; }
function relativeTime(value: string): string { const elapsed = Date.now() - Date.parse(value); if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'just now'; const minutes = Math.floor(elapsed / 60_000); if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`; }
function join(...values: Array<string | undefined>): string { return values.filter(Boolean).join(' '); }
