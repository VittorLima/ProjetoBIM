// src/main.js
// Viewer IFC + AR real (WebXR/Android) + Fallback simples (iOS/desktop)

import * as THREE from 'three';
import { IfcViewerAPI } from 'web-ifc-viewer';

let xrSession = null;
let xrRefSpace = null;
let xrHitTestSource = null;
let reticle = null;
const arRoot = new THREE.Group();

let dragYaw = 0, dragging = false, lastX = 0;
let userScale = 1;
let userTouchedScale = false;

function getRenderer(v){ return v?.context?.getRenderer?.() || v?.context?.renderer?.renderer || v?.context?.renderer; }
function getScene(v){ return v?.context?.getScene?.() || v?.context?.scene; }
function getCamera(v){ return v?.context?.getCamera?.() || v?.context?.camera; }

let viewer;
let model = null;
let ifcManager = null;
const STOREY_SUBSET_ID = 'storey_subset';
let storeyIndex = {}; // { [storeyID]: { name, ids:number[] } }

async function init() {
  const container = document.getElementById('three-canvas');
  if (!container) return;

  viewer = new IfcViewerAPI({
    container,
    backgroundColor: new THREE.Color(0xf0f0f0)
  });
  window.viewer = viewer;

  const wasmBase = import.meta.env.DEV ? '/' : import.meta.env.BASE_URL;
  await viewer.IFC.setWasmPath(wasmBase);

  viewer.axes.setAxes();
  viewer.grid.setGrid();
  viewer.context.renderer.postProduction.active = false;

  const scene    = getScene(viewer);
  const renderer = getRenderer(viewer);

  scene.add(arRoot);
  arRoot.visible = false;

  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x00ff99, transparent:true, opacity:0.95, depthTest:false })
    //material: new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),

  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const ifcFileInput   = document.getElementById('ifc-file-input');
  const statusElement  = document.getElementById('status');
  const arBtn          = document.getElementById('ar-button');
  const arExitBtn      = document.getElementById('ar-exit-button');
  const arOverlay      = document.getElementById('ar-overlay');
  const propsPanel     = document.getElementById('props-content');
  const storeySelector = document.getElementById('storey-selector');

  // --- Upload IFC ---
  ifcFileInput?.addEventListener('change', async (ev)=>{
    const file = ev.target.files?.[0];
    if(!file) return;
    statusElement.textContent = 'Carregando modelo 3D...';
    try {
      model = await viewer.IFC.loadIfc(file, true);
      ifcManager = viewer.IFC.loader.ifcManager;
      statusElement.textContent = 'Modelo carregado!';
      storeyIndex = await buildStoreyIndex(model.modelID);

      // popular seletor
      if (storeySelector) {
        storeySelector.innerHTML = `<option value="all">Todos os pavimentos</option>`;
        Object.entries(storeyIndex).forEach(([sid, info])=>{
          const opt = document.createElement('option');
          opt.value = sid;
          opt.textContent = info.name || `Pavimento ${sid}`;
          storeySelector.appendChild(opt);
        });
      }
    } catch (err) {
      statusElement.textContent = `Erro ao carregar: ${err?.message || err}`;
    }
  });

  // --- Clique para propriedades ---
  renderer?.domElement?.addEventListener('click', async (ev) => {
    if (!model) return;
    if (ev.target?.closest?.('#ar-overlay')) return;

    const result = await viewer.IFC.selector.pickIfcItem();
    if (!result) {
      resetModelView();
      viewer.IFC.selector.unpickIfcItems();
      propsPanel.innerHTML = 'Clique em um elemento';
      return;
    }

    const props    = await viewer.IFC.getProperties(model.modelID, result.id, true, true);
    const storey   = await getStoreyName(viewer, model.modelID, result.id);
    const material = await getMaterialName(viewer, model.modelID, result.id);

    const altura   = formatDim(props?.OverallHeight?.value);
    const largura  = formatDim(props?.OverallWidth?.value);
    const humanName = humanizeType(props?.type);

    propsPanel.innerHTML = `
      <h5>${humanName}: ${props?.Name?.value || "Sem nome"}</h5>
      <p><b>Pavimento:</b> ${storey}</p>
      <p><b>Material:</b> ${material}</p>
      ${altura  ? `<p><b>Altura:</b> ${altura}</p>`   : ""}
      ${largura ? `<p><b>Largura:</b> ${largura}</p>` : ""}
    `;
  });

  // --- Seletor de pavimentos ---
  // --- Seletor de pavimentos (corrigido e com reset automático) ---
