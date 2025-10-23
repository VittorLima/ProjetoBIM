import * as THREE from 'three';
import { IfcViewerAPI } from 'web-ifc-viewer';

// ==================================================================================
// ## BLOCO 0: VARIÁVEIS GLOBAIS E PARÂMETROS
// ==================================================================================

/** Instância principal do viewer IFC */
let viewer;
/** Modelo IFC carregado (primeiro/único) */
let model = null;
/** Atalho para o gerenciador IFC */
let ifcManager = null;

/** ID fixo para subsets de pavimento */
const STOREY_SUBSET_ID = 'storey_subset';

/** Subset de pavimento ativo (null = todos os pavimentos) */
let currentSubset = null;

/** Grupo raiz para transformar o modelo no modo AR (WebXR) */
const arRoot = new THREE.Group();

/** Sessão WebXR e objetos auxiliares (AR) */
let xrSession = null;
let xrRefSpace = null;
let xrHitTestSource = null;
let reticle = null;

/** Controle de escala do usuário no AR */
let userScale = 1;
let userTouchedScale = false;

/** Base para rotação por arraste (futuro) */
let dragYaw = 0;

/** Painel de propriedades tem seleção ativa? (UI) */
let gHasSelection = false;

/** Parâmetros de origem/posição inicial — podem ser definidos externamente. */
let originParams = { x: 0, y: 0, z: 0, distance: 1.2 };

// ==================================================================================
/**
 * Define/atualiza parâmetros de origem para posicionamento inicial/absoluto.
 * Pode ser chamado por outro módulo/trabalho para injetar coordenadas (X,Y,Z) e distância.
 * @param {{x?:number, y?:number, z?:number, distance?:number}} params
 */
export function setOriginParams(params = {}) {
  originParams = { ...originParams, ...params };
}
// ==================================================================================

// ==================================================================================
// ## BLOCO 1: HELPERS / CORE DO VIEWER
// ==================================================================================

/**
 * Obtém o renderer do viewer, independente de layout/contexto (tolerante a variações).
 * @param {IfcViewerAPI} v
 * @returns {THREE.WebGLRenderer}
 */
const getRenderer = (v) => v?.context?.getRenderer?.() || v?.context?.renderer?.renderer || v?.context?.renderer;

/**
 * Obtém a cena THREE atual do viewer.
 * @param {IfcViewerAPI} v
 * @returns {THREE.Scene}
 */
const getScene    = (v) => v?.context?.getScene?.()    || v?.context?.scene;

/**
 * Obtém a câmera ativa do viewer.
 * @param {IfcViewerAPI} v
 * @returns {THREE.Camera}
 */
const getCamera   = (v) => v?.context?.getCamera?.()   || v?.context?.camera;

/**
 * Obtém a lista de modelos IFC presentes no viewer.
 * @param {IfcViewerAPI} v
 * @returns {Array<{mesh: THREE.Object3D, modelID: number}>}
 */
const getIFCModels = (v) => v?.context?.items?.ifcModels || [];

/**
 * Converte um tipo IFC (ex.: "IFCWINDOW") para um nome legível ("Window").
 * @param {string} t
 * @returns {string}
 */
