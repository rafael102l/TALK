import { View } from "react-native";

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

export function PhoneIcon({ size = 28, color = "#FFFFFF" }: IconProps) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={{ transform: [{ rotate: "-38deg" }], alignItems: "center" }}>
        <View
          style={{
            width: size * 0.46,
            height: size * 0.22,
            borderRadius: size * 0.11,
            backgroundColor: color,
          }}
        />
        <View style={{ width: size * 0.2, height: size * 0.28, backgroundColor: color }} />
        <View
          style={{
            width: size * 0.46,
            height: size * 0.22,
            borderRadius: size * 0.11,
            backgroundColor: color,
          }}
        />
      </View>
    </View>
  );
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
