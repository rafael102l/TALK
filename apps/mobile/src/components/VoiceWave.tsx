import { View } from "react-native";
import { colors } from "../lib/theme";

const BARS = [6, 14, 9, 18, 11, 20, 8, 16, 12, 19, 7, 15, 10, 17, 8, 13, 18, 9, 14, 11, 16, 7, 19, 12];

export function VoiceWave({
  progress,
  tint,
  dim,
  seed = 0,
}: {
  progress: number;
  tint?: string;
  dim?: string;
  seed?: number;
}) {
  const on = tint || colors.ring;
  const off = dim || "rgba(255,255,255,0.32)";
  const shift = Math.floor(seed / 90) % BARS.length;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flex: 1, height: 28 }}>
      {BARS.map((base, i) => {
        const h = BARS[(i + shift) % BARS.length] || base;
        const filled = i / BARS.length <= Math.max(0, Math.min(1, progress));
        return (
          <View
            key={i}
            style={{
              width: 2.5,
              height: h,
              borderRadius: 2,
              backgroundColor: filled ? on : off,
            }}
          />
        );
      })}
    </View>
  );
}