function humanizeType(t){
  if(!t) return 'Elemento';
  const s = String(t).replace(/^IFC/i,'').replace(/([A-Z])/g,' $1').trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Formata um valor de dimensão (m) com heurística simples para mm>m.
 * @param {number|string} value
 * @returns {string|null}
 */
function formatDim(value) {
  if (!value && value !== 0) return null;
  const num = parseFloat(value);
  if (Number.isNaN(num)) return String(value);
  return num > 100 ? (num/1000).toFixed(2) + ' m' : num + ' m';
}

/**
 * Remove canvases duplicados que alguns navegadores criam ao inicializar o WebGL.
 * Mantém apenas o primeiro canvas dentro do container.
 * @param {HTMLElement} container
 */
function removeDuplicateCanvases(container){
  if (!container) return;
  const canvases = container.querySelectorAll('canvas');
  if (canvases.length <= 1) return;
  [...canvases].slice(1).forEach(c => c.remove());
}

// ==================================================================================
// ## BLOCO 2: VISUALIZAÇÃO DINÂMICA (PAVIMENTO / MODOS)
// ==================================================================================
// Pensado para facilitar mudanças futuras: da visão por pavimento para disciplina,
// elemento, ou qualquer outro critério de filtragem/isolamento visual.

/**
 * Aplica visibilidade conforme o subset de pavimento ativo.
 * Se não houver subset (currentSubset = null), mostra os meshes originais.
 */
function applyStoreyVisibility(){
  const ifcModels = getIFCModels(viewer);
  if (!ifcModels.length) return;

  if (!currentSubset){
    // "Todos" → mostra os meshes originais
    ifcModels.forEach(m => { if (m.mesh) m.mesh.visible = true; });
    return;
  }
  // Pavimento específico → esconde originais e mostra APENAS o subset
  ifcModels.forEach(m => { if (m.mesh) m.mesh.visible = false; });
  const scene = getScene(viewer);
  if (!currentSubset.parent) scene.add(currentSubset);
  currentSubset.visible = true;
}

/**
 * Catálogo de modos de visualização. Por ora, apenas 'storey'.
 * No futuro, acrescente 'discipline', 'elementType', etc.
 */
const VisualizationModes = {
  /** Modo atual de visualização */
  currentMode: 'storey',
  /** Tabela de handlers para cada modo */
  modes: {
    storey: () => applyStoreyVisibility(),
  },
  /**
   * Aplica o modo atual (invoca o handler correspondente).
   */
  apply(){
    const fn = this.modes[this.currentMode];
    if (fn) fn();
  }
};

// ==================================================================================
// ## BLOCO 3: AR WEBXR (POSICIONAMENTO / ESCALA / SESSÃO)
// ==================================================================================

/**
 * Garante um ÚNICO clone do modelo/Subset IFC dentro do `arRoot` para uso no AR.
 * Preserva materiais (sem compartilhar referências) e aplica flags seguras para AR.
 * @returns {THREE.Object3D|null}
 */
function ensureARMesh() {
  const models = getIFCModels(viewer);
  if (!models.length) return null;

  // Reutiliza se já existir dentro do arRoot
  let m = arRoot.children.find(c => c.userData?.fromIFC);
  if (m) return m;

  // Fonte: prefere o subset visível (se houver), senão o mesh do primeiro modelo
  const src = (typeof currentSubset !== 'undefined' && currentSubset) ? currentSubset : models[0]?.mesh;
  if (!src) return null;

  // Clona preservando materiais (inclusive arrays de materiais)
  const clone = src.clone(true);
  clone.userData.fromIFC = true;

  clone.applyMatrix4(src.matrixWorld);
  clone.updateMatrixWorld(true);

  // Reaplica materiais originais um-a-um (garante cópia, não referência compartilhada)
  const srcMeshes = [];
  src.traverse(o => { if (o.isMesh) srcMeshes.push(o); });

  let idx = 0;
  clone.traverse(o => {
    if (!o.isMesh) return;
    const srcMesh = srcMeshes[idx++] || null;
    if (!srcMesh) return;

    const copyMat = (mat) => (mat && mat.clone) ? mat.clone() : mat;
    o.material = Array.isArray(srcMesh.material)
      ? srcMesh.material.map(copyMat)
      : copyMat(srcMesh.material);

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => {
      if (!m) return;
      m.depthWrite = true;
      m.side = THREE.DoubleSide;
      m.needsUpdate = true;
    });
  });

  clone.position.set(0,0,0);
  clone.rotation.set(0,0,0);
  clone.scale.set(1,1,1);

  arRoot.add(clone);
  const scene = getScene(viewer);
  if (!scene.children.includes(arRoot)) scene.add(arRoot);
  return clone;
}

/**
 * Força materiais visíveis/opacos — evita transparência e face culling no AR.
 * Não troca o tipo do material, apenas ajusta flags-chave.
 * @param {THREE.Object3D} obj
 */
