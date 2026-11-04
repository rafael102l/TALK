import { useEffect, useState } from "react";
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
  // Smooth fallback: if the photo fails to load, retry once, then fall back to
  // the default gender icon instead of showing a blank circle.
  const [broken, setBroken] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    setBroken(false);
    setTries(0);
  }, [uri]);
  const showPhoto = Boolean(uri) && !broken;
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
      {showPhoto ? (
        <Image
          key={`${uri}-${tries}`}
          source={{ uri: uri as string }}
          onError={() => {
            if (tries < 1) setTries(1);
            else setBroken(true);
          }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
        />
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
