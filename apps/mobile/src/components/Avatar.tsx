import { Image, StyleSheet, View } from "react-native";
import { VoiceGender } from "@talk/shared";
import { colors } from "../lib/theme";
import { GenderIcon } from "./MirsIcons";

export function Avatar({
  uri,
  name,
  size = 46,
  gender = "male",
  ringColor = colors.ring,
}: {
  uri?: string | null;
  name: string;
  size?: number;
  gender?: VoiceGender;
  ringColor?: string;
}) {
  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: ringColor,
        },
      ]}
    >
      {uri ? (
        <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} />
      ) : (
        <GenderIcon gender={gender} size={Math.round(size * 0.78)} color={colors.ring} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.bgDeep,
    borderWidth: 3,
    borderColor: colors.ring,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