function forceVisibleAndOpaque(obj){
  if (!obj) return;
  obj.traverse(o => {
    o.visible = true;
    if (!o.isMesh) return;

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => {
      if (!m) return;
      if (m.opacity === undefined) m.opacity = 1;
      if (m.transparent === undefined) m.transparent = false;
      m.depthWrite = true;
      m.side = THREE.DoubleSide;
      m.needsUpdate = true;
    });
  });
}

/**
 * Calcula auto-escala com base na diagonal do bounding box (metros).
 * @param {THREE.Object3D} mesh
 * @param {number} targetDiagMeters
 * @returns {number} escala
 */
function autoScaleFor(mesh, targetDiagMeters = 1.5){
  const box = new THREE.Box3().setFromObject(mesh);
  const s = box.getSize(new THREE.Vector3());
  let diag = Math.hypot(s.x, s.y, s.z) || 1;
  // Heurística: se unidade parece mm, converte para m
  const diagMeters = diag > 500 ? (diag / 1000) : diag;
  const scale = targetDiagMeters / diagMeters;
  return Math.max(0.005, Math.min(10, scale));
}

/**
 * Posiciona o `arRoot` à frente da câmera considerando `originParams`.
 * @param {number} distance Distância em metros; padrão usa originParams.distance
 */
function placeInFrontOfCamera(distance = originParams.distance) {
  const cam = getCamera(viewer);
  const mesh = ensureARMesh();
  if (!mesh) return;
  // ---Para desativar o Hit-test comente a linha abaixo.---
  if (!userTouchedScale) userScale = autoScaleFor(mesh, 1.5);

  const dir = new THREE.Vector3(0,0,-1).applyQuaternion(cam.quaternion);
  const pos = new THREE.Vector3(originParams.x, originParams.y, originParams.z).add(dir.multiplyScalar(distance));
  const yaw = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ').y;

  arRoot.position.copy(pos);
  arRoot.quaternion.set(0,0,0,1);
  arRoot.rotateY(yaw);
  arRoot.scale.set(1, 1, 1);
  arRoot.visible = true;
  dragYaw = arRoot.rotation.y; // base para rotação por arraste (futuro)
}

/**
 * Copia a matriz do retículo para o `arRoot` (quando há hit-test).
 */
function placeModelAtReticle() {
  if (!reticle || !reticle.visible) return;
  const mesh = ensureARMesh(); if (!mesh) return;
  forceVisibleAndOpaque(mesh);
  arRoot.matrix.copy(reticle.matrix);
  arRoot.matrix.decompose(arRoot.position, arRoot.quaternion, arRoot.scale);
  // pequeno offset para evitar z-fighting com o chão
  arRoot.position.y += 0.01;
  if (!userTouchedScale) userScale = autoScaleFor(mesh, 1.5);
  arRoot.scale.set(userScale, userScale, userScale);
  arRoot.visible = true;
}

/**
 * Tenta ancorar no retículo se visível; caso contrário, posiciona à frente da câmera.
 */
function tryPlaceOnTap() {
  if (xrSession) {
    if (reticle && reticle.visible) { placeModelAtReticle(); return; }
    placeInFrontOfCamera();
  }
}

/**
 * Inicia AR WebXR mantendo UI e restauração do viewer conforme o comportamento original.
 * @param {HTMLElement} domOverlayRoot Elemento raiz para overlays de DOM (botões etc.)
 */