storeySelector?.addEventListener('change', async (ev) => {
  if (!model || !ifcManager) return;

  const scene = getScene(viewer);
  const subsetManager = ifcManager.subsets;
  const modelID = model.modelID;

  // Remover subset anterior e restaurar modelo completo
  try {
    subsetManager.removeSubset(modelID, STOREY_SUBSET_ID, scene);
  } catch (e) {
    console.warn("Nenhum subset anterior para remover:", e.message);
  }
  (viewer.context.items.ifcModels || []).forEach(m => { if (m.mesh) m.mesh.visible = true; });

  const value = ev.target.value;
  if (value === 'all') {
    resetModelView();
    return;
  }

  // Buscar pavimento e seus elementos
  const storeys = await getAllStoreys(viewer, modelID);
  const storey = storeys.find(s => String(s.expressID) === String(value));
  if (!storey) return;

  const elementIDs = [];
  collectProductIDs(storey, elementIDs);
  if (!elementIDs.length) {
    console.warn('Nenhum elemento encontrado para o pavimento', value);
    return;
  }

  try {
    // Criar subset com o material original
    const subset = subsetManager.createSubset({
      modelID,
      ids: elementIDs,
      material: ifcManager.material,  // usa o material original IFC
      scene,
      removePrevious: true,
      customID: STOREY_SUBSET_ID,
      applyBVH: true // melhora performance e aparência
    });

    // Esconde o modelo original e mostra apenas o subset
    if (subset) {
      (viewer.context.items.ifcModels || []).forEach(m => { if (m.mesh) m.mesh.visible = false; });
      if (!subset.parent) scene.add(subset);
      subset.visible = true;
    }

  } catch (err) {
    console.error('Erro ao criar subset:', err);
  }
});

  // --- Botões AR ---
  arBtn?.addEventListener('click', async () => {
    try {
      let hasAR = false;
      if (navigator.xr?.isSessionSupported) {
        try { hasAR = await navigator.xr.isSessionSupported('immersive-ar'); } catch {}
      }
      if (hasAR) await startAR(viewer, arOverlay);
      else       await startFallbackAR(viewer);
      document.body.classList.add('is-ar');
      arOverlay?.classList.remove('hidden');
      arBtn.style.display = 'none';
      arExitBtn.style.display = 'inline-block';
    } catch (e) {
      statusElement.textContent = 'Erro ao iniciar AR: ' + (e?.message || e);
    }
  });

  arExitBtn?.addEventListener('click', ()=> endAR(viewer));
}

