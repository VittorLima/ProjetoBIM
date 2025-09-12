🏗️ ProjetoBIM

Visualizador IFC para projetos BIM no navegador, desenvolvido com
[**web-ifc-viewer**](https://github.com/ifcjs/web-ifc-viewer) e
[Vite](https://vitejs.dev/).\
Publicado no [GitHub Pages](https://pages.github.com/).

------------------------------------------------------------------------

🚀 Tecnologias

-   [Vite](https://vitejs.dev/)
-   [Three.js](https://threejs.org/)
-   [web-ifc](https://github.com/IFCjs/web-ifc)
-   [web-ifc-viewer](https://github.com/IFCjs/web-ifc-viewer)

------------------------------------------------------------------------

📂 Estrutura do Projeto

    ProjetoBIM/
    ├── public/
    │   ├── web-ifc.wasm
    │   ├── web-ifc-mt.wasm
    │   ├── web-ifc-mt.worker.js
    │   └── vite.svg
    ├── src/
    │   ├── main.js
    │   ├── counter.js
    │   ├── style.css
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── ...

> Os arquivos `.wasm` devem estar na pasta `public/`.

------------------------------------------------------------------------

⚙️ Configuração

Clone o repositório e instale as dependências:

``` bash
git clone https://github.com/VittorLima/ProjetoBIM.git
cd ProjetoBIM
npm install
```

------------------------------------------------------------------------

▶️ Rodando localmente

``` bash
npm run dev
```

Abra o navegador em <http://localhost:5173>.

------------------------------------------------------------------------

🛠️ Build

``` bash
npm run build
```

Os arquivos finais serão gerados na pasta `dist/`.

------------------------------------------------------------------------

🌐 Deploy no GitHub Pages

1.  **Configure o caminho base no Vite**\
    Edite `vite.config.js`:

    ``` js
    import { defineConfig } from "vite";

    export default defineConfig({
      base: "/ProjetoBIM/"
    });
    ```

2.  **Ajuste o caminho do WASM no viewer**\
    No `main.js`:

    ``` js
    await viewer.IFC.setWasmPath("./");
    ```

3.  **Deploy**

    ``` bash
    npm run deploy
    ```

4.  **Ative o Pages**

    -   Vá em **Settings → Pages** no repositório\
    -   Selecione a branch `gh-pages` e o diretório `/ (root)`

------------------------------------------------------------------------

🔗 URL Final

Após o deploy, acesse:\
👉 <https://VittorLima.github.io/ProjetoBIM/>

------------------------------------------------------------------------

📜 Licença

Este projeto está licenciado sob a licença **MIT**.\
Você pode usar, modificar e distribuir o código, desde que mantenha o
aviso de direitos autorais.\
O software é fornecido "como está", sem garantias.
