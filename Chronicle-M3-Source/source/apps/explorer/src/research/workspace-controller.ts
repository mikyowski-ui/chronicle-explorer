import { PlannerBoundary } from '../../research-semantic/planner.ts';
import { createProviderConnection, type ProviderConnection, type ProviderConnectionInput } from '../../research-semantic/provider-transport.ts';
import { canonicalJSON, immutable } from './engine.ts';
import { WorkspaceEngine, type UnifiedResult } from './workspace-engine.ts';
import { createCatalogue, compileIntent } from '../../research-semantic/catalogue.ts';
import { refineRevision, revisionIntent } from '../../research-semantic/revisions.ts';
import { specForStudy, validateWorkspace, WorkspaceReplaySchema, WORKSPACE_VERSIONS, type Selection, type WorkspaceSpecification } from '../../research-semantic/workspace-contract.ts';
import type { SemanticEntity, SemanticObservation, SourcePin } from '../../research-semantic/contracts.ts';
export interface WorkspaceSnapshot{
 revision:number;pendingRevision:number;status:'idle'|'loading'|'ready'|'error';message:string;errorCode:string|null;
 cursorYear:number;analysisTimeWindow:{start:number;end:number}|null;selection:Selection|null;active:UnifiedResult|null;
 selectedEvidence:{observation:SemanticObservation;entity:SemanticEntity;source:SourcePin;visible:boolean}|null;
}
export type WorkspaceAction={type:'cursor';year:number;origin:string;revision:number}|{type:'select';entityId:string;observationId:string;origin:string;revision:number}|{type:'clear-selection';origin:string;revision:number};
/** One store for both pilots, all views and the existing Atlas cursor adapter. */
export class ResearchController{
 private readonly provider:ProviderConnection;
 private listeners=new Set<(state:WorkspaceSnapshot)=>void>();private request=0;private commits=0;private pending:AbortController|null=null;private disposed=false;private state:WorkspaceSnapshot;
 constructor(initialYear:number,private readonly engine=new WorkspaceEngine(),private readonly timeoutMs=5000,providerInput:ProviderConnectionInput={}){
  if(!Number.isFinite(initialYear)||initialYear < -12000||initialYear>3000)throw new Error('Invalid host year');
  this.provider=createProviderConnection(providerInput);
  this.state=immutable({revision:0,pendingRevision:0,status:'idle',message:'Prepared example — planner not enabled.',errorCode:null,cursorYear:initialYear,analysisTimeWindow:null,selection:null,active:null,selectedEvidence:null});
 }
 getSnapshot(){return this.state;}
 getProviderStatus(){return this.provider.status;}
 subscribe(listener:(state:WorkspaceSnapshot)=>void){if(this.disposed)throw new Error('Disposed');this.listeners.add(listener);listener(this.state);return()=>{this.listeners.delete(listener);};}
 private update(patch:Partial<WorkspaceSnapshot>){
  const next={...this.state,...patch},s=next.selection,f=next.active?.fixture;
  const observation=f?.observations.find(o=>o.id===s?.observationId&&o.entityId===s?.entityId),entity=f?.entities.find(e=>e.id===s?.entityId),source=f?.sourcePins.find(p=>p.id===observation?.provenance.sourceId);
  next.selectedEvidence=observation&&entity&&source?{observation,entity,source,visible:!!next.active?.bundle.observations.some(r=>r.id===observation.id)}:null;
  const previous=this.state;this.state=immutable(next);
  try{for(const listener of this.listeners)listener(this.state);}
  catch{this.state=previous;for(const listener of this.listeners){try{listener(previous);}catch{/* Data rollback is preserved even if a host renderer is unavailable. */}}throw new Error('RENDER_FAILED');}
 }
 dispatch(action:WorkspaceAction):boolean{
  if(this.disposed||action.revision!==this.state.revision||typeof action.origin!=='string'||action.origin.length>120)return false;
  if(action.type==='cursor'){if(!Number.isFinite(action.year)||action.year < -12000||action.year>3000||action.year===this.state.cursorYear)return false;this.update({cursorYear:action.year});return true;}
  if(action.type==='clear-selection'){if(!this.state.selection)return false;this.update({selection:null});return true;}
  if(!this.state.active?.fixture.observations.some(r=>r.id===action.observationId&&r.entityId===action.entityId))return false;
  if(this.state.selection?.observationId===action.observationId&&this.state.selection.entityId===action.entityId)return false;
  this.update({selection:{entityId:action.entityId,observationId:action.observationId}});return true;
 }
 private async stage(operation:(signal:AbortSignal)=>Promise<UnifiedResult>):Promise<boolean>{
  if(this.disposed)return false;const request=++this.request;this.pending?.abort();const abort=new AbortController();this.pending=abort;
  this.update({pendingRevision:request,status:'loading',message:'Validating and staging the complete workspace…',errorCode:null});
  let timer:ReturnType<typeof setTimeout>|undefined;let cancel:(()=>void)|undefined;
  try{
   const cancellation=new Promise<never>((_,reject)=>{cancel=()=>reject(new Error('CANCELLED'));abort.signal.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>{reject(new Error('DATA_TIMEOUT'));abort.abort();},this.timeoutMs);});
   const active=await Promise.race([operation(abort.signal),cancellation]);if(this.disposed||request!==this.request||abort.signal.aborted)return false;
   if(active===this.state.active){this.update({status:'ready',message:'Scope unchanged; no duplicate revision was created.'});return true;}
   this.update({revision:request,active,analysisTimeWindow:{start:active.spec.plan.scope.epoch[0],end:active.spec.plan.scope.epoch[1]},status:'ready',message:'Source-backed prepared workspace · edition pinned',errorCode:null,...(active.restored?{cursorYear:active.restored.cursorYear,selection:active.restored.selection}:{})});this.commits++;return true;
  }catch(error){if(this.disposed||request!==this.request)return false;const code=error instanceof Error&&'code' in error?String(error.code):error instanceof Error?error.message:'INVALID_SPEC';const patch={status:'error' as const,errorCode:code,message:code==='INSUFFICIENT_EVIDENCE'?'No observations overlap this scope. Previous workspace remains visible; missing is not zero.':code==='RENDER_FAILED'?'The new views could not be installed. Previous workspace data was restored.':'The requested workspace could not be activated. Previous evidence remains visible.'};try{this.update(patch);}catch{this.state=immutable({...this.state,...patch});}return false;}
  finally{if(timer)clearTimeout(timer);if(cancel)abort.signal.removeEventListener('abort',cancel);if(this.pending===abort)this.pending=null;}
 }
 run(input:unknown){return this.stage(signal=>this.engine.prepare(input,signal));}
 openPilot(id:string){return this.stage(signal=>this.engine.prepared(id,signal));}
 replay(input:unknown){return this.stage(signal=>this.engine.reopen(input,signal));}
 refine(entityIds:string[],epoch:[number,number]){
  const parent=this.state.active;if(!parent)return Promise.resolve(false);
  return this.stage(async signal=>{const r=await this.engine.registration(parent.spec.plan.scope.datasetId,signal),intent=revisionIntent(parent.study,entityIds,epoch);
   const catalogue=createCatalogue([r]);if(canonicalJSON(compileIntent(intent,catalogue))===canonicalJSON(parent.study.plan))return parent;
   const next=refineRevision(parent.study,intent,catalogue);
   return this.engine.finish(next,{...specForStudy(next,parent.spec.views),title:parent.spec.title},r);
  });
 }
 setViews(views:WorkspaceSpecification['views']){
  const parent=this.state.active;if(!parent)return Promise.resolve(false);
  return this.stage(async signal=>{const r=await this.engine.registration(parent.spec.plan.scope.datasetId,signal);return this.engine.finish(parent.study,{...parent.spec,views},r,parent.legacy);});
 }
 async requestProposal(question:string){
  const active=this.state.active;const planner=new PlannerBoundary(this.provider,(input)=>validateWorkspace(input,this.engine.catalogue(active?.spec.plan.scope.datasetId??'')));
  return planner.propose(question,{disclosure:'offline-fixture-only',catalogueVersion:'local-workspace-v2',datasets:active?[{id:active.spec.plan.scope.datasetId,indicatorIds:[active.spec.plan.scope.indicatorId],entityIds:active.spec.plan.scope.entityIds}]:[],parentRevisionId:active?.study.archive.revisions.at(-1)?.id??null});
 }
 exportManifest():string{
  const a=this.state.active;if(!a)throw new Error('Open a workspace before saving.');
  const archive=WorkspaceReplaySchema.parse({schemaVersion:2,kind:'chronicle-workspace-replay',versions:WORKSPACE_VERSIONS,study:a.study.archive,views:a.spec.views,cursorYear:this.state.cursorYear,cursorPrecision:'year-navigation-anchor',selection:this.state.selectedEvidence?this.state.selection:null});
  const text=canonicalJSON(archive);if(new TextEncoder().encode(text).length>65536)throw new Error('Workspace replay exceeds 64 KiB.');return text+'\n';
 }
 cancel(){if(this.disposed)return;this.pending?.abort();this.pending=null;++this.request;this.update({pendingRevision:this.request,status:this.state.active?'ready':'idle',message:'Request cancelled; previous workspace retained.'});}
 close(){if(this.disposed)return;this.pending?.abort();this.pending=null;const revision=++this.request;this.update({revision,pendingRevision:revision,status:'idle',active:null,analysisTimeWindow:null,selectedEvidence:null,message:'Prepared example — planner not enabled.'});}
 getDiagnostics(){return{listeners:this.listeners.size,commits:this.commits,revision:this.state.revision,pending:!!this.pending,disposed:this.disposed,...this.engine.getDiagnostics()};}
 dispose(){if(this.disposed)return;this.close();this.listeners.clear();this.engine.dispose();this.disposed=true;}
}