/* ======== NOVA função corrigida ======== */
function collectProductIDs(node, out) {
  if (!node) return;
  const type = (node.type || '').toUpperCase();
  const isContainer = ['IFCPROJECT','IFCSITE','IFCBUILDING','IFCBUILDINGSTOREY'].includes(type);
  if (!isContainer && Number.isInteger(node.expressID)) {
    out.push(node.expressID);
  }
  (node.children || []).forEach(child => collectProductIDs(child, out));
}
/*
  // rotação simples no fallback (se quiser usar)
  const canvas = renderer.domElement;
  canvas.addEventListener('mousedown', ev=>{ dragging=true; lastX=ev.clientX; });
  canvas.addEventListener('mousemove', ev=>{
    if (!dragging) return;
    const dx = ev.clientX - lastX; lastX = ev.clientX;
    dragYaw += dx * 0.005; arRoot.rotation.y = dragYaw;
  });
  canvas.addEventListener('mouseup', ()=> dragging=false);
  canvas.addEventListener('touchstart', ev=>{ dragging=true; lastX=ev.touches?.[0]?.clientX ?? 0; }, {passive:true});
  canvas.addEventListener('touchmove',  ev=>{
    if (!dragging) return;
    const x = ev.touches?.[0]?.clientX ?? 0;
    const dx = x - lastX; lastX = x;
    dragYaw += dx * 0.005; arRoot.rotation.y = dragYaw;
  }, {passive:true});
  canvas.addEventListener('touchend', ()=> dragging=false);
}
*/
/* ===== Índice de pavimentos (rápido e robusto) ===== */
async function buildStoreyIndex(modelID) {
  const tree = await viewer.IFC.getSpatialStructure(modelID);
  const index = {};

  // Percorre o modelo hierarquicamente
  async function traverse(node, currentStorey) {
    if (!node) return;

    const type = (node.type || '').toUpperCase();

    // Quando encontra um pavimento
    if (type === 'IFCBUILDINGSTOREY') {
      currentStorey = node;
      const ids = [];

      collectDescendantProducts(node, ids);

      // 🔹 Busca as propriedades oficiais do pavimento, igual ao painel
      const storeyProps = await viewer.IFC.getProperties(modelID, node.expressID, true, true);
      const name =
        storeyProps?.LongName?.value ||
        storeyProps?.Name?.value ||
        node.LongName?.value ||
        node.Name?.value ||
        `Pavimento ${node.expressID}`;

      index[node.expressID] = { name, ids: Array.from(new Set(ids)) };
    }

    // Adiciona produtos diretos
    if (currentStorey && isProductNode(node) && Number.isInteger(node.expressID)) {
      if (!index[currentStorey.expressID])
        index[currentStorey.expressID] = { name: `Pavimento ${currentStorey.expressID}`, ids: [] };
      index[currentStorey.expressID].ids.push(node.expressID);
    }

    // Recursão
    if (node.children?.length) {
      for (const ch of node.children) {
        await traverse(ch, currentStorey);
      }
    }
  }

  await traverse(tree, null);
  return index;
}

function isProductNode(node){
  const t = (node.type||'').toUpperCase();
  if (!t.startsWith('IFC')) return false;
  // containers que NÃO queremos somar
  const containers = new Set([
    'IFCPROJECT','IFCSITE','IFCBUILDING','IFCBUILDINGSTOREY',
    'IFCSPACE','IFCZONE'
  ]);
  return !containers.has(t);
}

function collectDescendantProducts(node, out){
  if (!node) return;
  if (isProductNode(node) && Number.isInteger(node.expressID)) out.push(node.expressID);
  (node.children||[]).forEach(ch => collectDescendantProducts(ch, out));
}

/* ========= Utilidades de propriedades ========= */
function formatDim(value) {
  if (!value && value !== 0) return null;
  const num = parseFloat(value);
  if (Number.isNaN(num)) return value;
  return num > 100 ? (num/1000).toFixed(2) + ' m' : num + ' m';
}

async function getStoreyName(viewer, modelID, elementID) {
  const tree = await viewer.IFC.getSpatialStructure(modelID);
  let storeyID = null;

  function search(node) {
    if (!node) return false;
    if (node.expressID === elementID) return true;
    for (const c of (node.children||[])) {
      if (search(c)) {
        if ((node.type||'') === "IFCBUILDINGSTOREY") storeyID = node.expressID;
        return true;
      }
    }
    return false;
  }
  search(tree);

  if (!storeyID) return "N/A";
  const storeyProps = await viewer.IFC.getProperties(modelID, storeyID, true, true);
  return storeyProps?.LongName?.value || storeyProps?.Name?.value || `Pavimento ${storeyID}`;
}

async function getMaterialName(viewer, modelID, elementID) {
  const props = await viewer.IFC.getProperties(modelID, elementID, true, true);

  if (props?.HasAssociations) {
    for (const rel of props.HasAssociations) {
      const related = rel?.value?.RelatingMaterial?.value;
      if (related?.Name?.value) return related.Name.value;
    }
  }
  if (props?.IsDefinedBy) {
    for (const def of props.IsDefinedBy) {
      const rel = def?.value?.RelatingPropertyDefinition?.value;
      if (rel?.HasProperties) {
        for (const p of rel.HasProperties) {
          const prop = p.value;
          if (prop.Name?.value?.toLowerCase().includes("material")) {
            return prop.NominalValue?.value || prop.Name?.value;
          }
        }
      }
    }
  }
  return "N/A";
}

