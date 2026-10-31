import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import * as WebBrowser from 'expo-web-browser';
import { useAuthStore } from './store/authStore';
import { colors } from './theme';

import LoginScreen from './screens/LoginScreen';
import WalletScreen from './screens/WalletScreen';
import SendScreen from './screens/SendScreen';
import SettingsScreen from './screens/SettingsScreen';
import SplashScreen from './screens/SplashScreen';

// Completes the auth session if the app was opened by the sign-in redirect.
WebBrowser.maybeCompleteAuthSession();

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function WalletTabs() {
  return (
    <Tab.Navigator screenOptions={{ tabBarActiveTintColor: colors.primary, tabBarInactiveTintColor: colors.muted }}>
      <Tab.Screen name="WalletTab" component={WalletScreen} options={{ title: 'Wallet' }} />
      <Tab.Screen name="SendTab" component={SendScreen} options={{ title: 'Send' }} />
      <Tab.Screen name="SettingsTab" component={SettingsScreen} options={{ title: 'Settings' }} />
    </Tab.Navigator>
  );
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const { user, initializeAuth } = useAuthStore();

  useEffect(() => {
    initializeAuth().finally(() => setBooting(false));
  }, [initializeAuth]);

  if (booting) return <SplashScreen />;

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {user ? (
          <Stack.Screen name="Wallet" component={WalletTabs} />
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} options={{ animation: 'none' }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
