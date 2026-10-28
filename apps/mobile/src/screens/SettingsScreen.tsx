import React, { useEffect, useState } from 'react';
import { Alert, SafeAreaView, ScrollView, Switch, Text, TouchableOpacity, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useAuthStore } from '../store/authStore';
import { isBiometricLockOn, setBiometricLock } from '../lib/secureSession';
import { colors, ui } from '../theme';

export default function SettingsScreen() {
  const { user, token, signOut } = useAuthStore();
  const [lockOn, setLockOn] = useState(false);
  const [lockAvailable, setLockAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      setLockOn(await isBiometricLockOn());
      setLockAvailable((await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync()));
    })();
  }, []);

  const toggleLock = async (next: boolean) => {
    setBusy(true);
    try {
      // Prove it's the device owner before changing how the session is protected.
      const check = await LocalAuthentication.authenticateAsync({
        promptMessage: next ? 'Turn on biometric lock' : 'Turn off biometric lock',
      });
      if (!check.success) return;
      await setBiometricLock(next, token);
      setLockOn(next);
    } catch {
      Alert.alert('Could not change the lock', 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={ui.screen}>
      <ScrollView contentContainerStyle={ui.pad}>
        <View style={ui.card}>
          <Text style={ui.label}>Signed in as</Text>
          <Text style={ui.body}>{user?.email}</Text>
        </View>

        <View style={ui.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={[ui.body, { fontWeight: '600' }]}>Biometric lock</Text>
              <Text style={ui.label}>
                {lockAvailable
                  ? 'Require Face ID or fingerprint to open OpenPrivy. Transfers always ask for confirmation.'
                  : 'Set up Face ID or fingerprint in your device settings to use this.'}
              </Text>
            </View>
            <Switch
              value={lockOn}
              onValueChange={toggleLock}
              disabled={!lockAvailable || busy}
              trackColor={{ false: colors.border, true: colors.primary }}
              accessibilityLabel="Biometric lock"
            />
          </View>
        </View>

        <TouchableOpacity
          style={ui.secondaryButton}
          onPress={() =>
            Alert.alert('Sign out', 'You will need to sign in again to use your wallet.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
            ])
          }
          accessibilityRole="button"
        >
          <Text style={[ui.secondaryText, { color: colors.danger }]}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
