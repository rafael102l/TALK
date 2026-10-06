import { VoiceGender } from "@talk/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/theme";
import { Avatar } from "./Avatar";
import { SpeakerIcon } from "./MirsIcons";

export type RosterPerson = {
  id: string;
  name: string;
  photo?: string | null;
  gender?: VoiceGender;
  pendingCount?: number;
};

export type PresenceKind = "offline" | "online" | "talking" | "receiving";

const ROW = 88;
const COL_W = 92;

export function SelectedRoster({
  people,
  speakingId,
  focusedId,
  activeTalkId,
  pendingId,
  onlineIds,
  mutedIds,
  onFocus,
  onRemove,
  onToggleMute,
}: {
  people: RosterPerson[];
  speakingId?: string | null;
  focusedId?: string | null;
  /** Cyan pulse: I am recording to them, or they are recording to me */
  activeTalkId?: string | null;
  pendingId?: string | null;
  onlineIds?: Set<string> | Record<string, boolean>;
  mutedIds?: Record<string, boolean>;
  onFocus: (id: string) => void;
  onRemove: (id: string) => void;
  onToggleMute: (id: string) => void;
}) {
  const [height, setHeight] = useState(0);
  const [armedId, setArmedId] = useState<string | null>(null);
  if (!people.length) return null;
  const perCol = Math.max(1, Math.floor(Math.max(height, ROW) / ROW));
  const cols: RosterPerson[][] = [];
  people.forEach((person, index) => {
    const col = Math.floor(index / perCol);
    if (!cols[col]) cols[col] = [];
    cols[col].push(person);
  });

  function isOnline(id: string) {
    if (!onlineIds) return false;
    if (onlineIds instanceof Set) return onlineIds.has(id);
    return Boolean(onlineIds[id]);
  }

  return (
    <View
      style={styles.wrap}
      pointerEvents="box-none"
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
    >
      <View style={styles.grid} pointerEvents="box-none">
        {cols.map((col, index) => (
          <View key={index} style={styles.col} pointerEvents="box-none">
            {col.map((person) => {
              const pending = (person.pendingCount ?? 0) > 0 || pendingId === person.id;
              const receiving = speakingId === person.id;
              const talking = activeTalkId === person.id && !receiving;
              const presence: PresenceKind = receiving
                ? "receiving"
                : talking
                  ? "talking"
                  : isOnline(person.id)
                    ? "online"
                    : "offline";
              const armed = armedId === person.id;
              const muted = Boolean(mutedIds?.[person.id]);
              const count = person.pendingCount ?? (pendingId === person.id ? 1 : 0);
              const ring =
                presence === "receiving"
                  ? colors.receiving
                  : presence === "offline"
                    ? colors.offline
                    : colors.neon;
              return (
                <View key={person.id} style={styles.item}>
                  <Pressable
                    delayPressIn={0}
                    onPress={() => {
                      if (pending) {
                        onFocus(person.id);
                        setArmedId(null);
                        return;
                      }
                      if (focusedId !== person.id) {
                        onFocus(person.id);
                        setArmedId(null);
                        return;
                      }
                      setArmedId(armed ? null : person.id);
                    }}
                  >
                    <StatusMark kind={presence} color={ring}>
                      <Avatar
                        uri={person.photo}
                        name={person.name}
                        size={46}
                        gender={person.gender ?? "male"}
                        ringColor={ring}
                      />
                    </StatusMark>
                    {count > 0 ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{count > 9 ? "9+" : String(count)}</Text>
                      </View>
                    ) : null}
                  </Pressable>
                  {armed && !pending ? (
                    <>
                      <Pressable
                        style={styles.xBtn}
                        onPress={() => {
                          setArmedId(null);
                          onRemove(person.id);
                        }}
                        hitSlop={8}
                      >
                        <Text style={styles.xText}>×</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.spkBtn, muted && styles.spkOff]}
                        onPress={() => onToggleMute(person.id)}
                        hitSlop={8}
                      >
                        <SpeakerIcon size={12} color={muted ? "#E53935" : colors.ring} />
                      </Pressable>
                    </>
                  ) : null}
                  <Text
                    style={[
                      styles.name,
                      presence === "receiving" && styles.nameRecv,
                      (presence === "online" || presence === "talking") && styles.nameOnline,
                    ]}
                    numberOfLines={2}
                  >
                    {person.name}
                  </Text>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

function StatusMark({
  kind,
  color,
  children,
}: {
  kind: PresenceKind;
  color: string;
  children: ReactNode;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const pulsing = kind === "talking" || kind === "receiving";
  useEffect(() => {
    if (!pulsing) {
      pulse.setValue(0);
      return;
    }
    const duration = kind === "receiving" ? 420 : 560;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(0);
    };
  }, [pulsing, kind, pulse]);
  const scale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, kind === "receiving" ? 1.16 : 1.12],
  });
  const glow = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });
  return (
    <View style={styles.mark}>
      {pulsing ? (
        <Animated.View
          style={[
            styles.neon,
            {
              borderColor: color,
              opacity: glow,
              transform: [{ scale: kind === "receiving" ? 1.26 : 1.2 }],
            },
          ]}
        />
      ) : (
        <View style={[styles.neon, styles.neonIdle, { borderColor: color }]} />
      )}
      <Animated.View style={{ transform: [{ scale: pulsing ? scale : 1 }] }}>{children}</Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    // Below the PTT button — never steal the mic press.
    zIndex: 2,
  },
  grid: {
    flexDirection: "row-reverse",
    alignItems: "flex-start",
    gap: 6,
    height: "100%",
  },
  col: { width: COL_W, gap: 8, paddingTop: 2 },
  item: { width: COL_W, height: ROW, alignItems: "center", gap: 2 },
  mark: { width: 58, height: 58, alignItems: "center", justifyContent: "center" },
  neon: {
    position: "absolute",
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 3,
    backgroundColor: "transparent",
  },
  neonIdle: { opacity: 0.85, transform: [{ scale: 1.08 }] },
  badge: {
    position: "absolute",
    top: -2,
    right: 2,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#E53935",
    borderWidth: 2,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    zIndex: 8,
  },
  badgeText: { color: "#FFFFFF", fontSize: 12, fontWeight: "900" },
  xBtn: {
    position: "absolute",
    top: 0,
    left: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#111111",
    borderWidth: 2,
    borderColor: colors.ring,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 6,
  },
  xText: { color: colors.ring, fontSize: 16, fontWeight: "900", marginTop: -1 },
  spkBtn: {
    position: "absolute",
    top: 0,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#111111",
    borderWidth: 2,
    borderColor: colors.ring,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 6,
  },
  spkOff: { borderColor: "#E53935" },
  name: {
    color: colors.offline,
    fontSize: 12,
    fontWeight: "800",
    textAlign: "center",
    width: COL_W,
  },
  nameOnline: { color: colors.neon },
  nameRecv: { color: colors.receiving },
});