async function startAR(domOverlayRoot){
  const renderer = getRenderer(viewer);
  const scene    = getScene(viewer);
  const camera   = getCamera(viewer);

  const ifcModels = getIFCModels(viewer);
  if (!ifcModels.length) throw new Error('Carregue um arquivo IFC antes de iniciar o AR.');

  // Habilita WebXR
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');

  // Pede sessão AR com dom-overlay (se disponível)
  xrSession = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures:['local-floor'],
    optionalFeatures:['hit-test','dom-overlay'],
    domOverlay:{ root: (domOverlayRoot || document.body) }
  });

  await renderer.xr.setSession(xrSession);
  // Garante a mesma aparência do modo normal
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;


  try { xrRefSpace = await xrSession.requestReferenceSpace('local-floor'); }
  catch { xrRefSpace = await xrSession.requestReferenceSpace('local'); }

  // Hit-test viewer-space (se suportado)
  // ----Para desativar o Hit-test comente o trecho abaixo.----
  try {
    const viewerSpace = await xrSession.requestReferenceSpace('viewer');
    xrHitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
  } catch { xrHitTestSource = null; }
  

  // ----Para desativar o Hit-test retire o comentario da linha abaixo.----
  /*xrHitTestSource = null;*/ // força a não usar hit test

  // Fundo transparente + garantir grid OFF e eixos ON (também no AR)
  renderer.domElement.style.background = 'transparent';
  renderer.setClearColor(0x000000, 0);
  scene.background = null;
  viewer.grid?.setGrid(false);
  viewer.axes?.setAxes(true);

  // Luzes auxiliares (melhora visual no AR)
  if (!scene.getObjectByName('ar-ambient')) {
    const amb = new THREE.AmbientLight(0xffffff, 0.8); amb.name = 'ar-ambient'; scene.add(amb);
  }
  if (!scene.getObjectByName('ar-dir')) {
    const dir = new THREE.DirectionalLight(0xffffff, 0.6); dir.position.set(1,2,1); dir.name='ar-dir'; scene.add(dir);
  }

  // Esconde meshes originais e subset durante o AR
  ifcModels.forEach(m => { if (m.mesh) m.mesh.visible = false; });
  if (currentSubset) currentSubset.visible = false;
  try { viewer.IFC.selector.unpickIfcItems(); } catch {}

  // Prepara clone único do ifcModel e força materiais opacos
  const clone = ensureARMesh();
  forceVisibleAndOpaque(clone);

  // Eventos de interação da sessão
  xrSession.addEventListener('select', async (event) => {
    if (!model) return;
    const renderer = getRenderer(viewer);
    const scene = getScene(viewer);
    const camera = getCamera(viewer);

    // Faz um raycast a partir da tela (centro do visor) para selecionar o elemento.
    const raycaster = new THREE.Raycaster();
    const center = new THREE.Vector2(0, 0);
    raycaster.setFromCamera(center, camera);

    // Verifica interseção com o modelo IFC clonado dentro do arRoot
    const intersectables = [];
    arRoot.traverse(o => { if (o.isMesh) intersectables.push(o); });
    const intersects = raycaster.intersectObjects(intersectables, true);

    if (intersects.length) {
      const intersect = intersects[0];
      const faceIndex = intersect.faceIndex;
      const geom = intersect.object.geometry;
      const idAttr = geom.getAttribute('expressID');
      const expressID = idAttr ? idAttr.getX(faceIndex) : null;

      if (expressID != null) {
        try {
          const props = await viewer.IFC.getProperties(model.modelID, expressID, true, true);
          const storey = await getStoreyName(model.modelID, expressID);
          const material = await getMaterialName(model.modelID, expressID);

          const altura   = formatDim(props?.OverallHeight?.value);
          const largura  = formatDim(props?.OverallWidth?.value);
          const humanName = humanizeType(props?.type);

          const propsPanel = document.getElementById('props-content');
          if (propsPanel) {
            propsPanel.innerHTML = `
              <h5>${humanName}: ${props?.Name?.value || "Sem nome"}</h5>
              <p><b>Pavimento:</b> ${storey}</p>
              <p><b>Material:</b> ${material}</p>
              ${altura  ? `<p><b>Altura:</b> ${altura}</p>`   : ""}
              ${largura ? `<p><b>Largura:</b> ${largura}</p>` : ""}
            `;
          }
        } catch (err) {
          console.warn('Falha ao obter propriedades do elemento no AR:', err);
        }
      }
    }
  });
  xrSession.addEventListener('end',    ()=> endAR());

  // Loop de renderização XR + hit-test
  
  renderer.setAnimationLoop((time, frame)=>{
    /*if (frame && xrHitTestSource) {
      const hits = frame.getHitTestResults(xrHitTestSource);
      if (hits.length){
        const pose = hits[0].getPose(xrRefSpace);
        if (pose){ reticle.visible=true; reticle.matrix.fromArray(pose.transform.matrix); }
      } else reticle.visible=false;
    }
    */
    renderer.render(scene,camera);
  });
  
  arRoot.visible = true;
  if (!xrHitTestSource) placeInFrontOfCamera(); // fallback de posicionamento SEM sair do WebXR

  // UI
  document.body.classList.add('is-ar');
  document.getElementById('ar-overlay')?.classList.remove('hidden');
  document.getElementById('ar-button')?.style && (document.getElementById('ar-button').style.display='none');
  document.getElementById('ar-exit-button')?.style && (document.getElementById('ar-exit-button').style.display='inline-block');
}

