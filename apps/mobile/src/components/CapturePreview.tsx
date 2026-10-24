import { Video, ResizeMode } from "expo-av";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { EMOJIS } from "./EmojiPicker";
import { SendArrowIcon } from "./MirsIcons";
import type { ChatCapture } from "../lib/capture";
import { useI18n } from "../i18n";
import {
  compressPhoto,
  containRect,
  cropPhoto,
  flattenStage,
  imageSize,
  saveEditedToGallery,
} from "../lib/photoEdit";

type Mode = "idle" | "draw" | "text" | "sticker" | "crop" | "hd";
type Point = { x: number; y: number };
type Stroke = { color: string; width: number; points: Point[] };
type Overlay = { id: string; kind: "text" | "sticker"; value: string; x: number; y: number; scale: number; color: string; size: number };

const COLORS = ["#FFFFFF", "#F5E6C8", "#F2C14E", "#E67E22", "#E74C3C", "#E91E63", "#9B59B6", "#3F51B5", "#1E78F0", "#00BCD4", "#2ECC71", "#111111"];
const BRUSHES = [3, 7, 12, 20];
const TEXT_SIZES = [18, 22, 28, 36, 48];
const STICKERS = ["💬", "💭", "⬜", "⭕", "➡️", "⭐", "❤️", "🔥", "😂", "😍", "☕", "🧁", "🍪", "🌈", "⚡", "💯", "👍", "🙏", "🎉", "✨", ...EMOJIS];