function humanizeType(type) {
  if (!type) return 'Elemento';
  if (typeof type === 'object' && type.value) type = type.value;
  if (typeof type !== 'string') return 'Elemento';
  const map = {
    'IFCWALLSTANDARDCASE': 'Parede',
    'IFCBEAM'            : 'Viga',
    'IFCCOLUMN'          : 'Pilar',
    'IFCSLAB'            : 'Laje',
    'IFCWINDOW'          : 'Janela',
    'IFCDOOR'            : 'Porta'
  };
  return map[type.toUpperCase()] || type;
}

/* ========= Reset de visualização ========= */
function resetModelView(){
  if (!model || !ifcManager) return;
  const scene = getScene(viewer);
  const subsetManager = ifcManager.subsets;
  try { subsetManager.removeSubset(model.modelID, STOREY_SUBSET_ID, scene); } catch {}
  const ifcModels =
    viewer.context?.items?.ifcModels ||
    viewer.context?.ifcModels || [];
  ifcModels.forEach(m => { if (m.mesh) m.mesh.visible = true; });
}

/* ========= AR (igual ao seu) ========= */
async function startAR(viewer, domOverlayRoot){
  const renderer = getRenderer(viewer);
  const scene    = getScene(viewer);
  const camera   = getCamera(viewer);

  const models = viewer?.context?.items?.ifcModels || [];
  if (!models.length) throw new Error('Carregue um arquivo IFC antes de iniciar o AR.');

  let overlayRoot = domOverlayRoot || document.body;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');

  xrSession = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures:['local-floor'],
    optionalFeatures:['hit-test','dom-overlay'],
    domOverlay:{ root: overlayRoot }
  });

  await renderer.xr.setSession(xrSession);
  try { xrRefSpace = await xrSession.requestReferenceSpace('local-floor'); }
  catch { xrRefSpace = await xrSession.requestReferenceSpace('local'); }

  try {
    const viewerSpace = await xrSession.requestReferenceSpace('viewer');
    xrHitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
  } catch { xrHitTestSource = null; }

  renderer.domElement.style.background = 'transparent';
  renderer.setClearColor(0x000000, 0);
  scene.background = null;
  viewer.grid?.setGrid(false);
  viewer.axes?.setAxes(false);

  xrSession.addEventListener('select', ()=> tryPlaceOnTap(viewer));
  xrSession.addEventListener('end', ()=> endAR(viewer));

  renderer.setAnimationLoop((time, frame)=>{
    if(!frame) return;
    if (xrHitTestSource) {
      const hits = frame.getHitTestResults(xrHitTestSource);
      if (hits.length){
        const pose = hits[0].getPose(xrRefSpace);
        if (pose){ reticle.visible=true; reticle.matrix.fromArray(pose.transform.matrix); }
      } else reticle.visible=false;
    }
    renderer.render(scene,camera);
  });

  arRoot.visible = true;
  if (!xrHitTestSource) placeInFrontOfCamera(viewer, 1.2);
}

/* ========= Fallback simples ========= */
async function startFallbackAR(viewer){
  const renderer = getRenderer(viewer);
  const scene    = getScene(viewer);

  const models = viewer?.context?.items?.ifcModels || [];
  if (!models.length) throw new Error('Carregue um arquivo IFC antes de iniciar o AR.');

  renderer.xr.enabled = false;
  renderer.setClearColor(0xffffff, 1);
  scene.background = new THREE.Color(0xffffff);

  viewer.grid?.setGrid(false);
  viewer.axes?.setAxes(false);

  const clone = ensureARMesh(viewer);
  forceVisibleAndOpaque(clone);

  (viewer.context.items.ifcModels || []).forEach(m => { if (m.mesh) m.mesh.visible = false; });

  placeInFrontOfCamera(viewer, 1.2);
  arRoot.visible = true;

  const loop = ()=> {
    requestAnimationFrame(loop);
    renderer.render(scene, getCamera(viewer));
  };
  loop();
}

