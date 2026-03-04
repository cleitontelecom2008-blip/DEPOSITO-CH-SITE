/**
 * @fileoverview CH Geladas PDV — Firebase Initialization
 * @version 6.0.0-enterprise
 *
 * Responsabilidades:
 *  - Inicializar Firebase App + Firestore
 *  - Expor window.firestoreDB para sync.js
 *  - Principio de responsabilidade única: nada mais aqui
 *
 * ─── SEGURANÇA ──────────────────────────────────────────────────────
 *  As credenciais Firebase para apps web são PÚBLICAS por design —
 *  o Firebase as exige no client-side para identificar o projeto.
 *  A proteção real vem pelas REGRAS DO FIRESTORE (Firebase Console →
 *  Firestore → Rules) e pelo domínio autorizado em Authentication.
 *
 *  ✅ Proteja assim (Firebase Console):
 *    1. Firestore Rules: permita leitura/escrita apenas ao doc do app
 *       rules_version = '2';
 *       service cloud.firestore {
 *         match /databases/{database}/documents {
 *           match /ch_geladas/sistema {
 *             allow read, write: if request.time < timestamp.date(2099,1,1);
 *           }
 *           match /{document=**} {
 *             allow read, write: if false;
 *           }
 *         }
 *       }
 *    2. API Key Restrictions: restrinja a chave no Google Cloud Console
 *       ao domínio de produção (ex: chgeladas.com.br)
 *    3. Firebase Auth: habilite "Authorized domains" apenas para seu domínio
 *
 *  🔒 Em apps com dados sensíveis, use Firebase App Check para garantir
 *     que apenas seu app real consegue acessar o Firestore.
 * ────────────────────────────────────────────────────────────────────
 */

import { initializeApp }       from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, enableNetwork, disableNetwork }
                               from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ═══════════════════════════════════════════════════════════════════
   CONFIGURAÇÃO DO PROJETO
   → Gere e restrinja sua API key em: console.cloud.google.com
   → Restrinja domínios em: console.firebase.google.com → Auth → Settings
═══════════════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = Object.freeze({
  apiKey:            "AIzaSyCPq8-B4l-kThTXtX9CVBTdpzarBObUYxI",
  authDomain:        "ch-geladas.firebaseapp.com",
  projectId:         "ch-geladas",
  storageBucket:     "ch-geladas.firebasestorage.app",
  messagingSenderId: "859746983655",
  appId:             "1:859746983655:web:dce025d5048850923a8c42",
});

/* ═══════════════════════════════════════════════════════════════════
   GERENCIAMENTO DE CONECTIVIDADE
   Sincroniza o estado online/offline do Firebase com a rede real
═══════════════════════════════════════════════════════════════════ */
let _firestoreInstance = null;

function _setupConnectivityListeners(db) {
  // Quando o browser vai offline → pausa tentativas do Firestore
  window.addEventListener('offline', async () => {
    console.info('[Firebase] 📴 Rede offline — pausando Firestore');
    try { await disableNetwork(db); } catch (_) { /* silencioso */ }
    window.dispatchEvent(new CustomEvent('ch:connectivity', { detail: { online: false } }));
  });

  // Quando volta online → retoma Firestore + dispara re-sync
  window.addEventListener('online', async () => {
    console.info('[Firebase] 📶 Rede restaurada — retomando Firestore');
    try { await enableNetwork(db); } catch (_) { /* silencioso */ }
    window.dispatchEvent(new CustomEvent('ch:connectivity', { detail: { online: true } }));
  });
}

/* ═══════════════════════════════════════════════════════════════════
   INICIALIZAÇÃO
═══════════════════════════════════════════════════════════════════ */
try {
  const app   = initializeApp(FIREBASE_CONFIG);
  const db    = getFirestore(app);

  _firestoreInstance = db;

  // Expõe globalmente para sync.js (undefined → aguardar; null → falhou)
  window.firestoreDB = db;

  // Listeners de conectividade (melhora UX offline/online)
  _setupConnectivityListeners(db);

  console.info(
    `[Firebase] ✅ Conectado → ${FIREBASE_CONFIG.projectId}`,
    `| online: ${navigator.onLine}`
  );

} catch (err) {
  console.error('[Firebase] ❌ Falha crítica ao inicializar:', err);

  // null sinaliza para sync.js operar em modo offline imediatamente
  window.firestoreDB = null;
}
