import { Text, View } from "react-native";

type IconProps = { size?: number; color?: string };

export function MicIcon({ size = 108, color = "#FFFFFF" }: IconProps) {
  const capsuleW = size * 0.34;
  const capsuleH = size * 0.48;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: capsuleW,
          height: capsuleH,
          borderRadius: capsuleW / 2,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          marginTop: size * 0.04,
          width: size * 0.5,
          height: size * 0.08,
          borderBottomLeftRadius: size * 0.2,
          borderBottomRightRadius: size * 0.2,
          borderWidth: size * 0.06,
          borderTopWidth: 0,
          borderColor: color,
          backgroundColor: "transparent",
        }}
      />
      <View
        style={{
          width: size * 0.08,
          height: size * 0.12,
          backgroundColor: color,
          marginTop: 1,
        }}
      />
    </View>
  );
}

/** WhatsApp-style send chevron; flips for RTL (points toward the start side). */
export function SendArrowIcon({
  size = 22,
  color = "#FFFFFF",
  rtl = false,
}: IconProps & { rtl?: boolean }) {
  const wing = size * 0.42;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ scaleX: rtl ? -1 : 1 }],
      }}
    >
      <View
        style={{
          width: 0,
          height: 0,
          borderTopWidth: wing * 0.72,
          borderBottomWidth: wing * 0.72,
          borderLeftWidth: wing * 1.15,
          borderTopColor: "transparent",
          borderBottomColor: "transparent",
          borderLeftColor: color,
          marginLeft: size * 0.08,
        }}
      />
    </View>
  );
}

export function PeopleIcon({ size = 34, color = "#FFFFFF" }: IconProps) {
  const head = size * 0.26;
  const bodyW = size * 0.4;
  const bodyH = size * 0.24;
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ position: "absolute", left: size * 0.06, top: size * 0.26, alignItems: "center" }}>
        <View style={{ width: head, height: head, borderRadius: head / 2, backgroundColor: color }} />
        <View
          style={{
            width: bodyW,
            height: bodyH,
            borderTopLeftRadius: bodyW / 2,
            borderTopRightRadius: bodyW / 2,
            backgroundColor: color,
            marginTop: 3,
          }}
        />
      </View>
      <View style={{ position: "absolute", right: size * 0.02, top: size * 0.16, alignItems: "center" }}>
        <View style={{ width: head * 1.08, height: head * 1.08, borderRadius: 99, backgroundColor: color }} />
        <View
          style={{
            width: bodyW * 1.05,
            height: bodyH,
            borderTopLeftRadius: bodyW / 2,
            borderTopRightRadius: bodyW / 2,
            backgroundColor: color,
            marginTop: 3,
          }}
        />
      </View>
    </View>
  );
}

export function BellIcon({ size = 28, color = "#FFFFFF" }: IconProps) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: size * 0.16, height: size * 0.1, borderRadius: 99, backgroundColor: color }} />
      <View
        style={{
          width: size * 0.56,
          height: size * 0.46,
          borderTopLeftRadius: size * 0.28,
          borderTopRightRadius: size * 0.28,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          width: size * 0.72,
          height: size * 0.1,
          borderRadius: 3,
          backgroundColor: color,
          marginTop: 1,
        }}
      />
      <View
        style={{
          width: size * 0.14,
          height: size * 0.14,
          borderRadius: 99,
          backgroundColor: color,
          marginTop: 2,
        }}
      />
    </View>
  );
}

export function WalkieIcon({ size = 28, color = "#FFFFFF" }: IconProps) {
  return (
    <View style={{ width: size, height: size, alignItems: "center" }}>
      <View style={{ width: 2, height: size * 0.18, backgroundColor: color, borderRadius: 1 }} />
      <View
        style={{
          width: size * 0.58,
          height: size * 0.68,
          borderRadius: size * 0.12,
          borderWidth: 2,
          borderColor: color,
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
        }}
      >
        <View style={{ width: size * 0.28, height: size * 0.14, borderRadius: 3, backgroundColor: color }} />
        <View style={{ width: size * 0.16, height: size * 0.16, borderRadius: size * 0.08, borderWidth: 2, borderColor: color }} />
      </View>
    </View>
  );
}

export function ChatIcon({ size = 28, color = "#FFFFFF" }: IconProps) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: size * 0.72,
          height: size * 0.5,
          borderRadius: size * 0.2,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          width: size * 0.2,
          height: size * 0.2,
          backgroundColor: color,
          transform: [{ rotate: "45deg" }],
          marginTop: -size * 0.1,
          marginRight: size * 0.22,
        }}
      />
    </View>
  );
}

/** Ionicons "call" handset (U+EAD9). `down` is the hang-up pose. */
const PHONE_GLYPH = "\uEAD9";

export function PhoneIcon({ size = 28, color = "#FFFFFF", down = false }: IconProps & { down?: boolean }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ rotate: down ? "135deg" : "0deg" }],
      }}
    >
      <Text
        allowFontScaling={false}
        style={{
          fontFamily: "ionicons",
          fontSize: size * 0.92,
          lineHeight: size,
          color,
          includeFontPadding: false,
          textAlign: "center",
        }}
      >
        {PHONE_GLYPH}
      </Text>
    </View>
  );
}

