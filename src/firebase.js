import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

// =====================================================================
// 1) Pegá acá la config de TU proyecto Firebase.
//    La sacás de: consola de Firebase > ⚙️ Configuración del proyecto >
//    "Tus apps" > app Web > SDK de Firebase > Configuración.
// =====================================================================
const firebaseConfig = {
  apiKey: "AIzaSyCmV_-1faY9_GjycVd-ltibHpbEvrIakn4",
  authDomain: "planboda.firebaseapp.com",
  projectId: "planboda",
  storageBucket: "planboda.firebasestorage.app",
  messagingSenderId: "175637691182",
  appId: "1:175637691682:web:66dcf368fcd9fdfb3958bf"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
