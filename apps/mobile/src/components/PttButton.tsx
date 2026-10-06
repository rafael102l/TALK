import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";

const PEARL = "#F3EBDD";
const PILL_W = 118 * 0.38;
const PILL_H = 118 * 0.6;
const PILL_R = 118 * 0.19;

export function PttButton({
  disabled,
  talking,
  busy,
  onPressIn,
  onPressOut,
}: {
  disabled?: boolean;
  talking: boolean;
  busy?: boolean;
  onPressIn: () => void;
  onPressOut: () => void;
}) {
  const fill = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!talking) {
      fill.stopAnimation();
      fill.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(fill, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(fill, { toValue: 0, duration: 120, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [talking, fill]);

  const rise = fill.interpolate({
    inputRange: [0, 1],
    outputRange: [PILL_H, 0],
  });

  return (
    <View style={styles.wrap}>
      <Pressable
        disabled={disabled}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        delayPressIn={0}
        style={[styles.outer, talking && styles.talking, (busy || disabled) && styles.dim]}
      >
        <View style={styles.highlight} />
        <View style={styles.pill}>
          <Animated.View style={[styles.pearl, { transform: [{ translateY: rise }] }]} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
  outer: {
    width: 210,
    height: 210,
    borderRadius: 105,
    backgroundColor: "#1A74EE",
    borderWidth: 3,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    elevation: 10,
    shadowColor: "#003A8C",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
  },
  highlight: {
    position: "absolute",
    top: -20,
    width: 180,
    height: 120,
    borderRadius: 90,
    backgroundColor: "rgba(255,255,255,0.28)",
  },
  pill: {
    width: PILL_W,
    height: PILL_H,
    borderRadius: PILL_R,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
  },
  pearl: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: PILL_H,
    backgroundColor: PEARL,
  },
  talking: { borderWidth: 5, backgroundColor: "#0D5AD4" },
  dim: { opacity: 0.55 },
});
