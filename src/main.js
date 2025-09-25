  // main-unificado-completo_v2.js
  // Viewer IFC + AR (WebXR real quando suportado) + fallback (fundo branco)
  
  import * as THREE from 'three';
  import { IfcViewerAPI } from 'web-ifc-viewer';
  import {
    IFCPRESENTATIONLAYERASSIGNMENT,
    IFCWALL, IFCSLAB, IFCBEAM, IFCCOLUMN, IFCDOOR, IFCWINDOW,
    IFCSYSTEM, IFCDISTRIBUTIONSYSTEM,
    IFCZONE, IFCSPATIALZONE, IFCSPACE
  } from 'web-ifc';
  
  /* ========= AR (WebXR) state ========= */
  let xrSession = null;
  let xrRefSpace = null;
  let xrHitTestSource = null;
  let reticle = null;
  const arRoot = new THREE.Group();
  
  /* helpers para viewer */
  function getRenderer(viewer){ return viewer.context.getRenderer?.() || viewer.context.renderer?.renderer || viewer.context.renderer; }
  function getScene(viewer){ return viewer.context.getScene?.() || viewer.context.scene; }
  function getCamera(viewer){ return viewer.context.getCamera?.() || viewer.context.camera; }
  
  async function init() {
    const container = document.getElementById('three-canvas');
  
    const viewer = new IfcViewerAPI({
      container,
      backgroundColor: new THREE.Color(0xf0f0f0)
    });
    
    const wasmBase = import.meta.env.DEV ? '/' : import.meta.env.BASE_URL;
    await viewer.IFC.setWasmPath(wasmBase);
  
    // cena/render/câmera
    const scene    = getScene(viewer);
    const camera   = getCamera(viewer);
    const renderer = getRenderer(viewer);
  
    // grupo AR + retículo
    scene.add(arRoot); arRoot.visible = false;
    reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 })
    );
    reticle.matrixAutoUpdate = false; reticle.visible = false; scene.add(reticle);
  
    // modelo claro
    viewer.axes.setAxes();
    viewer.grid.setGrid();
    viewer.context.renderer.postProduction.active = false;
  
    const ifcFileInput  = document.getElementById('ifc-file-input');
    const statusElement = document.getElementById('status');
  
    /* ===== Botões AR do cabeçalho ===== */
    const arBtn     = document.getElementById('ar-button');
    const arExitBtn = document.getElementById('ar-exit-button');
  
    /* ===== Overlay AR ===== */
    const arOverlay  = document.getElementById('ar-overlay');
    const arExitUI   = document.getElementById('ar-exit');
    const arScaleInp = document.getElementById('ar-scale');
  
    function enterARUI(){
      document.body.classList.add('is-ar');
      if (arOverlay) arOverlay.classList.remove('hidden');
      if (arBtn)     arBtn.style.display = 'none';
      if (arExitBtn) arExitBtn.style.display = 'none';
    }
    function exitARUI(){
      document.body.classList.remove('is-ar');
      if (arOverlay) arOverlay.classList.add('hidden');
      if (arBtn)     arBtn.style.display = 'inline-block';
      if (arExitBtn) arExitBtn.style.display = 'none';
    }
  
    // escala pelo slider
    arScaleInp?.addEventListener('input', e=>{
      const s = parseFloat(e.target.value || '1');
      arRoot.scale.set(s,s,s);
    });
  
    // Clique do botão AR: decide entre AR real e fallback
    arBtn?.addEventListener('click', async () => {
      try {
        let hasAR = false;
        if (navigator.xr && navigator.xr.isSessionSupported) {
          try { hasAR = await navigator.xr.isSessionSupported('immersive-ar'); } catch { hasAR = false; }
        }
        if (hasAR) {
          await startAR(viewer, arOverlay);
          enterARUI();
        } else {
          // fallback: mantém cena normal (fundo branco) com a UI do AR
          arRoot.visible = true;
          document.body.classList.add('is-ar');
          statusElement.textContent = 'Modo AR não suportado neste dispositivo. Exibindo modelo em fundo branco.';
        }
      } catch (e) {
        statusElement.textContent = 'Erro ao iniciar AR. Veja o console para detalhes.';
      }
    });
  
    arExitBtn?.addEventListener('click', ()=> endAR(viewer));
    arExitUI?.addEventListener('click', ()=> endAR(viewer));
  
    // UI principal
    const controls = document.createElement('div');
    controls.id = 'controls';
    Object.assign(controls.style, {
      position: 'absolute', top: '10px', right: '10px', zIndex: '10',
      background: 'rgba(255,255,255,0.95)', padding: '15px',
      borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', maxWidth: '620px'
    });
  
    controls.innerHTML = `
      <h4 style="margin:0 0 8px 0;">Visualização</h4>
      <div class="row">
        <label style="display:none">Modo:</label>
        <select id="mode-selector">
          <option value="level">Nível</option>
          <option value="layer">Layer</option>
          <option value="type">Tipo</option>
          <option value="system">Sistema</option>
          <option value="zone">Zona</option>
          <option value="property">Propriedade</option>
        </select>
        <select id="group-selector"></select>
      </div>
      <div id="prop-controls" class="row" style="display:none;">
        <input id="pset-input" placeholder="Pset (ex.: Pset_WallCommon)">
        <input id="prop-input" placeholder="Propriedade (ex.: IsExternal)">
        <select id="op-input">
          <option value="=">=</option>
          <option value="!=">≠</option>
          <option value=">">></option>
          <option value="<"><</option>
          <option value="contains">contém</option>
        </select>
        <input id="val-input" placeholder="Valor">
        <button id="apply-prop-filter">Aplicar</button>
      </div>
      <div class="row">
        <button id="show-all-button">Mostrar Tudo</button>
        <button id="reset-all-button">Resetar Tudo</button>
      </div>
    `;
    document.body.appendChild(controls);
  
    const toggleBtn = document.getElementById('toggle-controls');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const isOpen = controls.classList.toggle('open');
        toggleBtn.setAttribute('aria-expanded', String(isOpen));
      });
    }
  
    const propsPanel = document.createElement('div');
    propsPanel.id = 'props-panel';
    Object.assign(propsPanel.style, {
      position: 'absolute', right: '10px', width: '360px', maxHeight: '55vh',
      overflowY: 'auto', background: 'rgba(255,255,255,0.97)', padding: '15px',
      borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
    });
    propsPanel.innerHTML = `<h4 style="margin:0 0 8px 0;">Propriedades</h4><div id="props-content">Clique em um elemento</div>`;
    document.body.appendChild(propsPanel);
  
    function layoutPanels(){ const rect = controls.getBoundingClientRect(); propsPanel.style.top = `${rect.bottom + 10}px`; }
    layoutPanels(); window.addEventListener('resize', layoutPanels);
  
    /* ===== Fit de câmera ===== */
    function fitScene(viewer, padding = 1.2) {
      const scene = viewer.context.getScene?.() || viewer.context.scene;
      const camera = viewer.context.getCamera?.() || viewer.context.camera;
      const ctrls =
        viewer.context.ifcCamera?.cameraControls ||
        viewer.context.orbitControls ||
        viewer.context.cameraControls || null;
  
      const box = new THREE.Box3().setFromObject(scene);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      if (!isFinite(size.x + size.y + size.z)) return;
  
      if (camera.isPerspectiveCamera) {
        const maxSize = Math.max(size.x, size.y, size.z);
        const fov = (camera.fov * Math.PI) / 180;
        let distance = (maxSize / 2) / Math.tan(fov / 2);
        distance *= padding;
        const dir = new THREE.Vector3(1, 1, 1).normalize();
        camera.position.copy(center.clone().add(dir.multiplyScalar(distance)));
        if (ctrls?.setLookAt) ctrls.setLookAt(camera.position.x, camera.position.y, camera.position.z, center.x, center.y, center.z, true);
        else if (ctrls?.target){ ctrls.target.copy(center); ctrls.update?.(); }
        else camera.lookAt(center);
        camera.near = Math.max(distance / 100, 0.01); camera.far = distance * 1000; camera.updateProjectionMatrix();
      } else if (camera.isOrthographicCamera) {
        const width = size.x * padding, height = size.y * padding;
        camera.left = -width/2; camera.right = width/2; camera.top = height/2; camera.bottom = -height/2;
        camera.position.set(center.x, center.y, center.z + size.z * padding);
        if (ctrls?.target) ctrls.target.copy(center);
        camera.updateProjectionMatrix();
      }
    }
  
    /* ===== Estado / índices / filtros ===== */
    let model; let selectedElement = null;
    const SUBSET_ID = 'focus-subset'; const ifcManager = () => viewer.IFC.loader.ifcManager;
    const indices = { levels:{}, layers:{}, types:{}, systems:{}, zones:{} };
    const propCache = {};
  
    function setMeshOpacity(mesh, transparent, opacity){
      const apply = (mat)=>{ if(!mat) return; mat.transparent=transparent; mat.opacity=opacity; mat.depthWrite=!transparent; mat.depthTest=true; };
      const m = mesh.material; Array.isArray(m)? m.forEach(apply) : apply(m);
    }
    function setTransparency(active){ viewer.context.items.ifcModels.forEach(m => setMeshOpacity(m.mesh, active, active ? 0.18 : 1)); }
    function clearFocusSubset(){ try{ ifcManager().removeSubset(model.modelID, undefined, viewer.context.scene, SUBSET_ID);}catch{} }
    function focusVisibleIDs(ids){
      clearFocusSubset(); if(!ids || !ids.length) return;
      const solid = new THREE.MeshBasicMaterial({ transparent:false, opacity:1 });
      ifcManager().createSubset({ modelID:model.modelID, ids, scene:viewer.context.scene, removePrevious:true, material:solid, customID:SUBSET_ID });
    }
  
    function prettyLevelName(props){
      const raw = props.LongName?.value || props.Name?.value;
      if (raw) return raw;
      const elev = typeof props.Elevation?.value === 'number' ? props.Elevation.value : null;
      if (elev === 0) return 'Térreo';
      if (elev !== null) return `Nível ${elev.toFixed(2)} m`;
      return `Nível ${props.expressID}`;
    }
    function findNode(node, id){ if(!node) return null; if(node.expressID===id) return node; for(const ch of node.children||[]){ const r=findNode(ch,id); if(r) return r; } return null; }
    function collectDescendantIds(node, bag=[]){ if(!node) return bag; for(const ch of node.children||[]){ if(typeof ch.expressID==='number') bag.push(ch.expressID); collectDescendantIds(ch,bag);} return bag; }
  
    async function buildLevelIndex(){
      indices.levels = {};
      const storeyIDs = await viewer.IFC.getAllItemsOfType(model.modelID, 3750856006);
      const spatial = await viewer.IFC.getSpatialStructure(model.modelID);
      for (const sid of storeyIDs){
        const p = await viewer.IFC.getProperties(model.modelID, sid, true, false);
        const name = prettyLevelName(p);
        const node = findNode(spatial, sid);
        const ids = collectDescendantIds(node, []);
        if (ids.length) indices.levels[name] = ids;
      }
    }
    async function buildLayerIndex(){
      indices.layers = {};
      const layerIDs = await viewer.IFC.getAllItemsOfType(model.modelID, IFCPRESENTATIONLAYERASSIGNMENT);
      for (const lid of layerIDs){
        const layer = await viewer.IFC.getProperties(model.modelID, lid, true, true);
        const name = layer.Name?.value || `Layer ${lid}`;
        const assigned = (layer.AssignedItems || []).flatMap(x => x?.value || []);
        const ids = assigned.map(x => (x?.value?.expressID ?? x?.expressID)).filter(v=>typeof v==='number');
        if (ids.length) indices.layers[name] = ids;
      }
    }
    async function buildTypeIndex(){
      indices.types = {};
      const defs = [
        { label:'Paredes (IFCWALL)', type: IFCWALL },
        { label:'Lajes (IFCSLAB)', type: IFCSLAB },
        { label:'Vigas (IFCBEAM)', type: IFCBEAM },
        { label:'Pilares (IFCCOLUMN)', type: IFCCOLUMN },
        { label:'Portas (IFCDOOR)', type: IFCDOOR },
        { label:'Janelas (IFCWINDOW)', type: IFCWINDOW },
      ];
      for (const d of defs){
        const ids = await viewer.IFC.getAllItemsOfType(model.modelID, d.type, true);
        if (ids?.length) indices.types[d.label] = { type:d.type, ids };
      }
    }
    async function buildSystemIndex(){
      indices.systems = {};
      const systemTypes = [IFCSYSTEM, IFCDISTRIBUTIONSYSTEM];
      for (const st of systemTypes){
        const sysIDs = await viewer.IFC.getAllItemsOfType(model.modelID, st, true);
        for (const sid of sysIDs){
          const sys = await viewer.IFC.getProperties(model.modelID, sid, true, true);
          const name = sys.Name?.value || sys.LongName?.value || `Sistema ${sid}`;
          const rels = (sys.IsGroupedBy || []).flatMap(r=>r?.value||[]);
          const ids = [];
          for (const rel of rels){
            const related = (rel.RelatedObjects?.value || rel.RelatedObjects || []).map(o=>o.value?.expressID ?? o.expressID);
            for (const id of related) if (typeof id==='number') ids.push(id);
          }
          if (ids.length) indices.systems[name] = Array.from(new Set(ids));
        }
      }
    }
    async function buildZoneIndex(){
      indices.zones = {};
      for (const gt of [IFCZONE, IFCSPATIALZONE]){
        const zids = await viewer.IFC.getAllItemsOfType(model.modelID, gt, true);
        for (const zid of zids){
          const z = await viewer.IFC.getProperties(model.modelID, zid, true, true);
          const name = z.Name?.value || z.LongName?.value || `Zona ${zid}`;
          const rels = (z.IsGroupedBy||[]).flatMap(r=>r?.value||[]);
          const ids = [];
          for (const rel of rels){
            const related = (rel.RelatedObjects?.value || rel.RelatedObjects || []).map(o=>o.value?.expressID ?? o.expressID);
            for (const id of related) if (typeof id==='number') ids.push(id);
          }
          if (ids.length) indices.zones[name] = Array.from(new Set(ids));
        }
      }
      // Spaces
      const spaceIDs = await viewer.IFC.getAllItemsOfType(model.modelID, IFCSPACE, true);
      const spatial = await viewer.IFC.getSpatialStructure(model.modelID);
      for (const sid of spaceIDs){
        const sp = await viewer.IFC.getProperties(model.modelID, sid, true, false);
        const name = sp.LongName?.value || sp.Name?.value || `Espaço ${sid}`;
        const node = findNode(spatial, sid);
        const ids = collectDescendantIds(node, []);
        if (ids.length) indices.zones[name] = Array.from(new Set(ids));
      }
    }
  
    function togglePropControls(show){ document.getElementById('prop-controls').style.display = show? 'flex':'none'; }
    function populateGroupSelector(){
      const mode = document.getElementById('mode-selector').value;
      const groupSel = document.getElementById('group-selector');
      groupSel.innerHTML = '';
      const add = (v,l)=>{ const o=document.createElement('option'); o.value=v; o.textContent=l; groupSel.appendChild(o); };
  
      if (mode === 'property'){ togglePropControls(true); add('all','(— resultado do filtro —)'); groupSel.disabled=true; }
      else {
        togglePropControls(false); groupSel.disabled=false; add('all','Todos');
        if (mode==='level')  Object.keys(indices.levels ).forEach(n=>add(n,n));
        if (mode==='layer')  Object.keys(indices.layers ).forEach(n=>add(n,n));
        if (mode==='type')   Object.keys(indices.types  ).forEach(n=>add(n,n));
        if (mode==='system') Object.keys(indices.systems).forEach(n=>add(n,n));
        if (mode==='zone')   Object.keys(indices.zones  ).forEach(n=>add(n,n));
      }
    }
    function showGroupByMode(){
      const mode  = document.getElementById('mode-selector').value;
      const value = document.getElementById('group-selector').value;
      if (mode==='property') return;
      if (value==='all'){ clearFocusSubset(); setTransparency(false); return; }
      let ids=[];
      if (mode==='level')  ids = indices.levels[value] || [];
      if (mode==='layer')  ids = indices.layers[value] || [];
      if (mode==='type')   ids = indices.types[value]?.ids || [];
      if (mode==='system') ids = indices.systems[value] || [];
      if (mode==='zone')   ids = indices.zones[value] || [];
      setTransparency(true); focusVisibleIDs(ids);
    }
  
    const PROPERTY_TYPES_SCOPE=[IFCWALL,IFCSLAB,IFCBEAM,IFCCOLUMN,IFCDOOR,IFCWINDOW];
    async function getPropsCached(id){ if(!propCache[id]) propCache[id]=await viewer.IFC.getProperties(model.modelID,id,true,true); return propCache[id]; }
    function readPsetValueFromProps(props, psetName, propName){
      const defs=(props.IsDefinedBy||[]).map(x=>x?.RelatingPropertyDefinition?.value).filter(Boolean);
      for(const def of defs){
        const dName=def.Name?.value || def.LongName?.value; if(dName!==psetName) continue;
        const item=(def.HasProperties||[]).find(pp=>pp?.Name?.value===propName); if(!item) continue;
        const v=item.NominalValue?.value ?? item.NominalValue?.wrappedValue ?? item.NominalValue; return v;
      }
      return undefined;
    }
    function compareValues(left,op,rightRaw){
      const rNum=Number(rightRaw), leftNum=Number(left);
      if(!Number.isNaN(leftNum)&&!Number.isNaN(rNum)&&['>','<','=','!='].includes(op)){
        if(op==='>') return leftNum>rNum; if(op=== '<') return leftNum<rNum; if(op==='=') return leftNum===rNum; if(op==='!=') return leftNum!==rNum;
      }
      const l=String(left??'').toLowerCase(), r=String(rightRaw??'').toLowerCase();
      if(op==='contains') return l.includes(r); if(op==='=') return l===r; if(op==='!=') return l!==r; return false;
    }
    async function applyPropertyFilter(){
      const pset=document.getElementById('pset-input').value.trim();
      const prop=document.getElementById('prop-input').value.trim();
      const op  =document.getElementById('op-input').value;
      const val =document.getElementById('val-input').value.trim();
      if(!pset||!prop||!op){ alert('Preencha Pset, Propriedade e Operador.'); return; }
  
      const matched=[];
      for(const t of PROPERTY_TYPES_SCOPE){
        const ids=await viewer.IFC.getAllItemsOfType(model.modelID,t,true);
        for(const id of ids){
          const props=await getPropsCached(id);
          const v=readPsetValueFromProps(props,pset,prop);
          if(v===undefined) continue;
          if(compareValues(v,op,val)) matched.push(id);
        }
      }
      setTransparency(true); focusVisibleIDs(Array.from(new Set(matched)));
      const gs=document.getElementById('group-selector'); gs.innerHTML=''; const o=document.createElement('option');
      o.value='all'; o.textContent=`(filtro: ${pset}.${prop} ${op} ${val})`; gs.appendChild(o); gs.value='all';
    }
  
    function resetAll(){
      clearFocusSubset(); setTransparency(false);
      try{ viewer.IFC.selector.unHighlightIfcItems?.(); }catch{}
      try{ viewer.IFC.selector.unpickIfcItems(); }catch{}
      selectedElement=null; document.getElementById('props-content').innerHTML='Clique em um elemento';
      document.getElementById('mode-selector').value='level'; populateGroupSelector(); document.getElementById('group-selector').value='all';
      fitScene(viewer);
    }
  
    ifcFileInput.addEventListener('change', async (ev)=>{
      const file=ev.target.files[0]; if(!file) return;
      statusElement.textContent='Carregando modelo 3D...';
      try{
        model=await viewer.IFC.loadIfc(file,true);
        await buildLevelIndex(); await buildLayerIndex(); await buildTypeIndex(); await buildSystemIndex(); await buildZoneIndex();
        populateGroupSelector(); resetAll();
        statusElement.textContent='Modelo carregado! Use Nível/Layer/Tipo/Sistema/Zona/Propriedade.';
      }catch(err){ statusElement.textContent=`Erro ao carregar o arquivo: ${err.message}`; }
    });
  
    document.getElementById('mode-selector').addEventListener('change', ()=>{ populateGroupSelector(); showGroupByMode(); });
    document.getElementById('group-selector').addEventListener('change', ()=>{ showGroupByMode(); });
    document.getElementById('show-all-button').addEventListener('click', ()=>{
      clearFocusSubset(); setTransparency(false);
      const mode=document.getElementById('mode-selector').value;
      if(mode!=='property') document.getElementById('group-selector').value='all';
    });
    document.getElementById('reset-all-button').addEventListener('click', resetAll);
    document.getElementById('apply-prop-filter').addEventListener('click', applyPropertyFilter);
  
    // Seleção com toggle
    window.addEventListener('click', async (ev)=>{
      if (ev.target.closest('#controls') || ev.target.closest('#props-panel') || ev.target.closest('#info')) return;
      const result=await viewer.IFC.selector.pickIfcItem();
  
      if(result && selectedElement && result.modelID===selectedElement.modelID && result.id===selectedElement.id){
        try{ viewer.IFC.selector.unHighlightIfcItems?.(); }catch{}
        viewer.IFC.selector.unpickIfcItems(); selectedElement=null;
        document.getElementById('props-content').innerHTML='Clique em um elemento'; return;
      }
      if(result){
        viewer.IFC.selector.highlightIfcItem();
        const props=await viewer.IFC.getProperties(result.modelID,result.id,true,true);
        const content=document.getElementById('props-content'); content.innerHTML='';
        for(const k in props){ if(props[k]?.value!==undefined){ const p=document.createElement('p'); p.innerHTML=`<strong>${k}:</strong> ${props[k].value}`; content.appendChild(p);} }
        selectedElement={ modelID:result.modelID, id:result.id };
      } else {
        try{ viewer.IFC.selector.unHighlightIfcItems?.(); }catch{}
        viewer.IFC.selector.unpickIfcItems(); selectedElement=null;
        document.getElementById('props-content').innerHTML='Clique em um elemento';
      }
    });
  
  } // end init()
  
  /* ========= AR core (usando overlay como domOverlay) ========= */
  async function startAR(viewer, domOverlayRoot){
    const renderer = getRenderer(viewer);
    const scene    = getScene(viewer);
    const camera   = getCamera(viewer);
  
    if (!('xr' in navigator)) throw new Error('Este navegador não expõe WebXR (navigator.xr ausente). Use Chrome/Edge Android.');
    let arSupported = false;
    try { arSupported = await navigator.xr.isSessionSupported('immersive-ar'); } catch { arSupported = false; }
    if (!arSupported) throw new Error('WebXR AR não suportado neste dispositivo/navegador (isSessionSupported retornou false).');
  
    let overlayRoot = domOverlayRoot || document.getElementById('ar-overlay') || document.body;
    const inDoc = overlayRoot && overlayRoot.isConnected; if (!inDoc) overlayRoot = document.body;
  
    renderer.xr.enabled=true;
    renderer.xr.setReferenceSpaceType('local-floor');
  
    try {
      xrSession = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures:['hit-test','local-floor'],
        optionalFeatures:['dom-overlay'],
        domOverlay:{ root: overlayRoot }
      });
  
      await renderer.xr.setSession(xrSession);
  
      try { xrRefSpace = await xrSession.requestReferenceSpace('local-floor'); }
      catch { xrRefSpace = await xrSession.requestReferenceSpace('local'); }
  
      const viewerSpace = await xrSession.requestReferenceSpace('viewer');
      xrHitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
  
      xrSession.addEventListener('select', ()=>{ if (reticle?.visible) placeModelAtReticle(viewer); });
      xrSession.addEventListener('end', ()=>{ endAR(viewer); });
  
      renderer.setAnimationLoop((time, frame)=>{
        if(!frame) return;
        const hits = frame.getHitTestResults(xrHitTestSource);
        if (hits.length){
          const pose=hits[0].getPose(xrRefSpace);
          if(pose){ reticle.visible=true; reticle.matrix.fromArray(pose.transform.matrix); }
        } else { reticle.visible=false; }
        renderer.render(scene,camera);
      });
  
      arRoot.visible = true;
      document.body.classList.add('is-ar');
    } catch (err) {
      let hint = '';
      switch (err?.name) {
        case 'SecurityError': hint = 'Precisa servir via HTTPS ou localhost.'; break;
        case 'NotAllowedError': hint = 'Permissão de câmera negada.'; break;
        case 'NotSupportedError': hint = 'Recurso não suportado neste device.'; break;
        case 'InvalidStateError': hint = 'Já existe uma sessão XR ativa.'; break;
        case 'AbortError': hint = 'A sessão foi abortada.'; break;
        default: hint = 'Falha inesperada ao criar a sessão WebXR.';
      }
      throw new Error(`${hint} [${err?.name ?? 'Erro'}] ${err?.message ?? ''}`);
    }
  }
  
  function endAR(viewer){
    const renderer=getRenderer(viewer);
    renderer.setAnimationLoop(null);
    renderer.xr.enabled=false;
  
    if (xrHitTestSource){ try{ xrHitTestSource.cancel?.(); }catch{} }
    xrHitTestSource=null; xrRefSpace=null;
  
    if (xrSession){ try{ xrSession.end(); }catch{} }
    xrSession=null;
  
    if (reticle) reticle.visible=false;
    arRoot.visible=false;
  
    document.body.classList.remove('is-ar');
    const arOverlay=document.getElementById('ar-overlay'); arOverlay?.classList.add('hidden');
    const btn=document.getElementById('ar-button'); const btnExit=document.getElementById('ar-exit-button');
    if(btn) btn.style.display='inline-block'; if(btnExit) btnExit.style.display='none';
  
    try{ const viewer = null; }catch{}
  }
  
  function placeModelAtReticle(viewer){
    if (!reticle || !reticle.visible) return;
    const models = viewer?.context?.items?.ifcModels || [];
    if (!models.length) return;
  
    const source = models[0].mesh;
    const already = arRoot.children.find(c => c.userData?.fromIFC);
    const mesh = already || (()=>{ const c = source.clone(true); c.userData.fromIFC = true; arRoot.add(c); return c; })();
  
    arRoot.matrix.copy(reticle.matrix);
    arRoot.matrix.decompose(arRoot.position, arRoot.quaternion, arRoot.scale);
    arRoot.position.y += 0.01;
  
    if (!already){
      const box = new THREE.Box3().setFromObject(mesh);
      const size = box.getSize(new THREE.Vector3());
      const diag = Math.hypot(size.x,size.y,size.z) || 1;
      const s = 1.0 / diag; // alvo ~1m
      arRoot.scale.setScalar(s);
      const slider = document.getElementById('ar-scale');
      if (slider) slider.value = String(s);
    }
  }
  
  init();