/** Copy for the English-only local app shell. */
const welcomeCopy = {
  en: {
    title: 'Choose a story to play',
    empty: 'No work selected. Open char.pub to choose a story or a draft.',
    received: 'Launch details received. Review the exact version before starting.',
  },
} as const

/**
 * Render the static same-origin browser shell without embedding authored content.
 * @param nonce - Per-process CSP and same-origin request nonce, never an OAuth credential.
 * @param registryOrigin - Locally configured Registry origin used by the browse link.
 * @returns HTML whose authored values are inserted only through textContent or form values.
 */
export function appHTML(nonce: string, registryOrigin: string): string {
  const registryURL = new URL('/', registryOrigin).href.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const copy = welcomeCopy.en
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>char.pub roleplay</title>
<style nonce="${nonce}">
html{color-scheme:light;background:#f8fafc;color:#172033}
body{font:16px/1.5 system-ui;max-width:850px;margin:2rem auto;padding:0 1rem;background:#f8fafc;color:#172033}
button,input,select,textarea{font:inherit;margin:.35rem;padding:.5rem;color:#172033;background:#fff;border:1px solid #64748b;border-radius:.3rem}
button{background:#e2e8f0;cursor:pointer}button:disabled{color:#64748b;background:#f1f5f9;cursor:not-allowed}
textarea{width:95%;min-height:5rem}label{display:block}input[type=checkbox]{accent-color:#1d4ed8}
a{color:#164eba}a:visited{color:#6b21a8}summary{cursor:pointer}a,summary{ text-underline-offset:.15em }
:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e2e8f0;color:#172033;padding:1rem;border:1px solid #94a3b8;border-radius:.3rem}
fieldset{margin:1rem 0;border:1px solid #64748b}legend{padding:0 .3rem}#status{background:#e2e8f0;color:#172033;padding:.75rem;border-radius:.3rem}
[hidden]{display:none!important}
</style>
<h1>Local roleplay</h1><p>This page uses your locally configured Registry and model. Chat stays in this Runtime. Only Story content is supported; judgments remain undetermined and chat does not automatically confirm plot changes.</p>
<section id="welcome"><h2>${copy.title}</h2>
<p><a id="registry-link" href="${registryURL}" target="_blank" rel="noopener noreferrer">Open char.pub</a></p>
<ol><li>Choose a story on char.pub and select <strong>Start playing</strong>. For your own draft, open its editor and select <strong>Try draft</strong>.</li><li>Choose this Runtime address: <code id="runtime-url"></code>. char.pub will open it with the exact work to review.</li><li>Authorize Registry access if needed, review the version and character bindings, then start a new session.</li></ol>
<p>This page needs a work from char.pub before it can start a session.</p></section>
<p id="status" role="status">${copy.empty}</p>
<p id="launch-ready" hidden><a href="${registryURL}" target="_blank" rel="noopener noreferrer">Choose another work on char.pub</a></p>
<button id="authorize">Authorize Registry access</button>
<details id="manual-launch"><summary>Advanced: paste launch JSON</summary><p>Use this only if you already have launch JSON for an exact published work or draft build.</p><label>Launch JSON<textarea id="launch"></textarea></label></details>
<button id="review" disabled>Review version</button><button id="cancel">Cancel active operation</button>
<section id="candidate" hidden><h2>Review this version</h2><pre id="details"></pre><p id="restart"></p><label>Opening<select id="start"></select></label><label>Viewpoint<select id="view"></select></label><fieldset id="bindings"><legend>Runtime character bindings</legend></fieldset><label><input id="accept" type="checkbox">I reviewed the rating, license, capability limitations and exact version. Start a new session.</label><button id="begin">Start new session</button></section>
<section id="game" hidden><h2>Session</h2><pre id="history"></pre><label>Your reply<textarea id="reply"></textarea></label><button id="send">Send once</button><h3>Save synthetic preview input</h3><p>Write a short synthetic summary; this does not copy the chat. The file also contains the full Story state, which may include secrets. Review it before downloading.</p><label>Synthetic summary<textarea id="summary"></textarea></label><fieldset id="synthetic-bindings"><legend>Synthetic preview bindings (fill separately)</legend></fieldset><button id="prepare-export">Review preview file</button><pre id="export-review" hidden></pre><button id="export" hidden>Confirm and download preview JSON</button></section>
<script nonce="${nonce}">
const by=id=>document.getElementById(id);
let candidate,exportReview,session,activeSession,exportVersion=0;
const nonce=${JSON.stringify(nonce)};
const launchCopy=${JSON.stringify(copy)};
function showLaunch(){const hasLaunch=by('launch').value.trim().length>0;by('welcome').hidden=hasLaunch;by('launch-ready').hidden=!hasLaunch;by('review').disabled=!hasLaunch;status(hasLaunch?launchCopy.received:launchCopy.empty)}
by('runtime-url').textContent=location.origin+'/';
by('launch').addEventListener('input',()=>{candidate=undefined;by('candidate').hidden=true;by('accept').checked=false;showLaunch()});
async function call(path,body={}) {
  if(path!=='cancel')activeSession=body.session;
  const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Roleplay-Client':nonce},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw new Error(value.error||'Request failed');return value;
}
const explanations={
  'roleplay_app.story_required':'This Runtime currently requires a Story. Choose another Runtime for this content.',
  'roleplay_app.content_required':'This is a policy artifact, not playable content.',
  'roleplay_app.participant_unknown':'Choose an actual participant from this exact version.',
  'roleplay_app.start_unknown':'This opening is not part of the reviewed version.',
  'roleplay_app.tokenizer_unsupported':'This entry supports only the estimate tokenizer. The locked profile needs another Runtime.',
  'roleplay_app.locked_view_mismatch':'The work locks a different viewpoint mode.',
  'roleplay_app.capability_unsupported':'This Runtime does not support a required capability.',
  'roleplay_app.authorization_changed':'Authorization changed. Review this exact work again.',
  'roleplay_app.stale_session':'This tab belongs to an older session (stale_session). Use the tab that started the new session.',
  'registry.http_403':'The Registry denied access. Check granted scopes and work permissions.',
  'registry.http_401':'Authorization expired or was revoked. Authorize again.',
  'registry.draft_expired':'This draft build expired. Return to the editor and build a new version.',
  'roleplay_app.restart_confirmation_required':'Confirm starting a new session; the existing log will remain unchanged.',
  'roleplay_app.invalid_input':'Check the launch, opening and character bindings.',
  'story.condition_undetermined':'The opening condition is undetermined. This entry does not infer judge results.'
};
function status(value){by('status').textContent=explanations[value]||value}
async function run(fn){try{status('Working…');await fn()}catch(error){status(error.message)}}
function text(value){return typeof value==='string'?value:value?.[candidate?.locale]??Object.values(value??{})[0]??''}
function invalidateExport(){exportVersion++;exportReview=undefined;by('export-review').hidden=true;by('export').hidden=true}
function bindings(container){
  const result={};
  for(const field of by(container).querySelectorAll('fieldset')){
    const name=field.querySelector('[data-name]').value.trim();if(!name)continue;
    const description=field.querySelector('[data-description]').value.trim();
    const outward=field.querySelector('[data-outward]').value.trim();
    result[field.dataset.key]={kind:field.dataset.kind,display_name:name,...(description?{description}:{}),...(outward?{outward_description:outward}:{})};
  }
  return result;
}
function renderBindings(container,slots,synthetic){
  const root=by(container);root.replaceChildren();
  const legend=document.createElement('legend');legend.textContent=synthetic?'Synthetic preview bindings (fill separately)':'Bindings for the next new session';root.append(legend);
  for(const slot of slots){
    const field=document.createElement('fieldset');field.dataset.key=slot.key;field.dataset.kind=slot.accepts.includes('persona')?'persona':'character';
    const label=document.createElement('legend');label.textContent=slot.hint||slot.key;field.append(label);
    for(const [key,title,multiline] of [['name','display name',false],['description','private description',true],['outward','public outward description',true]]){
      const line=document.createElement('label');line.textContent=(synthetic?'Synthetic ':'')+title;
      const control=document.createElement(multiline?'textarea':'input');control.dataset[key]='';
      control.setAttribute('aria-label',(synthetic?'Synthetic ':'')+slot.key+' '+title);line.append(control);field.append(line);
    }
    root.append(field);
  }
}
function showSession(value){by('game').hidden=false;by('history').textContent=value.history.map(item=>(item.role==='user'?'You':'Character')+': '+item.text).join('\\n\\n');status(value.status?('Generation '+value.status):'Session started. No model request yet.')}
for(const id of ['start','view','bindings']){by(id).addEventListener('input',()=>{by('accept').checked=false});by(id).addEventListener('change',()=>{by('accept').checked=false})}
for(const id of ['summary','synthetic-bindings'])by(id).addEventListener('input',invalidateExport);
by('authorize').onclick=()=>run(async()=>{const value=await call('authorize');location.assign(value.authorizationURL)});
by('review').onclick=()=>run(async()=>{
  by('candidate').hidden=true;by('accept').checked=false;invalidateExport();
  candidate=await call('review',JSON.parse(by('launch').value));by('candidate').hidden=false;
  by('details').textContent=JSON.stringify({source:candidate.source,metadata:candidate.metadata,capabilities:candidate.capabilities,support:candidate.support},null,2);
  by('restart').textContent=candidate.restart_required?'A session already exists. Starting this version creates a new session; the previous log remains unchanged.':'';
  by('start').replaceChildren();
  for(const item of candidate.starts){const option=document.createElement('option');option.value=item.id;option.textContent=text(item.title)+' ('+item.id+')';by('start').append(option)}
  if(!candidate.starts.length){const option=document.createElement('option');option.value='';option.textContent='Default opening';by('start').append(option)}
  else if(!candidate.start&&candidate.starts.length>1){const option=document.createElement('option');option.value='';option.textContent='Choose an opening';by('start').prepend(option);by('start').value=''}
  if(candidate.start)by('start').value=candidate.start;
  by('view').replaceChildren();
  if(candidate.view.mode==='narrator'){const option=document.createElement('option');option.value='';option.textContent='Narrator';by('view').append(option)}
  else for(const item of candidate.participants){const option=document.createElement('option');option.value=item.key;option.textContent=text(item.display_name);by('view').append(option);if(item.key===candidate.view.for_participant)by('view').value=item.key}
  renderBindings('bindings',candidate.late_slots,false);status('Review the version and supply bindings before starting.');
});
by('begin').onclick=()=>run(async()=>{
  if(!candidate||!by('accept').checked)throw new Error('Review and confirm this version first.');
  if(candidate.starts.length>1&&!by('start').value)throw new Error('Choose an opening.');
  const value=await call('start',{review:candidate.review,bindings:bindings('bindings'),restart:candidate.restart_required,...(by('start').value?{start:by('start').value}:{}),...(by('view').value?{for_participant:by('view').value}:{})});
  session=value.session;showSession(value);candidate.restart_required=true;by('accept').checked=false;
  by('summary').value='';renderBindings('synthetic-bindings',candidate.late_slots,true);invalidateExport();
});
by('send').onclick=()=>run(async()=>{showSession(await call('turn',{session,text:by('reply').value}));by('reply').value='';invalidateExport()});
by('cancel').onclick=()=>run(async()=>{await call('cancel',activeSession?{session:activeSession}:{});status('Cancellation requested. A completed durable response may already have committed.')});
by('prepare-export').onclick=()=>run(async()=>{
  if(!by('summary').value.trim())throw new Error('Write a synthetic summary first.');
  const version=exportVersion;
  const value=await call('prepare-export',{session,history:[{role:'user',text:by('summary').value}],bindings:bindings('synthetic-bindings')});
  if(version!==exportVersion)throw new Error('Synthetic input changed. Review the file again.');
  exportReview=value;by('export-review').hidden=false;by('export-review').textContent=JSON.stringify(value.payload,null,2);by('export').hidden=false;status('Review the entire file, including state and synthetic bindings, before downloading.');
});
by('export').onclick=()=>run(async()=>{
  if(!exportReview)throw new Error('Review the synthetic file first.');
  const result=await call('export',{session,digest:exportReview.digest});
  const url=URL.createObjectURL(new Blob([result.json],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='runtime-preview.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0);status('Preview file exported locally.');
});
const intent=new URLSearchParams(location.hash.slice(1)).get('launch');
if(intent){by('launch').value=intent;sessionStorage.setItem('roleplay-launch',intent);history.replaceState(null,'',location.pathname)}
else by('launch').value=sessionStorage.getItem('roleplay-launch')||'';
showLaunch();
</script></html>`
}
