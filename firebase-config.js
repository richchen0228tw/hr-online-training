// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// TODO: Replace the following with your app's Firebase project configuration
// See: https://firebase.google.com/docs/web/setup#available-libraries
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

export { db };
