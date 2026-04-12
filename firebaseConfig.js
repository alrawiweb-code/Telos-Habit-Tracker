import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCredential, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyDpfopxwpl-ZaNHHd9IwKM2Tm45kJyJp6A",
  authDomain: "telos-habit.firebaseapp.com",
  projectId: "telos-habit",
  storageBucket: "telos-habit.firebasestorage.app",
  messagingSenderId: "586803424168",
  appId: "1:586803424168:web:bc2ba7049b88084ca70b9d",
  measurementId: "G-BMXHSPME3Y"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db, signInWithCredential, GoogleAuthProvider };
