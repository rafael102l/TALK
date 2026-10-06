import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../src/lib/auth";
import { colors } from "../src/lib/theme";

export default function Gate() {
  const { ready, user } = useAuth();
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: "center" }}>
        <ActivityIndicator color={colors.amber} />
      </View>
    );
  }
  if (!user) return <Redirect href="/login" />;
  if (!user.displayName) return <Redirect href="/onboarding/profile" />;
  return <Redirect href="/home" />;
}
