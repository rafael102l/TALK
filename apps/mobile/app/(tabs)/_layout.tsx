import { Redirect, Tabs } from "expo-router";
import { useI18n } from "../../src/i18n";
import { useAuth } from "../../src/lib/auth";
import { colors } from "../../src/lib/theme";

export default function TabsLayout() {
  const { ready, user } = useAuth();
  const { t } = useI18n();
  if (ready && !user) return <Redirect href="/login" />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: "none", height: 0 },
        sceneContainerStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="home" options={{ title: t("broadcast") }} />
      <Tabs.Screen name="people" options={{ title: t("people") }} />
      <Tabs.Screen name="history" options={{ title: t("history") }} />
      <Tabs.Screen name="settings" options={{ title: t("settings") }} />
    </Tabs>
  );
}
