(() => {
  'use strict';

  const APP_VERSION = '6.0.0';
  const SCHEMA_VERSION = 7;
  const DB_KEY = 'prepaFutsal.database.v5';
  const DB_BACKUP_KEY = 'prepaFutsal.databaseBackups.v1';
  const LEGACY_LOG_KEYS = ['prepaFutsal.logs.v2','prepaFutsal.logs.v1'];
  const LEGACY_PLAN_KEY = 'prepaFutsal.customPlan.v2';
  const LEGACY_PREF_KEY = 'prepaFutsal.prefs.v1';
  const BASE_PLAN = Array.isArray(window.PLAN_DATA) ? window.PLAN_DATA : [];

  const main = document.getElementById('main');
  const toast = document.getElementById('toast');
  const userSelect = document.getElementById('userSelect');
  const importInput = document.getElementById('importInput');
  const backupInput = document.getElementById('backupInput');

  let db = loadDatabase();
  let view = 'today';
  let selectedDate = '';
  let calendarFilter = 'all';
  let PLAN = [], byDate = {}, minDate = '', maxDate = '';
  let weekAnchor = '';
  let plannerSelectedDate = '';
  let statsExercise = '';
  let timerState = null;
  let timerInterval = null;

  function nowISO(){ return new Date().toISOString(); }
  function isoLocal(d=new Date()){
    const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function uid(prefix='id'){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`; }
  function loadJSON(key,fallback){ try{ const v=JSON.parse(localStorage.getItem(key)); return v ?? fallback; }catch{return fallback;} }
  function esc(v=''){ return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
  function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }
  function num(v){ if(v===null||v===undefined||v==='') return NaN; const n=parseFloat(String(v).replace(',','.').replace(/[^\d.-]/g,'')); return Number.isFinite(n)?n:NaN; }
  function roundStep(v,step=.5){ return Math.round(v/step)*step; }
  function parseDurationMin(v=''){ const m=String(v).match(/(\d+(?:[.,]\d+)?)\s*(?:min|')/i); return m?num(m[1]):0; }
  function fmtDate(iso,long=true){ const d=new Date(iso+'T12:00:00'); return new Intl.DateTimeFormat('es-ES',long?{weekday:'long',day:'numeric',month:'long',year:'numeric'}:{day:'2-digit',month:'short'}).format(d); }
  function toastMsg(msg){ toast.textContent=msg; toast.classList.add('show'); setTimeout(()=>toast.classList.remove('show'),1900); }

  function legacyDefaultUser(){
    let logs={}; for(const k of LEGACY_LOG_KEYS){const x=loadJSON(k,null); if(x){logs=x;break;}}
    const customPlan=loadJSON(LEGACY_PLAN_KEY,{});
    const prefs=loadJSON(LEGACY_PREF_KEY,{});
    const u={
      id:'user_principal', name:'Principal', createdAt:nowISO(), bodyWeightKg:'',
      logs, customPlan, prefs:{...prefs,useBasePlan:true,autoRecommendations:true},
      metadata:{migratedFromLegacy:true,storageNamespace:'principal'}
    };
    stampMissingOwnership(u);
    return u;
  }

  function stampMissingOwnership(u){
    if(!u || !u.id) return;
    u.logs=u.logs||{}; u.customPlan=u.customPlan||{}; u.metadata=u.metadata||{}; u.templates=Array.isArray(u.templates)?u.templates:[]; u.competitions=Array.isArray(u.competitions)?u.competitions:[]; u.planVersions=Array.isArray(u.planVersions)?u.planVersions:[]; u.exerciseLibrary=u.exerciseLibrary||{};
    Object.values(u.logs).forEach(rec=>{ if(rec && !rec.ownerId) rec.ownerId=u.id; });
    Object.values(u.customPlan).forEach(rec=>{ if(rec && !rec.ownerId) rec.ownerId=u.id; });
    u.templates.forEach(rec=>{if(rec&&!rec.ownerId)rec.ownerId=u.id;});u.competitions.forEach(rec=>{if(rec&&!rec.ownerId)rec.ownerId=u.id;});
  }

  function quarantineRecord(ownerUser, kind, key, rec){
    db.quarantine=db.quarantine||[];
    db.quarantine.push({
      quarantinedAt:nowISO(),
      expectedOwnerId:ownerUser.id,
      foundOwnerId:rec?.ownerId||'',
      kind,key,
      data:JSON.parse(JSON.stringify(rec||{}))
    });
  }

  function enforceOwnership(u){
    if(!u || !u.id) return;
    u.logs=u.logs||{}; u.customPlan=u.customPlan||{}; u.prefs=u.prefs||{}; u.metadata=u.metadata||{};
    for(const [date,rec] of Object.entries(u.logs)){
      if(!rec) continue;
      if(!rec.ownerId) rec.ownerId=u.id;
      if(rec.ownerId!==u.id){
        quarantineRecord(u,'log',date,rec);
        delete u.logs[date];
      }
    }
    for(const [date,rec] of Object.entries(u.customPlan)){
      if(!rec) continue;
      if(!rec.ownerId) rec.ownerId=u.id;
      if(rec.ownerId!==u.id){
        quarantineRecord(u,'plan',date,rec);
        delete u.customPlan[date];
      }
    }
    u.metadata.lastOwnershipCheck=nowISO();
  }

  function reassignOwnership(u,newId){
    if(!u) return u;
    u.id=newId;
    u.logs=u.logs||{}; u.customPlan=u.customPlan||{}; u.metadata=u.metadata||{}; u.templates=Array.isArray(u.templates)?u.templates:[]; u.competitions=Array.isArray(u.competitions)?u.competitions:[]; u.planVersions=Array.isArray(u.planVersions)?u.planVersions:[]; u.exerciseLibrary=u.exerciseLibrary||{};
    Object.values(u.logs).forEach(rec=>{if(rec)rec.ownerId=newId;});
    Object.values(u.customPlan).forEach(rec=>{if(rec)rec.ownerId=newId;});
    u.metadata.storageNamespace=`profile_${newId}`;
    u.metadata.reassignedAt=nowISO();
    return u;
  }

  function newDatabase(){
    const u=legacyDefaultUser();
    return {
      schemaVersion:SCHEMA_VERSION,appVersion:APP_VERSION,createdAt:nowISO(),updatedAt:nowISO(),
      activeUserId:u.id,users:{[u.id]:u},quarantine:[],
      migrationHistory:[{at:nowISO(),to:SCHEMA_VERSION,note:'Migración inicial con aislamiento por propietario'}]
    };
  }

  function loadDatabase(){
    let d=loadJSON(DB_KEY,null);
    if(!d || !d.users){
      d=newDatabase();
      localStorage.setItem(DB_KEY,JSON.stringify(d));
      return d;
    }
    return migrateDatabase(d);
  }

  function migrateDatabase(d){
    if(!d.schemaVersion) d.schemaVersion=1;

    if(d.schemaVersion<5){
      backupDatabaseRaw(d,'Antes de migrar a v5');
      Object.values(d.users||{}).forEach(u=>{
        u.logs=u.logs||{}; u.customPlan=u.customPlan||{}; u.prefs=u.prefs||{};
        if(u.prefs.useBasePlan===undefined)u.prefs.useBasePlan=true;
        if(u.prefs.autoRecommendations===undefined)u.prefs.autoRecommendations=true;
        if(u.bodyWeightKg===undefined)u.bodyWeightKg='';
        u.metadata=u.metadata||{};
      });
      d.schemaVersion=5;
      d.migrationHistory=d.migrationHistory||[];
      d.migrationHistory.push({at:nowISO(),to:5,note:'Perfiles, registros estructurados, intervalos y recomendaciones automáticas'});
    }

    if(d.schemaVersion<6){
      backupDatabaseRaw(d,'Antes de activar aislamiento de usuarios v6');
      d.quarantine=d.quarantine||[];
      Object.values(d.users||{}).forEach(u=>{
        u.metadata=u.metadata||{};
        if(!u.metadata.storageNamespace)u.metadata.storageNamespace=`profile_${u.id}`;
        stampMissingOwnership(u);
      });
      d.schemaVersion=6;
      d.migrationHistory=d.migrationHistory||[];
      d.migrationHistory.push({
        at:nowISO(),to:6,
        note:'Aislamiento estricto por ownerId: plan, logs, recomendaciones y estadísticas quedan vinculados a un único usuario'
      });
    }

    if(d.schemaVersion<7){
      backupDatabaseRaw(d,'Antes de activar PREPA v6 adaptativa');
      d.centralExerciseLibrary=d.centralExerciseLibrary||{};
      Object.values(d.users||{}).forEach(u=>{
        u.templates=Array.isArray(u.templates)?u.templates:[];
        u.competitions=Array.isArray(u.competitions)?u.competitions:[];
        u.planVersions=Array.isArray(u.planVersions)?u.planVersions:[];
        u.exerciseLibrary=u.exerciseLibrary||{};
        u.prefs=u.prefs||{};
        if(u.prefs.adaptiveRecommendations===undefined)u.prefs.adaptiveRecommendations=true;
        if(u.prefs.wellnessAdjustment===undefined)u.prefs.wellnessAdjustment=true;
        stampMissingOwnership(u);
      });
      d.schemaVersion=7;
      d.migrationHistory=d.migrationHistory||[];
      d.migrationHistory.push({
        at:nowISO(),to:7,
        note:'v6: temporizadores, bienestar, planificador semanal, biblioteca, competiciones, plantillas, historial de plan y recomendación adaptativa'
      });
    }

    d.appVersion=APP_VERSION;
    d.updatedAt=nowISO();
    if(!d.activeUserId || !d.users[d.activeUserId]) d.activeUserId=Object.keys(d.users)[0];
    localStorage.setItem(DB_KEY,JSON.stringify(d));
    return d;
  }

  function backupDatabaseRaw(raw,label='Copia automática'){
    const arr=loadJSON(DB_BACKUP_KEY,[]);
    arr.unshift({at:nowISO(),label,data:raw});
    localStorage.setItem(DB_BACKUP_KEY,JSON.stringify(arr.slice(0,3)));
  }

  function saveDB(){
    Object.values(db.users||{}).forEach(u=>enforceOwnership(u));
    db.schemaVersion=SCHEMA_VERSION; db.appVersion=APP_VERSION; db.updatedAt=nowISO();
    localStorage.setItem(DB_KEY,JSON.stringify(db));
  }

  function currentUser(){
    const u=db.users[db.activeUserId] || Object.values(db.users)[0];
    if(u) enforceOwnership(u);
    return u;
  }

  function logs(){
    const u=currentUser();
    u.logs=u.logs||{};
    return u.logs;
  }

  function customPlan(){
    const u=currentUser();
    u.customPlan=u.customPlan||{};
    return u.customPlan;
  }

  function prefs(){
    const u=currentUser();
    u.prefs=u.prefs||{};
    return u.prefs;
  }


  function clone(v){ return JSON.parse(JSON.stringify(v)); }
  function activeData(){
    const u=currentUser();
    u.templates=Array.isArray(u.templates)?u.templates:[];
    u.competitions=Array.isArray(u.competitions)?u.competitions:[];
    u.planVersions=Array.isArray(u.planVersions)?u.planVersions:[];
    u.exerciseLibrary=u.exerciseLibrary||{};
    return u;
  }
  function addDaysISO(iso,days){const d=new Date(iso+'T12:00:00');d.setDate(d.getDate()+days);return isoLocal(d);}
  function dateDiffDays(a,b){return Math.round((new Date(b+'T12:00:00')-new Date(a+'T12:00:00'))/86400000);}
  function mondayISO(iso){const d=new Date(iso+'T12:00:00'),n=(d.getDay()+6)%7;d.setDate(d.getDate()-n);return isoLocal(d);}
  function weekDates(iso){const m=mondayISO(iso);return Array.from({length:7},(_,i)=>addDaysISO(m,i));}
  function formatShortDay(iso){const d=new Date(iso+'T12:00:00');return new Intl.DateTimeFormat('es-ES',{weekday:'short',day:'numeric'}).format(d).replace('.','');}
  function parseRir(text=''){const m=String(text).match(/RIR\s*(\d+)(?:\s*[-–]\s*(\d+))?/i);return m?Number(m[2]||m[1]):2;}
  function rpeFromIntensity(text='',type=''){const m=String(text).match(/RPE\s*(\d+)(?:\s*[-–]\s*(\d+))?/i);if(m)return Number(m[2]||m[1]);if(type==='Fútbol sala')return 8;if(/Fuerza|Pliometría|Unilateral/i.test(type))return 7;if(/Superior/i.test(type))return 6;if(/Bicicleta|Natación/i.test(type))return 4;return 5;}
  function plannedLoadForDay(d){const mins=parseDurationMin(d.duration)||60;return mins*rpeFromIntensity(d.intensity,d.type);}
  function isLowerStrengthDay(d){return !!d && (/Fuerza|Unilateral|Pliometría/i.test(d.type)||d.exercises?.some(e=>isLowerStrengthExercise(e)));}
  function isLowerStrengthExercise(e){const x=((e?.name||'')+' '+(e?.section||'')).toLowerCase();return /sentadilla|peso muerto|rdl|hip thrust|prensa|b[uú]lgara|split|zancada|femoral|salto|hop|bound|pogo|cmj/.test(x);}
  function isFutsalDay(d){return !!d && (d.type==='Fútbol sala'||/futsal|partido/i.test((d.objective||'')+' '+(d.details||'')));}

  function snapshotPlan(reason){
    const u=activeData();
    const snap={id:uid('version'),at:nowISO(),reason:reason||'Cambio de plan',customPlan:clone(u.customPlan||{}),competitions:clone(u.competitions||[])};
    u.planVersions.unshift(snap);u.planVersions=u.planVersions.slice(0,15);saveDB();return snap.id;
  }
  function restorePlanVersion(id){
    const u=activeData(),v=u.planVersions.find(x=>x.id===id);if(!v)return;
    if(!confirm(`Restaurar el plan de ${new Date(v.at).toLocaleString('es-ES')}? Los entrenamientos realizados y sus registros NO se borrarán.`))return;
    snapshotPlan('Antes de restaurar una versión anterior');
    u.customPlan=clone(v.customPlan||{});u.competitions=clone(v.competitions||[]);stampMissingOwnership(u);save();selectedDate='';rebuildPlan();setView('calendar');toastMsg('Plan restaurado · historial conservado');
  }

  const EXERCISE_ALIASES={
    'rdl':'Peso muerto rumano','peso muerto rumano':'Peso muerto rumano','pm rumano':'Peso muerto rumano','peso muerto rumano con barra':'Peso muerto rumano',
    'press banca md':'Press banca con mancuernas','press banca mancuernas':'Press banca con mancuernas','press banca con mancuernas':'Press banca con mancuernas',
    'hip thrust':'Hip thrust','hip thrust barra':'Hip thrust','sentadilla goblet':'Sentadilla goblet','sentadilla frontal':'Sentadilla frontal',
    'jalon neutro':'Jalón neutro','jalón neutro':'Jalón neutro','remo sentado polea':'Remo sentado en polea','remo pecho apoyado':'Remo pecho apoyado'
  };
  function normName(s=''){return String(s).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
  function canonicalExerciseName(name=''){const n=normName(name);for(const[k,v]of Object.entries(EXERCISE_ALIASES))if(normName(k)===n)return v;return String(name||'Ejercicio').trim();}
  function canonicalExerciseId(name=''){return 'lib_'+hashText(normName(canonicalExerciseName(name)));}
  function inferExerciseMeta(name=''){
    const x=normName(name);let group='General',pattern='General',equipment='Libre',type='reps',restSetSec=75,restExerciseSec=90;
    if(/sentadilla|split|bulgara|zancada|prensa/.test(x)){group='Pierna';pattern='Dominante de rodilla';type='strength';equipment=/prensa/.test(x)?'Máquina':/mancuerna|goblet/.test(x)?'Mancuernas':'Barra / libre';restSetSec=120;restExerciseSec=120;}
    else if(/peso muerto|rdl|hip thrust|femoral/.test(x)){group='Cadena posterior';pattern='Bisagra / extensión de cadera';type='strength';equipment=/femoral/.test(x)?'Máquina':/mancuerna/.test(x)?'Mancuernas':'Barra / libre';restSetSec=120;restExerciseSec=120;}
    else if(/press banca|flexion|press militar/.test(x)){group='Tren superior';pattern='Empuje';type='strength';equipment=/flexion/.test(x)?'Peso corporal':/mancuerna/.test(x)?'Mancuernas':'Barra / libre';restSetSec=90;restExerciseSec=90;}
    else if(/remo|jalon|face pull/.test(x)){group='Tren superior';pattern='Tracción';type='strength';equipment='Polea / mancuernas';restSetSec=90;restExerciseSec=90;}
    else if(/pallof|dead bug|bicho muerto|copenhagen|plancha/.test(x)){group='Core';pattern='Estabilidad';type='reps';equipment='Peso corporal / polea';restSetSec=30;restExerciseSec=45;}
    else if(/salto|hop|bound|pogo|cmj|snap/.test(x)){group='Potencia';pattern='Pliometría';type='reps';equipment='Peso corporal';restSetSec=75;restExerciseSec=90;}
    else if(/bici|bicicleta|rodaje/.test(x)){group='Cardio';pattern='Cíclico';type='bike';equipment='Bicicleta';}
    else if(/nataci|nado|crawl|espalda/.test(x)){group='Cardio';pattern='Natación';type='swim';equipment='Piscina';}
    return{group,pattern,equipment,type,restSetSec,restExerciseSec,progression:'Aumentar dificultad solo si técnica, volumen y RPE objetivo se cumplen.',regression:'Reducir carga, rango, volumen o complejidad manteniendo buena técnica.',videoUrl:''};
  }
  function ensureCentralLibrary(){
    db.centralExerciseLibrary=db.centralExerciseLibrary||{};
    BASE_PLAN.flatMap(d=>d.exercises||[]).forEach(e=>{const name=canonicalExerciseName(e.name||'');const id=canonicalExerciseId(name);if(!db.centralExerciseLibrary[id])db.centralExerciseLibrary[id]={id,name,...inferExerciseMeta(name),aliases:[]};const raw=e.name||'';if(raw&&raw!==name&&!db.centralExerciseLibrary[id].aliases.includes(raw))db.centralExerciseLibrary[id].aliases.push(raw);});
    Object.values(EXERCISE_ALIASES).forEach(name=>{const id=canonicalExerciseId(name);if(!db.centralExerciseLibrary[id])db.centralExerciseLibrary[id]={id,name,...inferExerciseMeta(name),aliases:[]};});
  }
  function exerciseLibraryEntry(name=''){
    ensureCentralLibrary();const id=canonicalExerciseId(name),u=activeData();return u.exerciseLibrary[id]||db.centralExerciseLibrary[id]||{id,name:canonicalExerciseName(name),...inferExerciseMeta(name),aliases:[]};
  }
  function allLibraryEntries(){ensureCentralLibrary();const u=activeData(),map={...db.centralExerciseLibrary,...u.exerciseLibrary};return Object.values(map).sort((a,b)=>a.name.localeCompare(b.name,'es'));}
  function saveCustomExercise(){
    const name=prompt('Nombre del ejercicio:');if(!name)return;const meta=inferExerciseMeta(name),id=canonicalExerciseId(name);const group=prompt('Grupo muscular / área:',meta.group)||meta.group;const pattern=prompt('Patrón de movimiento:',meta.pattern)||meta.pattern;const equipment=prompt('Material:',meta.equipment)||meta.equipment;const videoUrl=prompt('Enlace de vídeo o referencia (opcional):','')||'';activeData().exerciseLibrary[id]={id,name:canonicalExerciseName(name),group,pattern,equipment,type:meta.type,restSetSec:meta.restSetSec,restExerciseSec:meta.restExerciseSec,progression:meta.progression,regression:meta.regression,videoUrl,aliases:[name]};save();toastMsg('Ejercicio añadido a tu biblioteca');renderBackup();
  }

  function wellnessData(log){log.wellness=log.wellness||{sleep:'',fatigue:'',motivation:'',soreness:'',achilles:''};return log.wellness;}
  function readinessScore(w){
    const vals=[num(w.sleep),num(w.fatigue),num(w.motivation),num(w.soreness),num(w.achilles)];if(vals.filter(Number.isFinite).length<3)return null;
    const sleep=Number.isFinite(vals[0])?vals[0]:5,fat=Number.isFinite(vals[1])?vals[1]:5,mot=Number.isFinite(vals[2])?vals[2]:5,sore=Number.isFinite(vals[3])?vals[3]:5,ach=Number.isFinite(vals[4])?vals[4]:0;
    return clamp(Math.round(sleep*25/10+(10-fat)*20/10+mot*20/10+(10-sore)*15/10+(10-ach)*20/10),0,100);
  }
  function readinessLabel(score){if(score===null)return'Sin datos';if(score>=75)return'Buena';if(score>=55)return'Media';return'Baja';}
  function wellnessSuggestion(log){const w=wellnessData(log),s=readinessScore(w);if(s===null)return'Registra al menos 3 campos para contextualizar la sesión.';if(num(w.achilles)>3)return'El Aquiles está por encima de 3/10: no progreses la carga de pierna automáticamente y prioriza la pauta del fisio.';if(s<55)return'Preparación baja: la app mantendrá o reducirá ligeramente la recomendación de carga.';if(s<75)return'Preparación media: mantén el objetivo y evita progresiones agresivas.';return'Preparación buena: puedes seguir la progresión si el historial también la respalda.';}

  function parseTimeSeconds(v=''){
    const s=String(v).trim().toLowerCase();if(!s)return 0;let m=s.match(/(\d+(?:[.,]\d+)?)\s*(min|')\b/);if(m)return Math.round(num(m[1])*60);m=s.match(/(\d+(?:[.,]\d+)?)\s*(s|seg|sec)\b/);if(m)return Math.round(num(m[1]));if(/^\d+(?:[.,]\d+)?$/.test(s))return Math.round(num(s));return 0;
  }
  function ensureTimerDock(){
    let el=document.getElementById('timerDock');if(el)return el;el=document.createElement('div');el.id='timerDock';el.className='timerDock hidden';el.innerHTML='<div><small id="timerLabel">Temporizador</small><strong id="timerValue">00:00</strong><span id="timerPhase"></span></div><div class="timerActions"><button id="timerPause">Pausa</button><button id="timerSkip">Saltar</button><button id="timerStop">✕</button></div>';document.body.appendChild(el);
    el.querySelector('#timerPause').onclick=()=>{if(!timerState)return;timerState.paused=!timerState.paused;el.querySelector('#timerPause').textContent=timerState.paused?'Continuar':'Pausa';};
    el.querySelector('#timerSkip').onclick=()=>finishTimerPhase(true);el.querySelector('#timerStop').onclick=stopTimer;return el;
  }
  function timerFmt(sec){sec=Math.max(0,Math.ceil(sec));return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;}
  function startTimer(seconds,label='Descanso',meta={}){
    seconds=Math.max(1,Math.round(seconds));ensureTimerDock();if(timerInterval)clearInterval(timerInterval);timerState={remaining:seconds,total:seconds,label,paused:false,meta,startedAt:Date.now()};updateTimerDock();document.getElementById('timerDock').classList.remove('hidden');timerInterval=setInterval(()=>{if(!timerState||timerState.paused)return;timerState.remaining--;updateTimerDock();if(timerState.remaining<=0)finishTimerPhase(false);},1000);
  }
  function updateTimerDock(){if(!timerState)return;const el=ensureTimerDock();el.querySelector('#timerLabel').textContent=timerState.label;el.querySelector('#timerValue').textContent=timerFmt(timerState.remaining);el.querySelector('#timerPhase').textContent=timerState.meta?.phaseText||'';}
  function stopTimer(){if(timerInterval)clearInterval(timerInterval);timerInterval=null;timerState=null;document.getElementById('timerDock')?.classList.add('hidden');}
  function finishTimerPhase(skipped=false){
    if(!timerState)return;const meta=timerState.meta||{};if(navigator.vibrate&&!skipped)navigator.vibrate([120,80,120]);if(meta.sequence){const seq=meta.sequence,index=(meta.index||0)+1;if(index<seq.length){const n=seq[index];startTimer(n.seconds,n.label,{...meta,index,phaseText:n.phaseText});return;}toastMsg('Intervalos completados');}else if(!skipped)toastMsg('Descanso terminado');stopTimer();
  }
  function startIntervalSequence(e){
    if(e.cardioMode==='interval_distance'&&!parseTimeSeconds(e.intervalWork)){alert('Este bloque es por distancia. Registra cada intervalo en la tabla; el temporizador automático se usa cuando el trabajo está expresado en tiempo.');return;}
    const count=Number(e.intervalCount)||1,work=parseTimeSeconds(e.intervalWork),rec=parseTimeSeconds(e.intervalRecovery);if(!work){alert('Para usar el temporizador, el trabajo debe estar expresado en tiempo, por ejemplo 6 min o 30 s.');return;}
    const seq=[];for(let i=0;i<count;i++){seq.push({seconds:work,label:`Trabajo ${i+1}/${count}`,phaseText:e.intervalTarget||''});if(i<count-1&&rec)seq.push({seconds:rec,label:`Recuperación ${i+1}/${count}`,phaseText:'Prepárate para el siguiente intervalo'});}const first=seq[0];startTimer(first.seconds,first.label,{sequence:seq,index:0,phaseText:first.phaseText});
  }

  function weekSummary(anchor){
    const dates=weekDates(anchor),days=dates.map(d=>byDate[d]).filter(Boolean).filter(d=>d.type!=='Descanso'),done=days.filter(d=>logs()[d.date]?.status==='done').length,partial=days.filter(d=>logs()[d.date]?.status==='partial').length,pending=Math.max(0,days.length-done-partial);
    const matches=dates.flatMap(date=>activeData().competitions.filter(c=>c.date===date)).concat(days.filter(d=>/partido/i.test((d.objective||'')+' '+(d.details||''))).map(d=>({date:d.date,time:(String(d.details||'').match(/\b\d{1,2}:\d{2}\b/)||[''])[0],opponent:''}))).filter((v,i,a)=>a.findIndex(x=>x.date===v.date)===i);
    const cardio=days.filter(d=>['Bicicleta','Natación'].includes(d.type));
    const planned=days.reduce((a,d)=>a+plannedLoadForDay(d),0);let actual=0;days.forEach(d=>{const l=logs()[d.date];if(!l)return;const r=num(l.sessionRpe),m=num(l.actualMinutes);if(Number.isFinite(r)&&Number.isFinite(m))actual+=r*m;else if(l.status==='done')actual+=plannedLoadForDay(d);else if(l.status==='partial')actual+=plannedLoadForDay(d)*.5;});
    return{dates,days,done,partial,pending,matches,cardio,loadPct:planned?clamp(Math.round(actual/planned*100),0,150):0};
  }
  function weekDashboardHtml(anchor){const w=weekSummary(anchor),match=w.matches[0],card=w.cardio[0];return `<div class="weekDash"><div class="weekDashHead"><div><span>ESTA SEMANA</span><strong>${w.days.length} sesiones · ${w.done} hechas · ${w.pending} pendientes</strong></div><b>${w.loadPct}%</b></div><div class="weekDashGrid"><div><small>Partido</small><strong>${match?`${fmtDate(match.date,false)} ${match.time||''}`:'—'}</strong></div><div><small>Cardio</small><strong>${card?`${fmtDate(card.date,false)} · ${card.type}`:'—'}</strong></div><div><small>Carga completada</small><strong>${w.loadPct}%</strong></div></div><div class="progress"><i style="width:${Math.min(100,w.loadPct)}%"></i></div></div>`;}

  function scheduleWarnings(source,targetDate){
    const warnings=[];const next=byDate[addDaysISO(targetDate,1)],prev=byDate[addDaysISO(targetDate,-1)];if(isLowerStrengthDay(source)&&isFutsalDay(next))warnings.push('Esto coloca fuerza/pliometría de pierna 24 h antes del futsal o partido.');if(isFutsalDay(source)&&isLowerStrengthDay(prev))warnings.push('El día anterior ya contiene una sesión fuerte de pierna.');const comp=activeData().competitions.find(c=>c.date===addDaysISO(targetDate,1));if(isLowerStrengthDay(source)&&comp)warnings.push(`Hay partido al día siguiente${comp.time?' a las '+comp.time:''}.`);return warnings;
  }
  function performMove(fromDate,target){
    if(!fromDate||!target||fromDate===target)return;const source=byDate[fromDate];if(!source)return;const targetDay=byDate[target],warnings=scheduleWarnings(source,target);let msg=warnings.length?'⚠️ '+warnings.join('\n⚠️ ')+'\n\n':'';msg+=targetDay?`¿Intercambiar ${fromDate} y ${target}?`:`¿Mover el entrenamiento de ${fromDate} a ${target}?`;if(!confirm(msg))return;snapshotPlan(`Mover ${fromDate} → ${target}`);const ownerId=currentUser().id;if(targetDay){customPlan()[fromDate]={...normalizeDay({...targetDay,date:fromDate}),ownerId};customPlan()[target]={...normalizeDay({...source,date:target}),ownerId};}else{customPlan()[target]={...normalizeDay({...source,date:target}),ownerId};customPlan()[fromDate]={__deleted:true,ownerId};}save();rebuildPlan();selectedDate=target;plannerSelectedDate='';toastMsg(targetDay?'Entrenamientos intercambiados':'Entrenamiento movido');
  }

  function captureOverride(date){return Object.prototype.hasOwnProperty.call(customPlan(),date)?clone(customPlan()[date]):null;}
  function restoreCompetitionOriginals(comp){if(!comp?.originalOverrides)return;for(const[date,val]of Object.entries(comp.originalOverrides)){if(val===null)delete customPlan()[date];else customPlan()[date]=clone(val);}delete comp.originalOverrides;}
  function adjustForCompetition(comp){
    const u=activeData(),date=comp.date,prev=addDaysISO(date,-1),prev2=addDaysISO(date,-2);comp.originalOverrides={[date]:captureOverride(date),[prev]:captureOverride(prev),[prev2]:captureOverride(prev2)};const ownerId=u.id;
    const existing=byDate[date]||normalizeDay({date,type:'Fútbol sala',objective:'Partido',duration:'Según partido',intensity:'Alta',exercises:[]});
    const matchDay=normalizeDay({...existing,date,type:'Fútbol sala',objective:`Partido${comp.opponent?' vs '+comp.opponent:''} · ${comp.time||'hora por confirmar'}`,details:`PARTIDO DE FÚTBOL SALA${comp.time?' a las '+comp.time:''}.${comp.location?' · '+comp.location:''}\nEl partido es la carga principal del día.`,intensity:'Partido · alta',dailyNote:'Día de partido: llega fresca/o y evita añadir carga innecesaria antes del encuentro.',exercises:[{section:'Partido',name:'Partido de fútbol sala',kind:'session',planned:`${comp.time||''}${comp.opponent?' · '+comp.opponent:''}`} ]});customPlan()[date]={...matchDay,ownerId,competitionId:comp.id};
    const p=byDate[prev];if(p){let mod=clone(p);if(isLowerStrengthDay(p)){mod.objective='Ajuste prepartido · activación / descarga';mod.intensity='RIR 3-4';mod.duration='45-60 min';mod.details='Ajuste automático por partido al día siguiente. Volumen de pierna reducido; no buscar fallo ni fatiga residual.\n'+(p.details||'');mod.exercises=(p.exercises||[]).map(e=>isLowerStrengthExercise(e)&&e.kind==='strength'?{...e,sets:Math.max(2,Math.ceil((Number(e.sets)||3)*.7)),restSetSec:Math.max(90,Number(e.restSetSec)||90)}:e);}else if(['Bicicleta','Natación'].includes(p.type)){mod.intensity='RPE 3-4';mod.dailyNote='Recuperación prepartido: termina con sensación de ligereza.';}customPlan()[prev]={...normalizeDay(mod),ownerId,competitionId:comp.id,autoAdjusted:true};}
    const p2=byDate[prev2];if(p2&&isLowerStrengthDay(p2)){let mod=clone(p2);mod.dailyNote='Partido en 48 h: mantén margen y no añadas volumen extra.';mod.intensity=/RIR/i.test(mod.intensity)?mod.intensity:'RIR 2-3';customPlan()[prev2]={...normalizeDay(mod),ownerId,competitionId:comp.id,autoAdjusted:true};}
  }
  function addCompetition(){
    const date=prompt('Fecha del partido (AAAA-MM-DD):',nextSuggestedDate());if(!date)return;const time=prompt('Hora del partido:','20:00')||'';const opponent=prompt('Rival (opcional):','')||'';const location=prompt('Lugar (opcional):','')||'';snapshotPlan(`Añadir partido ${date}`);const comp={id:uid('match'),ownerId:currentUser().id,date,time,opponent,location,createdAt:nowISO()};activeData().competitions.push(comp);rebuildPlan();adjustForCompetition(comp);save();rebuildPlan();weekAnchor=mondayISO(date);renderCalendar();toastMsg('Partido añadido y carga previa ajustada');
  }
  function editCompetition(id){
    const u=activeData(),c=u.competitions.find(x=>x.id===id);if(!c)return;const date=prompt('Nueva fecha:',c.date);if(!date)return;const time=prompt('Hora:',c.time||'20:00')??c.time;const opponent=prompt('Rival:',c.opponent||'')??c.opponent;const location=prompt('Lugar:',c.location||'')??c.location;snapshotPlan(`Modificar partido ${c.date}`);restoreCompetitionOriginals(c);c.date=date;c.time=time;c.opponent=opponent;c.location=location;rebuildPlan();adjustForCompetition(c);save();rebuildPlan();weekAnchor=mondayISO(date);renderCalendar();toastMsg('Partido actualizado y plan reajustado');
  }
  function deleteCompetition(id){const u=activeData(),i=u.competitions.findIndex(x=>x.id===id);if(i<0)return;const c=u.competitions[i];if(!confirm('Eliminar este partido del calendario y restaurar los días que ajustó automáticamente?'))return;snapshotPlan(`Eliminar partido ${c.date}`);restoreCompetitionOriginals(c);u.competitions.splice(i,1);save();rebuildPlan();renderCalendar();}

  function saveTemplateFromDate(date){const d=byDate[date];if(!d)return;const name=prompt('Nombre de la plantilla:',d.objective||d.type);if(!name)return;activeData().templates.push({id:uid('tpl'),ownerId:currentUser().id,name,createdAt:nowISO(),day:clone({...d,date:''})});save();toastMsg('Plantilla guardada');renderCalendar();}
  function applyTemplate(id){const t=activeData().templates.find(x=>x.id===id);if(!t)return;const date=prompt('Fecha donde aplicar la plantilla (AAAA-MM-DD):',nextSuggestedDate());if(!date)return;if(byDate[date]&&!confirm('Ya existe entrenamiento ese día. ¿Sustituir el plan de esa fecha? El registro realizado no se borra.'))return;snapshotPlan(`Aplicar plantilla ${t.name} en ${date}`);customPlan()[date]={...normalizeDay({...clone(t.day),date}),ownerId:currentUser().id};save();rebuildPlan();selectedDate=date;renderCalendar();toastMsg('Plantilla aplicada');}
  function deleteTemplate(id){const u=activeData(),i=u.templates.findIndex(x=>x.id===id);if(i>=0&&confirm('Eliminar esta plantilla?')){u.templates.splice(i,1);save();renderCalendar();}}
  function hashText(s=''){ let h=2166136261; for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);} return (h>>>0).toString(36); }
  function exerciseId(e,i=0){ return e.id || `ex_${hashText((e.section||'')+'|'+(e.name||'')+'|'+i)}`; }

  function parseLoadDescriptor(s='',name=''){
    const t=String(s||'').trim();
    if(!t || /corporal|peso corporal/i.test(t)) return {weight:'',mode:/corporal/i.test(t)?'bodyweight':'total',text:t};
    let m=t.match(/2\s*[×xX]\s*(\d+(?:[.,]\d+)?)\s*kg/i);
    if(m) return {weight:num(m[1]),mode:'perHand',text:`${num(m[1])} kg por mancuerna`};
    m=t.match(/(\d+(?:[.,]\d+)?)\s*kg/i);
    if(m) return {weight:num(m[1]),mode:/mancuerna|md\b/i.test(name)?'perHand':'total',text:`${num(m[1])} kg`};
    return {weight:'',mode:'total',text:t};
  }
  function parseSetRep(text=''){
    const m=String(text).match(/(\d+)\s*[×xX]\s*(\d+)/);
    return m?{sets:Number(m[1]),reps:Number(m[2])}:{sets:'',reps:''};
  }
  function cleanPlanned(text='',loadText=''){
    let s=String(text||'').trim();
    if(loadText) s=s.replace(new RegExp(`\\s*[·\\-]?\\s*${escapeReg(loadText)}`,'i'),'');
    s=s.replace(/\s*[·\-]\s*2\s*[×xX]\s*\d+(?:[.,]\d+)?\s*kg\b.*$/i,'');
    s=s.replace(/\s*[·\-]\s*\d+(?:[.,]\d+)?\s*kg\b.*$/i,'');
    return s.replace(/\s*[·\-]\s*$/,'').trim();
  }
  function escapeReg(s){return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
  function defaultRest(e){
    const x=((e.name||'')+' '+(e.section||'')).toLowerCase();
    if(/plio|salto|hop|bound|cmj/.test(x)) return {set:75,exercise:90};
    if(/fisio|movilidad|almeja|puente|dead|bicho|flexion|pallof|copenhagen/.test(x)) return {set:30,exercise:45};
    if(/sentadilla|peso muerto|rdl|hip thrust|prensa|press banca|remo|jal[oó]n|b[uú]lgara|split squat/.test(x)) return {set:120,exercise:120};
    return {set:75,exercise:90};
  }
  function inferKind(e={}){
    const raw=String(e.kind||e.track||'').toLowerCase();
    const x=((e.name||'')+' '+(e.section||'')+' '+(e.planned||'')).toLowerCase();
    if(raw==='strength'||/fuerza|peso|carga/.test(raw)) return 'strength';
    if(raw==='reps'||/repet/.test(raw)) return 'reps';
    if(raw==='time') return 'time';
    if(raw==='session') return 'session';
    if(raw==='bike'||/bici|bicicleta/.test(raw)||/bici|bicicleta|rodaje|ruta/.test(x)) return 'bike';
    if(raw==='swim'||/nataci|nado/.test(raw)||/nataci|nado|crawl|espalda/.test(x)) return 'swim';
    if(raw==='intervals'||/interval/.test(raw)||/(\d+)\s*[×xX]\s*(\d+)\s*(?:min|s|seg|')/.test(x)) return 'intervals';
    if(raw==='cardio') return 'cardio';
    if(/press|remo|sentadilla|peso muerto|rdl|hip thrust|jal[oó]n|curl|prensa|b[uú]lgara|mancuerna|barra|polea/.test(x)) return 'strength';
    return 'reps';
  }
  function intervalSpec(text=''){
    const s=String(text);
    const unit=u=>u==="'"?'min':u;
    let m=s.match(/(\d+)\s*[×xX]\s*(\d+(?:[.,]\d+)?)\s*(min|s|seg|m|')[^]*?(?:\/|con|rec(?:uperaci[oó]n)?\s*)(\d+(?:[.,]\d+)?)\s*(min|s|seg|m|')/i);
    if(!m) m=s.match(/(\d+)\s*[×xX]\s*(\d+(?:[.,]\d+)?)\s*(min|s|seg|m|')/i);
    return m?{count:Number(m[1]),work:`${m[2]} ${unit(m[3])}`,recovery:m[4]?`${m[4]} ${unit(m[5])}`:'',target:(s.match(/RPE\s*\d+(?:-\d+)?/i)||[])[0]||''}:{count:'',work:'',recovery:'',target:''};
  }
  function normalizeExercise(e={},i=0){
    const canonicalName=canonicalExerciseName(e.canonicalName||e.name||'Ejercicio'),meta=exerciseLibraryEntry(canonicalName);
    const originalLoad=e.suggestedLoad||e.recommendedWeight||'';
    const ld=parseLoadDescriptor(originalLoad,e.name||'');
    const sr=parseSetRep(e.planned||'');
    const rest=defaultRest(e);
    const kind=inferKind(e);
    const spec=intervalSpec(e.planned||'');
    const planned=cleanPlanned(e.planned||'',originalLoad);
    let cardioMode=e.cardioMode||'';
    if(!cardioMode){if(kind==='intervals')cardioMode=/\bm\b|metros|km/i.test(spec.work)?'interval_distance':'interval_time';else if(['bike','swim','cardio'].includes(kind))cardioMode=/recuper/i.test((e.planned||'')+' '+(e.section||''))?'recovery':'continuous';else cardioMode='';}
    return {
      id:e.id||canonicalExerciseId(canonicalName), canonicalId:canonicalExerciseId(canonicalName), canonicalName,
      section:e.section||'Entrenamiento', name:e.name||canonicalName||'Ejercicio',
      kind, cardioMode, planned, sets:e.sets||sr.sets||'', reps:e.reps||sr.reps||'',
      recommendedWeight:e.recommendedWeight!==undefined?e.recommendedWeight:ld.weight,
      weightMode:e.weightMode||ld.mode||'total', loadStep:e.loadStep||((ld.mode==='perHand')?1:2.5),
      restSetSec:e.restSetSec||meta.restSetSec||rest.set, restExerciseSec:e.restExerciseSec||meta.restExerciseSec||rest.exercise,
      durationTarget:e.durationTarget||parseDurationMin(e.planned||'')||'', distanceTarget:e.distanceTarget||'', elevationTarget:e.elevationTarget||'',
      rpeTarget:e.rpeTarget||((String(e.planned||'').match(/RPE\s*([\d-]+)/i)||[])[1]||''),
      intervalCount:e.intervalCount||spec.count||'', intervalWork:e.intervalWork||spec.work||'', intervalRecovery:e.intervalRecovery||spec.recovery||'', intervalTarget:e.intervalTarget||spec.target||'',
      swimMeters:e.swimMeters||'', swimStroke:e.swimStroke||'', swimBlocks:e.swimBlocks||'', note:e.note||''
    };
  }
  function dailyNoteFor(d={}){
    const type=String(d.type||''), date=String(d.date||'');
    const hash=[...date].reduce((a,c)=>a+c.charCodeAt(0),0),pick=a=>a[hash%a.length];
    if(type==='Descanso')return pick(['Recuperar también es entrenar.','Hoy toca sumar energía para el siguiente estímulo.','Descanso planificado: no necesitas compensarlo.']);
    if(type==='Natación')return pick(['Nada cómodo y termina con sensación de ligereza.','Hoy el agua es recuperación, no una prueba.','Ritmo suave y respiración tranquila.']);
    if(type==='Bicicleta')return pick(['Cadencia cómoda y seguridad primero.','La bici debe dejarte mejor de lo que empezaste.','Suma tiempo aeróbico, no persigas la velocidad media.']);
    if(type==='Fútbol sala')return pick(['Hoy manda la pista: calidad, decisiones y buenas frenadas.','Guarda energía para lo específico: el futsal es el estímulo principal.','Compite o entrena rápido, pero con control.']);
    return pick(['Técnica limpia, registro claro y progresión sostenible.','Cumple el objetivo del día, no hace falta perseguir el fallo.','Cada dato que registras mejora la recomendación de la próxima sesión.']);
  }
  function normalizeDay(d={}){
    const ex=(Array.isArray(d.exercises)?d.exercises:[]).map((e,i)=>normalizeExercise(e,i));
    const base={date:d.date||isoLocal(),day:d.day||'',phase:d.phase||'Plan personalizado',type:d.type||'Gimnasio - Fuerza',objective:d.objective||'Entrenamiento',details:d.details||'',route:d.route||'',intensity:d.intensity||'RIR 2-3',duration:d.duration||'60-75 min',achilles:d.achilles||'Prioriza las indicaciones del fisioterapeuta y controla la respuesta del Aquiles.',exercises:ex};
    base.dailyNote=Object.prototype.hasOwnProperty.call(d,'dailyNote')?(d.dailyNote||''):dailyNoteFor(base);
    return base;
  }

  function rebuildPlan(){
    const u=currentUser(), map={};
    if(u.prefs?.useBasePlan!==false) BASE_PLAN.forEach(d=>map[d.date]=normalizeDay(d));
    Object.entries(u.customPlan||{}).forEach(([date,value])=>{
      if(!value || value.ownerId!==u.id) return;
      if(value.__deleted) delete map[date]; else map[date]=normalizeDay({...value,date});
    });
    PLAN=Object.values(map).sort((a,b)=>a.date.localeCompare(b.date));
    byDate=Object.fromEntries(PLAN.map(d=>[d.date,d]));
    minDate=PLAN[0]?.date||isoLocal(); maxDate=PLAN[PLAN.length-1]?.date||isoLocal();
    if(!selectedDate||!byDate[selectedDate])selectedDate=pickInitialDate();
    renderUserSelect();
  }
  function pickInitialDate(){ const t=isoLocal(); if(byDate[t])return t;if(!PLAN.length)return t;if(t<minDate)return minDate;if(t>maxDate)return maxDate;return PLAN.find(x=>x.date>=t)?.date||minDate; }
  function nextSuggestedDate(){const d=new Date((maxDate||isoLocal())+'T12:00:00');d.setDate(d.getDate()+1);return isoLocal(d);}

  function renderUserSelect(){
    userSelect.innerHTML=Object.values(db.users).map(u=>`<option value="${esc(u.id)}" ${u.id===db.activeUserId?'selected':''}>👤 ${esc(u.name)}</option>`).join('');
  }
  userSelect.addEventListener('change',()=>{
    saveDB();
    db.activeUserId=userSelect.value;
    const u=currentUser();
    enforceOwnership(u);
    selectedDate=''; PLAN=[]; byDate={}; minDate=''; maxDate='';
    saveDB(); rebuildPlan(); setView('today');
    toastMsg(`Perfil aislado activo: ${u.name}`);
  });

  function typeClass(type=''){if(type==='Fútbol sala')return'red';if(type.includes('Fuerza')||type.includes('Unilateral'))return'orange';if(type.includes('Superior'))return'blue';if(type.includes('Pliometría'))return'purple';if(type==='Bicicleta')return'green';if(type==='Natación')return'teal';return'gray';}
  function sectionClass(section=''){const s=String(section).toLowerCase();if(s.includes('calent'))return'section-warmup';if(/fisio|aquiles|tobillo/.test(s))return'section-fisio';if(/plio|salto|potencia/.test(s))return'section-plio';if(/core|abd/.test(s))return'section-core';if(/fuerza|entrenamiento/.test(s))return'section-force';return'';}

  function logFor(date){
    const u=currentUser(),L=logs();
    if(!L[date])L[date]={ownerId:u.id,status:'',sessionRpe:'',achillesBefore:'',achillesAfter:'',notes:'',actualMinutes:'',wellness:{sleep:'',fatigue:'',motivation:'',soreness:'',achilles:''},exercises:{}};
    if(!L[date].ownerId)L[date].ownerId=u.id;
    if(L[date].ownerId!==u.id){
      quarantineRecord(u,'log',date,L[date]);
      L[date]={ownerId:u.id,status:'',sessionRpe:'',achillesBefore:'',achillesAfter:'',notes:'',actualMinutes:'',wellness:{sleep:'',fatigue:'',motivation:'',soreness:'',achilles:''},exercises:{}};
    }
    L[date].exercises=L[date].exercises||{}; wellnessData(L[date]);
    return L[date];
  }
  function exerciseLog(log,e,i){
    if(log.exercises[e.id])return log.exercises[e.id];
    if(log.exercises[i]){log.exercises[e.id]=log.exercises[i];return log.exercises[e.id];}
    log.exercises[e.id]={}; return log.exercises[e.id];
  }
  function save(){ saveDB(); }

  function extractOldStrength(x,e){
    if(Array.isArray(x.setsData)&&x.setsData.length)return x.setsData;
    const reps=String(x.reps||'').split('/').map(num).filter(Number.isFinite);
    const load=parseLoadDescriptor(x.load||'',e.name).weight||num(x.load);
    const count=Number(x.sets)||reps.length||Number(e.sets)||1;
    const out=[];
    for(let i=0;i<count;i++)out.push({weight:Number.isFinite(load)?load:'',reps:Number.isFinite(reps[i])?reps[i]:(Number(e.reps)||''),rpe:''});
    if(out.some(s=>s.weight!==''||s.reps!=='')){x.setsData=out;return out;}
    return [];
  }
  function strengthHistory(name,beforeDate){
    const out=[],canonical=canonicalExerciseName(name);
    PLAN.filter(d=>d.date<beforeDate).forEach(d=>{
      const l=logs()[d.date]; if(!l||l.ownerId!==currentUser().id)return;
      d.exercises.forEach((e,i)=>{
        if(e.kind!=='strength'||canonicalExerciseName(e.canonicalName||e.name)!==canonical)return;
        const x=exerciseLog(l,e,i),sets=extractOldStrength(x,e);if(!sets.length)return;
        const valid=sets.filter(s=>Number.isFinite(num(s.weight))&&Number.isFinite(num(s.reps))&&num(s.reps)>0);if(!valid.length)return;
        const avgW=valid.reduce((a,s)=>a+num(s.weight),0)/valid.length,totalReps=valid.reduce((a,s)=>a+num(s.reps),0),volume=valid.reduce((a,s)=>a+num(s.weight)*num(s.reps),0);
        const rpes=valid.map(s=>num(s.rpe)).filter(Number.isFinite),avgRpe=rpes.length?avg(rpes):num(l.sessionRpe),e1rm=Math.max(...valid.map(s=>num(s.weight)*(1+num(s.reps)/30)));
        const bestSet=valid.reduce((best,s)=>num(s.weight)*(1+num(s.reps)/30)>num(best.weight)*(1+num(best.reps)/30)?s:best,valid[0]);
        const targetSets=Number(e.sets)||valid.length,targetReps=Number(e.reps)||Math.round(totalReps/valid.length),targetTotal=Math.max(1,targetSets*targetReps),completion=clamp(totalReps/targetTotal,0,1.25);
        out.push({date:d.date,weight:avgW,totalReps,sets:valid.length,avgRpe,e1rm,volume,bestSet:{weight:num(bestSet.weight),reps:num(bestSet.reps)},targetSets,targetReps,targetTotal,completion,achillesAfter:num(l.achillesAfter),wellness:clone(l.wellness||{}),dayObjective:d.objective||'',dayIntensity:d.intensity||''});
      });
    });
    return out.sort((a,b)=>a.date.localeCompare(b.date));
  }
  function recommendStrength(day,e){
    const baseW=num(e.recommendedWeight),baseSets=Number(e.sets)||3,baseReps=Number(e.reps)||8,targetRir=parseRir(day.intensity||'RIR 2');
    if(prefs().autoRecommendations===false||prefs().adaptiveRecommendations===false)return{weight:baseW,sets:baseSets,reps:baseReps,rir:targetRir,delta:0,reason:['Recomendación automática desactivada'],confidence:'—'};
    const h=strengthHistory(e.canonicalName||e.name,day.date),window=h.slice(-5),last=window[window.length-1],step=num(e.loadStep)||1;
    if(!last)return{weight:baseW,sets:baseSets,reps:baseReps,rir:targetRir,delta:0,reason:['Usando la carga base hasta disponer de registros comparables'],confidence:'Baja'};
    const avgCompletion=avg(window.map(x=>x.completion)),rpes=window.map(x=>x.avgRpe).filter(Number.isFinite),avgRpe=rpes.length?avg(rpes):NaN;
    const firstE=window[0]?.e1rm||last.e1rm,eTrend=firstE?((last.e1rm-firstE)/firstE*100):0,gap=dateDiffDays(last.date,day.date);
    const currentW=wellnessData(logFor(day.date)),ready=readinessScore(currentW),currentAch=num(currentW.achilles),recentAch=Math.max(...window.map(x=>x.achillesAfter).filter(Number.isFinite),0);
    const lower=isLowerStrengthExercise(e),deload=/descarga|deload|transici[oó]n/i.test((day.objective||'')+' '+(day.details||'')),poorReady=ready!==null&&ready<55,painHold=lower&&(currentAch>3||recentAch>3),hard=avgCompletion<.88||(Number.isFinite(avgRpe)&&avgRpe>=9.2),strong=window.length>=3&&avgCompletion>=.97&&(!Number.isFinite(avgRpe)||avgRpe<=8.2)&&eTrend>=-1;
    let weight=Number.isFinite(baseW)?Math.max(baseW,last.weight):last.weight,reps=baseReps,sets=baseSets,delta=0,reasons=[];
    if(deload){weight=Math.min(weight,last.weight);sets=Math.max(2,Math.ceil(baseSets*.75));targetRir=Math.max(targetRir,3);reasons.push('Semana de descarga: se reduce volumen y se conserva margen.');}
    else if(painHold){weight=Math.max(0,last.weight-step);targetRir=Math.max(targetRir,3);reasons.push('Aquiles >3/10 en un registro reciente: no se progresa la carga de pierna.');}
    else if(poorReady&&prefs().wellnessAdjustment!==false){weight=Math.min(weight,last.weight);targetRir=Math.max(targetRir,3);reasons.push('Bienestar previo bajo: se mantiene la carga y aumenta el margen.');}
    else if(gap>16){weight=Math.min(weight,last.weight);targetRir=Math.max(targetRir,3);reasons.push(`Han pasado ${gap} días desde este ejercicio: retorno conservador.`);}
    else if(hard){weight=Math.max(0,last.weight-step);reasons.push('Las últimas sesiones muestran RPE alto o repeticiones incompletas.');}
    else if(strong){weight=Math.max(weight,last.weight+step);reasons.push(`Últimas ${window.length} sesiones completas con margen y e1RM ${eTrend>=0?'+':''}${eTrend.toFixed(1)}%.`);}
    else if(avgCompletion>=.95&&(!Number.isFinite(avgRpe)||avgRpe<=8.5)){weight=Math.max(weight,last.weight);reps=Math.min(baseReps+1,baseReps+2);reasons.push('Buen cumplimiento: primero se consolida volumen antes de subir carga.');}
    else{weight=Math.max(weight,last.weight);reasons.push('Historial estable: mantener y reevaluar tras esta sesión.');}
    weight=roundStep(weight,e.weightMode==='perHand'?Math.min(step,1):Math.min(step,2.5));delta=Number.isFinite(last.weight)?roundStep(weight-last.weight,.5):0;
    if(ready!==null)reasons.push(`Preparación previa ${readinessLabel(ready).toLowerCase()} (${ready}/100).`);
    return{weight,sets,reps,rir:targetRir,delta,reason:reasons,confidence:window.length>=5?'Alta':window.length>=3?'Media':'Baja',metrics:{avgCompletion,avgRpe,eTrend,gap,ready}};
  }
  function weightLabel(e,w){
    if(e.weightMode==='bodyweight')return'Peso corporal';
    if(!Number.isFinite(num(w)))return e.recommendedWeight?`${e.recommendedWeight} kg`:'Sin carga';
    return e.weightMode==='perHand'?`${num(w)} kg por mancuerna`:`${num(w)} kg`;
  }

  function setView(v){view=v;document.querySelectorAll('.navBtn').forEach(b=>b.classList.toggle('active',b.dataset.view===v));render();scrollTo(0,0);}
  function render(){if(view==='today')renderDay();else if(view==='calendar')renderCalendar();else if(view==='stats')renderStats();else if(view==='motivation')renderMotivation();else if(view==='backup')renderBackup();else if(view==='editor')renderEditor(selectedDate,false);}

  function renderDay(){
    if(!PLAN.length){main.innerHTML=`<div class="empty card"><h3>Este perfil no tiene plan todavía</h3><p>Importa un entrenamiento o crea el primero.</p><button class="primaryBtn" id="emptyNew">＋ Crear entrenamiento</button></div>`;document.getElementById('emptyNew').onclick=()=>renderEditor(isoLocal(),true);return;}
    const day=byDate[selectedDate]||PLAN[0],idx=PLAN.findIndex(x=>x.date===day.date),prev=PLAN[idx-1]?.date,next=PLAN[idx+1]?.date,log=logFor(day.date),w=wellnessData(log),ready=readinessScore(w);
    const sections=[];day.exercises.forEach((e,i)=>{const sn=e.section||'Entrenamiento';let g=sections.find(x=>x.name===sn);if(!g){g={name:sn,items:[]};sections.push(g);}g.items.push({e,i});});
    const exHtml=sections.map(g=>`<div class="sectionHead"><h3>${esc(g.name)}</h3></div>${g.items.map(({e,i})=>exerciseCard(day,e,i,log)).join('')}`).join('');
    main.innerHTML=`${weekDashboardHtml(day.date)}
      <div class="dateNav"><button id="prevDay" ${!prev?'disabled':''}>‹</button><div class="dateTitle"><strong>${esc(fmtDate(day.date))}</strong><small>${esc(day.phase)}</small></div><button id="nextDay" ${!next?'disabled':''}>›</button></div>
      <div class="profileBanner">👤 Registrando solo para: <strong>${esc(currentUser().name)}</strong><span>Los datos de otros perfiles no se usan aquí.</span></div>
      <section class="hero"><div class="heroTop"><div><span class="pill ${typeClass(day.type)}">${esc(day.type)}</span><h2>${esc(day.objective)}</h2><p>${esc((day.details||'').split('\n')[0])}</p></div><button id="editDayBtn" class="editBtn">✏️ Editar</button></div><div class="meta"><span>⏱ ${esc(day.duration)}</span><span>🎯 ${esc(day.intensity)}</span></div>${day.route?`<div class="routeBox">🚴 <strong>Ruta:</strong> ${esc(day.route)}</div>`:''}</section>
      ${day.dailyNote?`<div class="dailyNote"><div class="dailyNoteIcon">✦</div><div><strong>Nota del día</strong><p>${esc(day.dailyNote)}</p></div></div>`:''}
      <div class="wellnessCard card"><div class="wellnessHead"><div><h3>Cómo llegas hoy</h3><p class="muted">Contextualiza la recomendación; no es un diagnóstico.</p></div><div class="readiness ${ready!==null&&ready<55?'low':ready!==null&&ready<75?'mid':'good'}"><strong>${ready===null?'—':ready}</strong><small>${readinessLabel(ready)}</small></div></div><div class="wellnessGrid">${[['sleep','Sueño','0 malo · 10 excelente'],['fatigue','Fatiga','0 baja · 10 alta'],['motivation','Ganas','0 bajas · 10 altas'],['soreness','Dolor muscular','0 nada · 10 mucho'],['achilles','Aquiles','0 nada · 10 mucho']].map(([k,t,p])=>`<div class="field"><label>${t}</label><input class="wellnessInput" data-wellness="${k}" inputmode="decimal" min="0" max="10" value="${esc(w[k]||'')}" placeholder="0-10"><small>${p}</small></div>`).join('')}</div><div class="wellnessAdvice">${esc(wellnessSuggestion(log))}</div></div>
      <div class="statusRow"><button class="statusBtn ${log.status==='done'?'sel done':''}" data-status="done">✅ Hecho</button><button class="statusBtn ${log.status==='partial'?'sel partial':''}" data-status="partial">🟡 Parcial</button><button class="statusBtn ${log.status==='skipped'?'sel skipped':''}" data-status="skipped">⏭ No hecho</button></div>
      <div class="card miniActions"><button id="moveDayBtn" class="dataBtn">↔ Mover / intercambiar</button><button id="templateDayBtn" class="dataBtn">▣ Guardar como plantilla</button></div>
      ${exHtml||'<div class="empty card">Sin ejercicios estructurados.</div>'}
      <div class="sessionBox"><h3>Registro de la sesión</h3><div class="sessionGrid"><div class="field"><label>Duración real (min)</label><input data-session="actualMinutes" inputmode="decimal" value="${esc(log.actualMinutes||'')}"></div><div class="field"><label>RPE sesión</label><input data-session="sessionRpe" inputmode="decimal" value="${esc(log.sessionRpe||'')}" placeholder="0-10"></div><div class="field"><label>Aquiles antes</label><input data-session="achillesBefore" inputmode="decimal" value="${esc(log.achillesBefore||'')}" placeholder="0-10"></div><div class="field"><label>Aquiles después</label><input data-session="achillesAfter" inputmode="decimal" value="${esc(log.achillesAfter||'')}" placeholder="0-10"></div></div><div class="field noteArea"><label>Notas</label><textarea data-session="notes" placeholder="Sensaciones, cambios, molestias...">${esc(log.notes||'')}</textarea></div></div>
      <div class="achillesAlert">🦶 <strong>Aquiles:</strong> ${esc(day.achilles)}</div>`;
    document.getElementById('prevDay')?.addEventListener('click',()=>{selectedDate=prev;renderDay();scrollTo(0,0);});document.getElementById('nextDay')?.addEventListener('click',()=>{selectedDate=next;renderDay();scrollTo(0,0);});document.getElementById('editDayBtn').onclick=()=>{view='editor';renderEditor(day.date,false);};document.getElementById('moveDayBtn').onclick=()=>moveOrSwapDay(day.date);document.getElementById('templateDayBtn').onclick=()=>saveTemplateFromDate(day.date);
    main.querySelectorAll('[data-status]').forEach(b=>b.onclick=()=>{log.status=b.dataset.status;save();renderDay();});main.querySelectorAll('[data-session]').forEach(el=>el.oninput=()=>{log[el.dataset.session]=el.value;save();});main.querySelectorAll('[data-wellness]').forEach(el=>el.oninput=()=>{w[el.dataset.wellness]=el.value;save();const score=readinessScore(w),box=main.querySelector('.readiness'),adv=main.querySelector('.wellnessAdvice');if(box){box.className='readiness '+(score!==null&&score<55?'low':score!==null&&score<75?'mid':'good');box.innerHTML=`<strong>${score===null?'—':score}</strong><small>${readinessLabel(score)}</small>`;}if(adv)adv.textContent=wellnessSuggestion(log);});main.querySelectorAll('.exercise').forEach(card=>bindExerciseCard(card,day,log));
  }
  function exerciseCard(day,e,i,log){
    const x=exerciseLog(log,e,i),done=x.done?'checked':'',kind=e.kind;
    const rest=`<div class="restLine"><span>⏱ Descanso series: <b>${e.restSetSec||'—'} s</b></span><span>➡️ Antes del siguiente ejercicio: <b>${e.restExerciseSec||'—'} s</b></span></div>`;
    let body='';
    if(kind==='strength') body=strengthCardBody(day,e,x);
    else if(kind==='intervals') body=intervalCardBody(e,x);
    else if(kind==='bike') body=bikeCardBody(e,x);
    else if(kind==='swim') body=swimCardBody(e,x);
    else if(kind==='cardio') body=cardioCardBody(e,x);
    else if(kind==='time'||kind==='session') body=sessionCardBody(e,x);
    else body=repsCardBody(e,x);
    return `<div class="exercise ${sectionClass(e.section)}" data-ex="${esc(e.id)}" data-index="${i}"><div class="exTop"><input class="check exDone" type="checkbox" ${done}><div><div class="exName">${esc(e.name)}</div>${e.planned?`<div class="planned">${esc(e.planned)}</div>`:''}</div></div>${body}${kind==='strength'||kind==='reps'?rest:''}<div class="field noteArea"><label>Nota del ejercicio</label><input class="exNote" value="${esc(x.note||'')}" placeholder="Sensaciones / técnica"></div></div>`;
  }
  function strengthCardBody(day,e,x){
    const rec=recommendStrength(day,e),sets=Number(rec.sets)||Number(e.sets)||3,reps=Number(rec.reps)||Number(e.reps)||'—';let sd=extractOldStrength(x,e);while(sd.length<sets)sd.push({weight:'',reps:'',rpe:''});x.setsData=sd;const delta=Number(rec.delta)||0,deltaText=delta?`${delta>0?'+':''}${delta} kg vs última`:'= última carga';
    return `<div class="recommendHero"><div><small>RECOMENDACIÓN ADAPTATIVA</small><strong>${esc(weightLabel(e,rec.weight))} · ${sets}×${reps} · RIR ${rec.rir}</strong><span>${esc(deltaText)}</span></div><span class="confidenceTag">${esc(rec.confidence)}</span></div><div class="autoRec"><b>Por qué:</b> ${rec.reason.map(esc).join(' ')}</div>
      <div class="restTimerRow"><div><span>Descanso entre series</span><strong>${e.restSetSec||'—'} s</strong></div><button class="primaryBtn small restTimerBtn" data-seconds="${e.restSetSec||90}">▶ Iniciar descanso</button></div>
      <div class="setTable"><div class="setRow"><div class="rowNum tableHead">#</div><div class="tableHead">Peso kg</div><div class="tableHead">Reps</div><div class="tableHead">RPE</div></div>${sd.slice(0,Math.max(sets,sd.length)).map((st,j)=>`<div class="setRow" data-set="${j}"><div class="rowNum">${j+1}</div><input class="setWeight" inputmode="decimal" value="${esc(st.weight??'')}" placeholder="${Number.isFinite(num(rec.weight))?rec.weight:''}"><input class="setReps" inputmode="numeric" value="${esc(st.reps??'')}" placeholder="${reps}"><input class="setRpe" inputmode="decimal" value="${esc(st.rpe??'')}" placeholder="0-10"></div>`).join('')}</div>
      <div class="strengthActions"><button class="lastBtn copyLast">↺ Copiar último registro</button><button class="lastBtn exerciseProfileBtn">📈 Ver progresión</button></div>`;
  }
  function repsCardBody(e,x){
    const sets=Number(e.sets)||'',reps=Number(e.reps)||'';
    return `<div class="prescription"><div class="prescBox"><span>Previsto</span><strong>${sets&&reps?`${sets} × ${reps}`:esc(e.planned||'Según pauta')}</strong></div><div class="prescBox"><span>Registro</span><strong>Reps / tiempo</strong></div></div><div class="inputs"><div class="field"><label>Series hechas</label><input class="exSets" inputmode="numeric" value="${esc(x.sets||'')}" placeholder="${sets}"></div><div class="field"><label>Reps reales</label><input class="exReps" value="${esc(x.reps||'')}" placeholder="${reps||'10/10/9'}"></div><div class="field"><label>Tiempo / dato</label><input class="exValue" value="${esc(x.value||'')}" placeholder="opcional"></div></div>`;
  }
  function intervalCardBody(e,x){
    const count=Number(e.intervalCount)||3;x.intervals=Array.isArray(x.intervals)?x.intervals:[];while(x.intervals.length<count)x.intervals.push({work:'',recovery:'',rpe:''});const mode=e.cardioMode||'interval_time',workLabel=mode==='interval_distance'?'Distancia / tiempo real':'Trabajo real';
    return `<div class="prescription"><div class="prescBox"><span>Formato</span><strong>${mode==='interval_distance'?'Intervalos por distancia':'Intervalos por tiempo'}</strong></div><div class="prescBox"><span>Plan</span><strong>${count} × ${esc(e.intervalWork||'trabajo')} · rec ${esc(e.intervalRecovery||'—')}</strong></div></div><button class="primaryBtn intervalTimerBtn" style="margin-top:9px">▶ Temporizador automático</button>
      <div class="intervalTable"><div class="intervalRow"><div class="rowNum tableHead">#</div><div class="tableHead">${workLabel}</div><div class="tableHead">Recuperación</div><div class="tableHead">RPE</div></div>${x.intervals.slice(0,count).map((st,j)=>`<div class="intervalRow" data-int="${j}"><div class="rowNum">${j+1}</div><input class="intWork" value="${esc(st.work||'')}" placeholder="${esc(e.intervalWork||'')}"><input class="intRecovery" value="${esc(st.recovery||'')}" placeholder="${esc(e.intervalRecovery||'')}"><input class="intRpe" inputmode="decimal" value="${esc(st.rpe||'')}" placeholder="${esc(e.intervalTarget||'0-10')}"></div>`).join('')}</div>`;
  }
  function embeddedIntervals(e,x){return e.intervalCount?`<div class="sectionHead" style="margin-top:12px"><h3>Registro por intervalos</h3></div>${intervalCardBody(e,x)}`:'';}
  function bikeCardBody(e,x){
    const sp=(num(x.distance)>0&&num(x.minutes)>0)?(num(x.distance)/(num(x.minutes)/60)).toFixed(1):'';return `<div class="prescription"><div class="prescBox"><span>Formato</span><strong>${e.cardioMode==='recovery'?'Recuperación':e.cardioMode?.startsWith('interval')?'Intervalos':'Continuo'}</strong></div><div class="prescBox"><span>Objetivo</span><strong>${esc(e.distanceTarget?e.distanceTarget+' km':e.planned||'Ruta prevista')}</strong></div></div><div class="inputs"><div class="field"><label>Km reales</label><input class="bikeDistance" inputmode="decimal" value="${esc(x.distance||'')}"></div><div class="field"><label>Minutos</label><input class="bikeMinutes" inputmode="decimal" value="${esc(x.minutes||'')}"></div><div class="field"><label>RPE</label><input class="bikeRpe" inputmode="decimal" value="${esc(x.rpe||'')}"></div><div class="field"><label>Desnivel + m</label><input class="bikeElevation" inputmode="decimal" value="${esc(x.elevation||'')}"></div></div><div class="metricResult">Velocidad media: <strong class="bikeSpeed">${sp?sp+' km/h':'—'}</strong></div>${embeddedIntervals(e,x)}`;
  }
  function swimCardBody(e,x){
    const pace=(num(x.meters)>0&&num(x.minutes)>0)?((num(x.minutes)*60)/(num(x.meters)/100)):NaN,pm=Number.isFinite(pace)?`${Math.floor(pace/60)}:${String(Math.round(pace%60)).padStart(2,'0')} /100 m`:'—';return `<div class="prescription"><div class="prescBox"><span>Formato</span><strong>${e.cardioMode==='recovery'?'Recuperación':e.cardioMode?.startsWith('interval')?'Bloques / intervalos':'Continuo'}</strong></div><div class="prescBox"><span>Objetivo</span><strong>${esc(e.swimMeters?e.swimMeters+' m':e.planned||'Nado previsto')}</strong></div></div><div class="inputs"><div class="field"><label>Metros totales</label><input class="swimMeters" inputmode="decimal" value="${esc(x.meters||'')}"></div><div class="field"><label>Minutos</label><input class="swimMinutes" inputmode="decimal" value="${esc(x.minutes||'')}"></div><div class="field"><label>RPE</label><input class="swimRpe" inputmode="decimal" value="${esc(x.rpe||'')}"></div><div class="field"><label>Estilo</label><input class="swimStroke" value="${esc(x.stroke||e.swimStroke||'')}" placeholder="crawl / espalda / mixto"></div><div class="field wide"><label>Bloques</label><input class="swimBlocks" value="${esc(x.blocks||e.swimBlocks||'')}" placeholder="ej. 4×200 + 4×50"></div></div><div class="metricResult">Ritmo medio calculado: <strong class="swimPace">${pm}</strong></div>${embeddedIntervals(e,x)}`;
  }
  function cardioCardBody(e,x){return `<div class="prescription"><div class="prescBox"><span>Formato</span><strong>${e.cardioMode==='recovery'?'Recuperación':e.cardioMode==='interval_distance'?'Intervalos por distancia':e.cardioMode==='interval_time'?'Intervalos por tiempo':'Continuo'}</strong></div><div class="prescBox"><span>RPE objetivo</span><strong>${esc(e.rpeTarget||'—')}</strong></div></div><div class="inputs"><div class="field"><label>Minutos</label><input class="cardioMinutes" inputmode="decimal" value="${esc(x.minutes||'')}"></div><div class="field"><label>Distancia</label><input class="cardioDistance" inputmode="decimal" value="${esc(x.distance||'')}"></div><div class="field"><label>RPE</label><input class="cardioRpe" inputmode="decimal" value="${esc(x.rpe||'')}"></div></div>${embeddedIntervals(e,x)}`;}
  function sessionCardBody(e,x){return `<div class="inputs"><div class="field"><label>Tiempo real</label><input class="sessionValue" value="${esc(x.value||'')}" placeholder="min / duración"></div><div class="field"><label>RPE</label><input class="sessionRpeEx" inputmode="decimal" value="${esc(x.rpe||'')}" placeholder="0-10"></div></div>`;}

  function bindExerciseCard(card,day,log){
    const i=Number(card.dataset.index),e=day.exercises[i],x=exerciseLog(log,e,i);card.querySelector('.exDone').onchange=ev=>{x.done=ev.target.checked;save();};card.querySelector('.exNote').oninput=ev=>{x.note=ev.target.value;save();};
    card.querySelectorAll('.setRow[data-set]').forEach(row=>{const j=Number(row.dataset.set);x.setsData=x.setsData||[];while(x.setsData.length<=j)x.setsData.push({});[['.setWeight','weight'],['.setReps','reps'],['.setRpe','rpe']].forEach(([sel,key])=>row.querySelector(sel).oninput=ev=>{x.setsData[j][key]=ev.target.value;save();});});
    card.querySelectorAll('.intervalRow[data-int]').forEach(row=>{const j=Number(row.dataset.int);x.intervals=x.intervals||[];while(x.intervals.length<=j)x.intervals.push({});[['.intWork','work'],['.intRecovery','recovery'],['.intRpe','rpe']].forEach(([sel,key])=>row.querySelector(sel).oninput=ev=>{x.intervals[j][key]=ev.target.value;save();});});
    const bind=(sel,key)=>{const el=card.querySelector(sel);if(el)el.oninput=()=>{x[key]=el.value;save();const speed=card.querySelector('.bikeSpeed');if(speed&&num(x.distance)>0&&num(x.minutes)>0)speed.textContent=(num(x.distance)/(num(x.minutes)/60)).toFixed(1)+' km/h';const pace=card.querySelector('.swimPace');if(pace&&num(x.meters)>0&&num(x.minutes)>0){const sec=num(x.minutes)*60/(num(x.meters)/100);pace.textContent=`${Math.floor(sec/60)}:${String(Math.round(sec%60)).padStart(2,'0')} /100 m`;}};};
    [['.exSets','sets'],['.exReps','reps'],['.exValue','value'],['.bikeDistance','distance'],['.bikeMinutes','minutes'],['.bikeRpe','rpe'],['.bikeElevation','elevation'],['.swimMeters','meters'],['.swimMinutes','minutes'],['.swimRpe','rpe'],['.swimStroke','stroke'],['.swimBlocks','blocks'],['.cardioMinutes','minutes'],['.cardioDistance','distance'],['.cardioRpe','rpe'],['.sessionValue','value'],['.sessionRpeEx','rpe']].forEach(([sel,key])=>bind(sel,key));
    card.querySelector('.copyLast')?.addEventListener('click',()=>{const h=findLastExerciseLog(day.date,e.canonicalName||e.name);if(!h){toastMsg('No hay un registro anterior');return;}Object.assign(x,clone(h));save();renderDay();toastMsg('Último registro copiado');});
    card.querySelector('.restTimerBtn')?.addEventListener('click',ev=>startTimer(Number(ev.currentTarget.dataset.seconds)||90,`Descanso · ${e.name}`,{phaseText:`Siguiente: ${e.restExerciseSec||90} s antes de cambiar de ejercicio`}));
    card.querySelector('.intervalTimerBtn')?.addEventListener('click',()=>startIntervalSequence(e));
    card.querySelector('.exerciseProfileBtn')?.addEventListener('click',()=>{statsExercise=e.canonicalName||e.name;setView('stats');});
  }
  function findLastExerciseLog(date,name){
    for(const d of PLAN.filter(d=>d.date<date).reverse()){const l=logs()[d.date];if(!l)continue;for(let i=0;i<d.exercises.length;i++){const e=d.exercises[i];if(canonicalExerciseName(e.canonicalName||e.name)===canonicalExerciseName(name)){const x=l.exercises?.[e.id]||l.exercises?.[i];if(x)return x;}}}return null;
  }

  function moveOrSwapDay(fromDate){const target=prompt('Fecha de destino (AAAA-MM-DD):',fromDate);if(!target||target===fromDate)return;performMove(fromDate,target);rebuildPlan();render();}
  function renderCalendar(){
    if(!weekAnchor)weekAnchor=mondayISO(selectedDate||isoLocal());const dates=weekDates(weekAnchor),filters=[['all','Todo'],['pending','Pendiente'],['done','Hecho'],['gym','Gym'],['futsal','Futsal'],['recovery','Cardio']],list=PLAN.filter(d=>{const st=logs()[d.date]?.status||'';if(calendarFilter==='pending')return st!=='done';if(calendarFilter==='done')return st==='done';if(calendarFilter==='gym')return d.type.startsWith('Gimnasio');if(calendarFilter==='futsal')return d.type==='Fútbol sala';if(calendarFilter==='recovery')return ['Bicicleta','Natación'].includes(d.type);return true;}),u=activeData();
    const weekCols=dates.map(date=>{const d=byDate[date],st=logs()[date]?.status||'',selected=plannerSelectedDate===date;return `<div class="weekCol ${selected?'selected':''}" data-drop-date="${date}"><div class="weekColHead">${esc(formatShortDay(date))}</div>${d?`<div class="dragSession ${typeClass(d.type)}" draggable="true" data-drag-date="${date}"><span>${esc(d.type)}</span><strong>${esc(d.objective)}</strong><small>${esc(d.duration)}</small><div><button class="tinyBtn openWeekDay" data-date="${date}">Abrir</button><button class="tinyBtn selectMove" data-date="${date}">${selected?'Cancelar':'Mover'}</button></div></div>`:'<div class="emptyDrop">Soltar aquí</div>'}${plannerSelectedDate&&plannerSelectedDate!==date?`<button class="dropHere" data-target="${date}">Mover aquí</button>`:''}<span class="statusDot ${st}"></span></div>`;}).join('');
    main.innerHTML=`<div class="card planHeader"><div><h2>Plan semanal · ${esc(currentUser().name)}</h2><p class="muted">Arrastra una sesión a otro día. En iPhone también puedes tocar “Mover” y después “Mover aquí”.</p></div><button id="newDayBtn" class="primaryBtn">＋ Nuevo</button></div>${weekDashboardHtml(weekAnchor)}<div class="weekNav"><button id="prevWeek">‹</button><strong>${esc(fmtDate(dates[0],false))} — ${esc(fmtDate(dates[6],false))}</strong><button id="nextWeek">›</button></div><div class="weekPlanner">${weekCols}</div>
      <div class="card"><div class="planHeader"><div><h3>Calendario de competición</h3><p class="muted">Al añadir o mover un partido, la app ajusta de forma conservadora la carga previa sin tocar el historial realizado.</p></div><button id="addCompetition" class="primaryBtn small">＋ Partido</button></div>${u.competitions.length?u.competitions.slice().sort((a,b)=>a.date.localeCompare(b.date)).map(c=>`<div class="competitionRow"><div><strong>⚽ ${esc(fmtDate(c.date,false))} · ${esc(c.time||'hora pendiente')}</strong><small>${esc(c.opponent||'Rival sin indicar')} ${c.location?'· '+esc(c.location):''}</small></div><div><button class="tinyBtn editCompetition" data-id="${c.id}">Editar</button> <button class="tinyBtn danger deleteCompetition" data-id="${c.id}">Borrar</button></div></div>`).join(''):'<p class="muted">Todavía no hay partidos añadidos al calendario de competición.</p>'}</div>
      <div class="card"><div class="planHeader"><div><h3>Plantillas</h3><p class="muted">Reutiliza sesiones completas sin volver a escribirlas.</p></div><button id="saveSelectedTemplate" class="secondaryBtn small">Guardar día actual</button></div>${u.templates.length?u.templates.map(t=>`<div class="templateRow"><div><strong>${esc(t.name)}</strong><small>${esc(t.day.type||'')} · ${t.day.exercises?.length||0} ejercicios</small></div><div><button class="tinyBtn applyTemplate" data-id="${t.id}">Aplicar</button> <button class="tinyBtn danger deleteTemplate" data-id="${t.id}">Borrar</button></div></div>`).join(''):'<p class="muted">No hay plantillas todavía.</p>'}</div>
      <div class="filterRow">${filters.map(([k,t])=>`<button class="filterBtn ${calendarFilter===k?'active':''}" data-filter="${k}">${t}</button>`).join('')}</div><div class="dayList">${list.map(dayListCard).join('')}</div>`;
    document.getElementById('newDayBtn').onclick=()=>renderEditor(nextSuggestedDate(),true);document.getElementById('prevWeek').onclick=()=>{weekAnchor=addDaysISO(weekAnchor,-7);renderCalendar();};document.getElementById('nextWeek').onclick=()=>{weekAnchor=addDaysISO(weekAnchor,7);renderCalendar();};document.getElementById('addCompetition').onclick=addCompetition;document.getElementById('saveSelectedTemplate').onclick=()=>saveTemplateFromDate(selectedDate||pickInitialDate());main.querySelectorAll('.editCompetition').forEach(b=>b.onclick=()=>editCompetition(b.dataset.id));main.querySelectorAll('.deleteCompetition').forEach(b=>b.onclick=()=>deleteCompetition(b.dataset.id));main.querySelectorAll('.applyTemplate').forEach(b=>b.onclick=()=>applyTemplate(b.dataset.id));main.querySelectorAll('.deleteTemplate').forEach(b=>b.onclick=()=>deleteTemplate(b.dataset.id));
    main.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{calendarFilter=b.dataset.filter;renderCalendar();});main.querySelectorAll('.dayCard').forEach(c=>{c.querySelector('.dayMain').onclick=()=>{selectedDate=c.dataset.date;setView('today');};c.querySelector('.swapQuick').onclick=ev=>{ev.stopPropagation();moveOrSwapDay(c.dataset.date);renderCalendar();};});main.querySelectorAll('.openWeekDay').forEach(b=>b.onclick=ev=>{ev.stopPropagation();selectedDate=b.dataset.date;setView('today');});main.querySelectorAll('.selectMove').forEach(b=>b.onclick=ev=>{ev.stopPropagation();plannerSelectedDate=plannerSelectedDate===b.dataset.date?'':b.dataset.date;renderCalendar();});main.querySelectorAll('.dropHere').forEach(b=>b.onclick=ev=>{ev.stopPropagation();performMove(plannerSelectedDate,b.dataset.target);rebuildPlan();renderCalendar();});
    let dragged='';main.querySelectorAll('[draggable="true"]').forEach(el=>{el.addEventListener('dragstart',ev=>{dragged=el.dataset.dragDate;ev.dataTransfer.effectAllowed='move';ev.dataTransfer.setData('text/plain',dragged);});});main.querySelectorAll('[data-drop-date]').forEach(col=>{col.addEventListener('dragover',ev=>{ev.preventDefault();col.classList.add('dragOver');});col.addEventListener('dragleave',()=>col.classList.remove('dragOver'));col.addEventListener('drop',ev=>{ev.preventDefault();col.classList.remove('dragOver');const from=ev.dataTransfer.getData('text/plain')||dragged,target=col.dataset.dropDate;if(from&&target){performMove(from,target);rebuildPlan();renderCalendar();}});});
  }
  function dayListCard(d){const dt=new Date(d.date+'T12:00:00'),st=logs()[d.date]?.status||'';return `<div class="dayCard" data-date="${d.date}"><div class="dayNum"><strong>${dt.getDate()}</strong><small>${new Intl.DateTimeFormat('es-ES',{month:'short'}).format(dt)}</small></div><div class="dayInfo dayMain"><strong>${esc(d.type)} · ${esc(d.objective)}</strong><small>${esc(d.duration)} · ${esc(d.intensity)}</small></div><div class="dayActions"><span class="statusDot ${st}"></span><button class="tinyBtn swapQuick" title="Mover/intercambiar">↔</button></div></div>`;}

  function renderEditor(date,isNew){
    view='editor'; const src=!isNew&&byDate[date]?JSON.parse(JSON.stringify(byDate[date])):normalizeDay({date,phase:'Plan personalizado',type:'Gimnasio - Fuerza',objective:'Nuevo entrenamiento',exercises:[]}); selectedDate=src.date;
    let exercises=(src.exercises||[]).map((e,i)=>normalizeExercise(e,i));
    main.innerHTML=`<div class="editorHead"><button id="cancelEdit" class="secondaryBtn">← Volver</button><h2>${isNew?'Nuevo entrenamiento':'Editar entrenamiento'}</h2></div><div class="card"><div class="editorGrid"><div class="field"><label>Fecha</label><input id="edDate" type="date" value="${esc(src.date)}"></div><div class="field"><label>Fase</label><input id="edPhase" value="${esc(src.phase)}"></div><div class="field"><label>Tipo</label><select id="edType">${['Gimnasio - Fuerza','Gimnasio - Superior','Gimnasio - Unilateral','Gimnasio - Pliometría','Fútbol sala','Bicicleta','Natación','Descanso','Otro'].map(x=>`<option ${src.type===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Duración</label><input id="edDuration" value="${esc(src.duration)}"></div><div class="field wide"><label>Objetivo</label><input id="edObjective" value="${esc(src.objective)}"></div><div class="field"><label>Intensidad</label><input id="edIntensity" value="${esc(src.intensity)}"></div><div class="field wide"><label>Ruta / ubicación</label><input id="edRoute" value="${esc(src.route)}"></div><div class="field wide"><label>Descripción</label><textarea id="edDetails">${esc(src.details)}</textarea></div><div class="field wide"><label>Nota diaria</label><textarea id="edDailyNote">${esc(src.dailyNote)}</textarea></div><div class="field wide"><label>Nota Aquiles</label><textarea id="edAchilles">${esc(src.achilles)}</textarea></div></div></div><div class="sectionHead"><h3>Ejercicios</h3><div><button id="addLibraryExerciseBtn" class="secondaryBtn small">＋ Biblioteca</button> <button id="addExerciseBtn" class="primaryBtn small">＋ Ejercicio</button></div></div><div id="exerciseEditor"></div><div class="editorActions"><button id="saveEdit" class="primaryBtn">💾 Guardar</button><button id="duplicateEdit" class="secondaryBtn">⧉ Duplicar</button>${!isNew?'<button id="moveEdit" class="secondaryBtn">↔ Mover/intercambiar</button><button id="restoreEdit" class="secondaryBtn">↺ Restaurar original</button><button id="deleteEdit" class="dangerBtn">🗑 Eliminar día</button>':''}</div>`;
    const editor=document.getElementById('exerciseEditor');
    function exFields(e,i){
      const common=`<div class="editorGrid compact"><div class="field wide"><label>Nombre</label><input data-key="name" value="${esc(e.name)}"></div><div class="field"><label>Sección</label><input data-key="section" value="${esc(e.section)}"></div><div class="field"><label>Tipo de registro</label><select data-key="kind">${[['strength','Fuerza / peso'],['reps','Repeticiones / técnica'],['intervals','Intervalos'],['bike','Bicicleta'],['swim','Natación'],['cardio','Cardio general'],['time','Tiempo'],['session','Sesión deportiva']].map(([v,t])=>`<option value="${v}" ${e.kind===v?'selected':''}>${t}</option>`).join('')}</select></div><div class="field wide"><label>Aclaración del ejercicio</label><input data-key="planned" value="${esc(e.planned)}"></div>`;
      if(e.kind==='strength')return common+`<div class="field"><label>Series</label><input data-key="sets" type="number" value="${esc(e.sets)}"></div><div class="field"><label>Reps recomendadas</label><input data-key="reps" type="number" value="${esc(e.reps)}"></div><div class="field"><label>Peso recomendado (kg)</label><input data-key="recommendedWeight" inputmode="decimal" value="${esc(e.recommendedWeight)}"></div><div class="field"><label>Formato carga</label><select data-key="weightMode"><option value="total" ${e.weightMode==='total'?'selected':''}>Peso total</option><option value="perHand" ${e.weightMode==='perHand'?'selected':''}>Por mancuerna</option><option value="bodyweight" ${e.weightMode==='bodyweight'?'selected':''}>Peso corporal</option></select></div><div class="field"><label>Paso de carga (kg)</label><input data-key="loadStep" inputmode="decimal" value="${esc(e.loadStep)}"></div><div class="field"><label>Descanso entre series (s)</label><input data-key="restSetSec" type="number" value="${esc(e.restSetSec)}"></div><div class="field"><label>Descanso al siguiente ejercicio (s)</label><input data-key="restExerciseSec" type="number" value="${esc(e.restExerciseSec)}"></div></div>`;
      if(e.kind==='intervals')return common+`<div class="field"><label>Formato</label><select data-key="cardioMode"><option value="interval_time" ${e.cardioMode==='interval_time'?'selected':''}>Por tiempo</option><option value="interval_distance" ${e.cardioMode==='interval_distance'?'selected':''}>Por distancia</option></select></div><div class="field"><label>Nº intervalos</label><input data-key="intervalCount" type="number" value="${esc(e.intervalCount)}"></div><div class="field"><label>Trabajo por intervalo</label><input data-key="intervalWork" value="${esc(e.intervalWork)}" placeholder="6 min / 400 m"></div><div class="field"><label>Recuperación</label><input data-key="intervalRecovery" value="${esc(e.intervalRecovery)}" placeholder="3 min"></div><div class="field"><label>Objetivo / RPE</label><input data-key="intervalTarget" value="${esc(e.intervalTarget)}"></div></div>`;
      if(e.kind==='bike')return common+`<div class="field"><label>Formato cardio</label><select data-key="cardioMode"><option value="continuous" ${e.cardioMode==='continuous'?'selected':''}>Continuo</option><option value="interval_time" ${e.cardioMode==='interval_time'?'selected':''}>Intervalos tiempo</option><option value="interval_distance" ${e.cardioMode==='interval_distance'?'selected':''}>Intervalos distancia</option><option value="recovery" ${e.cardioMode==='recovery'?'selected':''}>Recuperación</option></select></div><div class="field"><label>Km objetivo</label><input data-key="distanceTarget" inputmode="decimal" value="${esc(e.distanceTarget)}"></div><div class="field"><label>Min objetivo</label><input data-key="durationTarget" inputmode="decimal" value="${esc(e.durationTarget)}"></div><div class="field"><label>RPE objetivo</label><input data-key="rpeTarget" value="${esc(e.rpeTarget)}"></div><div class="field"><label>Desnivel objetivo +m</label><input data-key="elevationTarget" inputmode="decimal" value="${esc(e.elevationTarget||'')}"></div><div class="field"><label>Nº intervalos (opcional)</label><input data-key="intervalCount" type="number" value="${esc(e.intervalCount)}"></div><div class="field"><label>Trabajo intervalo</label><input data-key="intervalWork" value="${esc(e.intervalWork)}"></div><div class="field"><label>Recuperación intervalo</label><input data-key="intervalRecovery" value="${esc(e.intervalRecovery)}"></div></div>`;
      if(e.kind==='swim')return common+`<div class="field"><label>Formato cardio</label><select data-key="cardioMode"><option value="continuous" ${e.cardioMode==='continuous'?'selected':''}>Continuo</option><option value="interval_time" ${e.cardioMode==='interval_time'?'selected':''}>Intervalos tiempo</option><option value="interval_distance" ${e.cardioMode==='interval_distance'?'selected':''}>Intervalos distancia</option><option value="recovery" ${e.cardioMode==='recovery'?'selected':''}>Recuperación</option></select></div><div class="field"><label>Metros objetivo</label><input data-key="swimMeters" inputmode="decimal" value="${esc(e.swimMeters)}"></div><div class="field"><label>Min objetivo</label><input data-key="durationTarget" inputmode="decimal" value="${esc(e.durationTarget)}"></div><div class="field"><label>RPE objetivo</label><input data-key="rpeTarget" value="${esc(e.rpeTarget)}"></div><div class="field"><label>Estilo objetivo</label><input data-key="swimStroke" value="${esc(e.swimStroke||'')}" placeholder="crawl / espalda / mixto"></div><div class="field wide"><label>Bloques objetivo</label><input data-key="swimBlocks" value="${esc(e.swimBlocks||'')}" placeholder="4×200 + 4×50"></div><div class="field"><label>Nº intervalos (opcional)</label><input data-key="intervalCount" type="number" value="${esc(e.intervalCount)}"></div><div class="field"><label>Trabajo intervalo</label><input data-key="intervalWork" value="${esc(e.intervalWork)}"></div><div class="field"><label>Recuperación intervalo</label><input data-key="intervalRecovery" value="${esc(e.intervalRecovery)}"></div></div>`;
      if(e.kind==='cardio')return common+`<div class="field"><label>Formato cardio</label><select data-key="cardioMode"><option value="continuous" ${e.cardioMode==='continuous'?'selected':''}>Continuo</option><option value="interval_time" ${e.cardioMode==='interval_time'?'selected':''}>Intervalos tiempo</option><option value="interval_distance" ${e.cardioMode==='interval_distance'?'selected':''}>Intervalos distancia</option><option value="recovery" ${e.cardioMode==='recovery'?'selected':''}>Recuperación</option></select></div><div class="field"><label>Min objetivo</label><input data-key="durationTarget" inputmode="decimal" value="${esc(e.durationTarget)}"></div><div class="field"><label>Distancia objetivo</label><input data-key="distanceTarget" value="${esc(e.distanceTarget)}"></div><div class="field"><label>RPE objetivo</label><input data-key="rpeTarget" value="${esc(e.rpeTarget)}"></div><div class="field"><label>Nº intervalos (opcional)</label><input data-key="intervalCount" type="number" value="${esc(e.intervalCount)}"></div><div class="field"><label>Trabajo intervalo</label><input data-key="intervalWork" value="${esc(e.intervalWork)}"></div><div class="field"><label>Recuperación intervalo</label><input data-key="intervalRecovery" value="${esc(e.intervalRecovery)}"></div></div>`;
      return common+`<div class="field"><label>Series</label><input data-key="sets" value="${esc(e.sets)}"></div><div class="field"><label>Reps</label><input data-key="reps" value="${esc(e.reps)}"></div><div class="field"><label>Descanso series (s)</label><input data-key="restSetSec" value="${esc(e.restSetSec)}"></div><div class="field"><label>Descanso ejercicio (s)</label><input data-key="restExerciseSec" value="${esc(e.restExerciseSec)}"></div></div>`;
    }
    function draw(){
      editor.innerHTML=exercises.length?exercises.map((e,i)=>`<div class="exercise editExercise" data-i="${i}"><div class="editorExTop"><strong>${i+1}. ${esc(e.name)}</strong><div class="reorderBtns"><button class="tinyBtn upEx" data-i="${i}" ${i===0?'disabled':''}>↑</button><button class="tinyBtn downEx" data-i="${i}" ${i===exercises.length-1?'disabled':''}>↓</button><button class="tinyBtn danger removeEx" data-i="${i}">Eliminar</button></div></div>${exFields(e,i)}</div>`).join(''):'<div class="empty card">Pulsa “+ Ejercicio”.</div>';
      editor.querySelectorAll('.editExercise').forEach(card=>{const i=Number(card.dataset.i);card.querySelectorAll('[data-key]').forEach(el=>{el.oninput=()=>{exercises[i][el.dataset.key]=el.value;if(el.dataset.key==='kind'){exercises[i]=normalizeExercise(exercises[i],i);draw();}};});});
      editor.querySelectorAll('.removeEx').forEach(b=>b.onclick=()=>{exercises.splice(Number(b.dataset.i),1);draw();});
      editor.querySelectorAll('.upEx').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.i);[exercises[i-1],exercises[i]]=[exercises[i],exercises[i-1]];draw();});
      editor.querySelectorAll('.downEx').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.i);[exercises[i+1],exercises[i]]=[exercises[i],exercises[i+1]];draw();});
    }
    draw();
    document.getElementById('addExerciseBtn').onclick=()=>{exercises.push(normalizeExercise({section:'Entrenamiento',name:'Nuevo ejercicio',kind:'strength',sets:3,reps:8,recommendedWeight:'',restSetSec:90,restExerciseSec:90},exercises.length));draw();};
    document.getElementById('addLibraryExerciseBtn')?.addEventListener('click',()=>{const entries=allLibraryEntries();const q=prompt('Escribe parte del nombre del ejercicio:','');if(q===null)return;const matches=entries.filter(x=>normName(x.name).includes(normName(q))).slice(0,12);if(!matches.length){if(confirm('No encontrado. ¿Crear ejercicio propio?'))saveCustomExercise();return;}const menu=matches.map((x,i)=>`${i+1}. ${x.name} · ${x.group}`).join('\n');const n=Number(prompt(`Selecciona número:\n${menu}`,'1'))-1;if(!matches[n])return;const m=matches[n];exercises.push(normalizeExercise({name:m.name,canonicalName:m.name,section:m.group,kind:m.type,restSetSec:m.restSetSec,restExerciseSec:m.restExerciseSec},exercises.length));draw();});
    document.getElementById('cancelEdit').onclick=()=>setView('calendar');
    document.getElementById('saveEdit').onclick=()=>{snapshotPlan(isNew?'Crear entrenamiento':'Editar '+src.date);saveEditedDay(src,exercises,isNew,false);};
    document.getElementById('duplicateEdit').onclick=()=>{snapshotPlan('Duplicar '+src.date);saveEditedDay(src,exercises,isNew,true);};
    document.getElementById('moveEdit')?.addEventListener('click',()=>moveOrSwapDay(src.date));
    document.getElementById('restoreEdit')?.addEventListener('click',()=>{if(confirm('¿Restaurar el entrenamiento base de esta fecha?')){snapshotPlan('Restaurar base '+src.date);delete customPlan()[src.date];save();rebuildPlan();selectedDate=src.date;setView('today');}});
    document.getElementById('deleteEdit')?.addEventListener('click',()=>{if(confirm('¿Eliminar este día del plan? Los registros históricos no se borrarán.')){snapshotPlan('Eliminar '+src.date);customPlan()[src.date]={__deleted:true,ownerId:currentUser().id};save();rebuildPlan();selectedDate=pickInitialDate();setView('calendar');}});
  }
  function collectEditorDay(exercises){return normalizeDay({date:document.getElementById('edDate').value,phase:document.getElementById('edPhase').value,type:document.getElementById('edType').value,objective:document.getElementById('edObjective').value,duration:document.getElementById('edDuration').value,intensity:document.getElementById('edIntensity').value,route:document.getElementById('edRoute').value,details:document.getElementById('edDetails').value,dailyNote:document.getElementById('edDailyNote').value,achilles:document.getElementById('edAchilles').value,exercises});}
  function saveEditedDay(oldDay,exercises,isNew,duplicate){
    let day=collectEditorDay(exercises);if(!day.date){alert('Indica una fecha.');return;}if(duplicate){const nd=prompt('Fecha para la copia:',nextSuggestedDate());if(!nd)return;day.date=nd;}
    const ownerId=currentUser().id;
    customPlan()[day.date]={...day,ownerId};
    if(!isNew&&!duplicate&&oldDay.date!==day.date)customPlan()[oldDay.date]={__deleted:true,ownerId};
    save();rebuildPlan();selectedDate=day.date;setView('today');toastMsg(duplicate?'Entrenamiento duplicado':'Entrenamiento guardado');
  }

  function completedActiveDays(){
    return PLAN.filter(d=>d.type!=='Descanso'&&d.date<=isoLocal()).map(d=>({date:d.date,done:logs()[d.date]?.status==='done'}));
  }
  function streaks(){
    const a=completedActiveDays();let cur=0,best=0,temp=0;
    for(const x of a){if(x.done){temp++;best=Math.max(best,temp);}else temp=0;}cur=temp;return{current:cur,best};
  }
  function totalCompleted(){return Object.values(logs()).filter(l=>l.status==='done').length;}
  function achievements(){
    const done=totalCompleted(),st=streaks(),strengthCount=countLoggedKind('strength'),cardioCount=countLoggedKinds(['bike','swim','cardio','intervals']);
    const defs=[
      ['first','🎯','Primer paso','Completa 1 entrenamiento',done>=1],
      ['five','🔥','En marcha','Completa 5 entrenamientos',done>=5],
      ['ten','🏅','Doble dígito','Completa 10 entrenamientos',done>=10],
      ['twentyfive','🏆','Constancia','Completa 25 entrenamientos',done>=25],
      ['streak3','⚡','Racha 3','3 entrenos previstos seguidos',st.best>=3],
      ['streak5','🚀','Racha 5','5 entrenos previstos seguidos',st.best>=5],
      ['strength10','🏋️','Fuerza registrada','10 ejercicios de fuerza con datos',strengthCount>=10],
      ['cardio10','🚴','Motor activo','10 registros de cardio',cardioCount>=10],
    ];
    return defs.map(([id,icon,title,desc,unlocked])=>({id,icon,title,desc,unlocked}));
  }
  function countLoggedKind(kind){return countLoggedKinds([kind]);}
  function countLoggedKinds(kinds){let n=0;PLAN.forEach(d=>{const l=logs()[d.date];if(!l)return;d.exercises.forEach((e,i)=>{if(kinds.includes(e.kind)){const x=l.exercises?.[e.id]||l.exercises?.[i];if(x&&Object.keys(x).length>0)n++;}});});return n;}

  function personalScores(){
    const strengthRatios=[];
    const names=[...new Set(PLAN.flatMap(d=>d.exercises.filter(e=>e.kind==='strength').map(e=>e.name)))];
    names.forEach(name=>{const h=strengthHistory(name,'9999-12-31');if(h.length>=2&&h[0].e1rm>0)strengthRatios.push(h[h.length-1].e1rm/h[0].e1rm);});
    const strengthRatio=strengthRatios.length?strengthRatios.reduce((a,b)=>a+b,0)/strengthRatios.length:1;
    const strength=clamp(Math.round(50+(strengthRatio-1)*100),0,100);
    const cardioWeekly=weeklyCardioMinutes(8),half=Math.floor(cardioWeekly.length/2),old=avg(cardioWeekly.slice(0,half).map(x=>x.value)),recent=avg(cardioWeekly.slice(half).map(x=>x.value));
    const resistance=clamp(Math.round(50+(old>0?(recent/old-1)*60:recent>0?15:0)),0,100);
    const recentActive=PLAN.filter(d=>d.type!=='Descanso'&&d.date<=isoLocal()).slice(-20),done=recentActive.filter(d=>logs()[d.date]?.status==='done').length;
    const consistency=recentActive.length?Math.round(done/recentActive.length*100):0;
    let fields=0,filled=0;Object.values(logs()).forEach(l=>{fields+=2;if(l.sessionRpe)filled++;if(l.actualMinutes)filled++;});const dataQuality=fields?Math.round(filled/fields*100):0;
    return{strength,resistance,consistency,dataQuality};
  }
  function avg(a){const v=a.filter(Number.isFinite);return v.length?v.reduce((x,y)=>x+y,0)/v.length:0;}
  function levelName(s){return s<30?'Inicial':s<50?'En construcción':s<70?'Sólido':s<85?'Alto':'Muy alto';}
  function weeklyCardioMinutes(weeks=8){
    const end=new Date(isoLocal()+'T12:00:00'),arr=[];
    for(let w=weeks-1;w>=0;w--){const start=new Date(end);start.setDate(start.getDate()-w*7-6);const finish=new Date(end);finish.setDate(finish.getDate()-w*7);let v=0;PLAN.forEach(d=>{const dt=new Date(d.date+'T12:00:00');if(dt<start||dt>finish)return;const l=logs()[d.date];if(!l)return;d.exercises.forEach((e,i)=>{if(!['bike','swim','cardio','intervals'].includes(e.kind))return;const x=l.exercises?.[e.id]||l.exercises?.[i];if(x)v+=num(x.minutes)||0;});});arr.push({label:`S${weeks-w}`,value:v});}
    return arr;
  }
  function weeklyLoad(weeks=8){
    const end=new Date(isoLocal()+'T12:00:00'),arr=[];
    for(let w=weeks-1;w>=0;w--){const start=new Date(end);start.setDate(start.getDate()-w*7-6);const finish=new Date(end);finish.setDate(finish.getDate()-w*7);let v=0;Object.entries(logs()).forEach(([date,l])=>{const dt=new Date(date+'T12:00:00');if(dt<start||dt>finish)return;const r=num(l.sessionRpe),m=num(l.actualMinutes)||parseDurationMin(byDate[date]?.duration||'');if(Number.isFinite(r)&&m>0)v+=r*m;});arr.push({label:`S${weeks-w}`,value:Math.round(v)});}return arr;
  }
  function barChart(data){
    const max=Math.max(1,...data.map(x=>x.value));
    return `<div class="barChart">${data.map(x=>`<div class="barCol"><i style="height:${Math.max(2,Math.round(x.value/max*105))}px"></i><small>${esc(x.label)}</small></div>`).join('')}</div>`;
  }
  function strengthTrend(){
    const names=[...new Set(PLAN.flatMap(d=>d.exercises.filter(e=>e.kind==='strength').map(e=>e.name)))];
    let best=[];for(const name of names){const h=strengthHistory(name,'9999-12-31');if(h.length>best.length)best=h.map(x=>({...x,name}));}
    return best.slice(-10);
  }
  function lineChart(data){
    if(data.length<2)return'<p class="muted">Necesitas al menos 2 registros comparables.</p>';
    const w=340,h=110,p=10,vals=data.map(x=>x.value),min=Math.min(...vals),max=Math.max(...vals),span=max-min||1;
    const pts=data.map((x,i)=>`${p+i*(w-2*p)/(data.length-1)},${h-p-(x.value-min)/span*(h-2*p)}`).join(' ');
    return `<div class="chart"><svg viewBox="0 0 ${w} ${h}" role="img"><line x1="${p}" y1="${h-p}" x2="${w-p}" y2="${h-p}" stroke="#dfe7ec"/><polyline fill="none" stroke="#2f6fa3" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${pts}"/></svg></div>`;
  }


  function monthlyStats(){
    const map={};PLAN.forEach(d=>{const l=logs()[d.date];if(!l||l.ownerId!==currentUser().id)return;const m=d.date.slice(0,7);map[m]=map[m]||{month:m,sessions:0,strengthVolume:0,cardioMinutes:0,bikeKm:0,swimMeters:0,rpes:[],types:{}};const a=map[m];if(l.status==='done')a.sessions++;if(Number.isFinite(num(l.sessionRpe)))a.rpes.push(num(l.sessionRpe));a.types[d.type]=(a.types[d.type]||0)+(l.status==='done'?1:0);d.exercises.forEach((e,i)=>{const x=l.exercises?.[e.id]||l.exercises?.[i];if(!x)return;if(e.kind==='strength'){const sets=extractOldStrength(x,e);a.strengthVolume+=sets.reduce((sum,s)=>sum+(num(s.weight)||0)*(num(s.reps)||0),0);}if(['bike','swim','cardio','intervals'].includes(e.kind))a.cardioMinutes+=num(x.minutes)||0;if(e.kind==='bike')a.bikeKm+=num(x.distance)||0;if(e.kind==='swim')a.swimMeters+=num(x.meters)||0;});});return Object.values(map).sort((a,b)=>a.month.localeCompare(b.month)).map(x=>({...x,avgRpe:x.rpes.length?avg(x.rpes):0}));
  }
  function exerciseProgressData(name){const h=strengthHistory(name,'9999-12-31');return{history:h,bestE1rm:h.length?Math.max(...h.map(x=>x.e1rm)):0,bestSet:h.length?h.reduce((best,x)=>x.e1rm>best.e1rm?x:best,h[0]).bestSet:null,totalVolume:h.reduce((a,x)=>a+x.volume,0),last:h[h.length-1]};}
  function exerciseProfileHtml(name){
    if(!name)return'<p class="muted">Selecciona un ejercicio para ver su ficha.</p>';const p=exerciseProgressData(name),lib=exerciseLibraryEntry(name);if(!p.history.length)return`<p class="muted">Todavía no hay series registradas de ${esc(name)}.</p>`;const h=p.history;return `<div class="exerciseProfileHead"><div><span>${esc(lib.group)} · ${esc(lib.pattern)}</span><h3>${esc(lib.name)}</h3><small>${esc(lib.equipment)}</small></div>${lib.videoUrl?`<a href="${esc(lib.videoUrl)}" target="_blank" rel="noopener">Vídeo ↗</a>`:''}</div><div class="kpis"><div class="kpi"><strong>${p.last.e1rm.toFixed(1)}</strong><span>e1RM ACTUAL KG</span></div><div class="kpi"><strong>${p.bestE1rm.toFixed(1)}</strong><span>MEJOR e1RM</span></div><div class="kpi"><strong>${p.bestSet?`${p.bestSet.weight}×${p.bestSet.reps}`:'—'}</strong><span>MEJOR SERIE</span></div><div class="kpi"><strong>${Math.round(p.totalVolume)}</strong><span>VOLUMEN TOTAL KG</span></div></div><h4>e1RM estimado</h4>${lineChart(h.map(x=>({label:x.date,value:x.e1rm})))}<h4>Volumen por sesión</h4>${lineChart(h.map(x=>({label:x.date,value:x.volume})))}<h4>Peso medio</h4>${lineChart(h.map(x=>({label:x.date,value:x.weight})))}<h4>Repeticiones totales</h4>${lineChart(h.map(x=>({label:x.date,value:x.totalReps})))}<div class="libraryMeta"><strong>Progresión:</strong> ${esc(lib.progression)}<br><strong>Regresión:</strong> ${esc(lib.regression)}</div>`;
  }
  function typeDistribution(){const map={};PLAN.forEach(d=>{if(logs()[d.date]?.status==='done')map[d.type]=(map[d.type]||0)+1;});return Object.entries(map).sort((a,b)=>b[1]-a[1]);}
  function renderStats(){
    const active=PLAN.filter(d=>d.type!=='Descanso'),planned=active.length,done=active.filter(d=>logs()[d.date]?.status==='done').length,partial=active.filter(d=>logs()[d.date]?.status==='partial').length,pct=planned?Math.round(done/planned*100):0,scores=personalScores(),loads=weeklyLoad(8),months=monthlyStats(),dist=typeDistribution();
    const names=[...new Set(PLAN.flatMap(d=>d.exercises.filter(e=>e.kind==='strength').map(e=>canonicalExerciseName(e.canonicalName||e.name)))).values()].filter(n=>strengthHistory(n,'9999-12-31').length);if(!statsExercise&&names.length)statsExercise=names[0];const totalBike=months.reduce((a,x)=>a+x.bikeKm,0),totalSwim=months.reduce((a,x)=>a+x.swimMeters,0),totalCardio=months.reduce((a,x)=>a+x.cardioMinutes,0),rpes=months.map(x=>x.avgRpe).filter(x=>x>0),avgRpe=rpes.length?avg(rpes):0;
    main.innerHTML=`<div class="card"><h2>Progreso · ${esc(currentUser().name)}</h2><p class="muted">Todas las comparaciones son contigo misma/o y usan solo el perfil activo.</p></div><div class="levelGrid">${[['Fuerza',scores.strength],['Resistencia',scores.resistance],['Consistencia',scores.consistency],['Calidad de registro',scores.dataQuality]].map(([n,v])=>`<div class="levelCard"><div class="label">${n}</div><div class="score">${v}</div><div class="progress"><i style="width:${v}%"></i></div><div class="levelName">${levelName(v)}</div></div>`).join('')}</div><div class="kpis" style="margin-top:12px"><div class="kpi"><strong>${done}</strong><span>SESIONES HECHAS</span></div><div class="kpi"><strong>${pct}%</strong><span>CUMPLIMIENTO</span></div><div class="kpi"><strong>${totalBike.toFixed(1)}</strong><span>KM BICI</span></div><div class="kpi"><strong>${Math.round(totalSwim)}</strong><span>METROS NATACIÓN</span></div><div class="kpi"><strong>${Math.round(totalCardio)}</strong><span>MIN CARDIO</span></div><div class="kpi"><strong>${avgRpe?avgRpe.toFixed(1):'—'}</strong><span>RPE MEDIO</span></div></div>
      <div class="card"><h3>Carga semanal · RPE × minutos</h3>${barChart(loads)}<p class="chartCaption">Carga interna registrada; no sustituye valoración clínica ni del entrenador.</p></div>
      <div class="card"><h3>Evolución mensual</h3>${months.length?`<h4>Sesiones completadas</h4>${barChart(months.map(x=>({label:x.month.slice(5),value:x.sessions})))}<h4>Volumen de fuerza (kg·rep)</h4>${barChart(months.map(x=>({label:x.month.slice(5),value:Math.round(x.strengthVolume)})))}<h4>Minutos de cardio</h4>${barChart(months.map(x=>({label:x.month.slice(5),value:Math.round(x.cardioMinutes)})))}`:'<p class="muted">Todavía no hay datos mensuales suficientes.</p>'}</div>
      <div class="card"><h3>Distribución de entrenamientos</h3>${dist.length?dist.map(([name,value])=>`<div class="statBar"><span>${esc(name)}</span><div class="bar"><i style="width:${Math.round(value/Math.max(...dist.map(x=>x[1]))*100)}%"></i></div><b>${value}</b></div>`).join(''):'<p class="muted">Sin sesiones completadas.</p>'}</div>
      <div class="card"><div class="planHeader"><div><h3>Progresión por ejercicio</h3><p class="muted">Peso, reps, volumen, e1RM y mejor serie.</p></div></div><div class="field"><label>Ejercicio</label><select id="statsExerciseSelect">${names.map(n=>`<option ${n===statsExercise?'selected':''}>${esc(n)}</option>`).join('')}</select></div><div id="exerciseProfileBox">${exerciseProfileHtml(statsExercise)}</div></div>`;
    document.getElementById('statsExerciseSelect')?.addEventListener('change',ev=>{statsExercise=ev.target.value;document.getElementById('exerciseProfileBox').innerHTML=exerciseProfileHtml(statsExercise);});
  }
  function renderMotivation(){
    const st=streaks(),ach=achievements(),done=totalCompleted();
    const msg=st.current>=5?'Estás encadenando sesiones con mucha consistencia. Mantén la calidad antes que añadir volumen.':st.current>=2?'La racha ya está en marcha. El siguiente objetivo es simplemente completar bien la próxima sesión.':done?'Ya has empezado a construir historial. Cada sesión registrada hace la app más útil.':'Tu primera sesión registrada desbloqueará el primer logro.';
    main.innerHTML=`<div class="motivationCard motivationHero"><div class="streak"><div class="streakIcon">🔥</div><div><small>RACHA ACTUAL</small><h2>${st.current} entrenos</h2><div>Mejor racha: ${st.best}</div></div></div><p>${esc(msg)}</p></div><div class="card"><h3>Logros</h3><div class="achievementGrid">${ach.map(a=>`<div class="achievement ${a.unlocked?'':'locked'}"><div class="icon">${a.icon}</div><strong>${esc(a.title)}</strong><small>${esc(a.desc)}</small></div>`).join('')}</div></div><div class="card"><h3>Siguiente paso</h3><p class="muted">${done<5?`Te faltan ${5-done} sesiones para el logro “En marcha”.`:st.current<5?`Encadena ${5-st.current} entrenos previstos más para alcanzar la racha 5.`:'Sigue registrando peso, reps, RPE y duración: la recomendación automática gana precisión con historial.'}</p></div>`;
  }

  function renderBackup(){
    const u=activeData(),users=Object.values(db.users),versions=u.planVersions||[],library=allLibraryEntries(),customCount=Object.keys(u.exerciseLibrary||{}).length;
    main.innerHTML=`<div class="card"><h2>Usuarios aislados</h2><p class="muted">Cada perfil tiene plan, bienestar, registros, progresiones, calendario y recomendaciones independientes.</p>${users.map(x=>`<div class="userRow"><div><strong>${esc(x.name)} ${x.id===db.activeUserId?'· activo':''}</strong><small>${x.prefs?.useBasePlan===false?'Plan propio':'Plan PREPA + cambios'} · ${Object.keys(x.logs||{}).length} días con datos</small></div><div><button class="tinyBtn editUser" data-user="${x.id}">Abrir</button>${users.length>1?` <button class="tinyBtn danger deleteUser" data-user="${x.id}">Borrar</button>`:''}</div></div>`).join('')}<button id="addUser" class="dataBtn">＋ Crear usuario</button></div>
      <div class="card"><h2>Perfil activo</h2><div class="editorGrid"><div class="field"><label>Nombre</label><input id="profileName" value="${esc(u.name)}"></div><div class="field"><label>Peso corporal kg (opcional)</label><input id="profileWeight" inputmode="decimal" value="${esc(u.bodyWeightKg||'')}"></div></div><label class="toggleLine"><input id="autoRec" type="checkbox" ${u.prefs?.autoRecommendations!==false?'checked':''}> Recomendaciones automáticas</label><label class="toggleLine"><input id="wellnessAdjust" type="checkbox" ${u.prefs?.wellnessAdjustment!==false?'checked':''}> Ajustar recomendaciones según bienestar previo</label><button id="saveProfile" class="dataBtn">💾 Guardar perfil</button></div>
      <div class="card"><div class="planHeader"><div><h2>Biblioteca de ejercicios</h2><p class="muted">${library.length} ejercicios centralizados · ${customCount} propios. Los alias se agrupan para no duplicar RDL / peso muerto rumano, etc.</p></div><button id="addCustomExercise" class="primaryBtn small">＋ Propio</button></div><div class="libraryList">${library.slice(0,40).map(x=>`<div class="libraryRow"><div><strong>${esc(x.name)}</strong><small>${esc(x.group)} · ${esc(x.pattern)} · ${esc(x.equipment)}</small></div><span>${x.type}</span></div>`).join('')}</div></div>
      <div class="card"><h2>Historial de versiones del plan</h2><p class="muted">Restaurar una versión cambia el plan, no borra los entrenamientos realizados.</p>${versions.length?versions.map(v=>`<div class="versionRow"><div><strong>${esc(v.reason)}</strong><small>${new Date(v.at).toLocaleString('es-ES')}</small></div><button class="tinyBtn restoreVersion" data-id="${v.id}">Restaurar</button></div>`).join(''):'<p class="muted">Aún no hay versiones guardadas. Se crearán automáticamente antes de cambios importantes.</p>'}</div>
      <div class="card"><h2>Actualizar y proteger datos</h2><div class="dbStatus"><span>App ${APP_VERSION}</span><span>Base v${db.schemaVersion}</span><span>${users.length} usuario(s)</span></div><button id="optimizeDb" class="dataBtn">🛡 Crear copia y actualizar/optimizar base</button><button id="checkAppUpdate" class="dataBtn">↻ Comprobar actualización de la app</button><div class="successBox">Migración segura: se conserva el historial y cada registro sigue vinculado al usuario propietario.</div></div>
      <div class="card"><h2>Importar entrenamientos</h2><p class="muted">Excel / CSV / JSON se importa solo al usuario activo. Antes de sustituir fechas existentes se guarda una versión del plan.</p><button id="importPlan" class="dataBtn">📥 Importar archivo</button><button id="newTraining" class="dataBtn">＋ Crear entrenamiento manual</button></div>
      <div class="card"><h2>Copias de seguridad</h2><button id="exportCurrent" class="dataBtn">⬇ Exportar perfil actual</button><button id="exportAll" class="dataBtn">⬇ Exportar todos los usuarios</button><button id="importBackup" class="dataBtn">⬆ Importar copia completa</button></div>`;
    document.getElementById('saveProfile').onclick=()=>{u.name=document.getElementById('profileName').value.trim()||u.name;u.bodyWeightKg=document.getElementById('profileWeight').value;u.prefs.autoRecommendations=document.getElementById('autoRec').checked;u.prefs.adaptiveRecommendations=u.prefs.autoRecommendations;u.prefs.wellnessAdjustment=document.getElementById('wellnessAdjust').checked;save();renderUserSelect();toastMsg('Perfil guardado');};document.getElementById('addUser').onclick=createUser;main.querySelectorAll('.editUser').forEach(b=>b.onclick=()=>{db.activeUserId=b.dataset.user;save();selectedDate='';rebuildPlan();renderBackup();});main.querySelectorAll('.deleteUser').forEach(b=>b.onclick=()=>deleteUser(b.dataset.user));document.getElementById('addCustomExercise').onclick=saveCustomExercise;main.querySelectorAll('.restoreVersion').forEach(b=>b.onclick=()=>restorePlanVersion(b.dataset.id));document.getElementById('optimizeDb').onclick=optimizeDatabase;document.getElementById('checkAppUpdate').onclick=checkAppUpdate;document.getElementById('importPlan').onclick=()=>importInput.click();document.getElementById('newTraining').onclick=()=>renderEditor(nextSuggestedDate(),true);document.getElementById('exportCurrent').onclick=()=>downloadJSON(`PREPA_${safeName(u.name)}_backup.json`,{type:'prepa-user-backup',schemaVersion:SCHEMA_VERSION,isolation:'ownerId',user:u});document.getElementById('exportAll').onclick=()=>downloadJSON(`PREPA_todos_usuarios_${isoLocal()}.json`,{type:'prepa-full-backup',database:db});document.getElementById('importBackup').onclick=()=>backupInput.click();
  }
  function safeName(s){return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w-]+/g,'_');}
  function createUser(){
    const name=prompt('Nombre del nuevo usuario:');if(!name)return;const useBase=confirm('¿Quieres que este usuario empiece con el plan PREPA actual?\nAceptar = sí · Cancelar = plan vacío para importar el suyo.');
    const id=uid('user');db.users[id]={id,name:name.trim(),createdAt:nowISO(),bodyWeightKg:'',logs:{},customPlan:{},prefs:{useBasePlan:useBase,autoRecommendations:true,adaptiveRecommendations:true,wellnessAdjustment:true},templates:[],competitions:[],planVersions:[],exerciseLibrary:{},metadata:{storageNamespace:`profile_${id}`}};db.activeUserId=id;save();selectedDate='';rebuildPlan();setView('backup');toastMsg('Usuario creado');
  }
  function deleteUser(id){const u=db.users[id];if(!u||!confirm(`¿Borrar el perfil “${u.name}” y sus datos de esta app? Exporta una copia antes si quieres conservarlos.`))return;delete db.users[id];if(db.activeUserId===id)db.activeUserId=Object.keys(db.users)[0];save();selectedDate='';rebuildPlan();renderBackup();}
  function optimizeDatabase(){backupDatabaseRaw(JSON.parse(JSON.stringify(db)),'Copia previa a optimización manual');Object.values(db.users).forEach(u=>{u.logs=u.logs||{};u.customPlan=u.customPlan||{};u.prefs=u.prefs||{};u.prefs.autoRecommendations=u.prefs.autoRecommendations!==false;u.prefs.adaptiveRecommendations=u.prefs.adaptiveRecommendations!==false;u.prefs.wellnessAdjustment=u.prefs.wellnessAdjustment!==false;u.templates=Array.isArray(u.templates)?u.templates:[];u.competitions=Array.isArray(u.competitions)?u.competitions:[];u.planVersions=Array.isArray(u.planVersions)?u.planVersions:[];u.exerciseLibrary=u.exerciseLibrary||{};u.metadata=u.metadata||{};if(!u.metadata.storageNamespace)u.metadata.storageNamespace=`profile_${u.id}`;stampMissingOwnership(u);enforceOwnership(u);});db.schemaVersion=SCHEMA_VERSION;save();toastMsg('Copia creada · aislamiento verificado');renderBackup();}
  async function checkAppUpdate(){if(!('serviceWorker'in navigator)){toastMsg('No hay service worker en este navegador');return;}try{const reg=await navigator.serviceWorker.getRegistration();if(reg){await reg.update();toastMsg('Comprobación completada');}else toastMsg('Abre la app desde HTTPS para actualizarla');}catch{toastMsg('No se pudo comprobar ahora');}}
  function downloadJSON(name,obj){const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);}

  backupInput.addEventListener('change',async()=>{const f=backupInput.files[0];if(!f)return;try{const j=JSON.parse(await f.text());if(j.type==='prepa-full-backup'&&j.database?.users){backupDatabaseRaw(db,'Antes de importar copia');db=migrateDatabase(j.database);Object.values(db.users).forEach(u=>{stampMissingOwnership(u);enforceOwnership(u);});save();selectedDate='';rebuildPlan();renderBackup();toastMsg('Copia completa importada con usuarios aislados');}else if(j.type==='prepa-user-backup'&&j.user){const id=uid('user');const imported=reassignOwnership(JSON.parse(JSON.stringify(j.user)),id);imported.name=(j.user.name||'Importado')+' · importado';db.users[id]=imported;db.activeUserId=id;save();selectedDate='';rebuildPlan();renderBackup();toastMsg('Perfil importado en espacio independiente');}else alert('Formato de copia no reconocido.');}catch{alert('No se pudo leer la copia.');}backupInput.value='';});

  function headerKey(v=''){return String(v).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[._\-/]+/g,' ').replace(/\s+/g,' ');}
  function getField(obj,names){const wanted=names.map(headerKey);for(const[k,v]of Object.entries(obj||{}))if(wanted.includes(headerKey(k)))return v;return'';}
  function excelDate(v){if(v instanceof Date&&!isNaN(v))return isoLocal(v);if(typeof v==='number'&&window.XLSX?.SSF?.parse_date_code){const z=XLSX.SSF.parse_date_code(v);if(z)return`${z.y}-${String(z.m).padStart(2,'0')}-${String(z.d).padStart(2,'0')}`;}const s=String(v??'').trim();if(!s)return'';let m=s.match(/^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)/);if(m)return`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;m=s.match(/^([0-3]?\d)[\/-]([01]?\d)[\/-](\d{4})/);if(m)return`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;return s.slice(0,10);}
  function inferImportKind(name='',section='',raw=''){const x=(name+' '+section+' '+raw).toLowerCase();if(/interval|series.*min|\d+\s*[×x]\s*\d+\s*min/.test(x))return'intervals';if(/bici|bicicleta|rodaje/.test(x))return'bike';if(/nataci|nado|crawl/.test(x))return'swim';if(/press|remo|sentadilla|peso muerto|rdl|hip thrust|jal[oó]n|curl|prensa|mancuerna|barra|polea/.test(x))return'strength';return'reps';}
  function dayFromRow(r){const date=excelDate(getField(r,['date','fecha']));if(!date)return null;return normalizeDay({date,day:getField(r,['day','dia','día']),phase:getField(r,['phase','fase']),type:getField(r,['type','tipo','tipo de sesion']),objective:getField(r,['objective','objetivo']),duration:getField(r,['duration','duracion','duración']),intensity:getField(r,['intensity','intensidad']),route:getField(r,['route','ruta','ruta bici']),details:getField(r,['details','descripcion','entrenamiento completo']),dailyNote:getField(r,['daily note','nota del dia','nota diaria']),achilles:getField(r,['achilles','aquiles','nota aquiles']),exercises:[]});}
  function exerciseFromRow(r,i=0){const name=String(getField(r,['name','ejercicio','exercise','nombre ejercicio'])||'').trim();if(!name)return null;const section=String(getField(r,['section','seccion','bloque'])||'Entrenamiento').trim(),planned=getField(r,['planned','previsto','series reps','prescripcion']);const kind=getField(r,['kind','tipo registro','registro'])||inferImportKind(name,section,planned);return normalizeExercise({section,name,planned,kind,recommendedWeight:getField(r,['peso recomendado','carga sugerida','carga','peso']),restSetSec:getField(r,['descanso series','descanso entre series']),restExerciseSec:getField(r,['descanso ejercicio','descanso ejercicios']),intervalCount:getField(r,['intervalos','numero intervalos']),intervalWork:getField(r,['trabajo intervalo','trabajo']),intervalRecovery:getField(r,['recuperacion','recuperación']),distanceTarget:getField(r,['km objetivo','distancia objetivo']),durationTarget:getField(r,['min objetivo','duracion objetivo']),swimMeters:getField(r,['metros objetivo','metros'])},i);}
  function ensureXLSX(){if(window.XLSX)return Promise.resolve(window.XLSX);return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';s.onload=()=>resolve(window.XLSX);s.onerror=()=>reject(new Error('No se pudo cargar Excel'));document.head.appendChild(s);});}
  async function parsePlanExcel(file){await ensureXLSX();const book=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true});const find=names=>{for(const n of book.SheetNames)if(names.includes(headerKey(n)))return book.Sheets[n];return null;};const ps=find(['plan','plan diario','entrenamientos'])||book.Sheets[book.SheetNames[0]],es=find(['ejercicios','exercises']);const map={};XLSX.utils.sheet_to_json(ps,{defval:'',raw:true}).forEach((r,i)=>{const d=dayFromRow(r);if(!d)return;map[d.date]=map[d.date]||d;const e=exerciseFromRow(r,i);if(e)map[d.date].exercises.push(e);});if(es)XLSX.utils.sheet_to_json(es,{defval:'',raw:true}).forEach((r,i)=>{const date=excelDate(getField(r,['date','fecha'])),e=exerciseFromRow(r,i);if(!date||!e)return;if(!map[date])map[date]=normalizeDay({date,objective:'Entrenamiento importado',exercises:[]});map[date].exercises.push(e);});return Object.values(map).sort((a,b)=>a.date.localeCompare(b.date));}
  function parseCSV(text){const delimiter=(text.split('\n')[0].match(/;/g)||[]).length>=(text.split('\n')[0].match(/,/g)||[]).length?';':',';const rows=[];let row=[],field='',q=false;for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(c==='"'){if(q&&n==='"'){field+='"';i++;}else q=!q;}else if(c===delimiter&&!q){row.push(field);field='';}else if((c==='\n'||c==='\r')&&!q){if(c==='\r'&&n==='\n')i++;row.push(field);field='';if(row.some(x=>x!==''))rows.push(row);row=[];}else field+=c;}if(field||row.length){row.push(field);rows.push(row);}return rows;}
  function parsePlanCSV(text){const rows=parseCSV(text);if(rows.length<2)return[];const h=rows[0],map={};rows.slice(1).forEach((r,i)=>{const o=Object.fromEntries(h.map((k,j)=>[k,r[j]??''])),d=dayFromRow(o);if(!d)return;if(!map[d.date])map[d.date]=d;const e=exerciseFromRow(o,i);if(e)map[d.date].exercises.push(e);});return Object.values(map).sort((a,b)=>a.date.localeCompare(b.date));}

  importInput.addEventListener('change',async()=>{const file=importInput.files[0];if(!file)return;try{let days=[];if(/\.xlsx?$|\.xlsm$/i.test(file.name))days=await parsePlanExcel(file);else if(/\.csv$/i.test(file.name))days=parsePlanCSV(await file.text());else{const j=JSON.parse(await file.text());days=(Array.isArray(j)?j:(j.plan||[])).map(normalizeDay);}if(!days.length)throw new Error('Sin días');const overlap=days.filter(d=>byDate[d.date]).length;if(overlap&&!confirm(`${overlap} fecha(s) ya existen en ${currentUser().name}. ¿Reemplazarlas?`)){importInput.value='';return;}snapshotPlan(`Importar ${file.name}`);const ownerId=currentUser().id;days.forEach(d=>customPlan()[d.date]={...d,ownerId});save();rebuildPlan();selectedDate=days[0].date;setView('calendar');toastMsg(`${days.length} días importados a ${currentUser().name}`);}catch(err){console.error(err);alert('No se pudo importar. Revisa las columnas Fecha, Tipo, Objetivo y Ejercicio.');}importInput.value='';});

  document.querySelectorAll('.navBtn').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
  document.getElementById('todayBtn').addEventListener('click',()=>{selectedDate=pickInitialDate();setView('today');});

  if('serviceWorker'in navigator&&location.protocol.startsWith('http')){
    navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(r=>r.update().catch(()=>{})).catch(()=>{});
  }

  rebuildPlan(); selectedDate=pickInitialDate(); render();
})();