/* ========= Encerrar AR ========= */
function endAR(viewer){
  const renderer = getRenderer(viewer);
  const scene    = getScene(viewer);

  if (xrSession){
    xrSession.end().catch(()=>{});
    xrSession = null; xrRefSpace = null;
    xrHitTestSource = null;
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
  }

  for (let i = arRoot.children.length - 1; i >= 0; i--) {
    const child = arRoot.children[i];
    if (child.userData?.fromIFC) arRoot.remove(child);
  }
  (viewer.context.items.ifcModels || []).forEach(m => { if (m.mesh) m.mesh.visible = true; });

  arRoot.visible=false;
  renderer.setClearColor(0xf0f0f0, 1);
  scene.background = new THREE.Color(0xf0f0f0);

  document.body.classList.remove('is-ar');
  document.getElementById('ar-overlay')?.classList.add('hidden');
  document.getElementById('ar-button').style.display='inline-block';
  document.getElementById('ar-exit-button').style.display='none';
}

/* ========= utils (iguais) ========= */
function forceVisibleAndOpaque(obj){
  if (!obj) return;
  obj.traverse(o=>{
    o.visible = true;
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m=>{
        if (!m) return;
        if (m.clone) o.material = m.clone();
        o.material.transparent = false;
        o.material.opacity = 1;
        o.material.depthWrite = true;
        o.material.side = THREE.DoubleSide;
        o.material.needsUpdate = true;
      });
    }
  });
}

function ensureARMesh(viewer) {
  const models = viewer?.context?.items?.ifcModels || [];
  if (!models.length) return null;

  let m = arRoot.children.find(c => c.userData?.fromIFC);
  if (m) return m;

  const src = models[0].mesh;
  if (!src) return null;

  const clone = src.clone(true);
  clone.userData.fromIFC = true;
  clone.position.set(0,0,0);
  clone.rotation.set(0,0,0);
  clone.scale.set(1,1,1);

  arRoot.add(clone);
  const scene = getScene(viewer);
  if (!scene.children.includes(arRoot)) scene.add(arRoot);

  return clone;
}

function autoScaleFor(mesh, targetDiagMeters = 1.5){
  const box = new THREE.Box3().setFromObject(mesh);
  const s = box.getSize(new THREE.Vector3());
  let diag = Math.hypot(s.x, s.y, s.z) || 1;
  const diagMeters = diag > 500 ? (diag / 1000) : diag;
  const scale = targetDiagMeters / diagMeters;
  return Math.max(0.005, Math.min(10, scale));
}

function placeInFrontOfCamera(viewer, distance = 1.2) {
  const cam = getCamera(viewer);
  const mesh = ensureARMesh(viewer);
  if (!mesh) return;

  if (!userTouchedScale) userScale = autoScaleFor(mesh, 1.5);

  const dir = new THREE.Vector3(0,0,-1).applyQuaternion(cam.quaternion);
  const pos = cam.position.clone().add(dir.multiplyScalar(distance));
  const yaw = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ').y;

  arRoot.position.copy(pos);
  arRoot.quaternion.set(0,0,0,1);
  arRoot.rotateY(yaw);
  arRoot.scale.set(userScale, userScale, userScale);
  arRoot.visible = true;
  dragYaw = arRoot.rotation.y;
}

function tryPlaceOnTap(viewer) {
  if (xrSession) {
    if (reticle && reticle.visible) { placeModelAtReticle(viewer); return; }
    placeInFrontOfCamera(viewer);
  }
}

function placeModelAtReticle(viewer) {
  if (!reticle || !reticle.visible) return;
  const mesh = ensureARMesh(viewer); if (!mesh) return;
  forceVisibleAndOpaque(mesh);
  arRoot.matrix.copy(reticle.matrix);
  arRoot.matrix.decompose(arRoot.position, arRoot.quaternion, arRoot.scale);
  arRoot.position.y += 0.01;
  if (!userTouchedScale) userScale = autoScaleFor(mesh, 1.5);
  arRoot.scale.set(userScale, userScale, userScale);
  arRoot.visible = true;
}

// ===== Função auxiliar para buscar pavimentos =====
async function getAllStoreys(viewer, modelID) {
  const tree = await viewer.IFC.getSpatialStructure(modelID);
  const storeys = [];
  (function traverse(node) {
    if (!node) return;
    if ((node.type || '').toUpperCase() === 'IFCBUILDINGSTOREY') {
      storeys.push(node);
    }
    node.children?.forEach(traverse);
  })(tree);
  return storeys;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
