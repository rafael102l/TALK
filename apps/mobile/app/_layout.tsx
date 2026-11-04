import "react-native-gesture-handler";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { I18nManager } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../src/lib/auth";
import { I18nProvider } from "../src/i18n";
import { TargetsProvider } from "../src/lib/targets";
import { colors } from "../src/lib/theme";

I18nManager.allowRTL(true);
// Preload the Ionicons font so raw <Text fontFamily="ionicons"> glyphs
// (PhoneIcon/VideoIcon/etc. in MirsIcons) render immediately instead of
// falling back to a CJK system glyph before any @expo/vector-icons mounts.
void Ionicons.loadFont();

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <I18nProvider>
          <TargetsProvider>
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
              }}
            />
          </TargetsProvider>
        </I18nProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
