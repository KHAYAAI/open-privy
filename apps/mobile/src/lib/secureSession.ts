import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'op_session_token';
const LOCK_KEY = 'op_biometric_lock';

/**
 * The session token lives only in the platform keystore (iOS Keychain,
 * Android Keystore), never in AsyncStorage. It is readable only while the
 * device is unlocked and never restored to another device from a backup.
 * With the biometric lock on, the OS itself refuses to release the token
 * without Face ID / fingerprint (requireAuthentication), so the lock cannot
 * be bypassed by skipping a screen in the app.
 */
function options(biometric: boolean): SecureStore.SecureStoreOptions {
  return {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: biometric,
    authenticationPrompt: 'Unlock OpenPrivy',
  };
}

export async function isBiometricLockOn(): Promise<boolean> {
  return (await SecureStore.getItemAsync(LOCK_KEY)) === 'on';
}

export async function saveToken(token: string): Promise<void> {
  const biometric = await isBiometricLockOn();
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.setItemAsync(TOKEN_KEY, token, options(biometric));
}

/** May show the OS biometric prompt. Returns null if there is no token or the user cancels. */
export async function readToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY, options(await isBiometricLockOn()));
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/** Re-stores the current token under the new protection level. */
export async function setBiometricLock(on: boolean, currentToken: string | null): Promise<void> {
  await SecureStore.setItemAsync(LOCK_KEY, on ? 'on' : 'off', { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (currentToken) await saveToken(currentToken);
}
