import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { api, errorMessage } from '../lib/api';
import { validateAmount, validateRecipient } from '../lib/validation';
import { useWallet } from '../hooks/useWallet';
import { colors, ui } from '../theme';

type Step = { kind: 'edit' } | { kind: 'review'; to: string; eth: string } | { kind: 'sent'; txHash?: string };

/** Asks for Face ID / fingerprint (or the device passcode) before a transfer, when the device supports it. */
async function confirmWithDevice(eth: string): Promise<boolean> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const enrolled = hasHardware && (await LocalAuthentication.isEnrolledAsync());
  if (!enrolled) return true;
  const result = await LocalAuthentication.authenticateAsync({ promptMessage: `Confirm sending ${eth} ETH` });
  return result.success;
}

export default function SendScreen({ navigation }: any) {
  const { wallet, balance, loading } = useWallet();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [fieldError, setFieldError] = useState<{ to?: string; amount?: string }>({});
  const [step, setStep] = useState<Step>({ kind: 'edit' });
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  if (loading) {
    return (
      <View style={ui.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }
  if (!wallet) {
    return (
      <View style={ui.centered}>
        <Text style={ui.body}>Create a wallet on the Wallet tab first.</Text>
      </View>
    );
  }

  const review = () => {
    const r = validateRecipient(to, wallet.address);
    const a = validateAmount(amount, balance ?? undefined);
    setFieldError({ to: r.ok ? undefined : r.error, amount: a.ok ? undefined : a.error });
    if (r.ok && a.ok) {
      setSendError(null);
      setStep({ kind: 'review', to: r.value, eth: a.value.eth });
    }
  };

  const send = async () => {
    if (step.kind !== 'review') return;
    if (!(await confirmWithDevice(step.eth))) return;
    setSubmitting(true);
    setSendError(null);
    try {
      const { data } = await api.post('/transactions/send', { walletId: wallet.id, to: step.to, amount: step.eth });
      setStep({ kind: 'sent', txHash: data?.txHash });
      setTo('');
      setAmount('');
    } catch (err: any) {
      setSendError(
        err?.response?.status === 403
          ? 'This transfer was blocked by OpenPrivy’s compliance checks and was not sent. Contact support if you think this is a mistake.'
          : errorMessage(err, 'The transfer was not sent.'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={ui.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled">
          {step.kind === 'edit' && (
            <View style={ui.card}>
              <Text style={ui.label}>Recipient address</Text>
              <TextInput
                style={[ui.input, ui.mono]}
                value={to}
                onChangeText={setTo}
                placeholder="0x…"
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Recipient address"
              />
              {fieldError.to && <Text style={ui.fieldError}>{fieldError.to}</Text>}

              <Text style={[ui.label, { marginTop: 16 }]}>Amount (ETH)</Text>
              <TextInput
                style={ui.input}
                value={amount}
                onChangeText={setAmount}
                placeholder="0.00"
                keyboardType="decimal-pad"
                accessibilityLabel="Amount in ETH"
              />
              {fieldError.amount ? (
                <Text style={ui.fieldError}>{fieldError.amount}</Text>
              ) : (
                <Text style={[ui.label, { marginTop: 4 }]}>Available: {balance ?? '—'} ETH. Network fees are added on top.</Text>
              )}

              <TouchableOpacity style={[ui.button, { marginTop: 20 }]} onPress={review} accessibilityRole="button">
                <Text style={ui.buttonText}>Review</Text>
              </TouchableOpacity>
            </View>
          )}

          {step.kind === 'review' && (
            <View style={ui.card}>
              <Text style={[ui.body, { marginBottom: 16 }]}>Check every character of the address. Transfers cannot be reversed.</Text>
              <Text style={ui.label}>To</Text>
              <Text style={[ui.mono, { marginBottom: 12 }]} selectable>
                {step.to}
              </Text>
              <Text style={ui.label}>Amount</Text>
              <Text style={{ fontSize: 22, fontWeight: 'bold', color: colors.text, marginBottom: 16 }}>{step.eth} ETH</Text>
              {sendError && <Text style={ui.error}>{sendError}</Text>}
              <TouchableOpacity
                style={[ui.button, submitting && ui.disabled]}
                onPress={send}
                disabled={submitting}
                accessibilityRole="button"
              >
                {submitting ? <ActivityIndicator color="#fff" /> : <Text style={ui.buttonText}>Send {step.eth} ETH</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={[ui.secondaryButton, { marginTop: 12 }]}
                onPress={() => setStep({ kind: 'edit' })}
                disabled={submitting}
                accessibilityRole="button"
              >
                <Text style={ui.secondaryText}>Edit</Text>
              </TouchableOpacity>
            </View>
          )}

          {step.kind === 'sent' && (
            <View style={ui.card}>
              <Text style={[ui.title, { fontSize: 20 }]}>Transfer submitted</Text>
              {step.txHash && (
                <Text style={ui.mono} selectable>
                  {step.txHash}
                </Text>
              )}
              <TouchableOpacity
                style={[ui.button, { marginTop: 20 }]}
                onPress={() => {
                  setStep({ kind: 'edit' });
                  navigation.navigate('WalletTab');
                }}
                accessibilityRole="button"
              >
                <Text style={ui.buttonText}>Back to wallet</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
