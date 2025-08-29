// Firebase Configuration
// Replace with your actual Firebase config
const firebaseConfig = {
  apiKey: "your-api-key-here",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Initialize Firebase services
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

// Export for use in other modules
window.firebaseAuth = auth;
window.firebaseDb = db;
window.firebaseStorage = storage;

// Set up auth state observer
auth.onAuthStateChanged((user) => {
  if (user) {
    console.log('User signed in:', user.uid);
    // User is signed in
    window.currentUser = user;
  } else {
    console.log('User signed out');
    // User is signed out
    window.currentUser = null;
  }
});
