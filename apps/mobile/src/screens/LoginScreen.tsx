import React from 'react';
import { ActivityIndicator, SafeAreaView, Text, TouchableOpacity, View } from 'react-native';
import { useAuthStore } from '../store/authStore';
import { colors, ui } from '../theme';

export default function LoginScreen() {
  const { signIn, loading, error } = useAuthStore();

  return (
    <SafeAreaView style={ui.screen}>
      <View style={ui.centered}>
        <Text style={[ui.title, { fontSize: 32, color: colors.primary }]}>OpenPrivy</Text>
        <Text style={[ui.body, { textAlign: 'center', color: colors.muted, marginBottom: 32 }]}>
          A crypto wallet that works like any other account. New here? The same button creates your account.
        </Text>
        {error && <Text style={[ui.error, { alignSelf: 'stretch' }]}>{error}</Text>}
        <TouchableOpacity
          style={[ui.button, { alignSelf: 'stretch' }, loading && ui.disabled]}
          onPress={signIn}
          disabled={loading}
          accessibilityRole="button"
        >
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={ui.buttonText}>Continue</Text>}
        </TouchableOpacity>
        <Text style={[ui.label, { marginTop: 16, textAlign: 'center' }]}>
          Sign in with your work SSO, Google, or email.
        </Text>
      </View>
    </SafeAreaView>
  );
}