export function CapturePreview({
  capture,
  peerName,
  onSend,
  onCancel,
}: {
  capture: ChatCapture | null;
  peerName?: string;
  onSend: (result: { uri: string; viewOnce: boolean; caption: string }) => void;
  onCancel: () => void;
}) {
  const { t, rtl } = useI18n();
  const [uri, setUri] = useState(capture?.uri || "");
  const [mode, setMode] = useState<Mode>("idle");
  const [viewOnce, setViewOnce] = useState(false);
  const [onceHelp, setOnceHelp] = useState(false);
  const [caption, setCaption] = useState("");
  const [color, setColor] = useState("#2ECC71");
  const [brush, setBrush] = useState(7);
  const [textSize, setTextSize] = useState(28);
  const [hd, setHd] = useState(false);
  const [paths, setPaths] = useState<Stroke[]>([]);
  const [live, setLive] = useState<Point[]>([]);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [draft, setDraft] = useState("");
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [crop, setCrop] = useState({ x: 24, y: 80, w: 200, h: 280 });
  const [busy, setBusy] = useState(false);
  const stageRef = useRef<View>(null);
  const liveRef = useRef<Point[]>([]);
  const dragRef = useRef<{ id: string; dx: number; dy: number; startScale: number } | null>(null);

  useEffect(() => {
    setUri(capture?.uri || "");
    setMode("idle");
    setViewOnce(false);
    setOnceHelp(false);
    setCaption("");
    setPaths([]);
    setOverlays([]);
    setDraft("");
    setHd(false);
  }, [capture?.uri]);

  const photo = capture?.kind === "image";

  const drawPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => mode === "draw",
        onMoveShouldSetPanResponder: () => mode === "draw",
        onPanResponderGrant: (e) => {
          const next = [{ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }];
          liveRef.current = next;
          setLive(next);
        },
        onPanResponderMove: (e) => {
          const next = [...liveRef.current, { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }];
          liveRef.current = next;
          setLive(next);
        },
        onPanResponderRelease: () => {
          const points = liveRef.current;
          liveRef.current = [];
          setLive([]);
          if (points.length > 1) setPaths((current) => [...current, { color, width: brush, points }]);
        },
      }),
    [mode, color, brush],
  );

  const overlayPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => Boolean(dragRef.current),
        onMoveShouldSetPanResponder: () => Boolean(dragRef.current),
        onPanResponderMove: (e, g) => {
          const drag = dragRef.current;
          if (!drag) return;
          const pinch = e.nativeEvent.touches?.length > 1 ? Math.max(0.4, drag.startScale + g.dy / 220) : drag.startScale;
          setOverlays((current) =>
            current.map((row) =>
              row.id === drag.id ? { ...row, x: drag.dx + g.dx, y: drag.dy + g.dy, scale: pinch } : row,
            ),
          );
        },
        onPanResponderRelease: () => {
          dragRef.current = null;
        },
      }),
    [],
  );

  function startOverlayDrag(item: Overlay) {
    dragRef.current = { id: item.id, dx: item.x, dy: item.y, startScale: item.scale };
  }

  function placeText() {
    const value = draft.trim();
    Keyboard.dismiss();
    if (!value) {
      setMode("idle");
      return;
    }
    setOverlays((current) => [
      ...current,
      {
        id: `t-${Date.now()}`,
        kind: "text",
        value,
        x: stage.w / 2 - 40,
        y: stage.h / 2 - 20,
        scale: 1,
        color,
        size: textSize,
      },
    ]);
    setDraft("");
    setMode("idle");
  }

  function addSticker(value: string) {
    setOverlays((current) => [
      ...current,
      {
        id: `s-${Date.now()}`,
        kind: "sticker",
        value,
        x: stage.w / 2 - 24,
        y: stage.h / 2 - 24,
        scale: 1,
        color: "#FFFFFF",
        size: 44,
      },
    ]);
    setMode("idle");
  }

  async function applyCrop() {
    if (!uri || !stage.w) return;
    try {
      const size = await imageSize(uri);
      const box = containRect(stage.w, stage.h, size.width, size.height);
      const next = await cropPhoto(
        uri,
        {
          x: Math.max(0, (crop.x - box.x) / box.scale),
          y: Math.max(0, (crop.y - box.y) / box.scale),
          w: Math.max(8, crop.w / box.scale),
          h: Math.max(8, crop.h / box.scale),
        },
        hd,
      );
      setUri(next);
    } catch {
      /* keep original */
    }
    setMode("idle");
  }

  async function editedUri() {
    if (!photo) return uri;
    const hasOverlay = paths.length > 0 || overlays.length > 0 || live.length > 1;
    const flat = hasOverlay ? await flattenStage(stageRef, hd) : null;
    const source = flat || uri;
    return hd ? source : compressPhoto(source, false);
  }

  async function send() {
    if (busy) return;
    setBusy(true);
    try {
      const ready = await editedUri();
      onSend({ uri: ready, viewOnce, caption: caption.trim() });
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      const ready = await editedUri();
      await saveEditedToGallery(ready);
      Alert.alert("TALK", t("photoSavedGallery"));
    } finally {
      setBusy(false);
    }
  }

  if (!capture) return null;

  return (
    <Modal visible animationType="fade" onRequestClose={onCancel}>
      <View style={styles.page}>
        <View
          ref={stageRef}
          collapsable={false}
          style={styles.stage}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setStage({ w: width, h: height });
            setCrop({ x: 16, y: height * 0.12, w: width - 32, h: height * 0.62 });
          }}
          {...(mode === "draw" ? drawPan.panHandlers : overlayPan.panHandlers)}
        >
          {capture.kind === "video" ? (
            <Video source={{ uri }} style={styles.media} resizeMode={ResizeMode.CONTAIN} shouldPlay isLooping />
          ) : (
            <Image source={{ uri }} style={styles.media} resizeMode="contain" />
          )}
          {paths.map((stroke, index) => (
            <StrokeView key={index} stroke={stroke} />
          ))}
          {live.length > 1 ? <StrokeView stroke={{ color, width: brush, points: live }} /> : null}
          {overlays.map((item) => (
            <Pressable
              key={item.id}
              onPressIn={() => startOverlayDrag(item)}
              style={[styles.overlay, { left: item.x, top: item.y, transform: [{ scale: item.scale }] }]}
            >
              <Text style={item.kind === "text" ? [styles.overlayText, { color: item.color, fontSize: item.size }] : styles.sticker}>
                {item.value}
              </Text>
            </Pressable>
          ))}
          {viewOnce && mode === "idle" ? <View style={styles.onceDim} pointerEvents="none" /> : null}
          {viewOnce && mode === "idle" && !onceHelp ? (
            <View style={styles.oncePill} pointerEvents="none">
              <Text style={styles.oncePillTxt}>{t("viewOncePreview")}</Text>
            </View>
          ) : null}
          {onceHelp ? (
            <View style={styles.helpCard}>
              <Pressable onPress={() => setOnceHelp(false)} style={styles.helpClose} hitSlop={10}>
                <Text style={styles.helpCloseTxt}>✕</Text>
              </Pressable>
              <View style={styles.helpIcon}>
                <Text style={styles.helpIconTxt}>1</Text>
              </View>
              <Text style={styles.helpTitle}>{t("viewOnceCardTitle")}</Text>
              <Text style={styles.helpBody}>{t("viewOnceCardBody")}</Text>
              <Pressable onPress={() => setOnceHelp(false)} style={styles.helpOk}>
                <Text style={styles.helpOkTxt}>{t("viewOnceOk")}</Text>
              </Pressable>
              <Text style={styles.helpMore}>{t("viewOnceMoreInfo")}</Text>
            </View>
          ) : null}
          {mode === "crop" ? (
            <CropFrame crop={crop} stage={stage} onChange={setCrop} />
          ) : null}
        </View>

        {mode === "text" ? (
          <Pressable style={styles.textLayer} onPress={placeText}>
            <TextInput
              autoFocus
              value={draft}
              onChangeText={setDraft}
              placeholder={t("addTextOnPhoto")}
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={[styles.textInput, { color, fontSize: textSize }]}
              multiline
              textAlign="center"
            />
          </Pressable>
        ) : null}

        <SafeAreaView pointerEvents="box-none" style={styles.chrome}>
          {mode === "draw" ? (
            <View style={styles.top}>
              <View style={styles.toolOn}>
                <Text style={styles.toolOnTxt}>✎</Text>
              </View>
              <Pressable onPress={() => setPaths((current) => current.slice(0, -1))} hitSlop={10}>
                <Text style={styles.topIcon}>↶</Text>
              </Pressable>
              <View style={{ flex: 1 }} />
              <Pressable onPress={() => setMode("idle")} hitSlop={10}>
                <Text style={styles.done}>{t("doneEdit")}</Text>
              </Pressable>
            </View>
          ) : mode === "crop" ? (
            <View style={styles.top}>
              <Pressable onPress={onCancel} hitSlop={10}>
                <Text style={styles.topIcon}>←</Text>
              </Pressable>
              <View style={{ flex: 1 }} />
            </View>
          ) : mode === "text" ? (
            <View style={styles.top}>
              <View style={styles.toolOn}>
                <Text style={styles.toolOnTxt}>Aa</Text>
              </View>
              <View style={{ flex: 1 }} />
              <Pressable onPress={placeText} hitSlop={10}>
                <Text style={styles.done}>{t("doneEdit")}</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.top}>
              {photo ? (
                <>
                  <Pressable onPress={() => setMode("draw")} hitSlop={8} style={styles.topBtn}>
                    <Text style={styles.topIcon}>✎</Text>
                  </Pressable>
                  <Pressable onPress={() => setMode("text")} hitSlop={8} style={styles.topBtn}>
                    <Text style={styles.topAa}>Aa</Text>
                  </Pressable>
                  <Pressable onPress={() => setMode("sticker")} hitSlop={8} style={styles.topBtn}>
                    <Text style={styles.topIcon}>☺</Text>
                  </Pressable>
                  <Pressable onPress={() => setMode("crop")} hitSlop={8} style={styles.topBtn}>
                    <Text style={styles.topIcon}>⤢</Text>
                  </Pressable>
                </>
              ) : null}
              <Pressable onPress={() => setMode("hd")} hitSlop={8} style={styles.topBtn}>
                <Text style={[styles.topHd, hd && styles.topHdOn]}>HD</Text>
              </Pressable>
              <Pressable onPress={() => void download()} hitSlop={8} style={styles.topBtn}>
                <Text style={styles.topIcon}>↓</Text>
              </Pressable>
              <Pressable onPress={onCancel} hitSlop={8} style={styles.topBtn}>
                <Text style={styles.topIcon}>✕</Text>
              </Pressable>
            </View>
          )}

          {mode === "draw" ? (
            <>
              <View style={styles.colorRail}>
                {COLORS.map((item) => (
                  <Pressable key={item} onPress={() => setColor(item)} style={[styles.swatch, { backgroundColor: item }, color === item && styles.swatchOn]} />
                ))}
              </View>
              <View style={styles.brushRow}>
                {BRUSHES.map((width) => (
                  <Pressable key={width} onPress={() => setBrush(width)} style={[styles.brushDot, brush === width && styles.brushOn]}>
                    <View style={{ width: width + 4, height: width + 4, borderRadius: 20, backgroundColor: "#FFFFFF" }} />
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          {mode === "text" ? (
            <>
              <View style={styles.colorRail}>
                {COLORS.map((item) => (
                  <Pressable key={item} onPress={() => setColor(item)} style={[styles.swatch, { backgroundColor: item }, color === item && styles.swatchOn]} />
                ))}
              </View>
              <View style={styles.fontRow}>
                {TEXT_SIZES.map((size) => (
                  <Pressable key={size} onPress={() => setTextSize(size)}>
                    <Text style={[styles.fontAa, { fontSize: 10 + size / 6 }, textSize === size && styles.fontOn]}>Aa</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          {mode === "crop" ? (
            <View style={styles.cropBar}>
              <Pressable onPress={applyCrop}>
                <Text style={styles.done}>{t("doneEdit")}</Text>
              </Pressable>
              <Text style={styles.cropMid}>↻</Text>
              <Pressable onPress={() => setMode("idle")}>
                <Text style={styles.done}>{t("cancel")}</Text>
              </Pressable>
            </View>
          ) : null}

          {mode === "idle" ? (
            <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
              {viewOnce ? (
                <View style={styles.pips}>
                  <View style={styles.pip} />
                  <View style={[styles.pip, styles.pipOn]} />
                  <View style={styles.pip} />
                </View>
              ) : null}
              <View style={styles.bottom}>
                <View style={styles.sendWrap}>
                  <Pressable onPress={() => void send()} style={styles.send} disabled={busy}>
                    <SendArrowIcon size={22} color="#FFFFFF" rtl={rtl} />
                  </Pressable>
                  {peerName ? (
                    <Text style={styles.peer} numberOfLines={1}>
                      {peerName}
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  onPress={() => {
                    setViewOnce((on) => {
                      const next = !on;
                      setOnceHelp(next);
                      return next;
                    });
                  }}
                  style={[styles.one, viewOnce && styles.oneOn]}
                >
                  <Text style={[styles.oneTxt, viewOnce && styles.oneTxtOn]}>1</Text>
                </Pressable>
                <TextInput
                  value={caption}
                  onChangeText={setCaption}
                  placeholder={t("addCaption")}
                  placeholderTextColor="rgba(255,255,255,0.55)"
                  style={styles.caption}
                  textAlign={rtl ? "right" : "left"}
                />
              </View>
            </KeyboardAvoidingView>
          ) : null}
        </SafeAreaView>

        <Modal visible={mode === "sticker"} animationType="slide" transparent onRequestClose={() => setMode("idle")}>
          <Pressable style={styles.sheetBack} onPress={() => setMode("idle")}>
            <Pressable style={styles.sheet} onPress={() => undefined}>
              <View style={styles.sheetHandle} />
              <ScrollView contentContainerStyle={styles.stickerGrid}>
                {STICKERS.map((item, index) => (
                  <Pressable key={`${item}-${index}`} onPress={() => addSticker(item)} style={styles.stickerCell}>
                    <Text style={styles.sticker}>{item}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal visible={mode === "hd"} animationType="slide" transparent onRequestClose={() => setMode("idle")}>
          <Pressable style={styles.sheetBack} onPress={() => setMode("idle")}>
            <Pressable style={styles.quality} onPress={() => undefined}>
              <View style={styles.sheetHandle} />
              <Text style={styles.qualityTitle}>{t("photoQuality")}</Text>
              <Text style={styles.qualityHint}>{t("photoQualityHint")}</Text>
              <Pressable
                style={styles.qualityRow}
                onPress={() => {
                  setHd(false);
                  setMode("idle");
                }}
              >
                <View style={[styles.radio, !hd && styles.radioOn]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.qualityName}>{t("qualityStandard")}</Text>
                  <Text style={styles.qualityHint}>{t("qualityStandardHint")}</Text>
                </View>
              </Pressable>
              <Pressable
                style={styles.qualityRow}
                onPress={() => {
                  setHd(true);
                  setMode("idle");
                }}
              >
                <View style={[styles.radio, hd && styles.radioOn]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.qualityName}>{t("qualityHd")}</Text>
                  <Text style={styles.qualityHint}>{t("qualityHdHint")}</Text>
                </View>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
      </View>
    </Modal>
  );
}

function CropFrame({
  crop,
  stage,
  onChange,
}: {
  crop: { x: number; y: number; w: number; h: number };
  stage: { w: number; h: number };
  onChange: (next: { x: number; y: number; w: number; h: number }) => void;
}) {
  const origin = useRef(crop);
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const movers = useMemo(() => {
    return (["nw", "ne", "sw", "se"] as const).map((corner) =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          origin.current = cropRef.current;
        },
        onPanResponderMove: (_, g) => {
          onChange(growCrop(origin.current, corner, g.dx, g.dy, stage));
        },
      }),
    );
  }, [onChange, stage]);
  return (
    <View style={[styles.cropBox, { left: crop.x, top: crop.y, width: crop.w, height: crop.h }]}>
      <View style={styles.cropVLine} />
      <View style={[styles.cropVLine, { left: "33%" }]} />
      <View style={[styles.cropVLine, { left: "66%" }]} />
      <View style={styles.cropHLine} />
      <View style={[styles.cropHLine, { top: "33%" }]} />
      <View style={[styles.cropHLine, { top: "66%" }]} />
      {(["nw", "ne", "sw", "se"] as const).map((corner, index) => (
        <View
          key={corner}
          {...movers[index].panHandlers}
          style={[
            styles.cropHandle,
            corner.includes("n") ? { top: -8 } : { bottom: -8 },
            corner.includes("w") ? { left: -8 } : { right: -8 },
          ]}
        />
      ))}
    </View>
  );
}

function StrokeView({ stroke }: { stroke: Stroke }) {
  return (
    <>
      {stroke.points.slice(1).map((point, index) => {
        const prev = stroke.points[index];
        const dx = point.x - prev.x;
        const dy = point.y - prev.y;
        const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        return (
          <View
            key={`${prev.x}-${prev.y}-${index}`}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: prev.x,
              top: prev.y - stroke.width / 2,
              width: len,
              height: stroke.width,
              borderRadius: stroke.width,
              backgroundColor: stroke.color,
              transform: [{ rotate: `${angle}deg` }],
            }}
          />
        );
      })}
    </>
  );
}

function growCrop(
  current: { x: number; y: number; w: number; h: number },
  corner: "nw" | "ne" | "sw" | "se",
  dx: number,
  dy: number,
  stage: { w: number; h: number },
) {
  const next = { ...current };
  if (corner.includes("w")) {
    next.x = Math.max(8, current.x + dx);
    next.w = Math.max(80, current.w - dx);
  } else {
    next.w = Math.max(80, current.w + dx);
  }
  if (corner.includes("n")) {
    next.y = Math.max(8, current.y + dy);
    next.h = Math.max(80, current.h - dy);
  } else {
    next.h = Math.max(80, current.h + dy);
  }
  if (next.x + next.w > stage.w - 8) next.w = stage.w - 8 - next.x;
  if (next.y + next.h > stage.h - 8) next.h = stage.h - 8 - next.y;
  return next;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#000000" },
  stage: { ...StyleSheet.absoluteFillObject },
  media: { ...StyleSheet.absoluteFillObject },
  chrome: { flex: 1, justifyContent: "space-between" },
  top: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingTop: 4,
    gap: 8,
  },
  topBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  topIcon: { color: "#FFFFFF", fontSize: 22, fontWeight: "600" },
  topAa: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  topHd: { color: "rgba(255,255,255,0.8)", fontSize: 13, fontWeight: "800" },
  topHdOn: { color: "#2ECC71" },
  toolOn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#2ECC71",
    alignItems: "center",
    justifyContent: "center",
  },
  toolOnTxt: { color: "#111111", fontWeight: "800" },
  done: { color: "#FFFFFF", fontWeight: "700", fontSize: 16, paddingHorizontal: 8 },
  colorRail: {
    position: "absolute",
    left: 10,
    top: 90,
    gap: 6,
  },
  swatch: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.35)" },
  swatchOn: { transform: [{ scale: 1.25 }], borderColor: "#FFFFFF" },
  brushRow: {
    flexDirection: "row",
    justifyContent: "space-evenly",
    alignItems: "center",
    paddingBottom: 18,
  },
  brushDot: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  brushOn: { backgroundColor: "rgba(255,255,255,0.18)" },
  fontRow: {
    flexDirection: "row",
    justifyContent: "space-evenly",
    alignItems: "flex-end",
    paddingBottom: 12,
  },
  fontAa: { color: "rgba(255,255,255,0.45)", fontWeight: "800" },
  fontOn: { color: "#FFFFFF" },
  textLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  textInput: { minWidth: "70%", fontWeight: "700" },
  overlay: { position: "absolute" },
  overlayText: { fontWeight: "800", textShadowColor: "rgba(0,0,0,0.45)", textShadowRadius: 4 },
  sticker: { fontSize: 40 },
  cropBox: {
    position: "absolute",
    borderWidth: 1,
    borderColor: "#FFFFFF",
  },
  cropVLine: { position: "absolute", top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: "rgba(255,255,255,0.7)", left: 0 },
  cropHLine: { position: "absolute", left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: "rgba(255,255,255,0.7)", top: 0 },
  cropHandle: {
    position: "absolute",
    width: 16,
    height: 16,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    backgroundColor: "transparent",
  },
  cropBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 22,
    paddingBottom: 16,
  },
  cropMid: { color: "#FFFFFF", fontSize: 22 },
  onceDim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  oncePill: {
    position: "absolute",
    alignSelf: "center",
    top: "46%",
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  oncePillTxt: { color: "#111111", fontWeight: "700", fontSize: 15 },
  helpCard: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 28,
    paddingTop: 18,
    paddingBottom: 28,
    alignItems: "center",
    gap: 10,
  },
  helpClose: { position: "absolute", top: 14, right: 16 },
  helpCloseTxt: { color: "#667781", fontSize: 18, fontWeight: "700" },
  helpIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#00A884",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  helpIconTxt: { color: "#FFFFFF", fontWeight: "900", fontSize: 24 },
  helpTitle: { color: "#111B21", fontSize: 20, fontWeight: "800", textAlign: "center" },
  helpBody: { color: "#667781", fontSize: 14, lineHeight: 20, textAlign: "center" },
  helpOk: {
    marginTop: 8,
    alignSelf: "stretch",
    height: 48,
    borderRadius: 24,
    backgroundColor: "#111111",
    alignItems: "center",
    justifyContent: "center",
  },
  helpOkTxt: { color: "#FFFFFF", fontWeight: "800", fontSize: 16 },
  helpMore: { color: "#667781", fontSize: 13, fontWeight: "600" },
  pips: { flexDirection: "row", justifyContent: "center", gap: 6, paddingBottom: 8 },
  pip: { width: 6, height: 6, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.35)" },
  pipOn: { backgroundColor: "#FFFFFF" },
  bottom: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  sendWrap: { alignItems: "center", width: 64 },
  send: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#1A1A1A",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "#2A2A2A",
  },
  peer: { color: "#FFFFFF", fontSize: 10, fontWeight: "700", marginTop: 4, maxWidth: 72, textAlign: "center" },
  one: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  oneOn: { backgroundColor: "#FFFFFF" },
  oneTxt: { color: "#FFFFFF", fontWeight: "900", fontSize: 18 },
  oneTxtOn: { color: "#111111" },
  caption: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    backgroundColor: "rgba(40,40,40,0.82)",
    color: "#FFFFFF",
    paddingHorizontal: 16,
    fontSize: 16,
  },
  sheetBack: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: {
    height: "62%",
    backgroundColor: "#111111",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 8,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.25)",
    marginBottom: 10,
  },
  stickerGrid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 10, paddingBottom: 24 },
  stickerCell: { width: "16.66%", alignItems: "center", paddingVertical: 8 },
  quality: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 20,
    paddingBottom: 28,
    paddingTop: 10,
  },
  qualityTitle: { color: "#111111", fontSize: 20, fontWeight: "800", textAlign: "right", marginBottom: 6 },
  qualityHint: { color: "#667781", fontSize: 13, textAlign: "right", lineHeight: 18 },
  qualityRow: { flexDirection: "row-reverse", alignItems: "center", gap: 12, paddingVertical: 14 },
  qualityName: { color: "#111111", fontSize: 16, fontWeight: "700", textAlign: "right" },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#1E78F0",
  },
  radioOn: { backgroundColor: "#1E78F0" },
});
