import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc, query, where, orderBy } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';
import { getAuth, GoogleAuthProvider, signInWithCredential } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';

const firebaseConfig = {
  apiKey:            'AIzaSyCW5akGNm78Gum_xq4j5dMFKUjhDr1pjOg',
  authDomain:        'project-9718e7d4-4cd7-4f52-8d6.firebaseapp.com',
  projectId:         'project-9718e7d4-4cd7-4f52-8d6',
  storageBucket:     'project-9718e7d4-4cd7-4f52-8d6.firebasestorage.app',
  messagingSenderId: '6445860840',
  appId:             '1:6445860840:web:df91ec5752fddb27a8865d'
};

const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// Авторизуем пользователя в Firebase через Google ID token
async function firebaseSignIn(idToken) {
  const credential = GoogleAuthProvider.credential(idToken);
  await signInWithCredential(auth, credential);
}

// Сохранить метаданные файла
async function saveFileRecord(folderId, folderName, fileName, fileUrl, fileSize, uploadedBy) {
  return await addDoc(collection(db, 'files'), {
    folderId,
    folderName,
    fileName,
    fileUrl,
    fileSize,
    uploadedBy,
    uploadedAt: new Date().toISOString(),
  });
}

// Получить файлы из папки
async function getFilesByFolder(folderId) {
  const q = query(
    collection(db, 'files'),
    where('folderId', '==', folderId),
    orderBy('uploadedAt', 'desc')
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Удалить запись о файле
async function deleteFileRecord(docId) {
  await deleteDoc(doc(db, 'files', docId));
}

export { db, auth, firebaseSignIn, saveFileRecord, getFilesByFolder, deleteFileRecord };
