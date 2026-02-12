// Import the functions you need from the SDKs you need
import { initializeApp } from "./lib/firebase/firebase-app.js";
import {
    getFirestore,
    collection, getDocs, addDoc, updateDoc, doc, deleteDoc, query, where, setDoc, getDoc, writeBatch
} from "./lib/firebase/firebase-firestore.js";
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    sendEmailVerification,
    confirmPasswordReset,
    verifyPasswordResetCode
} from "./lib/firebase/firebase-auth.js";

// Firebase project configuration
const firebaseConfig = {
    apiKey: "AIzaSyBwQ8SNvJ_VcLkN9Bx7bop8OYU4fnRlpbM",
    authDomain: "hr-online-training.firebaseapp.com",
    projectId: "hr-online-training",
    storageBucket: "hr-online-training.firebasestorage.app",
    messagingSenderId: "194233859387",
    appId: "1:194233859387:web:4bd4b9be5a7cf4d1050b1e"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();

export {
    db,
    auth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    sendEmailVerification,
    confirmPasswordReset,
    verifyPasswordResetCode,
    collection, getDocs, addDoc, updateDoc, doc, deleteDoc, query, where, setDoc, getDoc, writeBatch
};
