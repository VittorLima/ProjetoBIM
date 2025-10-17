# 🏗️ ProjetoBIM — Visualizador IFC com Realidade Aumentada (WebXR)

Visualizador **IFC interativo** para projetos BIM diretamente no navegador, com suporte à **Realidade Aumentada (AR)** via WebXR.  
Desenvolvido com [**Three.js**](https://threejs.org/), [**web-ifc-viewer**](https://github.com/ifcjs/web-ifc-viewer) e empacotado com [**Vite**](https://vitejs.dev/).  

🚀 Permite:
- Carregar e visualizar arquivos `.IFC` em 3D.
- Isolar pavimentos e inspecionar propriedades BIM.
- Ativar modo **AR** para visualização do modelo no ambiente real (em dispositivos compatíveis).

Publicado no [**GitHub Pages**](https://pages.github.com/).

---

## 🧩 Funcionalidades

- 📁 Carregamento de arquivos `.IFC` diretamente no navegador.
- 🧱 Visualização 3D com controle de pavimentos (subsets dinâmicos).
- 🔍 Exibição de propriedades dos elementos BIM (altura, largura, material, pavimento etc.).
- 🌐 Modo **Realidade Aumentada (WebXR)** — posicione o modelo no mundo real.
- 🧭 Interface responsiva com **Bootstrap 5**.
- ⚙️ Compatível com **WebGL** e **Three.js**.

---

## 🚀 Tecnologias e Bibliotecas

| Categoria | Biblioteca | Descrição |
|------------|-------------|-----------|
| 🧱 Core BIM | [**web-ifc-viewer**](https://github.com/ifcjs/web-ifc-viewer) | Visualizador IFC completo baseado em Three.js |
| 📐 Renderização 3D | [**Three.js**](https://threejs.org/) | Motor 3D para renderização e manipulação de modelos |
| ⚙️ IFC Engine | [**web-ifc**](https://github.com/IFCjs/web-ifc) | Parser de arquivos `.IFC` em WebAssembly |
| 🌐 AR/WebXR | [**WebXR API**](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API) | API de Realidade Aumentada e Virtual para navegadores |
| 🎨 Estilo UI | [**Bootstrap 5**](https://getbootstrap.com/) | Framework CSS para layout e responsividade |
| ⚡ Bundler | [**Vite**](https://vitejs.dev/) | Ferramenta de build e hot reload |
| 🧰 Utilitários | [**ES Modules**](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules) | Modularização e importação/exportação de scripts |

---

## 📂 Estrutura do Projeto

```
ProjetoBIM/
├── public/
│   ├── web-ifc.wasm
│   ├── web-ifc-mt.wasm
│   ├── web-ifc-mt.worker.js
│   └── vite.svg
├── src/
│   ├── main.js          
│   ├── style.css        
│   └── utils.js         
├── index.html
├── package.json
├── vite.config.js
└── README.md
```

> ⚠️ Os arquivos `.wasm` devem obrigatoriamente estar na pasta `public/` para que o viewer funcione corretamente.

---

## ⚙️ Configuração

Clone o repositório e instale as dependências:

```bash
git clone https://github.com/VittorLima/ProjetoBIM.git
cd ProjetoBIM
npm install
```

---

## ▶️ Rodando localmente

```bash
npm run dev
```

Abra o navegador em:  
👉 <http://localhost:5173>

---

## 🛠️ Build (produção)

```bash
npm run build
```

Os arquivos finais serão gerados na pasta `dist/`.

---

## 🌐 Deploy no GitHub Pages

1. **Configure o caminho base no Vite**

   ```js
   // vite.config.js
   import { defineConfig } from "vite";
   export default defineConfig({
     base: "/ProjetoBIM/"
   });
   ```

2. **Ajuste o caminho do WASM no viewer**

   ```js
   await viewer.IFC.setWasmPath(import.meta.env.BASE_URL);
   ```

3. **Build + Deploy**

   ```bash
   npm run build
   npm run deploy
   ```

4. **Ative o Pages**
   - Vá em **Settings → Pages**
   - Selecione a branch `gh-pages`
   - Diretório `/ (root)`

---


## 🙌 Créditos

- [IFC.js](https://ifcjs.github.io/info/) — Framework open-source BIM para Web
- [Three.js](https://threejs.org/) — Renderização 3D
- [Bootstrap](https://getbootstrap.com/) — Estilização responsiva
- [MDN WebXR API](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API) — Documentação oficial AR/WebXR

---

## 📜 Licença

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Este projeto está licenciado sob a licença **MIT**.  
Você pode usar, modificar e distribuir o código, desde que mantenha o aviso de direitos autorais.  
O software é fornecido "como está", **sem garantias** de qualquer tipo.

---

## 🔗 URL Final

Após o deploy:  
👉 **https://VittorLima.github.io/ProjetoBIM/**