/**
 * Finaliza a sessão de AR e restaura o estado do viewer.
 */
function endAR(){
  const renderer = getRenderer(viewer);
  const scene    = getScene(viewer);

  // Termina sessão XR se houver
  if (xrSession){
    xrSession.end().catch(()=>{});
    xrSession = null; xrRefSpace = null; xrHitTestSource = null;
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
  }

  // Remove apenas o filho marcado como fromIFC (preserva outros filhos do arRoot)
  for (let i = arRoot.children.length - 1; i >= 0; i--) {
    const child = arRoot.children[i];
    if (child.userData?.fromIFC) arRoot.remove(child);
  }

  // Restaura visibilidade conforme o modo atual
  VisualizationModes.apply();

  // Esconde arRoot e restaura fundo do viewer
  arRoot.visible = false;
  renderer.setClearColor(0xf0f0f0, 1);
  scene.background = new THREE.Color(0xf0f0f0);

  // UI
  document.body.classList.remove('is-ar');
  document.getElementById('ar-overlay')?.classList.add('hidden');
  document.getElementById('ar-button')?.style && (document.getElementById('ar-button').style.display='inline-block');
  document.getElementById('ar-exit-button')?.style && (document.getElementById('ar-exit-button').style.display='none');
}

/**
 * Verifica suporte a WebXR/AR no navegador/dispositivo.
 * @returns {Promise<boolean>}
 */
async function isWebXRARSupported(){
  if (!('xr' in navigator)) return false;
  try {
    if (navigator.xr.isSessionSupported) {
      return await navigator.xr.isSessionSupported('immersive-ar');
    }
  } catch {}
  return false;
}

// ==================================================================================
// ## BLOCO 4: UTILITÁRIOS IFC / ÁRVORE ESPACIAL
// ==================================================================================

/**
 * Constrói um índice de pavimentos (id → { name, ids[] de produtos }).
 * @param {number} modelID
 * @returns {Promise<Record<string, {name:string, ids:number[]}>>}
 */
async function buildStoreyIndex(modelID) {
  const tree = await viewer.IFC.getSpatialStructure(modelID);
  const index = {};

  async function traverse(node, currentStorey) {
    if (!node) return;
    const type = (node.type || '').toUpperCase();

    if (type === 'IFCBUILDINGSTOREY') {
      currentStorey = node;
      const ids = [];
      collectDescendantProducts(node, ids);

      const storeyProps = await viewer.IFC.getProperties(modelID, node.expressID, true, true);
      const name = storeyProps?.LongName?.value || storeyProps?.Name?.value || node.LongName?.value || node.Name?.value || `Pavimento ${node.expressID}`;

      index[node.expressID] = { name, ids: Array.from(new Set(ids)) };
    }

    if (currentStorey && isProductNode(node) && Number.isInteger(node.expressID)) {
      index[currentStorey.expressID] ??= { name: `Pavimento ${currentStorey.expressID}`, ids: [] };
      index[currentStorey.expressID].ids.push(node.expressID);
    }

    if (node.children?.length) {
      for (const ch of node.children) await traverse(ch, currentStorey);
    }
  }

  await traverse(tree, null);
  return index;
}

/**
 * Determina se um nó da árvore representa um "produto" (elemento físico) e não um container.
 * @param {any} node
 * @returns {boolean}
 */