export function MicOffIcon({ size = 28, color = "#FFFFFF" }: IconProps) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <MicIcon size={size * 0.86} color={color} />
      <View
        style={{
          position: "absolute",
          width: size * 0.82,
          height: Math.max(3, size * 0.09),
          borderRadius: 2,
          backgroundColor: color,
          transform: [{ rotate: "-42deg" }],
        }}
      />
    </View>
  );
}

function IonGlyph({ glyph, size, color }: { glyph: string; size: number; color: string }) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Text
        allowFontScaling={false}
        style={{
          fontFamily: "ionicons",
          fontSize: size,
          lineHeight: size,
          color,
          includeFontPadding: false,
          textAlign: "center",
        }}
      >
        {glyph}
      </Text>
    </View>
  );
}

/** Ionicons videocam. */
export function VideoIcon({ size = 28, color = "#FFFFFF" }: IconProps) {
  return <IonGlyph glyph={"\uEF0E"} size={size} color={color} />;
}

/** Navigation chevron: left in LTR, right in RTL. */
export function BackChevronIcon({ size = 24, color = "#111B21", rtl = false }: IconProps & { rtl?: boolean }) {
  const thick = Math.max(2.2, size * 0.13);
  const arm = size * 0.36;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: arm,
          height: arm,
          borderColor: color,
          transform: [{ rotate: "45deg" }],
          ...(rtl
            ? { borderTopWidth: thick, borderRightWidth: thick, marginLeft: -size * 0.06 }
            : { borderBottomWidth: thick, borderLeftWidth: thick, marginLeft: size * 0.06 }),
        }}
      />
    </View>
  );
}

/** WhatsApp-style reply (curved arrow to the left). */
export function ReplyArrowIcon({ size = 22, color = "#111B21" }: IconProps) {
  const w = Math.max(1.8, size * 0.1);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          position: "absolute",
          left: size * 0.14,
          top: size * 0.22,
          width: size * 0.3,
          height: size * 0.3,
          borderLeftWidth: w,
          borderBottomWidth: w,
          borderColor: color,
          transform: [{ rotate: "45deg" }],
        }}
      />
      <View
        style={{
          position: "absolute",
          left: size * 0.22,
          top: size * 0.36,
          width: size * 0.46,
          height: w,
          backgroundColor: color,
          borderRadius: 1,
        }}
      />
      <View
        style={{
          position: "absolute",
          right: size * 0.22,
          top: size * 0.36,
          width: w,
          height: size * 0.28,
          backgroundColor: color,
          borderBottomLeftRadius: size * 0.12,
          borderBottomRightRadius: size * 0.12,
        }}
      />
    </View>
  );
}

/** WhatsApp-style forward (curved arrow to the right). */
export function ForwardArrowIcon({ size = 22, color = "#111B21" }: IconProps) {
  return (
    <View style={{ width: size, height: size, transform: [{ scaleX: -1 }] }}>
      <ReplyArrowIcon size={size} color={color} />
    </View>
  );
}

/** WhatsApp-style trash can. */
export function TrashIcon({ size = 22, color = "#111B21" }: IconProps) {
  const w = Math.max(1.7, size * 0.09);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: size * 0.18, height: w, backgroundColor: color, borderRadius: 1, marginBottom: 2 }} />
      <View style={{ width: size * 0.62, height: w, backgroundColor: color, borderRadius: 1, marginBottom: 2 }} />
      <View
        style={{
          width: size * 0.5,
          height: size * 0.48,
          borderWidth: w,
          borderColor: color,
          borderRadius: 3,
          borderTopWidth: 0,
        }}
      />
    </View>
  );
}

/** WhatsApp-style copy (two overlapping pages). */
export function CopyPagesIcon({ size = 22, color = "#111B21" }: IconProps) {
  const w = Math.max(1.6, size * 0.09);
  const box = size * 0.46;
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: "absolute",
          top: size * 0.14,
          left: size * 0.14,
          width: box,
          height: box * 1.15,
          borderWidth: w,
          borderColor: color,
          borderRadius: 3,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: size * 0.3,
          left: size * 0.3,
          width: box,
          height: box * 1.15,
          borderWidth: w,
          borderColor: color,
          borderRadius: 3,
          backgroundColor: "#FFFFFF",
        }}
      />
    </View>
  );
}

/** Three vertical dots (overflow menu). */
export function MoreVertIcon({ size = 22, color = "#111B21" }: IconProps) {
  const dot = Math.max(3, size * 0.18);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", gap: Math.max(2, size * 0.1) }}>
      <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }} />
      <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }} />
      <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }} />
    </View>
  );
}

/** Ionicons videocam-off. Shown while the camera is live: the next tap stops it. */
export function VideoOffIcon({ size = 28, color = "#FFFFFF" }: IconProps) {
  return <IonGlyph glyph={"\uEF0F"} size={size} color={color} />;
}

