# PlanBoda — app del casamiento de Ale & Cande

App instalable (PWA) con datos **compartidos en la nube** (Firebase): la editan los dos,
desde Android y desde iPhone, y se sincroniza en tiempo real.

> ⚠️ Sobre el "APK": un APK **no** se puede instalar en iPhone (iOS no usa APK). Por eso esto
> es una **PWA**: se instala como ícono en la pantalla de inicio en **Android y iPhone**, gratis,
> sin tiendas. Si igual querés un APK para Android, ver el final.

---

## 0) Lo que vas a necesitar
- Node.js instalado (https://nodejs.org, versión LTS).
- Una cuenta de Google (para Firebase).

## 1) Crear el proyecto en Firebase
1. Entrá a https://console.firebase.google.com y creá un proyecto (ej. "planboda").
2. En el menú **Compilación > Firestore Database** → **Crear base de datos** → modo producción → elegí región (ej. `southamerica-east1`).
3. En **Compilación > Authentication** → **Comenzar** → pestaña **Sign-in method** → habilitá **Anónimo**.
4. En **Firestore > Reglas**, pegá esto y publicá:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```
   (Solo pueden leer/escribir sesiones autenticadas. La app inicia sesión anónima sola.)
5. En **⚙️ Configuración del proyecto > Tus apps**, creá una app **Web** (`</>`). Copiá el objeto `firebaseConfig`.

## 2) Pegar la config
- Abrí `src/firebase.js` y reemplazá los `PEGAR_AQUI` por los valores de tu `firebaseConfig`.

## 3) Probar en la compu
```
npm install
npm run dev
```
Abrí la URL que muestra (ej. http://localhost:5173). Te va a pedir "¿Quién sos?" (Ale o Cande).

## 4) Publicar para usarla en los celulares
Necesitás subirla a internet (HTTPS) para instalarla. Opción recomendada: **Firebase Hosting**.

```
npm install -g firebase-tools
firebase login
firebase init hosting
#   - "Use an existing project" → elegí tu proyecto
#   - public directory:  dist
#   - Configure as a single-page app (rewrite all to /index.html):  Yes
#   - Set up automatic builds with GitHub:  No
npm run build
firebase deploy
```
Al terminar te da una URL tipo `https://planboda-xxxx.web.app`. Esa es tu app.

> Alternativa sin consola: hacés `npm run build` y arrastrás la carpeta `dist` a https://app.netlify.com/drop.

### Opción B: publicar con GitHub Pages
1. En `vite.config.js`, el campo `base` debe ser `"/NOMBRE-DEL-REPO/"` (viene como `/planboda/`; cambialo si tu repo se llama distinto).
2. Subí el proyecto a un repositorio de GitHub.
3. `npm install` (instala también `gh-pages`).
4. `npm run deploy` → compila y publica el contenido de `dist` en la rama `gh-pages`.
5. En el repo: **Settings → Pages**. Si no quedó solo, en *Source* elegí la rama `gh-pages` (carpeta `/root`). Guardá.
6. Tu app queda en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/`.
7. Para actualizar después de cambios: `npm run deploy`.

> GitHub Pages aloja solo los archivos de la app. La base de datos compartida sigue siendo Firebase (Pasos 1-2 de arriba), así que igual tenés que crear el proyecto Firebase y pegar la config en `src/firebase.js`.

## 5) Instalar en cada celular (queda como app con ícono)
- **Android (Chrome):** abrí la URL → menú ⋮ → **"Agregar a la pantalla principal"** / "Instalar app".
- **iPhone (Safari):** abrí la URL → botón **Compartir** (cuadrado con flecha) → **"Agregar a inicio"**.

Listo: ícono propio, pantalla completa, y la misma información para los dos.
La primera vez cada uno elige si es **Ale** o **Cande** (solo se usa para la doble confirmación de "Limpiar app").

---

## Panel "Limpiar app" (doble confirmación)
1. Uno toca **"Solicitar limpieza total"** y confirma → queda **pendiente** y se anota en el **Registro**.
2. En el **otro celular** aparece el aviso y el botón **"Confirmar y borrar todo"**.
3. Recién cuando el otro confirma, se borra **todo** lo cargado. Cualquiera puede **cancelar/rechazar** antes.
Todo (solicitud, cancelación, borrado) queda con quién y cuándo en el Registro.

## Notas
- Los datos viven en Firestore (documento `planboda/main`). Si más adelante querés separar varias bodas, se puede cambiar ese id.
- Edición simultánea: si los dos editan exactamente al mismo tiempo, gana el último guardado. Para uso normal de a uno por vez, no hay problema.
- Plan gratis de Firebase (Spark) alcanza de sobra para esto.

## (Opcional) APK de Android
Con la PWA ya publicada, podés generar un APK en https://www.pwabuilder.com (pegás tu URL → Android → descargás). Para iPhone no aplica: se usa la PWA.