function isProductNode(node){
  const t = (node.type||'').toUpperCase();
  if (!t.startsWith('IFC')) return false;
  const containers = new Set(['IFCPROJECT','IFCSITE','IFCBUILDING','IFCBUILDINGSTOREY','IFCSPACE','IFCZONE']);
  return !containers.has(t);
}

/**
 * Coleta recursivamente os produtos descendentes de um nó.
 * @param {any} node
 * @param {number[]} out
 */
function collectDescendantProducts(node, out){
  if (!node) return;
  if (isProductNode(node) && Number.isInteger(node.expressID)) out.push(node.expressID);
  (node.children||[]).forEach(ch => collectDescendantProducts(ch, out));
}

/**
 * Retorna o nome do pavimento de um elemento a partir da árvore espacial.
 * @param {number} modelID
 * @param {number} elementID
 * @returns {Promise<string>}
 */
async function getStoreyName(modelID, elementID) {
  const tree = await viewer.IFC.getSpatialStructure(modelID);
  let storeyID = null;
  function search(node) {
    if (!node) return false;
    if (node.expressID === elementID) return true;
    for (const c of (node.children||[])) {
      if (search(c)) { if ((node.type||'') === 'IFCBUILDINGSTOREY') storeyID = node.expressID; return true; }
    }
    return false;
  }
  search(tree);
  if (!storeyID) return 'N/A';
  const storeyProps = await viewer.IFC.getProperties(modelID, storeyID, true, true);
  return storeyProps?.LongName?.value || storeyProps?.Name?.value || `Pavimento ${storeyID}`;
}

/**
 * Tenta inferir o material a partir das associações/propriedades IFC.
 * @param {number} modelID
 * @param {number} elementID
 * @returns {Promise<string>}
 */
async function getMaterialName(modelID, elementID) {
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
          if (prop.Name?.value?.toLowerCase().includes('material')) {
            return prop.NominalValue?.value || prop.Name?.value;
          }
        }
      }
    }
  }
  return 'N/A';
}

// ==================================================================================
// ## BLOCO 5: BOOTSTRAP / INICIALIZAÇÃO E UI
// ==================================================================================

/**
 * Inicializa o viewer, UI e handlers principais.
 * - Garante eixos ON, grid OFF.
 * - Configura AR (reticle, luzes) e eventos de UI (upload, picking, seleção de pavimento, AR on/off).
 */
