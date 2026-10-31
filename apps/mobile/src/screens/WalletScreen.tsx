import React, { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, SafeAreaView, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { useAuthStore } from '../store/authStore';
import { useWallet } from '../hooks/useWallet';
import { colors, ui } from '../theme';

export default function WalletScreen({ navigation }: any) {
  const { user } = useAuthStore();
  const { wallet, balance, loading, error, refresh, createWallet } = useWallet();
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  if (loading) {
    return (
      <View style={ui.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={ui.screen}>
      <ScrollView
        contentContainerStyle={ui.pad}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
          />
        }
      >
        <Text style={ui.label}>{user?.email}</Text>
        {error && <Text style={ui.error}>{error}</Text>}
        {wallet ? (
          <View style={ui.card}>
            <Text style={ui.label}>Balance (Ethereum)</Text>
            {balance === null ? (
              <Text style={[ui.body, { color: colors.muted, marginBottom: 16 }]}>
                Your balance cannot be loaded right now. Pull down to refresh.
              </Text>
            ) : (
              <Text style={{ fontSize: 32, fontWeight: 'bold', color: colors.primary, marginBottom: 16 }}>{balance} ETH</Text>
            )}
            <Text style={ui.label}>Your address</Text>
            <Text style={[ui.mono, { marginBottom: 8 }]} selectable>
              {wallet.address}
            </Text>
            <TouchableOpacity
              onPress={async () => {
                await Clipboard.setStringAsync(wallet.address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              accessibilityRole="button"
            >
              <Text style={{ color: colors.primary, marginBottom: 16 }}>{copied ? 'Copied' : 'Copy address'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={() => navigation.navigate('SendTab')} accessibilityRole="button">
              <Text style={ui.buttonText}>Send</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={ui.card}>
            <Text style={[ui.body, { marginBottom: 16 }]}>You do not have a wallet yet. Create one to receive and send ETH.</Text>
            <TouchableOpacity
              style={[ui.button, creating && ui.disabled]}
              disabled={creating}
              onPress={async () => {
                setCreating(true);
                await createWallet();
                setCreating(false);
              }}
              accessibilityRole="button"
            >
              <Text style={ui.buttonText}>{creating ? 'Creating…' : 'Create wallet'}</Text>
            </TouchableOpacity>
          </View>
        )}
        <Text style={[ui.label, { marginTop: 8 }]}>
          Your private key is encrypted and held by OpenPrivy, so there is no seed phrase to write down.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
