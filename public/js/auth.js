// Authentication Module
class AuthManager {
  constructor() {
    this.auth = window.firebaseAuth;
    this.db = window.firebaseDb;
  }

  // Sign up with email and password
  async signUp(email, password, displayName) {
    try {
      const userCredential = await this.auth.createUserWithEmailAndPassword(email, password);
      const user = userCredential.user;
      
      // Update display name
      await user.updateProfile({
        displayName: displayName
      });
      
      // Create user document in Firestore
      await this.db.collection('users').doc(user.uid).set({
        displayName: displayName,
        email: email,
        createdAt: new Date(),
        profileComplete: false,
        isActive: true
      });
      
      console.log('User signed up successfully:', user.uid);
      return { success: true, user };
    } catch (error) {
      console.error('Sign up error:', error);
      return { success: false, error: error.message };
    }
  }

  // Sign in with email and password
  async signIn(email, password) {
    try {
      const userCredential = await this.auth.signInWithEmailAndPassword(email, password);
      const user = userCredential.user;
      console.log('User signed in successfully:', user.uid);
      return { success: true, user };
    } catch (error) {
      console.error('Sign in error:', error);
      return { success: false, error: error.message };
    }
  }

  // Sign out
  async signOut() {
    try {
      await this.auth.signOut();
      console.log('User signed out successfully');
      return { success: true };
    } catch (error) {
      console.error('Sign out error:', error);
      return { success: false, error: error.message };
    }
  }

  // Get current user
  getCurrentUser() {
    return this.auth.currentUser;
  }

  // Check if user is authenticated
  isAuthenticated() {
    return this.auth.currentUser !== null;
  }

  // Password reset
  async resetPassword(email) {
    try {
      await this.auth.sendPasswordResetEmail(email);
      return { success: true };
    } catch (error) {
      console.error('Password reset error:', error);
      return { success: false, error: error.message };
    }
  }

  // Listen for auth state changes
  onAuthStateChanged(callback) {
    return this.auth.onAuthStateChanged(callback);
  }
}

// Export auth manager instance
window.authManager = new AuthManager();