async function init() {
  const container = document.getElementById('three-canvas');
  if (!container) return;

  // Viewer com fundo cinza claro
  viewer = new IfcViewerAPI({ container, backgroundColor: new THREE.Color(0xf0f0f0) });
  const wasmBase = import.meta.env.DEV ? '/' : import.meta.env.BASE_URL;
  await viewer.IFC.setWasmPath(wasmBase);

  // Eixos ON; Grid OFF (garantido)
  viewer.axes.setAxes(true);
  viewer.grid.setGrid(false);
  viewer.context.renderer.postProduction.active = false;

  // Evita canvases duplicados
  removeDuplicateCanvases(container);

  const scene    = getScene(viewer);
  const renderer = getRenderer(viewer);

  // AR: raiz e retículo
  scene.add(arRoot); arRoot.visible = false;
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x00ff99, transparent:true, opacity:0.95, depthTest:false })
  );
  reticle.matrixAutoUpdate = false; reticle.visible = false; scene.add(reticle);

  // --- Elementos de UI (IDs esperados no HTML) ---
  const ifcFileInput   = document.getElementById('ifc-file-input');
  const statusElement  = document.getElementById('status');
  const arBtn          = document.getElementById('ar-button');
  const arExitBtn      = document.getElementById('ar-exit-button');
  const arOverlay      = document.getElementById('ar-overlay');
  const propsPanel     = document.getElementById('props-content');
  const storeySelector = document.getElementById('storey-selector');

  // Upload IFC
  ifcFileInput?.addEventListener('change', async (ev)=>{
    const file = ev.target.files?.[0];
    if(!file) return;
    statusElement.textContent = 'Carregando modelo 3D...';
    try {
      model = await viewer.IFC.loadIfc(file, true);
      ifcManager = viewer.IFC.loader.ifcManager;
      statusElement.textContent = 'Modelo carregado!';

      // Popular seletor de pavimentos usando a árvore espacial
      const storeyIndex = await buildStoreyIndex(model.modelID);
      if (storeySelector) {
        storeySelector.innerHTML = `<option value="all">Todos os pavimentos</option>`;
        Object.entries(storeyIndex).forEach(([sid, info])=>{
          const opt = document.createElement('option');
          opt.value = sid;
          opt.textContent = info.name || `Pavimento ${sid}`;
          storeySelector.appendChild(opt);
        });
      }

      // Estado inicial: todos os pavimentos
      currentSubset = null;
      VisualizationModes.currentMode = 'storey';
      VisualizationModes.apply();
    } catch (err) {
      statusElement.textContent = `Erro ao carregar: ${err?.message || err}`;
    }
  });

  // Picking (clique na tela) — desabilitado durante AR
  renderer?.domElement?.addEventListener('click', async (ev) => {
    if (!model) return;
    if (xrSession) return; // ignora picking durante AR
    if (ev.target?.closest?.('#ar-overlay')) return; // ignora cliques na UI do AR

    const result = await viewer.IFC.selector.pickIfcItem();
    if (!result) {
      if (gHasSelection) {
        try { viewer.IFC.selector.unpickIfcItems(); } catch {}
        propsPanel.innerHTML = 'Clique em um elemento';
        gHasSelection = false;
      }
      return;
    }

    gHasSelection = true;
    const props    = await viewer.IFC.getProperties(model.modelID, result.id, true, true);
    const storey   = await getStoreyName(model.modelID, result.id);
    const material = await getMaterialName(model.modelID, result.id);

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

  // Troca de pavimento (modo 'storey')
  storeySelector?.addEventListener('change', async (ev) => {
    if (!model || !ifcManager) return;

    const scene = getScene(viewer);
    const subsetManager = ifcManager.subsets;
    const modelID = model.modelID;

    // Remove subset anterior (se houver)
    try { subsetManager.removeSubset(modelID, STOREY_SUBSET_ID, scene); } catch {}
    currentSubset = null; // será recriado abaixo se necessário

    const value = ev.target.value;
    if (value === 'all') { VisualizationModes.apply(); return; }

    // Coleta elementIDs do pavimento alvo e cria novo subset
    const tree = await viewer.IFC.getSpatialStructure(modelID);
    function findStorey(node){
      if (!node) return null;
      if (String(node.expressID)===String(value)) return node;
      for (const c of (node.children||[])){
        const f = findStorey(c); if (f) return f;
      }
      return null;
    }
    function collectProductIDs(node, acc){
      if(!node) return;
      if (node.type && node.expressID && (node.type !== 'IFCBUILDINGSTOREY')) acc.push(node.expressID);
      node.children?.forEach(n=>collectProductIDs(n, acc));
    }
    const storeyNode = findStorey(tree);
    const elementIDs = []; collectProductIDs(storeyNode, elementIDs);
    if (!elementIDs.length) { VisualizationModes.apply(); return; }

    try {
      const subset = subsetManager.createSubset({
        modelID,
        ids: elementIDs,
        material: ifcManager.material,
        scene,
        removePrevious: true,
        customID: STOREY_SUBSET_ID,
        applyBVH: true
      });
      if (subset) currentSubset = subset;
      VisualizationModes.apply();
    } catch (err) {
      console.error('Erro ao criar subset de pavimento:', err);
      VisualizationModes.apply();
    }
  });

  // Botões AR
  arBtn?.addEventListener('click', async ()=>{
    try {
      if (!(await isWebXRARSupported())) {
        alert('Este navegador/dispositivo não suporta WebXR AR.');
        return;
      }
      await startAR(arOverlay);
    } catch (e) {
      console.warn('Falha ao iniciar AR WebXR:', e);
    }
  });
  arExitBtn?.addEventListener('click', ()=> endAR());
}

// Bootstrap: inicializa quando o DOM estiver pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