/** Outline camera for the chat composer. */
export function CameraIcon({ size = 22, color = "#54656F" }: IconProps) {
  const bodyW = size * 0.72;
  const bodyH = size * 0.5;
  const lens = size * 0.28;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: bodyW,
          height: bodyH,
          borderRadius: 4,
          borderWidth: 2,
          borderColor: color,
          alignItems: "center",
          justifyContent: "center",
          marginTop: size * 0.12,
        }}
      >
        <View style={{ width: lens, height: lens, borderRadius: lens / 2, borderWidth: 2, borderColor: color }} />
      </View>
      <View
        style={{
          position: "absolute",
          top: size * 0.12,
          width: size * 0.22,
          height: size * 0.14,
          borderTopLeftRadius: 3,
          borderTopRightRadius: 3,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

/** Ionicons camera-reverse. One tap swaps front and back. */
export function FlipCameraIcon({ size = 28, color = "#FFFFFF" }: IconProps) {
  return <IonGlyph glyph={"\uEADE"} size={size} color={color} />;
}

export function SpeakerIcon({ size = 28, color = "#FFFFFF" }: IconProps) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", flexDirection: "row" }}>
      <View
        style={{
          width: size * 0.18,
          height: size * 0.28,
          borderRadius: 3,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          width: 0,
          height: 0,
          borderTopWidth: size * 0.2,
          borderBottomWidth: size * 0.2,
          borderRightWidth: size * 0.2,
          borderTopColor: "transparent",
          borderBottomColor: "transparent",
          borderRightColor: color,
        }}
      />
      <View style={{ marginLeft: 3, gap: 3 }}>
        <View
          style={{
            width: size * 0.14,
            height: size * 0.14,
            borderRadius: size * 0.07,
            borderWidth: 2,
            borderColor: color,
            borderLeftColor: "transparent",
            borderBottomColor: "transparent",
            transform: [{ rotate: "45deg" }],
          }}
        />
        <View
          style={{
            width: size * 0.22,
            height: size * 0.22,
            borderRadius: size * 0.11,
            borderWidth: 2,
            borderColor: color,
            borderLeftColor: "transparent",
            borderBottomColor: "transparent",
            transform: [{ rotate: "45deg" }],
            marginLeft: 2,
          }}
        />
      </View>
    </View>
  );
}

export function DualDotIcon({ size = 22, color = "#FFFFFF" }: IconProps) {
  const d = size * 0.34;
  return (
    <View style={{ width: size, height: size, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}>
      <View style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: color }} />
      <View style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: color }} />
    </View>
  );
}

export function SearchIcon({ size = 22, color = "#FFFFFF" }: IconProps) {
  const r = size * 0.34;
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: "absolute",
          left: size * 0.12,
          top: size * 0.08,
          width: r * 2,
          height: r * 2,
          borderRadius: r,
          borderWidth: 2.6,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: size * 0.4,
          height: 3,
          backgroundColor: color,
          borderRadius: 2,
          right: size * 0.04,
          bottom: size * 0.16,
          transform: [{ rotate: "45deg" }],
        }}
      />
    </View>
  );
}

export function HistoryIcon({ size = 26, color = "#FFFFFF" }: IconProps) {
  return (
    <View style={{ width: size, height: size, justifyContent: "center", gap: size * 0.12 }}>
      <View style={{ height: 3, borderRadius: 2, backgroundColor: color, width: "100%" }} />
      <View style={{ height: 3, borderRadius: 2, backgroundColor: color, width: "78%" }} />
      <View style={{ height: 3, borderRadius: 2, backgroundColor: color, width: "56%" }} />
    </View>
  );
}

export function GenderIcon({
  gender = "male",
  size = 40,
  color = "#B8D4FF",
}: IconProps & { gender?: "male" | "female" | "child" }) {
  const child = gender === "child";
  const female = gender === "female";
  const head = size * (child ? 0.3 : 0.26);
  const bodyW = size * (female ? 0.7 : child ? 0.46 : 0.56);
  const bodyH = size * (child ? 0.28 : 0.36);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "flex-end", paddingBottom: size * 0.06 }}>
      {female ? (
        <View
          style={{
            position: "absolute",
            top: size * 0.08,
            width: head * 1.55,
            height: head * 0.7,
            borderTopLeftRadius: head,
            borderTopRightRadius: head,
            backgroundColor: color,
          }}
        />
      ) : null}
      <View
        style={{
          width: head,
          height: head,
          borderRadius: head / 2,
          backgroundColor: color,
          marginBottom: 3,
        }}
      />
      <View
        style={{
          width: bodyW,
          height: bodyH,
          backgroundColor: color,
          borderTopLeftRadius: female ? bodyW / 2 : bodyW * 0.45,
          borderTopRightRadius: female ? bodyW / 2 : bodyW * 0.45,
          borderBottomLeftRadius: female ? 2 : bodyW * 0.2,
          borderBottomRightRadius: female ? 2 : bodyW * 0.2,
        }}
      />
    </View>
  );
}
